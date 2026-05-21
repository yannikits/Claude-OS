/**
 * State-check for Anthropic auth (Phase 5d, ADR-0011 §26).
 *
 * Resolution order:
 *   1. CI env-vars (`CLAUDE_CODE_OAUTH_TOKEN`)
 *   2. `claude auth status --json` subprocess (when the binary is
 *      resolvable + executor is injectable for tests)
 *   3. `.credentials.json` file-read fallback
 *   4. `no-creds` state
 *
 * Cache: caller's responsibility. v1 returns a fresh state every call;
 * a 60s TTL cache (per ADR §32) can wrap this trivially.
 *
 * @module @domains/auth/state-check
 */
import { hasCiEnvCredentials, readCredentialsFile } from './credentials.js';
import type { AuthSource, AuthState } from './types.js';

type Executor = (
  binaryPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

interface StateCheckOpts {
  /** Override env-var lookup (tests). */
  readonly env?: NodeJS.ProcessEnv;
  /** Override home directory (tests). */
  readonly home?: string;
  /** Override the `now` clock used in `expiresAt` warnings. */
  readonly now?: () => Date;
  /** Path to the resolved `claude` binary (when known). */
  readonly binaryPath?: string;
  /** Inject a subprocess executor. Default uses node:child_process. */
  readonly exec?: Executor;
  /** Active profile name (surfaced into the result). */
  readonly profile?: string;
  /** Override the 1h "expires soon" warning threshold. */
  readonly expiresSoonMs?: number;
}

interface CliAuthStatusJson {
  readonly loggedIn?: unknown;
  readonly authMethod?: unknown;
  readonly apiProvider?: unknown;
}

const DEFAULT_EXPIRES_SOON_MS = 60 * 60 * 1000;

function fromFile(opts: StateCheckOpts): AuthState | null {
  const envelope = readCredentialsFile({
    ...(opts.env === undefined ? {} : { env: opts.env }),
    ...(opts.home === undefined ? {} : { home: opts.home }),
  });
  if (envelope === null) return null;
  const expiresAtMs = envelope.claudeAiOauth.expiresAt;
  // M34 (2026-05-21 code-review): readCredentialsFile akzeptiert
  // `typeof expiresAt === 'number'`, was NaN und Infinity einschliesst.
  // Mit NaN waere `expiresAtMs > nowMs` silent false → loggedIn=false
  // ohne Hinweis warum. Hier explizit checken und als malformed-creds
  // behandeln (fall-through zu noCreds).
  if (!Number.isFinite(expiresAtMs)) return null;
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  const threshold = opts.expiresSoonMs ?? DEFAULT_EXPIRES_SOON_MS;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const loggedIn = expiresAtMs > nowMs;
  const expiringSoon = loggedIn && expiresAtMs - nowMs < threshold;
  const result: AuthState = {
    loggedIn,
    source: 'file',
    expiresAt,
    scopes: envelope.claudeAiOauth.scopes,
    ...(opts.profile === undefined ? {} : { profile: opts.profile }),
    ...(expiringSoon
      ? {
          warning: `token expires at ${expiresAt} (within ${Math.round(threshold / 1000)}s)`,
        }
      : {}),
  };
  return result;
}

async function fromCli(opts: StateCheckOpts): Promise<AuthState | null> {
  if (opts.binaryPath === undefined || opts.exec === undefined) return null;
  let stdout: string;
  try {
    const result = await opts.exec(
      opts.binaryPath,
      ['auth', 'status', '--json'],
      opts.env ?? process.env,
    );
    if (result.exitCode !== 0) return null;
    stdout = result.stdout;
  } catch {
    return null;
  }
  let parsed: CliAuthStatusJson;
  try {
    parsed = JSON.parse(stdout) as CliAuthStatusJson;
  } catch {
    return null;
  }
  if (typeof parsed.loggedIn !== 'boolean') return null;
  const result: AuthState = {
    loggedIn: parsed.loggedIn,
    source: 'cli',
    ...(opts.profile === undefined ? {} : { profile: opts.profile }),
  };
  return result;
}

function fromEnv(opts: StateCheckOpts): AuthState {
  const result: AuthState = {
    loggedIn: true,
    source: 'env',
    warning: 'CI/headless mode: using CLAUDE_CODE_OAUTH_TOKEN env-var',
    ...(opts.profile === undefined ? {} : { profile: opts.profile }),
  };
  return result;
}

function noCreds(opts: StateCheckOpts): AuthState {
  const source: AuthSource = 'no-creds';
  const result: AuthState = {
    loggedIn: false,
    source,
    ...(opts.profile === undefined ? {} : { profile: opts.profile }),
  };
  return result;
}

/**
 * Returns the current auth state. Best-effort: tries each resolution
 * source in order and returns the first hit.
 */
export async function checkAuthState(opts: StateCheckOpts = {}): Promise<AuthState> {
  const env = opts.env ?? process.env;
  if (hasCiEnvCredentials(env)) return fromEnv(opts);
  const cli = await fromCli(opts);
  if (cli !== null) return cli;
  const file = fromFile(opts);
  if (file !== null) return file;
  return noCreds(opts);
}
