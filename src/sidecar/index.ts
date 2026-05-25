#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { resolveRoot } from '../core/environment/index.js';
import { resolveMachinePaths } from '../core/paths/index.js';
import { McpTrustStore, mcpTrustPathFor, startMcpWatcher } from '../domains/mcp-clients/index.js';
import { startScheduler } from '../domains/scheduler/index.js';
import { ChatSessions } from './chat-sessions.js';
import { createSidecarLogger } from './logger.js';
import { MemoryIndexService } from './memory-index-service.js';
import { registerMethods } from './methods.js';
import { PtyChatSessions } from './pty-chat-sessions.js';
import { RpcDispatcher, runRpcServer } from './rpc.js';
import { type InboxOutboxWatchers, setupWatchers } from './watchers.js';

const { logger, logsDir, currentFile } = await createSidecarLogger();
if (logsDir !== null) {
  logger.info({ logsDir, currentFile }, 'sidecar: logger ready (pino-roll daily)');
} else {
  logger.info('sidecar: logger ready (stderr-only)');
}

const dispatcher = new RpcDispatcher();

// M8 (2026-05-21 code-review): Sidecar generiert einen Per-Spawn-Nonce
// und committed ihn als stderr-handshake. Tauri-Supervisor (siehe
// `gui/src-tauri/src/supervisor.rs`) parsed die erste handshake-Line aus
// stderr und attached den nonce an jeden Wire-RPC. Wir aktivieren die
// Pruefung NACH dem handshake-write damit ein eventuell früher
// gefeuerter ping (z. B. von einem schon laufenden router) noch
// durchkommt — die handshake-Line ist immer das ERSTE was wir auf
// stderr schreiben.
//
// Opt-out via $CLAUDE_OS_RPC_NONCE=disabled (fuer e2e-tests / dev-runs
// die ohne Tauri-Supervisor laufen). Setzt man stattdessen einen
// concrete-Wert in der env, wird DIESER als expected verwendet
// (deterministic-mode fuer Integration-Tests).
const nonceMode = process.env.CLAUDE_OS_RPC_NONCE ?? 'auto';
let rpcNonce: string | null = null;
if (nonceMode !== 'disabled') {
  rpcNonce = nonceMode === 'auto' ? randomBytes(16).toString('hex') : nonceMode;
  // WICHTIG: dieser write MUSS auf stderr (nicht logger.info — das
  // landet im pino-file aber auch stderr ueber multistream). Tauri
  // supervisor parsed die line als JSON.
  process.stderr.write(
    `${JSON.stringify({ type: 'sidecar-ready', nonce: rpcNonce, pid: process.pid })}\n`,
  );
  dispatcher.setExpectedNonce(rpcNonce);
  logger.info({ noncePrefix: rpcNonce.slice(0, 8) }, 'sidecar: rpc-nonce active (M8)');
} else {
  logger.warn('sidecar: rpc-nonce DISABLED via env — only safe in dev/tests');
}

dispatcher.register('ping', () => ({ pong: true, ts: Date.now() }));

// Notifications flow out via stdout as JSON-RPC 2.0 envelopes without an `id`.
// The Tauri supervisor's stdout router recognises this shape and re-emits the
// payload as a Tauri event with `method` as the event name — same channel that
// inbox/outbox watchers already use (src/sidecar/watchers.ts).
function emitNotification(method: string, params: unknown): void {
  const envelope = JSON.stringify({ jsonrpc: '2.0', method, params });
  process.stdout.write(`${envelope}\n`);
}

const chatSessions = new ChatSessions(emitNotification);
logger.info('sidecar: chat-sessions ready (v1.2 line-buffered)');

// v1.x: PTY-backed sessions parallel zu den line-buffered chat-sessions.
// node-pty wird via pty-binding-loader monkey-patch geladen damit das
// sideloaded `.node`-Binary aus CLAUDE_OS_PTY_BINDINGS_DIR funktioniert
// auch unter pkg-Bundles. Load-Error wird gelogged, aber bringt den
// Sidecar nicht runter — pty.* RPCs sind dann einfach unregistered.
let ptyChatSessions: PtyChatSessions | null = null;
try {
  ptyChatSessions = new PtyChatSessions(emitNotification);
  logger.info('sidecar: pty-chat-sessions ready (v1.x full-tty)');
} catch (err) {
  logger.warn(
    { err: err instanceof Error ? err.message : String(err) },
    'sidecar: pty-chat-sessions disabled (node-pty failed to load)',
  );
}

let watchers: InboxOutboxWatchers | null = null;
try {
  watchers = setupWatchers(resolveRoot({}).path);
  logger.info('sidecar: inbox/outbox watchers running');
} catch (err) {
  logger.warn(
    { err: err instanceof Error ? err.message : String(err) },
    'sidecar: watchers disabled',
  );
}

// Scheduler-Runner als Hintergrund-Service starten. Tickt alle 60s
// gegen <dataDir>/schedules.json und feuert faellige Eintraege.
// Pro SchedulerEvent landet eine `schedule://event`-Notification beim
// Tauri-Supervisor, der sie als Tauri-Event an den Renderer weiterleitet.
const schedulerHandle = startScheduler({
  dataDir: resolveMachinePaths().dataDir,
  emit: (event) => emitNotification('schedule://event', event),
});
logger.info('sidecar: scheduler runner started (tick 60s)');

// MCP-Watcher als Hintergrund-Service starten. Probt alle 60s die in
// Claude Desktop / Claude Code konfigurierten MCP-Server live und
// emittiert status-changed-Events bei Veraenderungen. Status-Cache
// ist via `mcp.clients.status`-RPC abrufbar.
//
// Probe-Timeout via env-Var konfigurierbar (CLAUDE_OS_MCP_PROBE_TIMEOUT_MS).
// Default 15_000ms — claude-flow + aehnliche heavy MCP-Server brauchen
// 5-15s zum Initialisieren ihrer HNSW-Indizes etc.
const probeTimeoutFromEnv = Number.parseInt(process.env.CLAUDE_OS_MCP_PROBE_TIMEOUT_MS ?? '', 10);
const probeTimeoutMs =
  Number.isFinite(probeTimeoutFromEnv) && probeTimeoutFromEnv > 0 ? probeTimeoutFromEnv : 15_000;
// M3 (2026-05-21 code-review): trust-store fuer mcp-watcher. Nur
// acknowledged servers werden ge-spawnt; alle anderen Probes liefern
// `trust-required` und triggern eine GUI-Modal via Status-Event.
const mcpTrustStore = new McpTrustStore({
  filePath: mcpTrustPathFor(resolveMachinePaths().dataDir),
});
const mcpWatcherHandle = startMcpWatcher({
  emit: (event) => emitNotification('mcp-client://event', event),
  projectCwd: resolveRoot({}).path,
  probeTimeoutMs,
  isTrusted: (serverKey) => mcpTrustStore.isAcknowledged(serverKey),
});
logger.info(
  { probeTimeoutMs },
  'sidecar: mcp watcher started (tick 60s, probe-timeout configurable)',
);

// Memory-index service (Phase 3f). Lazy-tolerant: if CLAUDE_OS_VAULT_PATH
// is unset or the DB is corrupt, the service stays in "disabled" mode
// and memory.* RPCs return enabled:false. Boot never fails because of
// an unconfigured vault.
const memoryIndexService = new MemoryIndexService({
  log: (level, msg) => {
    const bound = logger.child({ component: 'memory-index' });
    if (level === 'error') bound.error(msg);
    else if (level === 'warn') bound.warn(msg);
    else bound.info(msg);
  },
});
await memoryIndexService.start();

dispatcher.register('shutdown', () => {
  queueMicrotask(async () => {
    logger.info('sidecar: shutdown requested via RPC');
    await chatSessions.shutdownAll();
    await ptyChatSessions?.shutdownAll();
    await schedulerHandle.stop();
    await mcpWatcherHandle.stop();
    await watchers?.close();
    await memoryIndexService.stop();
    process.exit(0);
  });
  return { ok: true };
});

registerMethods(dispatcher, {
  chatSessions,
  ...(ptyChatSessions !== null ? { ptyChatSessions } : {}),
  mcpWatcher: mcpWatcherHandle,
  emit: emitNotification,
  memoryIndex: memoryIndexService,
});

await runRpcServer({ dispatcher });

await chatSessions.shutdownAll();
await ptyChatSessions?.shutdownAll();
await schedulerHandle.stop();
await mcpWatcherHandle.stop();
await watchers?.close();
await memoryIndexService.stop();
logger.info('sidecar: RPC channel closed, exiting');
process.exit(0);
