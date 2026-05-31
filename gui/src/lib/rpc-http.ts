/**
 * HTTP implementation of the `RpcTransport`. Talks to the headless
 * server (`src/server/`) via `fetch` for RPCs and `EventSource` for
 * notifications.
 *
 * Two auth modes coexist (Web-7-tail):
 *  - **Bearer-Token (Stage 1, ADR-0033)**: sessionStorage-persisted
 *    token, attached as `Authorization: Bearer …` header on every
 *    fetch. `?token=…` query-string for EventSource + WebSocket
 *    (those transports can't set custom headers).
 *  - **Cookie (Stage 2, ADR-0036)**: `claude_os_session` HTTP-only
 *    cookie auto-attached by the browser for same-origin requests.
 *    No bearer header. CSRF double-submit: `x-csrf-token` header is
 *    echoed from the readable `claude_os_csrf` cookie on
 *    state-changing methods. SSE + WS need no `?token=` because
 *    browsers DO attach cookies to those — only headers are blocked.
 *
 * Mode is detected at call-time: cookie wins if `isCookieAuthed()`
 * (sessionStorage marker set by `auth-api.ts:loginWithCredentials`),
 * otherwise falls back to Bearer.
 *
 * @module @lib/rpc-http
 */
import { CSRF_COOKIE_NAME, isCookieAuthed, readCookie } from './auth-api';
import type { AuthCapableTransport, UnsubscribeFn } from './rpc-transport';

export const AUTH_STORAGE_KEY = 'claude-os-token';

const UNSAFE_METHODS = new Set<string>(['POST', 'PUT', 'PATCH', 'DELETE']);

interface PtySpawnedFrame {
  type: 'spawned';
  sessionId: string;
}
interface PtyAttachedFrame {
  type: 'attached';
  sessionId: string;
}
interface PtyDataFrame {
  type: 'data';
  data: string;
}
interface PtyExitFrame {
  type: 'exit';
  exitCode: number | null;
  signal: string | null;
}
interface PtyErrorFrame {
  type: 'error';
  code?: string;
  message: string;
}
type PtyServerFrame =
  | PtySpawnedFrame
  | PtyAttachedFrame
  | PtyDataFrame
  | PtyExitFrame
  | PtyErrorFrame;

interface PtyEventPayload {
  sessionId: string;
  data?: string;
  exitCode?: number | null;
  signal?: string | null;
}

/**
 * Single shared WebSocket per HTTP-transport instance. One claude-os tab
 * runs at most one PTY session at a time (xterm.js is a singleton on the
 * ChatPage); a multi-session future would lift this to a Map keyed by
 * client-allocated id.
 */
interface PtyChannel {
  ws: WebSocket;
  sessionId: string | null;
  /** Resolves when the server confirms spawn OR attach. */
  pendingBind: { resolve: (id: string) => void; reject: (e: Error) => void } | null;
  dataHandlers: Set<(payload: PtyEventPayload) => void>;
  exitHandlers: Set<(payload: PtyEventPayload) => void>;
}

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

function createSseConnection(token: string | null): SseConnection {
  // Cookie-mode: browser auto-attaches the session cookie to the
  // EventSource request, so we omit the query-string entirely.
  // Token-mode: EventSource can't set headers, so the bearer goes
  // in the URL (logged in proxy logs — token rotation mitigates).
  const url = token === null ? '/api/events' : `/api/events?token=${encodeURIComponent(token)}`;
  const source = new EventSource(url, { withCredentials: true });
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
  let pty: PtyChannel | null = null;

  function isCookieMode(): boolean {
    return isCookieAuthed();
  }

  /**
   * Resolve the set of auth-related fetch headers + credentials flag
   * for an outbound RPC. Cookie-mode wins when active — bearer is
   * skipped entirely, CSRF header attached on state-changing methods.
   */
  function authHeaders(method: string): {
    headers: Record<string, string>;
    credentials: RequestCredentials;
  } {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (isCookieMode()) {
      if (UNSAFE_METHODS.has(method.toUpperCase())) {
        const csrf = readCookie(CSRF_COOKIE_NAME);
        if (csrf !== null) headers['x-csrf-token'] = csrf;
      }
    } else if (token !== null) {
      headers.Authorization = `Bearer ${token}`;
    }
    return { headers, credentials: 'same-origin' };
  }

  /** Single source of truth: are we authenticated by any mode? */
  function hasAnyAuth(): boolean {
    return (token !== null && token.length > 0) || isCookieMode();
  }

  function closeSse(): void {
    if (sse === null) return;
    try {
      sse.source.close();
    } catch {
      /* nothing meaningful to do — connection might already be gone */
    }
    sse = null;
  }

  function closePty(): void {
    if (pty === null) return;
    try {
      pty.ws.close();
    } catch {
      /* nothing more to do */
    }
    if (pty.pendingBind !== null) {
      pty.pendingBind.reject(new Error('pty: ws closed before spawn confirmed'));
    }
    pty = null;
  }

  /** Open the PTY-WebSocket lazily (first pty.spawn call). */
  function ensurePtyChannel(): PtyChannel {
    if (pty !== null) return pty;
    if (!hasAnyAuth()) throw new Error('rpc-http: no auth (cookie or bearer) for PTY');
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Cookie-mode: browser auto-attaches the session cookie to the WS
    // upgrade request. Token-mode: bearer in the URL (WebSocket cannot
    // set headers, same trade-off as SSE).
    const baseUrl = `${proto}//${window.location.host}/api/pty/ws`;
    const url = isCookieMode() ? baseUrl : `${baseUrl}?token=${encodeURIComponent(token ?? '')}`;
    const ws = new WebSocket(url);
    const channel: PtyChannel = {
      ws,
      sessionId: null,
      pendingBind: null,
      dataHandlers: new Set(),
      exitHandlers: new Set(),
    };
    ws.addEventListener('message', (event) => {
      let frame: PtyServerFrame;
      try {
        frame = JSON.parse(event.data as string) as PtyServerFrame;
      } catch {
        return;
      }
      if (frame.type === 'spawned' || frame.type === 'attached') {
        channel.sessionId = frame.sessionId;
        if (channel.pendingBind !== null) {
          const pending = channel.pendingBind;
          channel.pendingBind = null;
          pending.resolve(frame.sessionId);
        }
      } else if (frame.type === 'data') {
        if (channel.sessionId === null) return;
        const payload: PtyEventPayload = { sessionId: channel.sessionId, data: frame.data };
        for (const h of channel.dataHandlers) {
          try {
            h(payload);
          } catch (err) {
            console.error('pty-ws: data handler threw', err);
          }
        }
      } else if (frame.type === 'exit') {
        const payload: PtyEventPayload = {
          sessionId: channel.sessionId ?? '',
          exitCode: frame.exitCode,
          signal: frame.signal,
        };
        for (const h of channel.exitHandlers) {
          try {
            h(payload);
          } catch (err) {
            console.error('pty-ws: exit handler threw', err);
          }
        }
      } else if (frame.type === 'error') {
        if (channel.pendingBind !== null) {
          const pending = channel.pendingBind;
          channel.pendingBind = null;
          pending.reject(new Error(`pty-ws: ${frame.code ?? 'error'}: ${frame.message}`));
        } else {
          console.error('pty-ws server error:', frame.code, frame.message);
        }
      }
    });
    ws.addEventListener('close', () => {
      if (pty === channel) pty = null;
      if (channel.pendingBind !== null) {
        channel.pendingBind.reject(new Error('pty: ws closed unexpectedly'));
      }
    });
    pty = channel;
    return channel;
  }

  function sendPtyFrame(frame: Record<string, unknown>): Promise<void> {
    const channel = pty;
    if (channel === null) {
      return Promise.reject(new Error('pty-ws: not connected'));
    }
    const payload = JSON.stringify(frame);
    if (channel.ws.readyState === WebSocket.OPEN) {
      channel.ws.send(payload);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onOpen = (): void => {
        channel.ws.removeEventListener('open', onOpen);
        channel.ws.removeEventListener('error', onError);
        channel.ws.send(payload);
        resolve();
      };
      const onError = (): void => {
        channel.ws.removeEventListener('open', onOpen);
        channel.ws.removeEventListener('error', onError);
        reject(new Error('pty-ws: ws errored before frame could be sent'));
      };
      channel.ws.addEventListener('open', onOpen);
      channel.ws.addEventListener('error', onError);
    });
  }

  async function call<T>(method: string, params: unknown = null): Promise<T> {
    if (!hasAnyAuth()) throw new Error('rpc-http: not authenticated (no cookie + no bearer)');

    // PTY methods route through the dedicated WebSocket (Phase Web-3).
    // The shape matches the existing sidecar pty.* RPC return types so
    // the helper functions in rpc.ts work unchanged.
    if (method === 'pty.spawn') {
      const channel = ensurePtyChannel();
      if (channel.pendingBind !== null || channel.sessionId !== null) {
        throw new Error(
          'rpc-http: a pty session is already active on this transport — kill it first',
        );
      }
      const p = (params ?? {}) as {
        args?: readonly string[];
        cols?: number;
        rows?: number;
        mode?: 'chat' | 'code';
      };
      const spawnPromise = new Promise<string>((resolve, reject) => {
        channel.pendingBind = { resolve, reject };
      });
      await sendPtyFrame({
        type: 'spawn',
        args: Array.isArray(p.args) ? p.args : [],
        ...(typeof p.cols === 'number' ? { cols: p.cols } : {}),
        ...(typeof p.rows === 'number' ? { rows: p.rows } : {}),
        ...(p.mode === 'code' || p.mode === 'chat' ? { mode: p.mode } : {}),
      });
      const sessionId = await spawnPromise;
      return { sessionId } as T;
    }

    // auth.login spawns its PTY session server-side (not via WS), then
    // returns {sessionId}. To receive the pty.data/exit stream on our
    // WS, attach the WS to that session id right after the RPC succeeds.
    if (method === 'auth.login') {
      const { headers, credentials } = authHeaders('POST');
      const res = await fetch('/api/rpc', {
        method: 'POST',
        headers,
        credentials,
        body: JSON.stringify({ method, params }),
      });
      if (res.status === 401) {
        writeStoredToken(null);
        token = null;
        closeSse();
        closePty();
        throw new Error('rpc-http: 401 unauthorized — token cleared');
      }
      const body = (await res.json()) as
        | { ok: true; result: { sessionId: string } }
        | { ok: false; error: { code: string; message: string } };
      if (!body.ok) {
        throw new Error(`rpc-http: ${body.error.code}: ${body.error.message}`);
      }
      const sessionId = body.result.sessionId;

      // Hook the WS to that session so pty.data + pty.exit can be
      // forwarded to the AuthLoginModal's xterm.
      const channel = ensurePtyChannel();
      if (channel.sessionId === null) {
        const attachPromise = new Promise<string>((resolve, reject) => {
          channel.pendingBind = { resolve, reject };
        });
        await sendPtyFrame({ type: 'attach', sessionId });
        await attachPromise;
      }
      return { sessionId } as T;
    }

    if (method === 'pty.write') {
      const p = (params ?? {}) as { sessionId?: string; input?: string };
      if (pty === null) throw new Error('rpc-http: no pty session — call pty.spawn first');
      await sendPtyFrame({ type: 'write', data: p.input ?? '' });
      return { ok: true } as T;
    }

    if (method === 'pty.resize') {
      const p = (params ?? {}) as { sessionId?: string; cols?: number; rows?: number };
      if (pty === null) throw new Error('rpc-http: no pty session — call pty.spawn first');
      await sendPtyFrame({ type: 'resize', cols: p.cols, rows: p.rows });
      return { ok: true } as T;
    }

    if (method === 'pty.kill') {
      if (pty === null) return { ok: true } as T;
      await sendPtyFrame({ type: 'kill' });
      closePty();
      return { ok: true } as T;
    }

    const { headers, credentials } = authHeaders('POST');
    const res = await fetch('/api/rpc', {
      method: 'POST',
      headers,
      credentials,
      body: JSON.stringify({ method, params }),
    });
    if (res.status === 401) {
      // Server says our auth is invalid — clear locally so the next
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
    if (!hasAnyAuth()) throw new Error('rpc-http: not authenticated for SSE');

    // pty.* events come over the dedicated WebSocket (Phase Web-3), NOT
    // the shared SSE stream. xterm.js needs sub-100ms round-trips that
    // SSE-via-cloudflare-proxy cannot reliably deliver.
    if (eventName === 'pty.data' || eventName === 'pty.exit') {
      const channel = ensurePtyChannel();
      const set = eventName === 'pty.data' ? channel.dataHandlers : channel.exitHandlers;
      const wrapped = handler as unknown as (payload: PtyEventPayload) => void;
      set.add(wrapped);
      return (): void => {
        set.delete(wrapped);
      };
    }

    // Cookie-mode: no token in URL — browser auto-attaches the session
    // cookie. Token-mode: bearer in the URL (EventSource can't set headers).
    if (sse === null) sse = createSseConnection(isCookieMode() ? null : token);

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
    // If a stale SSE/PTY-connection is open with the previous token, close
    // them so the next subscribe/spawn reopens with the new credentials.
    closeSse();
    closePty();
  }

  function clearAuth(): void {
    token = null;
    writeStoredToken(null);
    closeSse();
    closePty();
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
    return hasAnyAuth();
  }

  return { call, subscribe, setAuth, clearAuth, verifyAuth, hasAuth };
}
