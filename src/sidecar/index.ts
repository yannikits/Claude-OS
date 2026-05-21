#!/usr/bin/env node
import { resolveRoot } from '../core/environment/index.js';
import { resolveMachinePaths } from '../core/paths/index.js';
import { McpTrustStore, mcpTrustPathFor, startMcpWatcher } from '../domains/mcp-clients/index.js';
import { startScheduler } from '../domains/scheduler/index.js';
import { ChatSessions } from './chat-sessions.js';
import { createSidecarLogger } from './logger.js';
import { registerMethods } from './methods.js';
import { RpcDispatcher, runRpcServer } from './rpc.js';
import { type InboxOutboxWatchers, setupWatchers } from './watchers.js';

const { logger, logsDir, currentFile } = await createSidecarLogger();
if (logsDir !== null) {
  logger.info({ logsDir, currentFile }, 'sidecar: logger ready (pino-roll daily)');
} else {
  logger.info('sidecar: logger ready (stderr-only)');
}

const dispatcher = new RpcDispatcher();

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
logger.info('sidecar: chat-sessions ready');

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

dispatcher.register('shutdown', () => {
  queueMicrotask(async () => {
    logger.info('sidecar: shutdown requested via RPC');
    await chatSessions.shutdownAll();
    await schedulerHandle.stop();
    await mcpWatcherHandle.stop();
    await watchers?.close();
    process.exit(0);
  });
  return { ok: true };
});

registerMethods(dispatcher, { chatSessions, mcpWatcher: mcpWatcherHandle });

await runRpcServer({ dispatcher });

await chatSessions.shutdownAll();
await schedulerHandle.stop();
await mcpWatcherHandle.stop();
await watchers?.close();
logger.info('sidecar: RPC channel closed, exiting');
process.exit(0);
