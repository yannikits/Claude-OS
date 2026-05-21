/**
 * Agent-Namespace RPCs: list.
 * Split aus `sidecar/methods.ts` (M21).
 *
 * @module @sidecar/methods/agent
 */
import type { RpcDispatcher } from '../rpc.js';
import type { MethodsContext } from './_shared.js';

export function registerAgentMethods(dispatcher: RpcDispatcher, ctx: MethodsContext): void {
  dispatcher.register('agent.list', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { project?: string; limit?: number };
    const items = ctx.getAgentRunsRepo().list({
      ...(params.project === undefined ? {} : { project: params.project }),
      ...(params.limit === undefined ? {} : { limit: params.limit }),
    });
    return { count: items.length, items };
  });
}
