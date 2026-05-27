/**
 * Cookie-first authentication hook (Phase Web-7-2, ADR-0036 draft).
 *
 * Replaces the bearer-only `makeAuthHook` from `src/server/auth.ts`
 * with a hook that tries:
 *   1. Session cookie `claude_os_session` → user lookup → set `req.user`
 *   2. Bearer-token fallback (ADR-0033 Stage 1 multi-token) → set `req.tenant`
 *   3. Otherwise reject 401.
 *
 * Cookie path also enforces the double-submit CSRF token for unsafe
 * methods (POST/PUT/PATCH/DELETE) — bearer-only clients skip CSRF.
 *
 * The `tenantIdFor(user)` callback computes the tenant-id from a User.
 * Default since Phase Web-7-3 is the canonical `userToTenantId` from
 * `domains/tenant/resolve-token.ts`. Tests can inject a stub.
 *
 * Layering reminder (mirrors `src/server/auth.ts` header): this is a
 * transport-layer composition; domains (`users`, `sessions`,
 * `tenant`) stay independent.
 *
 * @module @server/cookie-auth
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRepository } from '../domains/sessions/index.js';
import { tokenToTenantId, userToTenantId } from '../domains/tenant/index.js';
import type { User, UserRepository } from '../domains/users/index.js';
import { type AuthError, extractBearer, matchBearerToken } from './auth.js';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from './cookies.js';
import { csrfEquals } from './csrf.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated when authenticated via session-cookie. */
    user?: User;
    /** Populated when authenticated via session-cookie — derived from user. */
    sessionId?: string;
  }
}

/** Routes that the global hook skips entirely (auth not yet established). */
const PUBLIC_PATHS = new Set<string>(['/api/auth/login', '/api/auth/register']);

const UNSAFE_METHODS = new Set<string>(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Routes exempt from CSRF (login mints the cookie; refresh exchanges a bearer). */
const CSRF_EXEMPT_PATHS = new Set<string>(['/api/auth/login', '/api/auth/refresh']);

export interface CookieAuthDeps {
  readonly expectedTokens: readonly string[];
  readonly sessionRepo: SessionRepository;
  readonly userRepo: UserRepository;
  /** Override tenant resolver — Phase Web-7-3 wires the real one. */
  readonly tenantIdFor?: (user: User) => string;
}

export function makeCookieAuthHook(deps: CookieAuthDeps) {
  if (deps.expectedTokens.length === 0) {
    throw new Error('makeCookieAuthHook: expectedTokens must contain at least one entry');
  }
  const tenantIdFor = deps.tenantIdFor ?? userToTenantId;

  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.url.startsWith('/api/')) return;
    const pathOnly = req.url.split('?')[0] ?? req.url;
    if (PUBLIC_PATHS.has(pathOnly)) return;

    // Try cookie first.
    const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> })
      .cookies;
    const sessionCookie = cookies?.[SESSION_COOKIE_NAME];
    if (sessionCookie !== undefined && sessionCookie.length > 0) {
      const session = deps.sessionRepo.resolve(sessionCookie);
      if (session !== null) {
        const user = deps.userRepo.findById(session.userId);
        if (user !== null && !user.disabled) {
          // CSRF on state-changing requests using cookie auth.
          if (UNSAFE_METHODS.has(req.method) && !CSRF_EXEMPT_PATHS.has(pathOnly)) {
            const csrfCookie = cookies?.[CSRF_COOKIE_NAME];
            const csrfHeader = req.headers[CSRF_HEADER_NAME];
            const headerVal = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
            if (
              csrfCookie === undefined ||
              headerVal === undefined ||
              typeof headerVal !== 'string' ||
              !csrfEquals(csrfCookie, headerVal)
            ) {
              reply.code(403).send({
                error: { code: 'csrf-failed', message: 'CSRF check failed' },
              });
              return;
            }
          }
          req.user = user;
          req.sessionId = session.id;
          req.tenant = tenantIdFor(user);
          return;
        }
      }
    }

    // Bearer fallback (existing ADR-0033 path).
    const header = req.headers.authorization;
    if (header !== undefined && header.length > 0) {
      try {
        const presented = extractBearer(header);
        const matched = matchBearerToken(presented, deps.expectedTokens);
        if (matched !== null) {
          req.tenant = tokenToTenantId(matched);
          return;
        }
        reply.code(401).send({ error: { code: 'unauthorized', message: 'auth: invalid bearer' } });
        return;
      } catch (err) {
        const e = err as AuthError;
        reply
          .code(e.statusCode ?? 401)
          .send({ error: { code: 'unauthorized', message: e.message } });
        return;
      }
    }

    reply.code(401).send({
      error: { code: 'unauthorized', message: 'auth: missing session cookie or bearer token' },
    });
  };
}
