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
import { existsSync, statSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import type { CloudProvider, ResolvedRoot } from './types.js';
import { RootNotFoundError } from './types.js';

const MARKER_FILE = '.claude-os-root';

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
 * Resolves the claude-os root directory by walking through the
 * resolution strategies documented at the top of this module.
 *
 * @param opts.explicit - Override path. Must satisfy {@link isClaudeOsRoot}.
 * @param opts.cwd - Starting directory for repo-detect. Defaults to `process.cwd()`.
 * @param opts.env - Environment-variable source. Defaults to `process.env`.
 * @throws {RootNotFoundError} when no strategy resolves a valid root.
 */
export function resolveRoot(
  opts: {
    readonly explicit?: string;
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): ResolvedRoot {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

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

  throw new RootNotFoundError(
    `Could not resolve claude-os root. Tried:\n` +
      `  1. explicit arg: (none)\n` +
      `  2. $CLAUDE_OS_ROOT env-var: (unset or empty)\n` +
      `  3. repo-detect from "${cwd}": no ancestor contains ${MARKER_FILE} or bin/claude{,.exe}\n` +
      `Set $CLAUDE_OS_ROOT or run claude-os from within a claude-os repository.`,
  );
}
