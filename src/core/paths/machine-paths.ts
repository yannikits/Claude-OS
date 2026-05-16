/**
 * Platform-aware per-machine path resolution per ADR-0002.
 *
 * Layout:
 *   Windows: `%APPDATA%/claude-os/{git-metadata,data,logs}/`
 *   POSIX:   `${XDG_CONFIG_HOME:-~/.config}/claude-os/{git-metadata,data,logs}/`
 *
 * Override via `$CLAUDE_OS_DATA_DIR` env-var (used for tests and unusual
 * installs). When set, the override path replaces `<base>/claude-os/` —
 * subdirectories are still appended.
 *
 * @module @core/paths/machine-paths
 */
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import type { MachinePaths } from './types.js';
import { PathsResolutionError } from './types.js';

const APP_DIR_NAME = 'claude-os';

interface ResolveOpts {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}

/**
 * Returns the path-style namespace matching the target platform so
 * resolution is decoupled from the runtime host. Tests can therefore
 * verify the POSIX branch on a Windows runner and vice versa.
 */
function pathStyle(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

/**
 * Resolves the per-machine data root for the current platform.
 * Pure function — does not touch the filesystem.
 */
function resolveDataRoot(opts: ResolveOpts): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const p = pathStyle(platform);

  const override = env.CLAUDE_OS_DATA_DIR;
  if (override !== undefined && override.trim().length > 0) {
    return p.resolve(override);
  }

  if (platform === 'win32') {
    const appdata = env.APPDATA;
    if (appdata !== undefined && appdata.trim().length > 0) {
      return p.resolve(p.join(appdata, APP_DIR_NAME));
    }
    // Fallback if %APPDATA% is somehow unset (e.g. stripped service env).
    if (home.length === 0) {
      throw new PathsResolutionError(
        'Cannot resolve data root: $APPDATA unset and homedir() returned empty string',
      );
    }
    return p.resolve(p.join(home, 'AppData', 'Roaming', APP_DIR_NAME));
  }

  // POSIX (mac, linux, *bsd): XDG-style config dir.
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.trim().length > 0) {
    return p.resolve(p.join(xdg, APP_DIR_NAME));
  }
  if (home.length === 0) {
    throw new PathsResolutionError(
      'Cannot resolve data root: $XDG_CONFIG_HOME unset and homedir() returned empty string',
    );
  }
  return p.resolve(p.join(home, '.config', APP_DIR_NAME));
}

/**
 * Resolves all standard per-machine paths. Subdirectories follow ADR-0002.
 *
 * @throws {PathsResolutionError} when no data root is resolvable.
 */
export function resolveMachinePaths(opts: ResolveOpts = {}): MachinePaths {
  const platform = opts.platform ?? process.platform;
  const p = pathStyle(platform);
  const dataRoot = resolveDataRoot(opts);
  return {
    dataRoot,
    gitMetadataDir: p.join(dataRoot, 'git-metadata'),
    dataDir: p.join(dataRoot, 'data'),
    logsDir: p.join(dataRoot, 'logs'),
  };
}

/**
 * Returns the external `.git/` target path for a given repo-name living
 * under the cloud-mount (e.g. `vault` → `<gitMetadataDir>/vault.git`).
 * The `.git` suffix mirrors the bare-repo convention so the directory
 * is recognisable as a Git metadata store.
 */
export function externalGitDirFor(repoName: string, opts: ResolveOpts = {}): string {
  if (repoName.length === 0 || repoName.includes('/') || repoName.includes('\\')) {
    throw new PathsResolutionError(
      `Invalid repo-name for git-metadata target: "${repoName}" (must be a single path segment)`,
    );
  }
  const platform = opts.platform ?? process.platform;
  const p = pathStyle(platform);
  const paths = resolveMachinePaths(opts);
  return p.join(paths.gitMetadataDir, `${repoName}.git`);
}
