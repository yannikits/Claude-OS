#!/usr/bin/env node
import { resolveRoot } from '../core/environment/index.js';
import { resolveMachinePaths } from '../core/paths/index.js';
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

dispatcher.register('shutdown', () => {
  queueMicrotask(async () => {
    logger.info('sidecar: shutdown requested via RPC');
    await chatSessions.shutdownAll();
    await schedulerHandle.stop();
    await watchers?.close();
    process.exit(0);
  });
  return { ok: true };
});

registerMethods(dispatcher, { chatSessions });

await runRpcServer({ dispatcher });

await chatSessions.shutdownAll();
await schedulerHandle.stop();
await watchers?.close();
logger.info('sidecar: RPC channel closed, exiting');
process.exit(0);
