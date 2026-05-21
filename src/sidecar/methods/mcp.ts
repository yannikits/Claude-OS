/**
 * MCP-Clients-Namespace RPCs: clients.status / clients.reprobe /
 * trust.list / trust.acknowledge / trust.revoke.
 * Split aus `sidecar/methods.ts` (M21); trust-RPCs in M3 (2026-05-21
 * code-review) hinzugefuegt.
 *
 * @module @sidecar/methods/mcp
 */
import { resolveMachinePaths } from '../../core/paths/index.js';
import {
  McpTrustStore,
  mcpTrustPathFor,
  type WatcherHandle,
} from '../../domains/mcp-clients/index.js';
import type { RpcDispatcher } from '../rpc.js';
import { requireString } from './_shared.js';

function makeTrustStore(): McpTrustStore {
  const machine = resolveMachinePaths();
  return new McpTrustStore({ filePath: mcpTrustPathFor(machine.dataDir) });
}

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

  // M3 (2026-05-21 code-review): Trust-RPCs. GUI ruft `mcp.trust.list`
  // beim Dashboard-Load; bei einem `trust-required`-ProbeResult zeigt
  // sie ein "Trust this server?"-Modal das `mcp.trust.acknowledge` ruft.
  // `mcp.trust.revoke` ist die Undo-Action im Settings-Pane.
  dispatcher.register('mcp.trust.list', () => {
    const store = makeTrustStore();
    return { entries: store.list() };
  });
  dispatcher.register('mcp.trust.acknowledge', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { serverKey?: string };
    const serverKey = requireString(params.serverKey, 'serverKey', 'mcp.trust.acknowledge');
    const store = makeTrustStore();
    store.acknowledge(serverKey);
    return {
      ok: true as const,
      serverKey,
      acknowledgedAt: store.acknowledgedAt(serverKey),
    };
  });
  dispatcher.register('mcp.trust.revoke', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { serverKey?: string };
    const serverKey = requireString(params.serverKey, 'serverKey', 'mcp.trust.revoke');
    const store = makeTrustStore();
    const revoked = store.revoke(serverKey);
    return { ok: true as const, serverKey, revoked };
  });
}
