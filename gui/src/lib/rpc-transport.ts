/**
 * Transport abstraction for the frontend RPC layer.
 *
 * Two implementations exist:
 *  - `rpc-tauri.ts`  → `invoke('rpc_call', ...)` + `listen(event)` via Tauri-API
 *  - `rpc-http.ts`   → `fetch('/api/rpc')` + EventSource('/api/events')
 *
 * `rpc.ts` picks one at module load via `isTauriRuntime()` and routes every
 * helper through it. The Tauri build and the headless server build are
 * therefore byte-identical at the React-component layer.
 *
 * Implements ADR-0032 phase Web-2.
 *
 * @module @lib/rpc-transport
 */

export type UnsubscribeFn = () => void | Promise<void>;

export interface RpcTransport {
  /** Invoke a sidecar/server RPC method and await the result. */
  call<T>(method: string, params?: unknown): Promise<T>;
  /**
   * Subscribe to a notification stream. The handler is invoked with the
   * raw payload object for every event matching `eventName`. The returned
   * function unsubscribes.
   */
  subscribe<T>(eventName: string, handler: (payload: T) => void): Promise<UnsubscribeFn>;
}

/**
 * Transports that need authentication (HTTP) implement this extension.
 * The Tauri transport does NOT — auth is handled by the OS-local Tauri
 * shell process and the user-session is the OS-login.
 */
export interface AuthCapableTransport extends RpcTransport {
  setAuth(token: string): void;
  clearAuth(): void;
  verifyAuth(token: string): Promise<boolean>;
  hasAuth(): boolean;
}

export function isAuthCapable(t: RpcTransport): t is AuthCapableTransport {
  const candidate = t as Partial<AuthCapableTransport>;
  return (
    typeof candidate.setAuth === 'function' &&
    typeof candidate.verifyAuth === 'function' &&
    typeof candidate.clearAuth === 'function'
  );
}

/**
 * Runtime detection: are we inside Tauri's webview?
 *
 * Tauri injects `window.__TAURI_INTERNALS__` (v2). When that is present we
 * use the Tauri transport; otherwise we are in a regular browser and use
 * the HTTP transport.
 */
export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window;
}
