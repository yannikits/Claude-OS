/**
 * Vault-Namespace RPCs: status.
 * Split aus `sidecar/methods.ts` (M21).
 *
 * @module @sidecar/methods/vault
 */
import { join } from 'node:path';
import { BusyFlag, loadVaultConfig } from '../../domains/vault-sync/index.js';
import { mtimeCached } from '../mtime-cache.js';
import type { RpcDispatcher } from '../rpc.js';
import type { MethodsContext } from './_shared.js';

export function registerVaultMethods(dispatcher: RpcDispatcher, ctx: MethodsContext): void {
  dispatcher.register('vault.status', () => {
    const root = ctx.rootPath();
    const machine = ctx.machinePaths();
    const vaultPath = join(root, 'vault');
    const busyFlagPath = join(machine.dataDir, 'vault-sync-state.json');
    const configPath = join(machine.dataDir, 'vault-config.json');
    // BusyFlag bleibt uncached — busy-state ist sub-second-volatile und
    // GUI-polling will den frischen Wert sehen (Dashboard zeigt sonst
    // einen stehengebliebenen "sync laeuft" auch nach release).
    const busy = new BusyFlag({ filePath: busyFlagPath }).read();
    const config = mtimeCached(configPath, () => loadVaultConfig(configPath), ctx.vaultConfigCache);
    return { vaultPath, busy, config };
  });
}
