/**
 * WebSocket bridge for interactive PTY sessions.
 *
 * Each WS connection manages exactly one PTY session for its lifetime.
 * Auth happens via:
 *   1. `claude_os_session` cookie (Stage 2 cookie-mode, ADR-0036) — the
 *      browser auto-attaches the cookie to the WS upgrade GET, which we
 *      validate via `sessionRepo.resolve()` and `userRepo.findById()`.
 *   2. Fallback: `?token=...` query string (Stage 1 token-mode).
 *
 * Browsers cannot attach `Authorization` headers to `new WebSocket(url)`,
 * so we don't accept bearer-via-header. The `/api/*` preHandler hook
 * does NOT run on WS upgrades — auth is re-checked inline.
 *
 * Wire-protocol (JSON-encoded text frames):
 *  Client → Server:
 *    {type:'spawn',  args?: string[], cols?: number, rows?: number}
 *    {type:'attach', sessionId: string}  — bind WS to a session another RPC
 *                                          spawned server-side (e.g. auth.login)
 *    {type:'write',  data: string}
 *    {type:'resize', cols: number, rows: number}
 *    {type:'kill'}
 *  Server → Client:
 *    {type:'spawned',  sessionId: string}
 *    {type:'attached', sessionId: string}
 *    {type:'data',     data: string}
 *    {type:'exit',     exitCode: number|null, signal: string|null}
 *    {type:'error',    message: string, code?: 'pty-disabled'|'spawn-failed'|...}
 *
 * Implements ADR-0032 phase Web-3.
 *
 * @module @server/ws-pty
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SessionRepository } from '../domains/sessions/index.js';
import type { User, UserRepository, UserRole } from '../domains/users/index.js';
import type { PtyChatSessions } from '../sidecar/pty-chat-sessions.js';
import { verifyBearerToken } from './auth.js';
import { SESSION_COOKIE_NAME } from './cookies.js';
import type { NotificationBus } from './events-sse.js';
import { effectiveRole, roleAtLeast } from './rbac.js';

/**
 * Minimum effective role allowed to spawn a tool-enabled ("code") PTY
 * session. "chat" spawns (tools disabled via `--tools ""`) are open to
 * every authenticated user. MC-C: maps to "wer hat Claude Code im Plan".
 * Single constant so the later Team-Plan per-seat switch is one edit.
 */
const CODE_MIN_ROLE = 'operator' as const;

/**
 * Server-owned args for the two spawn modes. The server NEVER trusts
 * client-supplied args for chat mode — it forces `--tools ""` so a
 * crafted WS frame cannot re-enable tools for a viewer. Code mode passes
 * client args through (operator+ is trusted).
 */
const CHAT_MODE_ARGS: readonly string[] = ['--tools', ''];

export type SpawnMode = 'chat' | 'code';

export type SpawnDecision =
  | { readonly ok: true; readonly args: readonly string[] }
  | { readonly ok: false; readonly code: 'forbidden'; readonly message: string };

/**
 * Pure MC-C spawn gate. Decides whether a `pty.spawn` frame is allowed and
 * what args the PTY should actually receive:
 *  - chat: always allowed, args forced to `--tools ""` (client args ignored
 *    so a crafted frame can't re-enable tools for a viewer).
 *  - code: requires effectiveRole >= CODE_MIN_ROLE when a cookie-user is
 *    present. A bearer-token session (`authUser === null`) is the single
 *    trusted owner (Stage 1) and passes. Client args flow through.
 */
export function resolveSpawnDecision(
  mode: SpawnMode,
  authUser: { readonly email: string; readonly role: UserRole } | null,
  adminEmails: ReadonlySet<string>,
  clientArgs: readonly string[],
): SpawnDecision {
  if (mode === 'chat') return { ok: true, args: [...CHAT_MODE_ARGS] };
  if (authUser !== null) {
    const role = effectiveRole({ email: authUser.email, role: authUser.role }, adminEmails);
    if (!roleAtLeast(role, CODE_MIN_ROLE)) {
      return {
        ok: false,
        code: 'forbidden',
        message: `Claude Code requires role '${CODE_MIN_ROLE}' or higher (you have '${role}')`,
      };
    }
  }
  return { ok: true, args: [...clientArgs] };
}

interface PtyDataEvent {
  sessionId: string;
  data: string;
}

interface PtyExitEvent {
  sessionId: string;
  exitCode: number | null;
  signal: string | null;
}

interface ClientFrame {
  type?: string;
  args?: unknown;
  cols?: unknown;
  rows?: unknown;
  data?: unknown;
  sessionId?: unknown;
  /** 'chat' (tools disabled, any authed user) | 'code' (full tools, operator+). */
  mode?: unknown;
}

interface RegisterPtyWsOptions {
  readonly pty: PtyChatSessions | null;
  readonly bus: NotificationBus;
  readonly expectedToken: string;
  /**
   * When multi-user Stage 2 is active, the session+user repos are passed
   * so the cookie-attached `claude_os_session` can authenticate the WS.
   * Unset → cookie-mode disabled, only bearer-token auth works.
   */
  readonly sessionRepo?: SessionRepository;
  readonly userRepo?: UserRepository;
  /**
   * Lowercased admin-email allowlist (mirror of `MultiUserConfig.adminEmails`).
   * Used with `effectiveRole()` so an allowlisted email is treated as admin
   * even when its stored DB role is lower. Empty/undefined → DB role only.
   */
  readonly adminEmails?: readonly string[];
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0;
}

function resolveQueryToken(req: FastifyRequest): string | null {
  const query = req.query as { token?: unknown } | undefined;
  if (query !== undefined && typeof query.token === 'string' && query.token.length > 0) {
    return query.token;
  }
  return null;
}

/**
 * Try cookie-mode auth: read `claude_os_session` from the WS upgrade
 * request, resolve it against the session repo, and verify the user
 * still exists and is not disabled. Returns the active `User` (so the
 * caller can role-gate spawn frames) or `null` when not a valid session.
 */
function checkSessionCookie(
  req: FastifyRequest,
  sessionRepo: SessionRepository,
  userRepo: UserRepository,
): User | null {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> })
    .cookies;
  const sessionId = cookies?.[SESSION_COOKIE_NAME];
  if (sessionId === undefined || sessionId.length === 0) return null;
  const session = sessionRepo.resolve(sessionId);
  if (session === null) return null;
  const user = userRepo.findById(session.userId);
  return user !== null && !user.disabled ? user : null;
}

export async function registerPtyWebSocket(
  app: FastifyInstance,
  opts: RegisterPtyWsOptions,
): Promise<void> {
  const adminAllowlist = new Set((opts.adminEmails ?? []).map((e) => e.toLowerCase()));

  app.get('/api/pty/ws', { websocket: true }, (socket, req) => {
    // Auth — browsers can't attach Authorization to `new WebSocket(url)`,
    // so we try cookie-mode first (browser auto-attaches the session
    // cookie to the upgrade GET) and fall back to `?token=…` query
    // string for Stage-1 token-mode. The /api/* preHandler hook does
    // NOT run on websocket upgrades, so we re-check here.
    //
    // `authUser` is the cookie-resolved user (carries `role` for the
    // code-spawn gate). It stays null in bearer-token mode — that token
    // is the single-owner credential (Stage 1), so it is allowed to
    // spawn code without a role lookup.
    let authUser: User | null = null;
    let authed = false;
    if (opts.sessionRepo !== undefined && opts.userRepo !== undefined) {
      authUser = checkSessionCookie(req, opts.sessionRepo, opts.userRepo);
      authed = authUser !== null;
    }
    if (!authed) {
      const presented = resolveQueryToken(req);
      authed = presented !== null && verifyBearerToken(presented, opts.expectedToken);
    }
    if (!authed) {
      try {
        socket.send(
          JSON.stringify({
            type: 'error',
            code: 'unauthorized',
            message: 'invalid or missing token',
          }),
        );
      } catch {
        /* socket may already be torn down */
      }
      try {
        socket.close(1008, 'unauthorized');
      } catch {
        /* nothing more to do */
      }
      return;
    }

    if (opts.pty === null) {
      try {
        socket.send(
          JSON.stringify({
            type: 'error',
            code: 'pty-disabled',
            message: 'node-pty failed to load on this server',
          }),
        );
        socket.close(1011, 'pty-disabled');
      } catch {
        /* socket already closed */
      }
      return;
    }
    const pty = opts.pty;

    let sessionId: string | null = null;
    let cleaned = false;

    const send = (payload: Record<string, unknown>): void => {
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        // Either the socket buffer is full or the connection died — the
        // close handler will run shortly and tear down the pty session.
      }
    };

    // NotificationBus is a single broadcast channel — subscribe once and
    // filter by method-name + our session-id.
    const unsubscribeBus = opts.bus.subscribe((method, params) => {
      if (sessionId === null) return;
      if (method === 'pty.data') {
        const evt = params as PtyDataEvent;
        if (evt.sessionId !== sessionId) return;
        send({ type: 'data', data: evt.data });
      } else if (method === 'pty.exit') {
        const evt = params as PtyExitEvent;
        if (evt.sessionId !== sessionId) return;
        send({ type: 'exit', exitCode: evt.exitCode, signal: evt.signal });
        // The PTY is gone — close the WS politely so the client can react.
        try {
          socket.close(1000, 'pty-exited');
        } catch {
          /* socket already closed */
        }
      }
    });

    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      unsubscribeBus();
      if (sessionId !== null) {
        try {
          pty.kill(sessionId);
        } catch {
          // session may already be dead; we still released our subscribers
          // above so a future exit-notification cannot leak to a closed WS.
        }
      }
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);

    socket.on('message', (raw: Buffer) => {
      let frame: ClientFrame;
      try {
        const text = raw.toString();
        frame = JSON.parse(text) as ClientFrame;
      } catch {
        send({ type: 'error', code: 'invalid-json', message: 'malformed JSON frame' });
        return;
      }

      const type = typeof frame.type === 'string' ? frame.type : '';

      try {
        if (type === 'spawn') {
          if (sessionId !== null) {
            send({
              type: 'error',
              code: 'already-spawned',
              message: 'this WS already owns a pty session',
            });
            return;
          }
          const clientArgs = Array.isArray(frame.args)
            ? (frame.args as readonly unknown[]).filter((a): a is string => typeof a === 'string')
            : [];

          // MC-C mode gate — see resolveSpawnDecision. Default 'chat' (most
          // restrictive) when mode is absent/unknown.
          const mode: SpawnMode = frame.mode === 'code' ? 'code' : 'chat';
          const decision = resolveSpawnDecision(
            mode,
            authUser === null ? null : { email: authUser.email, role: authUser.role },
            adminAllowlist,
            clientArgs,
          );
          if (!decision.ok) {
            send({ type: 'error', code: decision.code, message: decision.message });
            return;
          }
          const args = decision.args;

          const spawnOpts: { cols?: number; rows?: number } = {};
          if (frame.cols !== undefined) {
            if (!isPositiveInt(frame.cols)) {
              send({
                type: 'error',
                code: 'invalid-params',
                message: 'cols must be a positive integer',
              });
              return;
            }
            spawnOpts.cols = frame.cols;
          }
          if (frame.rows !== undefined) {
            if (!isPositiveInt(frame.rows)) {
              send({
                type: 'error',
                code: 'invalid-params',
                message: 'rows must be a positive integer',
              });
              return;
            }
            spawnOpts.rows = frame.rows;
          }
          const result = pty.spawn(args, spawnOpts);
          sessionId = result.sessionId;
          send({ type: 'spawned', sessionId: result.sessionId });
          return;
        }

        if (type === 'attach') {
          if (sessionId !== null) {
            send({
              type: 'error',
              code: 'already-bound',
              message: 'this WS is already bound to a session',
            });
            return;
          }
          if (typeof frame.sessionId !== 'string' || frame.sessionId.length === 0) {
            send({
              type: 'error',
              code: 'invalid-params',
              message: 'attach: sessionId must be a non-empty string',
            });
            return;
          }
          // No verification that the session actually exists here — if it
          // doesn't, the bus filter just never matches and the client sees
          // silence. PtyChatSessions itself enforces the ring-guard so
          // bogus sessionIds cannot DoS us.
          sessionId = frame.sessionId;
          send({ type: 'attached', sessionId });
          return;
        }

        if (sessionId === null) {
          send({
            type: 'error',
            code: 'not-spawned',
            message: 'send {type:"spawn"} or {type:"attach"} first',
          });
          return;
        }

        if (type === 'write') {
          if (typeof frame.data !== 'string') {
            send({
              type: 'error',
              code: 'invalid-params',
              message: 'data must be a string',
            });
            return;
          }
          pty.write(sessionId, frame.data);
          return;
        }

        if (type === 'resize') {
          if (!isPositiveInt(frame.cols) || !isPositiveInt(frame.rows)) {
            send({
              type: 'error',
              code: 'invalid-params',
              message: 'cols and rows must be positive integers',
            });
            return;
          }
          pty.resize(sessionId, frame.cols, frame.rows);
          return;
        }

        if (type === 'kill') {
          pty.kill(sessionId);
          return;
        }

        send({
          type: 'error',
          code: 'unknown-type',
          message: `unknown frame type: ${type}`,
        });
      } catch (err) {
        send({
          type: 'error',
          code: 'pty-error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  });
}
