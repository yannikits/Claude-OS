# ADR-0019 — Sidecar Background-Services-Pattern (v1.5+v1.7)

**Status:** Akzeptiert
**Datum:** 2026-05-20
**Bedingt durch:** Scheduler-Runner (PR [#40](https://github.com/yannikits/Claude-portable/pull/40), [#42](https://github.com/yannikits/Claude-portable/pull/42)) und MCP-Watcher (PR [#48](https://github.com/yannikits/Claude-portable/pull/48), [#49](https://github.com/yannikits/Claude-portable/pull/49)) wiederholten dasselbe Architektur-Muster — wir kodifizieren es jetzt damit weitere Services (Health-Watcher, Vault-Snapshot-Scheduler, Auto-Update-Checker) dem Pattern folgen koennen.

## Kontext

Bis Phase 5 hatte der Tauri-Sidecar nur **eventgesteuerte** Services: `chokidar` watcht inbox/outbox-Verzeichnisse, `ChatSessions` reagiert auf RPC-Calls. Phase 5/6/7 brachten **zeitgesteuerte** Hintergrund-Services (alle 60s tickt etwas), die das gleiche Lifecycle- und Wire-Muster brauchten:

- Tick-Loop mit konfigurierbarem Intervall
- Status-Cache fuer GUI-Polling
- Event-Stream zur GUI fuer Auto-Refresh
- Graceful Shutdown (laufender Tick wird abgewartet)
- Test-Seams (alle System-APIs injectable)

Die Versuchung waere, ein generisches `BackgroundService`-Framework zu bauen. Wir haben das ausprobiert und es ist **schlechter** als der pragmatische Duplikations-Pattern: jedes Service hat domain-spezifische Edge-Cases (Skip-on-Overlap-Semantik, Cache-Eviction-Regeln, Event-Typen), die ein generisches Framework entweder über-abstrahiert oder zwingt jeden Service durch awkward Hooks zu gehen.

## Entscheidung

**Sidecar-Background-Services folgen einem konsistenten Pattern aber bleiben einzelne Dateien — kein generisches Framework.**

### Pattern (pro Service)

Jeder Service exportiert eine `startXxx(opts)` Funktion mit dieser Shape:

```ts
export interface XxxOpts {
  readonly tickMs?: number;
  readonly emit: (event: XxxEvent) => void;
  readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  readonly now?: () => Date;
  // weitere Domain-spezifische Test-Seams (discover, probe, spawn ...)
}

export interface XxxHandle {
  stop: () => Promise<void>;
  snapshot?: () => ReadonlyMap<string, XxxStatus>; // optional pro Service
}

export function startXxx(opts: XxxOpts): XxxHandle { /* ... */ }
```

### Implementierungs-Regeln

1. **Erster Tick nach 50ms Delay** statt sofort — Caller bekommt Zeit Listener anzuhaengen bevor Events fliegen.
2. **`tickInFlight`-Flag** verhindert Skip-on-Overlap bei langen Ticks. Event `skip-overlap` wird emittiert statt aufzustauen.
3. **`scheduleNext()` rekursiv im finally-Block** — sicherstellen dass der Loop weiterlaeuft auch wenn ein Tick wirft.
4. **`stop()` ist async** und wartet auf `inFlightSettled`-Promise damit kein orphan-Probe nach Shutdown weiterlaeuft.
5. **Event-Stream-Notifications** als JSON-RPC-Notifications mit `method = '<service>://event'` an den Tauri-Supervisor — der Router (`gui/src-tauri/src/supervisor.rs:182`) forwarded automatisch als Tauri-Event ohne Rust-Aenderungen.
6. **Status-Cache** als `Map<string, StatusEntry>` zugaenglich via `snapshot()` — die Sidecar-RPC `xxx.status` ruft `snapshot()` und gibt es als JSON-Array zurueck.

### Lifecycle im Sidecar-Entry-Point

`src/sidecar/index.ts` folgt dieser Reihenfolge:

```ts
// Phase 1: Logger
const { logger } = await createSidecarLogger();

// Phase 2: Dispatcher + RPC-only-Methods (catalog.list, ping, ...)
const dispatcher = new RpcDispatcher();
dispatcher.register('ping', ...);

// Phase 3: stateful Services in fester Reihenfolge
const chatSessions = new ChatSessions(emitNotification);
const watchers = setupWatchers(...);          // inbox/outbox chokidar
const schedulerHandle = startScheduler(...);  // 60s-tick
const mcpWatcherHandle = startMcpWatcher(...); // 60s-tick

// Phase 4: Service-bezogene RPCs
registerMethods(dispatcher, { chatSessions, mcpWatcher: mcpWatcherHandle });

// Phase 5: Shutdown-Sequenz spiegelt Phase 3 in REVERSER Reihenfolge
dispatcher.register('shutdown', () => queueMicrotask(async () => {
  await chatSessions.shutdownAll();
  await schedulerHandle.stop();
  await mcpWatcherHandle.stop();
  await watchers?.close();
  process.exit(0);
}));
```

Reverse-Shutdown-Order vermeidet dass spaeter-gestartete Services in noch-laufende fruehere reinschreiben (z. B. der Scheduler ruft kein Watcher-Tick mehr an wenn der Watcher bereits gestoppt ist).

## Konsequenzen

### Positiv

- **Lese-Klarheit:** jeder Service ist eine Datei ~150-200 LOC. Kein Hin-und-her zwischen Framework und Implementation.
- **Test-Friendly:** Test-Seams sind explizit in der Opts-Signatur — Mocks sind `vi.fn(() => ...)` ohne Framework-Boilerplate.
- **Forward-kompatibel:** ein neuer Service braucht keine Framework-Aenderung. Copy das Pattern, anpassen, in `src/sidecar/index.ts` einhaengen.
- **Reproduzierbare Test-Time:** TimerHarness-Pattern (siehe `tests/domains/scheduler/runner.test.ts` und `tests/domains/mcp-clients/watcher.test.ts`) — Tests laufen mit echten async-microtasks aber ohne wall-clock-delays.

### Negativ / Akzeptierte Trade-offs

- **Code-Duplikation in den 50ms-Initial-Delay-, Timer-Override-, Stop-Logic-Bereichen** — pro neuem Service ~30 LOC Wiederholung. Akzeptiert weil die Variation der Edge-Cases ein Framework awkward machen wuerde.
- **Kein zentrales Service-Registry** im Sidecar — wenn ein Service "still vor sich hin laeuft" weil jemand `startXxx` aufruft aber nicht in `index.ts` traegt, bemerkt das nichts. Akzeptiert weil index.ts klein bleibt; lint-Regel koennte das später erzwingen.

### Konstraints fuer Folge-Services

- **Verpflichtende Felder in der `XxxOpts`:** `emit`, `setTimeoutFn?`, `clearTimeoutFn?`, `now?`. Andere Test-Seams nach Domain-Bedarf.
- **Default-`tickMs`:** 60_000. Niedriger nur mit Begruendung.
- **Event-Namespace:** `<service>://event` (z. B. `mcp-client://event`, `schedule://event`). Single-File-Pattern fuer einfaches Auto-Forwarding.
- **Shutdown-Order:** Reihenfolge in `index.ts` Phase 3 ↔ Phase 5 spiegeln.
- **Test-File:** mind. 4 Tests pro Service — tick-emit, snapshot-Inhalt, change-detection, cleanup-on-discover-loss. TimerHarness aus existing examples uebernehmen.

## Alternativen verworfen

**Generisches BackgroundService<TEvent, TStatus>-Framework:** Probiert in Phase-5-Spike. Resultat: jeder Service haette einen `tick()`-Callback implementieren muessen, plus eigene event-Typen, plus eigene snapshot-Methode. Das Framework brachte ~20 LOC Ersparnis pro Service aber 80 LOC eigenes Setup, plus jeder bug im Framework wirkte simultan auf alle Services. Verworfen.

**Event-Emitter-Subclass:** Ein `BackgroundService extends EventEmitter`-Klasse mit `emit()`/`start()`/`stop()`. Funktioniert, aber introduziert OOP-Inheritance-Stacks die mit der existing Funktional-Style-Domain (resolveBindings, parseCron etc.) inkonsistent waeren.

**Pull-only ohne Push-Events:** GUI polled jede Sekunde `xxx.status`-RPC statt Events zu empfangen. Funktional aequivalent, aber: a) wastete RPC-Roundtrips, b) GUI-Latenz waere bis zu poll-Intervall, c) Tauri-Event-Channel ist eh da.

## Referenzen

- ADR-0006 — Tauri-Node-Sidecar-IPC (definiert den Notification-Channel)
- `src/domains/scheduler/runner.ts` — erstes Service nach diesem Pattern
- `src/domains/mcp-clients/watcher.ts` — zweites Service, validierte das Pattern
- `src/sidecar/index.ts` — Lifecycle-Wire
- `gui/src-tauri/src/supervisor.rs:182` — Notification-zu-Tauri-Event-Forwarding
