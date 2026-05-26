/**
 * Bearer-Token authentication for the HTTP-Adapter.
 *
 * Single-User MVP per ADR-0032. The expected token is loaded once at boot
 * from `ServerConfig.authToken` and never logged. Verification uses
 * `crypto.timingSafeEqual` to avoid timing-leak attacks.
 *
 * For Multi-User (Phase Web-5+) this layer becomes a token→tenant lookup;
 * the public surface (`verifyBearerToken`, `requireAuth`) stays unchanged.
 *
 * @module @server/auth
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

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
 * Fastify `preHandler` hook that enforces Bearer-Token auth on a route.
 * Use via `fastify.register(authPlugin, {expectedToken})` (see index.ts).
 */
export function makeAuthHook(expectedToken: string) {
  if (expectedToken.length === 0) {
    throw new Error('makeAuthHook: expectedToken must be non-empty');
  }
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const token = extractBearer(req.headers.authorization);
      if (!verifyBearerToken(token, expectedToken)) {
        throw new AuthError('invalid');
      }
    } catch (err) {
      const e = err as AuthError;
      reply.code(e.statusCode ?? 401).send({
        error: { code: 'unauthorized', message: e.message },
      });
    }
  };
}
