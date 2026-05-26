/**
 * HTTP-Adapter for the existing sidecar `RpcDispatcher`.
 *
 * Routes:
 *  - `POST /api/rpc`           → dispatcher.invoke(method, params)
 *  - `POST /api/auth/verify`   → no-op (returns {ok:true}); auth is enforced
 *                                by the `preHandler` hook on all /api routes.
 *
 * Error mapping:
 *  - `MethodNotFound:` prefix from dispatcher  → 404 method-not-found
 *  - Validation errors (TypeBox/Ajv)           → 400 invalid-params
 *  - Everything else                           → 500 internal-error
 *
 * @module @server/rpc-http
 */
import type { FastifyInstance } from 'fastify';
import type { RpcDispatcher } from '../sidecar/rpc.js';

interface RpcRequestBody {
  method?: unknown;
  params?: unknown;
}

interface RpcSuccessResponse {
  ok: true;
  result: unknown;
}

interface RpcErrorResponse {
  ok: false;
  error: { code: string; message: string };
}

const METHOD_NOT_FOUND_PREFIX = 'MethodNotFound:';

export function registerRpcRoutes(app: FastifyInstance, dispatcher: RpcDispatcher): void {
  app.post<{ Body: RpcRequestBody }>(
    '/api/rpc',
    async (req, reply): Promise<RpcSuccessResponse | RpcErrorResponse> => {
      const body = req.body ?? {};
      if (typeof body.method !== 'string' || body.method.length === 0) {
        reply.code(400);
        return {
          ok: false,
          error: { code: 'invalid-request', message: 'method must be a non-empty string' },
        };
      }

      try {
        const result = await dispatcher.invoke(body.method, body.params ?? null);
        return { ok: true, result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        if (message.startsWith(METHOD_NOT_FOUND_PREFIX)) {
          reply.code(404);
          return {
            ok: false,
            error: { code: 'method-not-found', message },
          };
        }

        // TypeBox/Ajv validation errors typically include "must" or
        // "expected" — we keep that as 400 invalid-params; everything
        // else is treated as 500. Heuristic is loose by design; the
        // domain-side can throw richer typed errors in v1.x+.
        if (err instanceof Error && (err.name === 'ValidationError' || err.name === 'TypeError')) {
          reply.code(400);
          return {
            ok: false,
            error: { code: 'invalid-params', message },
          };
        }

        req.log.error({ err, method: body.method }, 'rpc-http: handler threw');
        reply.code(500);
        return {
          ok: false,
          error: { code: 'internal-error', message },
        };
      }
    },
  );

  // Auth verification round-trip for the frontend login page. Returns OK
  // when the preHandler-auth-hook accepts the bearer token. Body is
  // intentionally empty — the token in `Authorization` is the credential.
  app.post('/api/auth/verify', async () => ({ ok: true as const }));
}
