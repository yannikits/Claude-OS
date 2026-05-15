# ADR-0006 — Tauri ↔ Node-Sidecar IPC: Long-lived JSON-RPC über stdin/stdout

**Status:** Akzeptiert
**Datum:** 2026-05-15
**Bedingt durch:** ADR-0001 (Tauri 2.x) + Researcher-Spike auf Tauri-Production-Apps, Issue #3062, offizielle Docs

## Kontext

ADR-0001 hat Tauri 2.x als GUI-Stack mit Node-Sidecar gewählt. Was offen blieb: *wie* genau spricht der Rust-Shell mit dem Node-Sidecar, und ist der Sidecar kurzlebig (per Command gespawnt, sterbend nach jedem Aufruf) oder long-lived (einmal beim App-Start, läuft bis App-Close)?

Kurzlebig-pro-Command (Tauri-Default): jeder CLI-Aufruf zahlt ~200 ms Node-Bootstrap. Bei häufigen Status-/Diff-/List-Aufrufen aus der GUI wird das schmerzhaft. Außerdem: domain-state in `claude-os` (z. B. lokaler SQLite-Index der Agent-Runs, Vault-File-Watcher-Cache) kann nicht über Aufrufe hinweg gecacht werden.

Long-lived: ein Node-Sidecar wird beim Tauri-App-Start gespawnt, lebt bis App-Close, kommuniziert über stdin/stdout. Hot-Path-Aufrufe sind RPC-schnell.

Researcher-Befund: Standard-Lib für stdin/stdout-JSON-RPC ist `kkrpc` (newline-delimited JSON, kompatibel mit JSON-RPC 2.0). Long-lived erfordert manuelle Lifecycle-Logik (Health-Check, Auto-Restart, Graceful-Shutdown).

## Entscheidung

**Long-lived Node-Sidecar mit JSON-RPC 2.0 über stdin/stdout** (`kkrpc`-kompatibles Wire-Format).

### Lifecycle

1. **Spawn**: Tauri-`app.setup()` startet `Command::sidecar("claude-os-sidecar").spawn()`. Binär-Name per `$TARGET_TRIPLE`-Suffix (Hoppscotch-Konvention, siehe Phase 6).
2. **Health-Check**: Rust-Shell sendet alle 30 s `{"jsonrpc":"2.0","method":"ping","id":N}`. Erwarteter Pong innerhalb 5 s.
3. **Restart-Strategie**: Bei Exit-Code != 0 ODER Health-Check-Miss: 3-Strikes-Exponential-Backoff (1 s, 4 s, 16 s). Nach 3 fehlgeschlagenen Restarts: Tauri-App zeigt Error-Toast, GUI bleibt funktional, aber Domain-Operationen sind deaktiviert (Read-Only-Modus).
4. **Graceful-Shutdown**: Tauri-`app.on_window_event(Close)` sendet `{"method":"shutdown","id":N}`, wartet 2 s auf saubere Antwort, sonst SIGTERM, nach weiteren 2 s SIGKILL.

### Wire-Format

Newline-delimited JSON, jedes JSON-Objekt ist ein vollständiger JSON-RPC-2.0-Request bzw. Response.

```
→ {"jsonrpc":"2.0","method":"vault.snapshot","params":{"trigger":"manual"},"id":42}
← {"jsonrpc":"2.0","result":{"commitSha":"abc123","fileCount":12,"bytes":48391},"id":42}
```

Methodennamen folgen `<domain>.<operation>` (z. B. `vault.snapshot`, `catalog.list`, `agent.runs.recent`).

### Lib-Wahl

- **Node-Seite**: `kkrpc` (npm) — Standard für Sidecar-JSON-RPC, exponiert Domain-Code als RPC-Methoden via Registry-Pattern
- **Rust-Seite**: kein `kkrpc-rs` (existiert noch nicht stabil) — eigene minimale JSON-RPC-Layer auf `tokio::io::AsyncBufReadExt::lines` (~100 LOC)

## Konsequenzen

**Positiv**

- Heißer CLI-Pfad (~5 ms RPC-Roundtrip statt ~200 ms Node-Spawn)
- Domain-State (SQLite-Index, File-Watcher-Cache) lebt durch eine GUI-Session
- Keine Port-Konflikte oder Firewall-Themen (stdin/stdout statt HTTP/Socket)
- Process-Isolation: Sidecar-Crash bricht GUI nicht ab, Tauri-Shell zeigt nur Error-Toast
- Identisches RPC-Protokoll kann später für CLI↔Sidecar-Sharing wiederverwendet werden

**Negativ / Aufwand**

- Lifecycle-Wrapper braucht Tests für Crash-Szenarien (kill -9, OOM, infinite loop)
- Rust-Seite muss eigene JSON-RPC-Logik enthalten (kein Drop-in-Library)
- Debug-UX: Logs des Sidecar landen in Tauri-Output, nicht in eigenem File — zusätzliches File-Logging in Node-Side nötig
- Erst-Start-Latenz: Tauri-Window erscheint sofort, aber Domain-Operationen sind ~500 ms nach App-Start nicht verfügbar (Sidecar-Init). Loading-Spinner Pflicht.

## Implementierungs-Constraints

- `domains/*/` Public-Interfaces bleiben transport-agnostisch (kein RPC-Import in Domain-Code) — die RPC-Schicht ist Adapter in `cli/rpc-server.ts`
- Health-Check muss reentrancy-safe sein (kein Hängenbleiben in einem laufenden Vault-Snapshot)
- Shutdown-Sequence ist idempotent: doppeltes Senden von `shutdown` ist No-Op
- Sidecar-Stderr wird vom Tauri-Shell separat captured und in Renderer-Konsole gespiegelt (Debug-Hilfe)
- Logs-File pro Maschine: `%APPDATA%/claude-os/logs/sidecar-YYYY-MM-DD.log` (siehe ADR-0002 Pfad-Schema)

## Alternativen

| Option | Bewertung | Grund für Ablehnung |
|--------|-----------|---------------------|
| **Short-lived pro Command** (Tauri-Default) | Verworfen | 200 ms Bootstrap pro Call killt die UX bei Listing/Status-Operationen |
| **HTTP-Sidecar auf localhost** | Verworfen | Port-Konflikte, Firewall-Prompts, weniger Process-Isolation |
| **Unix-Socket / Named Pipe** | Verworfen | Plattform-spezifisch, mehr Code, kein Vorteil ggü. stdin/stdout |
| **gRPC** | Verworfen | Build-Komplexität nicht gerechtfertigt für Solo-Dev-Tool |
| **Tauri-Plugin in Rust statt Sidecar** | Verworfen v1 | Würde `claude-os`-Domain in Rust portieren — viel Aufwand, opfert npm-Ökosystem (siehe ADR-0001) |

## Quellen

- [Tauri Sidecar Docs](https://v2.tauri.app/develop/sidecar/)
- [Tauri Node.js as Sidecar](https://v2.tauri.app/learn/sidecar-nodejs/)
- [Tauri Sidecar Lifecycle Issue #3062](https://github.com/tauri-apps/plugins-workspace/issues/3062)
- `kkrpc` — npm package, primärer Newline-JSON-RPC-Lib für Tauri-Sidecars
- [Hoppscotch Agent src-tauri](https://github.com/hoppscotch/hoppscotch/tree/main/packages/hoppscotch-agent/src-tauri) — Production-Referenz

## Notiz

Diese ADR komplettiert ADR-0001 (Tauri-Wahl) mit dem fehlenden IPC-Detail. Phase 6 in `tasks/todo.md` enthält die Implementations-Tickets.
