/**
 * Secrets-Namespace RPCs: list / delete.
 * Split aus `sidecar/methods.ts` (M21).
 *
 * @module @sidecar/methods/secrets
 */
import { createSecretStore, SecretsLockedError } from '../../domains/secrets/index.js';
import type { RpcDispatcher } from '../rpc.js';
import { type MethodsContext, requireString } from './_shared.js';

export function registerSecretsMethods(dispatcher: RpcDispatcher, ctx: MethodsContext): void {
  dispatcher.register('secrets.list', async () => {
    const store = createSecretStore({ env: ctx.env() });
    try {
      const entries = await store.list();
      // SecretMetadata is already values-free: { key, backend } only. Returning it
      // verbatim is safe per ADR-0004 §51 — never log or expose values.
      return {
        backend: store.backend,
        count: entries.length,
        entries,
        locked: false as const,
      };
    } catch (err) {
      if (err instanceof SecretsLockedError) {
        return {
          backend: store.backend,
          count: 0,
          entries: [],
          locked: true as const,
          lockedReason: err.message,
        };
      }
      throw err;
    }
  });

  dispatcher.register('secrets.delete', async (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { key?: string };
    const key = requireString(params.key, 'key', 'secrets.delete');
    const store = createSecretStore({ env: ctx.env() });
    const deleted = await store.delete(key);
    return { key, deleted, backend: store.backend };
  });
}
