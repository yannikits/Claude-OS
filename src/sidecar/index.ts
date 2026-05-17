#!/usr/bin/env node
import { RpcDispatcher, runRpcServer } from './rpc.js';

const dispatcher = new RpcDispatcher();

dispatcher.register('ping', () => ({ pong: true, ts: Date.now() }));

dispatcher.register('shutdown', () => {
  queueMicrotask(() => process.exit(0));
  return { ok: true };
});

await runRpcServer({ dispatcher });

process.exit(0);
