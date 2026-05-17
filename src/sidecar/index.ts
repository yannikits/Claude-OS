#!/usr/bin/env node
import { resolveRoot } from '../core/environment/index.js';
import { registerMethods } from './methods.js';
import { RpcDispatcher, runRpcServer } from './rpc.js';
import { type InboxOutboxWatchers, setupWatchers } from './watchers.js';

const dispatcher = new RpcDispatcher();

dispatcher.register('ping', () => ({ pong: true, ts: Date.now() }));

let watchers: InboxOutboxWatchers | null = null;
try {
  watchers = setupWatchers(resolveRoot({}).path);
} catch (err) {
  process.stderr.write(
    `sidecar: watchers disabled (${err instanceof Error ? err.message : err})\n`,
  );
}

dispatcher.register('shutdown', () => {
  queueMicrotask(async () => {
    await watchers?.close();
    process.exit(0);
  });
  return { ok: true };
});

registerMethods(dispatcher);

await runRpcServer({ dispatcher });

await watchers?.close();
process.exit(0);
