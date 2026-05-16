/**
 * Resolves the Anthropic `claude` binary path.
 *
 * Resolution order:
 *   1. Explicit `binaryPath` override
 *   2. `<rootPath>/bin/claude.exe` (Windows) or `<rootPath>/bin/claude` (POSIX)
 *   3. `$PATH` walk for `claude.exe` / `claude` / `claude.cmd`
 *
 * @module @domains/claude-bridge/resolve-binary
 */
import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ResolvedBinary } from './types.js';
import { BinaryNotFoundError } from './types.js';

interface ResolveOpts {
  readonly binaryPath?: string;
  readonly rootPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

function isExecutableFile(p: string): boolean {
  if (!existsSync(p)) return false;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function candidateNames(platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
}

/**
 * Walks `$PATH` for the first matching `claude*` binary.
 */
function walkPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const pathVar = env.PATH ?? env.Path ?? env.path;
  if (pathVar === undefined || pathVar.length === 0) return null;
  const dirs = pathVar.split(delimiter).filter((d) => d.length > 0);
  const names = candidateNames(platform);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveClaudeBinary(opts: ResolveOpts = {}): ResolvedBinary {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;

  // 1. Explicit override.
  if (opts.binaryPath !== undefined && opts.binaryPath.length > 0) {
    if (!isExecutableFile(opts.binaryPath)) {
      throw new BinaryNotFoundError(
        `Explicit binary path "${opts.binaryPath}" does not point to a file`,
      );
    }
    return { path: opts.binaryPath, source: 'override' };
  }

  // 2. <root>/bin/claude{,.exe,.cmd}
  if (opts.rootPath !== undefined && opts.rootPath.length > 0) {
    for (const name of candidateNames(platform)) {
      const candidate = join(opts.rootPath, 'bin', name);
      if (isExecutableFile(candidate)) return { path: candidate, source: 'bin' };
    }
  }

  // 3. $PATH fallback.
  const fromPath = walkPath(env, platform);
  if (fromPath !== null) return { path: fromPath, source: 'path' };

  throw new BinaryNotFoundError(
    `Could not locate the Anthropic claude binary. Searched: ` +
      `${opts.rootPath === undefined ? '(no root supplied)' : `${opts.rootPath}/bin/`} ` +
      `and $PATH. Install the binary into <root>/bin/ or add it to PATH.`,
  );
}
