/**
 * Cache-cleaner — doctor-hook that deletes tarball cache entries
 * older than the configured retention per ADR-0009 (Phase 5f).
 *
 * Only `*.tar.gz` files at the top level of the cache dir are
 * touched. Sub-directories and non-tarball files (e.g. partial
 * `.tmp-` writes from a crashed install) are left alone — caller
 * decides whether to garbage-collect those.
 *
 * @module @domains/catalog/cache-cleaner
 */
import { type Dirent, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface CleanResult {
  readonly removedCount: number;
  readonly removedBytes: number;
  readonly remainingCount: number;
  readonly errors: readonly string[];
}

interface CleanOpts {
  readonly cacheDir: string;
  /** Files older than this (mtime) are removed. */
  readonly maxAgeMs: number;
  /** Override clock (tests). */
  readonly now?: () => Date;
}

const TARBALL_PATTERN = /\.tar\.gz$/i;

export function cleanTarballCache(opts: CleanOpts): CleanResult {
  if (!existsSync(opts.cacheDir)) {
    return { removedCount: 0, removedBytes: 0, remainingCount: 0, errors: [] };
  }
  const now = (opts.now ?? (() => new Date()))().getTime();
  const threshold = now - opts.maxAgeMs;
  let removedCount = 0;
  let removedBytes = 0;
  let remainingCount = 0;
  const errors: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(opts.cacheDir, { withFileTypes: true, encoding: 'utf8' }) as Dirent[];
  } catch (err) {
    errors.push(
      `cannot read ${opts.cacheDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { removedCount, removedBytes, remainingCount, errors };
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!TARBALL_PATTERN.test(entry.name)) continue;
    const path = join(opts.cacheDir, entry.name);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(path);
    } catch (err) {
      errors.push(`cannot stat ${path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (s.mtimeMs >= threshold) {
      remainingCount += 1;
      continue;
    }
    try {
      unlinkSync(path);
      removedCount += 1;
      removedBytes += s.size;
    } catch (err) {
      errors.push(`cannot unlink ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { removedCount, removedBytes, remainingCount, errors };
}

export const DEFAULT_TARBALL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
