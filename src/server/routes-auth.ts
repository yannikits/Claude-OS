/**
 * Authentication routes (Phase Web-7-2, ADR-0036 draft).
 *
 *   POST /api/auth/login    email + password → Set-Cookie session + csrf
 *   POST /api/auth/logout   revoke session + clear cookies
 *   POST /api/auth/refresh  slide session TTL (no bearer→cookie exchange in v1)
 *   GET  /api/auth/me       current user or null
 *
 * All four routes return JSON. Login and logout emit audit-log events
 * (`auth.login.success`, `auth.login.failed`, `auth.logout`) with
 * hashed email + IP — never the plaintext (per SECURITY.md §4
 * redaction rule).
 *
 * Rate-limit: `LoginRateLimiter` debits a token per FAILED login per
 * IP. Successful login clears the bucket.
 *
 * The login route is **exempt from the global auth hook**
 * (`PUBLIC_PATHS` in `cookie-auth.ts`). Logout/refresh/me run under
 * the cookie-or-bearer hook so the request is already authenticated.
 *
 * @module @server/routes-auth
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AuditLogger } from '../core/audit/index.js';
import type { SessionRepository } from '../domains/sessions/index.js';
import { userToTenantId } from '../domains/tenant/index.js';
import type { UserRepository } from '../domains/users/index.js';
import {
  buildClearCookie,
  buildCsrfCookie,
  buildSessionCookie,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from './cookies.js';
import { newCsrfToken } from './csrf.js';
import type { LoginRateLimiter } from './rate-limit.js';

export interface AuthRoutesDeps {
  readonly userRepo: UserRepository;
  readonly sessionRepo: SessionRepository;
  readonly rateLimiter: LoginRateLimiter;
  readonly audit?: AuditLogger;
  /** When false, sets the `Secure` flag on cookies. */
  readonly insecureCookies: boolean;
  /** Session lifetime in seconds for `Max-Age=`. */
  readonly sessionMaxAgeSec: number;
}

interface LoginBody {
  email?: unknown;
  password?: unknown;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): void {
  app.post('/api/auth/login', async (req, reply) => {
    const ip = clientIp(req);
    const body = (req.body ?? {}) as LoginBody;
    const email = typeof body.email === 'string' ? body.email : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (email.length === 0 || password.length === 0) {
      reply
        .code(400)
        .send({ error: { code: 'invalid-request', message: 'email and password required' } });
      return;
    }

    const rl = deps.rateLimiter.check(ip);
    if (!rl.allowed) {
      reply.header('retry-after', rl.retryAfterSec.toString());
      deps.audit?.append({
        kind: 'auth.login.failed',
        action: 'login',
        workspace: 'system',
        outcome: 'denied',
        details: {
          reason: 'rate-limited',
          emailHash: hashedEmail(email),
          ipHash: hashedIp(ip),
          retryAfterSec: rl.retryAfterSec,
        },
      });
      reply.code(429).send({
        error: {
          code: 'rate-limited',
          message: `too many login attempts; retry after ${rl.retryAfterSec}s`,
        },
      });
      return;
    }

    const user = await deps.userRepo.verifyPassword(email, password);
    if (user === null) {
      deps.rateLimiter.recordFailed(ip);
      deps.audit?.append({
        kind: 'auth.login.failed',
        action: 'login',
        workspace: 'system',
        outcome: 'denied',
        details: {
          reason: 'invalid-credentials',
          emailHash: hashedEmail(email),
          ipHash: hashedIp(ip),
          userAgent: ua(req),
        },
      });
      reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'invalid email or password' } });
      return;
    }

    deps.rateLimiter.recordSuccess(ip);
    deps.userRepo.recordLogin(user.id);

    const session = deps.sessionRepo.issue({
      userId: user.id,
      userAgent: ua(req),
      ip,
    });
    const csrf = newCsrfToken();
    const sessionCookie = buildSessionCookie({
      value: session.id,
      maxAgeSec: deps.sessionMaxAgeSec,
      secure: !deps.insecureCookies,
    });
    const csrfCookie = buildCsrfCookie({
      value: csrf,
      maxAgeSec: deps.sessionMaxAgeSec,
      secure: !deps.insecureCookies,
    });
    reply.header('set-cookie', [sessionCookie, csrfCookie]);

    deps.audit?.append({
      kind: 'auth.login.success',
      action: 'login',
      workspace: 'system',
      tenant: userToTenantId(user),
      outcome: 'ok',
      details: {
        userId: user.id,
        emailHash: hashedEmail(email),
        ipHash: hashedIp(ip),
        userAgent: ua(req),
      },
    });

    reply.send({
      user: {
        id: user.id,
        email: user.email,
        tenantId: userToTenantId(user),
      },
      csrfToken: csrf,
      expiresAt: session.expiresAt,
    });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const sessionId = req.sessionId;
    const userId = req.user?.id ?? null;
    if (sessionId !== undefined) {
      deps.sessionRepo.revoke(sessionId);
    }
    reply.header('set-cookie', [
      buildClearCookie(SESSION_COOKIE_NAME, !deps.insecureCookies),
      buildClearCookie(CSRF_COOKIE_NAME, !deps.insecureCookies),
    ]);
    if (userId !== null) {
      deps.audit?.append({
        kind: 'auth.logout',
        action: 'logout',
        workspace: 'system',
        outcome: 'ok',
        details: { userId, ipHash: hashedIp(clientIp(req)) },
      });
    }
    reply.send({ ok: true });
  });

  /**
   * `refresh` slides the active session's TTL. Returns the new expiry.
   * v1 does NOT exchange a bearer-token for a cookie — bearer tokens
   * are not bound to a user (ADR-0033 §Stage 1), and we don't want
   * to fabricate a session without a user-of-record.
   */
  app.post('/api/auth/refresh', async (req, reply) => {
    if (req.user === undefined || req.sessionId === undefined) {
      reply.code(401).send({
        error: { code: 'unauthorized', message: 'refresh requires an active session-cookie' },
      });
      return;
    }
    // resolve() already slid the TTL during the global hook — peek to read.
    const session = deps.sessionRepo.peek(req.sessionId);
    if (session === null) {
      reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'session expired during refresh' } });
      return;
    }
    // Re-issue the cookie with the new Max-Age so the browser updates expiry.
    reply.header(
      'set-cookie',
      buildSessionCookie({
        value: session.id,
        maxAgeSec: deps.sessionMaxAgeSec,
        secure: !deps.insecureCookies,
      }),
    );
    reply.send({ expiresAt: session.expiresAt });
  });

  app.get('/api/auth/me', async (req, reply) => {
    if (req.user === undefined) {
      // Cookie-less request authenticated via bearer — no user-of-record.
      reply.send({ user: null });
      return;
    }
    reply.send({
      user: {
        id: req.user.id,
        email: req.user.email,
        tenantId: userToTenantId(req.user),
      },
    });
  });
}

function clientIp(req: { ip?: string }): string {
  return req.ip ?? '0.0.0.0';
}

function ua(req: { headers: { 'user-agent'?: string | string[] } }): string | null {
  const v = req.headers['user-agent'];
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === 'string' && v.length > 0 ? v.slice(0, 256) : null;
}

function hashedEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 16);
}

function hashedIp(ip: string): string {
  return createHash('sha256').update(ip, 'utf8').digest('hex').slice(0, 16);
}
