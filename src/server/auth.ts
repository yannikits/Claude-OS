/**
 * Bearer-Token authentication for the HTTP-Adapter.
 *
 * Multi-User Stage 1 (ADR-0033): accepts a list of valid tokens. Each
 * token's SHA-256 prefix becomes a deterministic Tenant-ID set on the
 * request as `req.tenant`. Verification stays constant-time across the
 * whole list (no timing-side-channel by token position).
 *
 * Single-token setups keep working unchanged — the list-of-one is the
 * Single-User case.
 *
 * @module @server/auth
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { tokenToTenantId } from '../domains/tenant/index.js';

// Re-export so existing callers and tests that import from `@server/auth`
// keep working unchanged. The canonical definition lives in
// `src/domains/tenant/resolve-token.ts` (correct layering: domain →
// transport, never the other way).
export { tokenToTenantId };

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Tenant-ID derived from the bearer token (sha256-prefix). Set by
     * `makeAuthHook` after a successful match. Domain methods that need
     * per-user isolation read this — default-fallback to "personal" when
     * absent (e.g. Tauri-mode or unauthenticated /healthz).
     */
    tenant?: string;
  }
}

const BEARER_PREFIX = 'Bearer ';

export class AuthError extends Error {
  constructor(
    public readonly reason: 'missing' | 'malformed' | 'invalid',
    public readonly statusCode: 401 | 400 = 401,
  ) {
    super(`auth: ${reason}`);
    this.name = 'AuthError';
  }
}

/**
 * Constant-time bearer-token comparison. Returns `true` iff `presented`
 * exactly matches `expected`. Length-mismatch returns `false` without
 * allocating a same-length buffer (which would itself leak length via
 * timing; the early-return is intentional — length is not secret).
 */
export function verifyBearerToken(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  // Both buffers must be same length for timingSafeEqual.
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Parse the env-supplied token configuration into a list. Accepts both
 * single-token (legacy / Single-User) and comma-separated multi-token.
 *
 * Whitespace around entries is trimmed. Empty entries (e.g. trailing
 * commas) are dropped silently.
 */
export function parseTokenList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Constant-time match against the entire token list. Returns the
 * matched token (so the caller can compute the tenant-id) or null when
 * no entry matches. Always loops over every list entry — early-return
 * would leak position via timing.
 */
export function matchBearerToken(presented: string, expected: readonly string[]): string | null {
  let match: string | null = null;
  for (const candidate of expected) {
    if (verifyBearerToken(presented, candidate)) {
      // Don't `break` — keep going to even out the loop time.
      match = candidate;
    }
  }
  return match;
}

/**
 * Extract the bearer token from a `Authorization: Bearer <token>` header.
 * Throws `AuthError` with a precise reason for the failure case.
 */
export function extractBearer(headerValue: string | undefined): string {
  if (headerValue === undefined || headerValue === '') {
    throw new AuthError('missing');
  }
  if (!headerValue.startsWith(BEARER_PREFIX)) {
    throw new AuthError('malformed', 400);
  }
  const token = headerValue.slice(BEARER_PREFIX.length).trim();
  if (token.length === 0) throw new AuthError('malformed', 400);
  return token;
}

/**
 * Routes that may receive the bearer token via `?token=...` query-string
 * instead of the `Authorization` header. Browsers cannot attach custom
 * headers to `EventSource` connections, so we accept the token via URL
 * for SSE only.
 *
 * Trade-off: the token appears in proxy/access logs for these routes.
 * Mitigation: tokens are session-scoped (sessionStorage) and rotatable
 * via env-restart. Header-auth remains preferred everywhere else.
 */
const QUERY_TOKEN_ALLOWED_PATHS = new Set<string>(['/api/events', '/api/pty/ws']);

/**
 * Fastify `preHandler` hook that enforces Bearer-Token auth on a route.
 * Accepts any of the configured tokens (Multi-User Stage 1) and sets
 * `req.tenant` to the deterministic tenant-id derived from the matching
 * token.
 *
 * For the routes in `QUERY_TOKEN_ALLOWED_PATHS` it also accepts a
 * `?token=...` query-string (needed for browser `EventSource` and
 * `WebSocket` which cannot send custom headers).
 */
export function makeAuthHook(expectedTokens: readonly string[]) {
  if (expectedTokens.length === 0) {
    throw new Error('makeAuthHook: expectedTokens must contain at least one entry');
  }
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const presented = resolvePresentedToken(req);
      const matched = matchBearerToken(presented, expectedTokens);
      if (matched === null) {
        throw new AuthError('invalid');
      }
      req.tenant = tokenToTenantId(matched);
    } catch (err) {
      const e = err as AuthError;
      reply.code(e.statusCode ?? 401).send({
        error: { code: 'unauthorized', message: e.message },
      });
    }
  };
}

function resolvePresentedToken(req: FastifyRequest): string {
  const header = req.headers.authorization;
  if (header !== undefined && header.length > 0) {
    return extractBearer(header);
  }
  const pathOnly = req.url.split('?')[0] ?? req.url;
  if (QUERY_TOKEN_ALLOWED_PATHS.has(pathOnly)) {
    const q = (req.query as { token?: unknown } | undefined)?.token;
    if (typeof q === 'string' && q.length > 0) return q;
  }
  throw new AuthError('missing');
}
