# ADR-0034 — Skill-Sandbox Process-Isolation via child_process.fork

**Status:** Akzeptiert (2026-05-27)
**Datum:** 2026-05-27
**Bedingt durch:** ADR-0026 §"Sandbox" Gate 1 + Yannik-Decision auf den three-brain-Klärungsslot (Option B aus `three-brain-out/2026-05-27-phase-5-completion/plan.md`).

## Kontext

ADR-0026 fordert für quarantined Skills (LLM-generierter Code) eine echte Process-Isolation mit:

- Kein Filesystem-Write außer `<sandbox>/`
- Kein Netz außer Hostname-Allowlist
- Kein Zugriff auf `customer-confidential`-Notes
- 30s Timeout pro Tool-Call, hard-kill bei Überschreitung

Drei Optionen wurden in `three-brain-out/2026-05-27-phase-5-completion/plan.md` evaluiert:

| Option | Pro | Contra |
|---|---|---|
| **A) `node:worker_threads`** | low-latency RPC, single Node-process | Worker hat full Node-API access — fs-wrapper ist defense-in-depth, nicht hard-barrier |
| **B) `node:child_process.fork`** | echter OS-Prozess, klares IPC, kill-on-timeout trivial, kein Heap-share | Windows hat kein chroot — Path-Validation ist defense-in-depth, kein OS-Enforcement |
| **C) WASM-Runtime** (Wasmtime/Wasmer mit Node-Embedding) | echte Capability-Isolation, kein-fs / kein-net Default | Skill-Author muss WASM-kompatible-Subset schreiben → großer DX-Hit |

## Entscheidung

**Option B (`child_process.fork`) als Phase-5a-Foundation.**

Begründung:

1. **Echte Process-Boundary** — anders als `worker_threads` ist der Skill in einem separaten OS-Prozess; ein `process.kill` beim Parent-Hängen ist sicher
2. **30s-Timeout über SIGKILL** funktioniert deterministisch — wir warten nicht auf Cooperative-Cancellation
3. **Kein Heap-Sharing** mit der Parent — Skill kann nicht im Eval-Style auf Parent-State zugreifen
4. **Cross-Platform pragmatic** — auf Linux/macOS könnten wir später optional cgroups + chroot dranschalten; auf Windows ist Process-Boundary das Maximum was wir ohne extreme Komplexität bekommen
5. **DX bleibt erträglich** — Skill-Author schreibt eine normale Node-ESM-Funktion (`export default async function run(input)`), keine WASM-Subset-Pflicht

## Implementation

### Process-Spawn

```typescript
import { fork } from 'node:child_process';

const child = fork(workerEntry, [], {
  silent: true,
  env: stripSecretEnv(process.env), // CLAUDE_OS_AUTH_TOKEN/SECRETS_PASSPHRASE etc. raus
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
```

Worker-Entry (`src/domains/skill-lifecycle/sandbox/worker-entry.ts`):

```typescript
process.on('message', async (msg) => {
  const mod = await import(msg.skillScriptPath);
  const run = mod.default ?? mod.run;
  const output = await run(msg.input);
  process.send({ kind: 'ok', output });
  process.exit(0);
});
```

### Timeout-Enforcement

```typescript
const killTimer = setTimeout(() => {
  child.kill('SIGKILL');
  finish({ status: 'timeout', killedBy: 'timeout', ... });
}, timeoutMs); // default 30s
killTimer.unref(); // don't block process exit
```

Hard-SIGKILL, kein gracioses-Stop. Skill ist quarantined — verdiente keine Kooperations-Verhandlung.

### Path-Validation (Defense-in-Depth)

```typescript
const normalized = resolve(skillScriptPath);
const rel = relative(sandboxRoot, normalized);
if (rel.startsWith('..') || isAbsolute(rel)) {
  throw new SandboxError('path outside sandbox-root', 'invalid-path');
}
```

**Windows-Caveat:** Junction-Links + UNC-Pfade (`\\?\C:\...`) können diese Check umgehen. Wir dokumentieren das als bewussten Trade-off — Defense-in-Depth gegen versehentliche Skill-Author-Bugs, nicht gegen malicious actors mit Windows-FS-Wissen. **Echte Sicherheits-Boundary ist die Process-Boundary + Timeout.**

### Secret-Env-Strip

Vor `fork()` werden secret-shaped env-vars aus der Child-Env entfernt:

- `CLAUDE_OS_SECRETS_KEY`
- `CLAUDE_OS_SECRETS_PASSPHRASE`
- `CLAUDE_OS_AUTH_TOKEN`
- `ANTHROPIC_*`

Plus `CLAUDE_OS_SANDBOX=1` als marker für die Child — kann später für conditional fs/net-patches im worker-entry genutzt werden.

### IPC-Protokoll

Strict typed JSON via Node-IPC:

```typescript
// Parent → Child
interface SandboxIpcRequest {
  kind: 'run';
  skillId: string;
  skillScriptPath: string;
  input: unknown;
}

// Child → Parent
type SandboxIpcResponse =
  | { kind: 'ok'; output: unknown }
  | { kind: 'error'; message: string };
```

## Was NICHT in dieser Foundation enthalten ist (Phase-5b deferred)

- **fs-API-Patching** im worker-entry — Skill kann `/etc/passwd` lesen. Phase-5b implementiert fs-Wrapper analog zu Deno-Permissions
- **net-API-Patching** — Skill kann via `fetch` beliebige Hosts erreichen. Phase-5b implementiert Hostname-Allowlist via patched `node:net`
- **`customer-confidential`-Vault-Lockout** — aktuell macht der Skill nichts mit dem Vault. Phase-5b verbindet die Sandbox mit einem Custom-Vault-Reader der nur `personal` / `_sandbox`-Notes sieht
- **Cooperative-Cancellation-API** für lange Skills — Future ADR wenn 30s Hard-Kill zu aggressiv ist

Die Foundation reicht für den **Spike**: prove that we can run untrusted code with process-boundary + timeout. Phase-5b ist die Härtung.

## Konsequenzen

### Positiv

- ADR-0026 Gate 1 ist **prototyped + Vitest-verifiziert** — Self-Improvement-Phase kann starten sobald Gate 2 (Signing) auch durch
- Pattern ist Cross-Platform identisch — kein Windows-vs-POSIX-Split im Caller-Code
- IPC ist deterministisch + JSON-only — kein Pickle-/Eval-Risk
- Worker-Entry ist ~80 LOC — gut auditierbar

### Negativ

- **fs/net-Hardening fehlt noch** — heute kann ein Skill `node:fs` direkt nutzen. Dokumentiert als Phase-5b-Block. Bis dahin: keine LLM-generated Skills aktivieren (Lifecycle bleibt bei `draft`)
- **Pro-Skill ~150-300ms Fork-Overhead** — für hochfrequente Skills nicht ideal; akzeptabel für quarantined-Test-Runs
- **Windows-Junction-Link-Bypass** — dokumentiert + akzeptiert. Real-world-Risk niedrig (LLM müsste explizit Windows-FS-Wissen einbauen)

## Alternativen verworfen

- **A worker_threads:** Heap-Sharing-Risk + nicht echt isolierter Crash-Boundary. Verworfen.
- **C WASM:** DX-Verschlechterung disqualifiziert das für quarantined-Skill-DX. Wäre v2-Material bei echtem hochsicherheitsbedarf.
- **chroot/jail-Plugins:** Cross-Platform-Brüche (Linux-only). Sandbox darf nicht OS-spezifisch sein.

## Referenzen

- [ADR-0026](0026-skill-auto-promotion-lifecycle.md) §"Sandbox" — die Anforderung
- [SECURITY.md §5.3](../../SECURITY.md) — Sandbox-Specs
- `src/domains/skill-lifecycle/sandbox/` — Implementation
- `three-brain-out/2026-05-27-phase-5-completion/plan.md` — Discovery (drei Optionen evaluiert)
