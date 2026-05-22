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
    try {
      const deleted = await store.delete(key);
      return { key, deleted, backend: store.backend };
    } catch (err) {
      if (err instanceof SecretsLockedError) {
        // ADR-0004 §51: Backend-locked-Status surface'n als typed-Error,
        // ohne den master-key-Internals zu leaken.
        throw new Error('secrets-backend-locked');
      }
      throw err;
    }
  });

  /**
   * v1.x.+1 mutation. Wert geht durch IPC und liegt waehrend des Calls
   * im sidecar-RAM. NIEMALS den Value loggen — ADR-0004 §51. Der
   * `value` darf empty-string sein (User koennte ein Secret explizit
   * zu "" setzen wollen, statt es zu loeschen). Lockfile-Wrapping
   * im EncryptedFileStore haendelt cross-process-concurrency (M5).
   */
  dispatcher.register('secrets.set', async (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { key?: string; value?: string };
    const key = requireString(params.key, 'key', 'secrets.set');
    if (typeof params.value !== 'string') {
      throw new Error('secrets.set: params.value must be a string');
    }
    const store = createSecretStore({ env: ctx.env() });
    try {
      // Detect updated-vs-new via list() — keys-only, no value-leak.
      const existing = await store.list();
      const updated = existing.some((e) => e.key === key);
      await store.set(key, params.value);
      return { key, backend: store.backend, updated };
    } catch (err) {
      if (err instanceof SecretsLockedError) {
        throw new Error('secrets-backend-locked');
      }
      // Re-throw with opaque message — never include value in error.
      // The SecretsError-class itself only references key+backend.
      throw err;
    }
  });
}
