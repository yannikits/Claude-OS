/**
 * Credentials reader for Anthropic-CLI `.credentials.json` files
 * (Phase 5d, ADR-0011).
 *
 * READ-ONLY: we never write to the Anthropic-owned credentials file.
 *
 * Two read paths:
 *   1. `$ANTHROPIC_CONFIG_DIR/.credentials.json` (override + multi-profile)
 *   2. `~/.claude/.credentials.json` (default Linux/Windows)
 *
 * macOS keychain (`Claude Code-credentials`) is NOT read by this v1
 * module — file-fallback is still present in new claude.exe builds.
 * Keychain read via `@napi-rs/keyring` is staged for v1.x.
 *
 * @module @domains/auth/credentials
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { AuthError, type CredentialsFileEnvelope, type SchemaCheckResult } from './types.js';

interface CredentialsReaderOpts {
  /** Override the home directory (tests). */
  readonly home?: string;
  /** Override the env-var source. */
  readonly env?: NodeJS.ProcessEnv;
}

const REQUIRED_FIELDS = ['accessToken', 'refreshToken', 'expiresAt', 'scopes'] as const;

/**
 * Returns the resolved path the credentials file would live at.
 *
 * M10 (2026-05-21 code-review): wenn `$ANTHROPIC_CONFIG_DIR` gesetzt
 * ist, wird der Pfad mit realpathSync canonicalized (Symlinks werden
 * aufgeloest) — das verhindert dass ein attacker-gesetzter Env-Var auf
 * einen symlinked-Pfad in einem world-writable Verzeichnis verweist
 * und claude-os heimlich von dort Credentials liest.
 */
export function resolveCredentialsPath(opts: CredentialsReaderOpts = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const override = env.ANTHROPIC_CONFIG_DIR;
  if (override !== undefined && override.trim().length > 0) {
    let canonical = override.trim();
    try {
      canonical = realpathSync(canonical);
    } catch {
      // Path existiert noch nicht — raw-override bleibt. caller ENOENT'd
      // beim credential-read, was die richtige outcome ist (kein silent
      // fallback auf den default-path).
    }
    return join(canonical, '.credentials.json');
  }
  return join(home, '.claude', '.credentials.json');
}

/**
 * M10 doctor-helper: pruefe ob ein gesetzter $ANTHROPIC_CONFIG_DIR auf
 * einen "sicheren" Pfad zeigt. Zurueck: null wenn unverdaechtig,
 * Warning-String wenn der canonicalized override OUTSIDE des home dirs
 * UND nicht unter common system-config-dirs liegt.
 */
export function validateAnthropicConfigDir(opts: CredentialsReaderOpts = {}): string | null {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const override = env.ANTHROPIC_CONFIG_DIR;
  if (override === undefined || override.trim().length === 0) return null;
  let canonical = override.trim();
  try {
    canonical = realpathSync(canonical);
  } catch {
    return `ANTHROPIC_CONFIG_DIR="${override}" verweist auf einen nicht-existierenden Pfad`;
  }
  const homeReal = (() => {
    try {
      return realpathSync(home);
    } catch {
      return home;
    }
  })();
  // Akzeptiert: unter home dir OR unter typischen system-config-dirs.
  if (isPathUnder(canonical, homeReal)) return null;
  const safeRoots = [
    // POSIX
    '/etc/claude',
    '/usr/local/etc/claude',
    // Windows
    process.env.PROGRAMDATA !== undefined ? join(process.env.PROGRAMDATA, 'claude') : null,
  ].filter((p): p is string => p !== null);
  for (const root of safeRoots) {
    if (isPathUnder(canonical, root)) return null;
  }
  return (
    `ANTHROPIC_CONFIG_DIR="${override}" (realpath: "${canonical}") liegt OUTSIDE des ` +
    'User-Home und ist nicht unter einem bekannten System-Config-Root — koennte ' +
    'auf attacker-controlled Pfad zeigen. Doctor-Warning, kein Hard-Block.'
  );
}

function isPathUnder(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '' || rel === '.') return true;
  if (rel.startsWith('..')) return false;
  if (rel.startsWith(sep) || /^[A-Za-z]:[/\\]/.test(rel)) return false;
  return true;
}

/** True when CI/headless env-vars are populated. */
export function hasCiEnvCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  const token = env.CLAUDE_CODE_OAUTH_TOKEN;
  return token !== undefined && token.trim().length > 0;
}

/** Reads + parses the credentials file. Returns null on missing/corrupt. */
export function readCredentialsFile(
  opts: CredentialsReaderOpts = {},
): CredentialsFileEnvelope | null {
  const path = resolveCredentialsPath(opts);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const inner = (parsed as Record<string, unknown>).claudeAiOauth;
  if (inner === undefined || inner === null || typeof inner !== 'object' || Array.isArray(inner)) {
    return null;
  }
  const obj = inner as Record<string, unknown>;
  if (
    typeof obj.accessToken !== 'string' ||
    typeof obj.refreshToken !== 'string' ||
    typeof obj.expiresAt !== 'number' ||
    !Array.isArray(obj.scopes)
  ) {
    return null;
  }
  return parsed as CredentialsFileEnvelope;
}

/**
 * Validates that the credentials file (if present) carries the
 * expected fields. Used by the doctor's schema-drift warning per
 * ADR-0011 constraint section.
 */
export function checkCredentialsSchema(opts: CredentialsReaderOpts = {}): SchemaCheckResult {
  const path = resolveCredentialsPath(opts);
  if (!existsSync(path)) {
    return {
      ok: true,
      missingFields: [],
      warning: 'no .credentials.json present (not logged in?)',
    };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return {
      ok: false,
      missingFields: [],
      warning: `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, missingFields: [], warning: `${path} is not valid JSON` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, missingFields: ['claudeAiOauth'], warning: 'envelope is not an object' };
  }
  const inner = (parsed as Record<string, unknown>).claudeAiOauth;
  if (inner === undefined || typeof inner !== 'object' || inner === null || Array.isArray(inner)) {
    return { ok: false, missingFields: ['claudeAiOauth'], warning: 'missing claudeAiOauth root' };
  }
  const obj = inner as Record<string, unknown>;
  const missing: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    if (obj[field] === undefined) missing.push(field);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      missingFields: missing,
      warning:
        `Anthropic-CLI .credentials.json missing fields: ${missing.join(', ')}. ` +
        'Schema may have changed — check for a claude-os update.',
    };
  }
  return { ok: true, missingFields: [] };
}

/**
 * Returns true when the token expires within `skewMs` of now.
 * Helper for proactive-refresh decisions (Phase 5d-tail). v1 only
 * surfaces a warning; actual refresh remains claude.exe's job.
 */
export function isExpiringSoon(
  envelope: CredentialsFileEnvelope,
  skewMs = 60_000,
  now: () => Date = () => new Date(),
): boolean {
  const nowMs = now().getTime();
  return envelope.claudeAiOauth.expiresAt - nowMs < skewMs;
}

/** Type-guard / discriminator usable in CLI presenters. */
export function isAuthError(err: unknown): err is AuthError {
  return err instanceof AuthError;
}
