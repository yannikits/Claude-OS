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

/**
 * Multipart upload endpoint for browser drag-and-drop (Phase Web-3 follow-up).
 *
 * Browsers cannot replicate the Tauri `files://dropped` IPC, so files come
 * in via standard multipart form-data POST. We pipe each part to the same
 * `<root>/inbox/<ISO>-<basename>` layout the existing sidecar watcher
 * monitors — the rest of the flow (chokidar add-event → `inbox://changed`
 * notification → ChatPage banner) keeps working unchanged.
 */
export async function registerInboxUpload(
  app: FastifyInstance,
  dispatcher: RpcDispatcher,
): Promise<void> {
  // Lazy-load @fastify/multipart so the test harness doesn't need it.
  const fastifyMultipart = (await import('@fastify/multipart')).default;
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 64 * 1024 * 1024, // 64 MB per file
      files: 10, // max 10 files per drop
    },
  });

  app.post('/api/inbox/upload', async (req, reply) => {
    const parts = req.parts();
    const stagedPaths: string[] = [];
    const { writeFile } = await import('node:fs/promises');
    const { mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmpRoot = join(tmpdir(), 'claude-os-upload');
    await mkdir(tmpRoot, { recursive: true });

    let count = 0;
    for await (const part of parts) {
      if (part.type !== 'file') continue;
      count += 1;
      const safe = part.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const stagedPath = join(tmpRoot, `${Date.now()}-${count}-${safe}`);
      const buf = await part.toBuffer();
      await writeFile(stagedPath, buf);
      stagedPaths.push(stagedPath);
    }

    if (stagedPaths.length === 0) {
      reply.code(400);
      return { ok: false, error: { code: 'no-files', message: 'no file parts in upload' } };
    }

    // Now delegate to the existing inbox.import RPC so chokidar + the
    // watcher pipeline behaves identically to the Tauri drag-drop path.
    try {
      const result = (await dispatcher.invoke('inbox.import', { paths: stagedPaths })) as {
        count: number;
        paths: string[];
      };
      return { ok: true as const, result };
    } catch (err) {
      req.log.error({ err }, 'inbox.upload: inbox.import failed');
      reply.code(500);
      return {
        ok: false,
        error: {
          code: 'inbox-import-failed',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  });
}
