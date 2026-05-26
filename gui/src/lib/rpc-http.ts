/**
 * HTTP implementation of the `RpcTransport`. Talks to the headless
 * server (`src/server/`) via `fetch` for RPCs and `EventSource` for
 * notifications.
 *
 * @module @lib/rpc-http
 */
import type { AuthCapableTransport, UnsubscribeFn } from './rpc-transport';

export const AUTH_STORAGE_KEY = 'claude-os-token';

function readStoredToken(): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  return sessionStorage.getItem(AUTH_STORAGE_KEY);
}

function writeStoredToken(value: string | null): void {
  if (typeof sessionStorage === 'undefined') return;
  if (value === null) {
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
  } else {
    sessionStorage.setItem(AUTH_STORAGE_KEY, value);
  }
}

interface SseConnection {
  readonly source: EventSource;
  /** eventName → set of handlers (one DOM-listener per name handles all). */
  readonly handlers: Map<string, Set<(payload: unknown) => void>>;
  /** Event names with a DOM-listener attached. */
  readonly attached: Set<string>;
}

function createSseConnection(token: string): SseConnection {
  const url = `/api/events?token=${encodeURIComponent(token)}`;
  const source = new EventSource(url);
  return { source, handlers: new Map(), attached: new Set() };
}

/**
 * HTTP transport factory. Token is read from sessionStorage on construction
 * if not passed explicitly; subsequent `setAuth` persists the token there.
 *
 * The SSE-connection is lazy: opened on the first `subscribe()` call. If
 * the connection drops, EventSource auto-reconnects (browser-native).
 */
export function createHttpTransport(initialToken?: string): AuthCapableTransport {
  let token: string | null = initialToken ?? readStoredToken();
  let sse: SseConnection | null = null;

  function closeSse(): void {
    if (sse === null) return;
    try {
      sse.source.close();
    } catch {
      /* nothing meaningful to do — connection might already be gone */
    }
    sse = null;
  }

  async function call<T>(method: string, params: unknown = null): Promise<T> {
    if (token === null) throw new Error('rpc-http: no auth token set');
    const res = await fetch('/api/rpc', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ method, params }),
    });
    if (res.status === 401) {
      // Server says our token is invalid — clear locally so the next
      // navigation lands on the login screen. Caller still sees the throw.
      writeStoredToken(null);
      token = null;
      closeSse();
      throw new Error('rpc-http: 401 unauthorized — token cleared');
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(`rpc-http: non-JSON response (status ${res.status})`);
    }
    const envelope = body as
      | { ok: true; result: T }
      | { ok: false; error: { code: string; message: string } };
    if (!envelope.ok) {
      throw new Error(`rpc-http: ${envelope.error.code}: ${envelope.error.message}`);
    }
    return envelope.result;
  }

  async function subscribe<T>(
    eventName: string,
    handler: (payload: T) => void,
  ): Promise<UnsubscribeFn> {
    if (token === null) throw new Error('rpc-http: no auth token for SSE');
    if (sse === null) sse = createSseConnection(token);

    let handlerSet = sse.handlers.get(eventName);
    if (handlerSet === undefined) {
      handlerSet = new Set();
      sse.handlers.set(eventName, handlerSet);
    }

    if (!sse.attached.has(eventName)) {
      sse.attached.add(eventName);
      sse.source.addEventListener(eventName, (e: Event) => {
        const data = (e as MessageEvent).data;
        let parsed: unknown = null;
        try {
          parsed = data === '' || data === undefined ? null : JSON.parse(data as string);
        } catch {
          parsed = data;
        }
        const currentSse = sse;
        if (currentSse === null) return;
        const set = currentSse.handlers.get(eventName);
        if (set === undefined) return;
        for (const h of set) {
          try {
            h(parsed);
          } catch (err) {
            console.error(`rpc-http: subscriber for ${eventName} threw`, err);
          }
        }
      });
    }

    const wrappedHandler = handler as (payload: unknown) => void;
    handlerSet.add(wrappedHandler);

    return (): void => {
      const currentSse = sse;
      if (currentSse === null) return;
      const set = currentSse.handlers.get(eventName);
      if (set === undefined) return;
      set.delete(wrappedHandler);
      // No automatic close — EventSource lifetime is per-page, browser
      // reconnects on disconnect, server cleans up subscribers on close.
    };
  }

  function setAuth(t: string): void {
    if (t.length === 0) throw new Error('setAuth: token must be non-empty');
    token = t;
    writeStoredToken(t);
    // If a stale SSE-connection is open with the previous token, close it
    // so the next subscribe-call reopens with the new credentials.
    closeSse();
  }

  function clearAuth(): void {
    token = null;
    writeStoredToken(null);
    closeSse();
  }

  async function verifyAuth(candidateToken: string): Promise<boolean> {
    if (candidateToken.length === 0) return false;
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${candidateToken}`,
        },
        body: JSON.stringify({}),
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  function hasAuth(): boolean {
    return token !== null && token.length > 0;
  }

  return { call, subscribe, setAuth, clearAuth, verifyAuth, hasAuth };
}
