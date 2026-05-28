/**
 * `claude-os serve` — start the headless HTTP server.
 *
 * Implements Phase Web-1 of the server-deployment plan (ADR-0032) plus
 * the Web-7 Multi-User Stage 2 wire-up (ADR-0036): when `users.sqlite`
 * exists in the data-dir (or `$CLAUDE_OS_MULTI_USER=1` forces it), the
 * server opens the UserRepository, creates the SessionRepository +
 * LoginRateLimiter, plumbs through the AuditLogger, and starts with
 * `MultiUserConfig` set. Otherwise it stays in Stage-1 token-only mode.
 *
 * @module @cli/commands/serve
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { AuditLogger } from '../../core/audit/index.js';
import { resolveMachinePaths } from '../../core/paths/index.js';
import { SessionRepository } from '../../domains/sessions/index.js';
import { resolveUsersDbPath, UserRepository } from '../../domains/users/index.js';
import { startServer } from '../../server/index.js';
import { LoginRateLimiter } from '../../server/rate-limit.js';
import {
  DEFAULT_SERVER_CONFIG,
  type MultiUserConfig,
  type ServerConfig,
} from '../../server/types.js';

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

function envFlag(name: string): boolean {
  const v = process.env[name];
  return v === '1' || v === 'true';
}

/**
 * Decide whether to enable Multi-User Stage 2 (Web-7, ADR-0036).
 *
 * Trigger conditions (any of these):
 *  - `users.sqlite` already exists in the data-dir (operator created
 *    accounts via `claude-os users create`)
 *  - `$CLAUDE_OS_MULTI_USER=1` explicitly forces it (covers
 *    self-registration-only deployments where the file doesn't exist
 *    yet)
 *
 * Override: `$CLAUDE_OS_DISABLE_MULTI_USER=1` forces back to Stage 1.
 */
async function maybeMultiUserConfig(dataDir: string): Promise<MultiUserConfig | undefined> {
  if (envFlag('CLAUDE_OS_DISABLE_MULTI_USER')) return undefined;
  const usersDbExists = existsSync(resolveUsersDbPath(dataDir));
  const forced = envFlag('CLAUDE_OS_MULTI_USER');
  if (!usersDbExists && !forced) return undefined;

  const userRepo = await UserRepository.open({ dataDir });
  const sessionRepo = new SessionRepository();
  const rateLimiter = new LoginRateLimiter({ capacity: 5 });
  const audit = new AuditLogger();
  const insecureCookies = envFlag('CLAUDE_OS_INSECURE_COOKIES');
  const sessionMaxAgeSec = 30 * 24 * 60 * 60;
  const allowRegistration = envFlag('CLAUDE_OS_ALLOW_REGISTRATION');
  const registrationRateLimiter = allowRegistration
    ? new LoginRateLimiter({ capacity: 3, refillIntervalMs: 60 * 60 * 1000 })
    : undefined;

  return {
    userRepo,
    sessionRepo,
    rateLimiter,
    audit,
    insecureCookies,
    sessionMaxAgeSec,
    ...(allowRegistration ? { allowRegistration: true } : {}),
    ...(registrationRateLimiter !== undefined ? { registrationRateLimiter } : {}),
  };
}

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description(
      'Start headless HTTP server (Phase Web-1). Reads bearer token from $CLAUDE_OS_AUTH_TOKEN. ' +
        'Auto-detects Multi-User Stage 2 (ADR-0036) when users.sqlite exists in the data-dir.',
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

      const machinePaths = resolveMachinePaths();
      const multiUser = await maybeMultiUserConfig(machinePaths.dataDir);

      const config: ServerConfig = {
        host: opts.host ?? DEFAULT_SERVER_CONFIG.host,
        port: parsePortOrDefault(opts.port, DEFAULT_SERVER_CONFIG.port),
        authToken,
        staticDir: resolveStaticDir(opts.staticDir),
        corsOrigin: opts.corsOrigin ?? DEFAULT_SERVER_CONFIG.corsOrigin,
        sseHeartbeatMs: DEFAULT_SERVER_CONFIG.sseHeartbeatMs,
        trustProxy: DEFAULT_SERVER_CONFIG.trustProxy,
        ...(multiUser !== undefined ? { multiUser } : {}),
      };

      if (multiUser !== undefined) {
        const userCount = multiUser.userRepo.countAll();
        console.error(
          `claude-os serve: Multi-User Stage 2 enabled (${userCount} users)` +
            (multiUser.allowRegistration === true ? `, self-registration ON` : '') +
            (multiUser.insecureCookies ? `, INSECURE cookies — dev only` : ''),
        );
      }

      const handle = await startServer(config);

      const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
        console.error(`\nclaude-os serve: received ${signal}, shutting down...`);
        try {
          await handle.shutdown();
          if (multiUser !== undefined) multiUser.userRepo.close();
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
