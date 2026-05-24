/**
 * Loads `.env` (per dotenv) into `process.env` and exposes a typed view.
 *
 * Resolution order for `.env` location:
 *   1. Explicit `envFilePath` argument (tests)
 *   2. `<claude-os-root>/.env` if a root is resolvable
 *   3. `process.cwd()/.env` as last resort
 *
 * Missing `.env` is **not** an error — env-vars may be set externally
 * (CI, system env, shell exports). `loadAppEnv` just returns whatever
 * `process.env` ends up containing after the dotenv load attempt.
 *
 * @module @core/config/env-loader
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { resolveRoot } from '../environment/index.js';
import type { AppEnv } from './types.js';

interface LoadOpts {
  /** Explicit `.env` path. Skips resolution. Tests use this. */
  readonly envFilePath?: string;
  /** Env source for after-load read. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** CWD for resolution fallback. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

function pickEnvFile(opts: LoadOpts): string | null {
  if (opts.envFilePath !== undefined) {
    return opts.envFilePath;
  }
  try {
    const root = resolveRoot({});
    const candidate = join(root.path, '.env');
    if (existsSync(candidate)) return candidate;
  } catch {
    // root unresolvable — fall through to cwd
  }
  const cwdCandidate = join(opts.cwd ?? process.cwd(), '.env');
  if (existsSync(cwdCandidate)) return cwdCandidate;
  return null;
}

/**
 * Loads `.env` (if present) and returns a typed `AppEnv` view of the
 * `process.env` state afterwards. Pure read — no side effects beyond
 * the dotenv merge.
 *
 * Repeated calls are safe but redundant; dotenv merges by default (no
 * override of already-set vars), so a second call is a no-op unless
 * the file changed since the first load.
 */
export function loadAppEnv(opts: LoadOpts = {}): AppEnv {
  const envFile = pickEnvFile(opts);
  if (envFile !== null) {
    dotenvConfig({ path: envFile, quiet: true });
  }

  const env = opts.env ?? process.env;
  const vaultPath = env.CLAUDE_OS_VAULT_PATH?.trim();
  const defaultWorkspace = env.CLAUDE_OS_DEFAULT_WORKSPACE?.trim();

  return {
    ...(vaultPath !== undefined && vaultPath.length > 0 ? { vaultPath } : {}),
    ...(defaultWorkspace !== undefined && defaultWorkspace.length > 0
      ? { defaultWorkspace }
      : {}),
  };
}
