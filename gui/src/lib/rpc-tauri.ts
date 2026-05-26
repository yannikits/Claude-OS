/**
 * Tauri implementation of the `RpcTransport`. Delegates to `@tauri-apps/api`.
 *
 * @module @lib/rpc-tauri
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { RpcTransport, UnsubscribeFn } from './rpc-transport';

export function createTauriTransport(): RpcTransport {
  return {
    async call<T>(method: string, params: unknown = null): Promise<T> {
      return invoke<T>('rpc_call', { method, params });
    },
    async subscribe<T>(eventName: string, handler: (payload: T) => void): Promise<UnsubscribeFn> {
      return listen<T>(eventName, (e) => handler(e.payload));
    },
  };
}
