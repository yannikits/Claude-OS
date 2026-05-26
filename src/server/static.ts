/**
 * Static-file serve + SPA-fallback for the Vite-built frontend.
 *
 * Strategy:
 *  - Hashed asset paths (`/assets/*`) get long immutable cache headers.
 *  - Everything else (HTML, root) goes through the SPA fallback to
 *    `index.html` so client-side routing works for deep-links.
 *  - The `/api/*` namespace is registered BEFORE this and takes precedence.
 *
 * @module @server/static
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';

export async function registerStaticRoutes(app: FastifyInstance, staticDir: string): Promise<void> {
  if (!existsSync(staticDir)) {
    app.log.warn({ staticDir }, 'static: dir does not exist — skipping SPA serve');
    return;
  }
  const indexHtmlPath = join(staticDir, 'index.html');
  if (!existsSync(indexHtmlPath)) {
    app.log.warn({ staticDir, indexHtmlPath }, 'static: index.html missing — skipping SPA serve');
    return;
  }

  await app.register(fastifyStatic, {
    root: staticDir,
    prefix: '/',
    cacheControl: true,
    maxAge: '1h',
    immutable: false,
    setHeaders(res, path) {
      // Long-lived cache for Vite-hashed asset files; HTML must always
      // revalidate so a deploy picks up immediately.
      if (path.includes('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (path.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
    },
  });

  // SPA-fallback for client-side routes (e.g. /chat, /vault). Any GET that
  // is not an /api/* call and not an existing file falls back to index.html.
  app.setNotFoundHandler((req, reply: FastifyReply) => {
    if (req.method !== 'GET') {
      reply.code(404).send({ error: { code: 'not-found', message: 'Not found' } });
      return;
    }
    if (req.url.startsWith('/api/')) {
      reply.code(404).send({ error: { code: 'not-found', message: 'API route not found' } });
      return;
    }
    reply.type('text/html').sendFile('index.html');
  });
}
