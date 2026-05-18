/**
 * Resolves the claude-os root directory according to ADR-0002.
 *
 * The root contains:
 *   - Plain-text vault under `vault/`
 *   - Configs under `config/`
 *   - inbox/outbox drop-folders
 *   - The Anthropic CLI binary under `bin/claude{,.exe}`
 *
 * Resolution order (highest priority first):
 *   1. Explicit path argument
 *   2. `$CLAUDE_OS_ROOT` environment variable
 *   3. Repo-detect: walk up from cwd looking for a marker file or `bin/claude{,.exe}`
 *
 * @module @core/environment/root-resolver
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import type { CloudProvider, ResolvedRoot } from './types.js';
import { RootNotFoundError } from './types.js';

const MARKER_FILE = '.claude-os-root';
const PORTABLE_DIR_NAME = 'portable-root';
const APP_DIR_NAME = 'claude-os';

/**
 * Heuristic detection of the cloud-sync client managing a path.
 * Pattern-matches against known cloud-client default mount points.
 * Returns `'unknown'` for paths that don't match a known provider —
 * which is a valid state (e.g. local-only setups, custom mounts).
 */
export function detectCloudProvider(path: string): CloudProvider {
  const lower = path.toLowerCase();
  // rclone first — its mount-points can contain other provider names
  // (e.g. /mnt/rclone/onedrive/...). rclone is the file-watcher-relevant
  // layer regardless of what's being mounted underneath.
  if (
    lower.includes('/mnt/rclone') ||
    lower.includes('\\rclone') ||
    lower.includes('/rclone-mount')
  ) {
    return 'rclone';
  }
  if (
    lower.includes('onedrive') ||
    lower.includes('cloudstorage/onedrive') ||
    lower.includes('cloudstorage\\onedrive')
  ) {
    return 'onedrive';
  }
  if (
    lower.includes('google drive') ||
    lower.includes('drivefs') ||
    lower.includes('googledrive')
  ) {
    return 'gdrive';
  }
  if (lower.includes('dropbox')) return 'dropbox';
  if (lower.includes('icloud') || lower.includes('com~apple~clouddocs')) return 'icloud';
  return 'unknown';
}

/**
 * Tests whether `path` is a valid claude-os root.
 *
 * Either:
 *   - the marker file `.claude-os-root` exists at the path's top level, OR
 *   - the path contains `bin/claude.exe` (Windows) or `bin/claude` (POSIX),
 *     which is the evolution marker from the original claude-portable repo.
 */
function isClaudeOsRoot(path: string): boolean {
  if (!existsSync(path)) return false;
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;
  if (existsSync(join(path, MARKER_FILE))) return true;
  if (existsSync(join(path, 'bin', 'claude.exe')) || existsSync(join(path, 'bin', 'claude'))) {
    return true;
  }
  return false;
}

/**
 * Walks up the directory tree from `startDir` looking for the first
 * directory that satisfies {@link isClaudeOsRoot}. Returns the absolute
 * path of the match or `null` if the FS root is reached first.
 */
function walkUp(startDir: string): string | null {
  let current = resolve(startDir);
  const fsRoot = parse(current).root;
  while (true) {
    if (isClaudeOsRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current || current === fsRoot) return null;
    current = parent;
  }
}

/**
 * Resolves the per-user portable data directory (no FS access).
 *   Windows: `%APPDATA%/claude-os/portable-root`
 *   POSIX:   `${XDG_CONFIG_HOME:-~/.config}/claude-os/portable-root`
 *
 * Honours `$CLAUDE_OS_DATA_DIR` as override base (matches machine-paths.ts).
 * Returns `null` only when no home directory is resolvable — that's a
 * pathological env where portable mode genuinely cannot be bootstrapped.
 */
function portableRootCandidate(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): string | null {
  const override = env.CLAUDE_OS_DATA_DIR;
  if (override !== undefined && override.trim().length > 0) {
    return join(resolve(override), PORTABLE_DIR_NAME);
  }
  if (platform === 'win32') {
    const appdata = env.APPDATA;
    if (appdata !== undefined && appdata.trim().length > 0) {
      return join(resolve(appdata), APP_DIR_NAME, PORTABLE_DIR_NAME);
    }
    if (home.length === 0) return null;
    return join(resolve(home), 'AppData', 'Roaming', APP_DIR_NAME, PORTABLE_DIR_NAME);
  }
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.trim().length > 0) {
    return join(resolve(xdg), APP_DIR_NAME, PORTABLE_DIR_NAME);
  }
  if (home.length === 0) return null;
  return join(resolve(home), '.config', APP_DIR_NAME, PORTABLE_DIR_NAME);
}

/**
 * Bootstraps the portable root on first use: creates the marker file
 * and the minimal directory layout (`config/`, `vault/`, `inbox/`,
 * `outbox/`). Idempotent — safe to call when the layout already exists.
 */
function bootstrapPortableRoot(path: string): void {
  mkdirSync(path, { recursive: true });
  const marker = join(path, MARKER_FILE);
  if (!existsSync(marker)) {
    writeFileSync(marker, '', { flag: 'wx' });
  }
  for (const sub of ['config', 'vault', 'inbox', 'outbox']) {
    mkdirSync(join(path, sub), { recursive: true });
  }
  const catalogPath = join(path, 'config', 'catalog.json');
  if (!existsSync(catalogPath)) {
    writeFileSync(catalogPath, `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`);
  }
}

/**
 * Returns `true` when portable fallback is enabled. Defaults to off so
 * CLI usage continues to require an explicit repo or env-var; the
 * Tauri GUI supervisor opts in by setting `CLAUDE_OS_PORTABLE=1`.
 */
function portableEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.CLAUDE_OS_PORTABLE;
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'yes' || t === 'on';
}

/**
 * Resolves the claude-os root directory by walking through the
 * resolution strategies documented at the top of this module.
 *
 * @param opts.explicit - Override path. Must satisfy {@link isClaudeOsRoot}.
 * @param opts.cwd - Starting directory for repo-detect. Defaults to `process.cwd()`.
 * @param opts.env - Environment-variable source. Defaults to `process.env`.
 * @param opts.platform - Platform override (for tests). Defaults to `process.platform`.
 * @param opts.home - Home-dir override (for tests). Defaults to `os.homedir()`.
 * @throws {RootNotFoundError} when no strategy resolves a valid root.
 */
export function resolveRoot(
  opts: {
    readonly explicit?: string;
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly home?: string;
  } = {},
): ResolvedRoot {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();

  if (opts.explicit !== undefined) {
    if (!isClaudeOsRoot(opts.explicit)) {
      throw new RootNotFoundError(
        `Explicit path "${opts.explicit}" is not a valid claude-os root ` +
          `(missing ${MARKER_FILE} and bin/claude{,.exe}).`,
      );
    }
    const path = resolve(opts.explicit);
    return { path, source: 'explicit', cloudProvider: detectCloudProvider(path) };
  }

  const envRoot = env.CLAUDE_OS_ROOT;
  if (envRoot !== undefined && envRoot.trim().length > 0) {
    if (!isClaudeOsRoot(envRoot)) {
      throw new RootNotFoundError(
        `$CLAUDE_OS_ROOT="${envRoot}" is not a valid claude-os root ` +
          `(missing ${MARKER_FILE} and bin/claude{,.exe}).`,
      );
    }
    const path = resolve(envRoot);
    return { path, source: 'env-var', cloudProvider: detectCloudProvider(path) };
  }

  const detected = walkUp(cwd);
  if (detected !== null) {
    return {
      path: detected,
      source: 'repo-detect',
      cloudProvider: detectCloudProvider(detected),
    };
  }

  if (portableEnabled(env)) {
    const candidate = portableRootCandidate(env, platform, home);
    if (candidate !== null) {
      bootstrapPortableRoot(candidate);
      return {
        path: candidate,
        source: 'portable',
        cloudProvider: detectCloudProvider(candidate),
      };
    }
  }

  throw new RootNotFoundError(
    `Could not resolve claude-os root. Tried:\n` +
      `  1. explicit arg: (none)\n` +
      `  2. $CLAUDE_OS_ROOT env-var: (unset or empty)\n` +
      `  3. repo-detect from "${cwd}": no ancestor contains ${MARKER_FILE} or bin/claude{,.exe}\n` +
      `  4. portable fallback: ${portableEnabled(env) ? 'enabled but home/APPDATA/XDG unresolved' : 'disabled (set $CLAUDE_OS_PORTABLE=1)'}\n` +
      `Set $CLAUDE_OS_ROOT or run claude-os from within a claude-os repository.`,
  );
}
