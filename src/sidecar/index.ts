#!/usr/bin/env node
import { resolveRoot } from '../core/environment/index.js';
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

dispatcher.register('shutdown', () => {
  queueMicrotask(async () => {
    logger.info('sidecar: shutdown requested via RPC');
    await watchers?.close();
    process.exit(0);
  });
  return { ok: true };
});

registerMethods(dispatcher);

await runRpcServer({ dispatcher });

await watchers?.close();
logger.info('sidecar: RPC channel closed, exiting');
process.exit(0);
