/**
 * MCP-Clients-Namespace RPCs: clients.status / clients.reprobe.
 * Split aus `sidecar/methods.ts` (M21). Nur registriert wenn
 * `WatcherHandle` injected ist (v1.7).
 *
 * @module @sidecar/methods/mcp
 */
import type { WatcherHandle } from '../../domains/mcp-clients/index.js';
import type { RpcDispatcher } from '../rpc.js';
import { requireString } from './_shared.js';

export function registerMcpMethods(dispatcher: RpcDispatcher, watcher: WatcherHandle): void {
  dispatcher.register('mcp.clients.status', () => {
    const snapshot = watcher.snapshot();
    const entries = Array.from(snapshot.entries()).map(([key, status]) => ({
      key,
      entry: status.entry,
      result: status.result,
      probedAt: status.probedAt,
    }));
    return { count: entries.length, entries };
  });
  dispatcher.register('mcp.clients.reprobe', async (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { serverKey?: string };
    const serverKey = requireString(params.serverKey, 'serverKey', 'mcp.clients.reprobe');
    const result = await watcher.reprobe(serverKey);
    if (result === null) {
      return { ok: false as const, code: 'unknown-server', serverKey };
    }
    return {
      ok: true as const,
      key: serverKey,
      entry: result.entry,
      result: result.result,
      probedAt: result.probedAt,
    };
  });
}
