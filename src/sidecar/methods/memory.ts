/**
 * Memory-Namespace RPCs (Phase 3f): stats + rebuild.
 *
 * Exposed when the sidecar boots with a `MemoryIndexService` attached.
 * When the service is in disabled-mode (no vault, corrupt DB), the
 * RPCs return the service-stats with `enabled: false` so the GUI can
 * render a useful "memory index not available" hint.
 *
 * @module @sidecar/methods/memory
 */
import type { MemoryIndexService, ServiceStats } from '../memory-index-service.js';
import type { RpcDispatcher } from '../rpc.js';

export function registerMemoryMethods(
  dispatcher: RpcDispatcher,
  service: MemoryIndexService,
): void {
  dispatcher.register('memory.stats', (): ServiceStats => service.getStats());

  dispatcher.register('memory.rebuild', () => {
    return service.rebuild();
  });
}
