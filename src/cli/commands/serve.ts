/**
 * `claude-os serve` — start the headless HTTP server.
 *
 * Implements Phase Web-1 of the server-deployment plan (ADR-0032). Wraps
 * the same `RpcDispatcher` the Tauri sidecar uses and exposes it over
 * Fastify HTTP + SSE.
 *
 * @module @cli/commands/serve
 */
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { startServer } from '../../server/index.js';
import { DEFAULT_SERVER_CONFIG, type ServerConfig } from '../../server/types.js';

interface ServeOptions {
  readonly host?: string;
  readonly port?: string;
  readonly staticDir?: string;
  readonly corsOrigin?: string;
}

function parsePortOrDefault(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    throw new Error(`serve: invalid --port "${raw}" — must be 1..65535`);
  }
  return n;
}

function resolveStaticDir(opt: string | undefined): string | null {
  if (opt === '') return null;
  if (opt !== undefined) return resolve(opt);
  const fromEnv = process.env.CLAUDE_OS_STATIC_DIR;
  if (fromEnv !== undefined && fromEnv.length > 0) return resolve(fromEnv);
  return null;
}

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description(
      'Start headless HTTP server (Phase Web-1). Reads bearer token from $CLAUDE_OS_AUTH_TOKEN.',
    )
    .option('--host <host>', `bind host (default ${DEFAULT_SERVER_CONFIG.host})`)
    .option('--port <port>', `bind port (default ${DEFAULT_SERVER_CONFIG.port})`)
    .option(
      '--static-dir <path>',
      'serve Vite-built frontend from <path> (default $CLAUDE_OS_STATIC_DIR or none)',
    )
    .option(
      '--cors-origin <origin>',
      'allow CORS from <origin> (default: same-origin only, no CORS header)',
    )
    .action(async (opts: ServeOptions) => {
      const authToken = process.env.CLAUDE_OS_AUTH_TOKEN ?? '';
      if (authToken.length === 0) {
        console.error(
          'claude-os serve: $CLAUDE_OS_AUTH_TOKEN is required. Generate one with:\n' +
            "  node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"\n" +
            'and set it in your environment (docker-compose .env or shell export).',
        );
        process.exit(2);
      }

      const config: ServerConfig = {
        host: opts.host ?? DEFAULT_SERVER_CONFIG.host,
        port: parsePortOrDefault(opts.port, DEFAULT_SERVER_CONFIG.port),
        authToken,
        staticDir: resolveStaticDir(opts.staticDir),
        corsOrigin: opts.corsOrigin ?? DEFAULT_SERVER_CONFIG.corsOrigin,
        sseHeartbeatMs: DEFAULT_SERVER_CONFIG.sseHeartbeatMs,
        trustProxy: DEFAULT_SERVER_CONFIG.trustProxy,
      };

      const handle = await startServer(config);

      const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
        console.error(`\nclaude-os serve: received ${signal}, shutting down...`);
        try {
          await handle.shutdown();
          process.exit(0);
        } catch (err) {
          console.error(
            `claude-os serve: shutdown error: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(1);
        }
      };

      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
    });
}
