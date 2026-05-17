/**
 * applyLock — extracts the lock-cached tarballs into per-kind install
 * directories. Closes the `catalog sync` Phase-6-hint.
 *
 * For every lock entry that has a matching enabled catalog entry:
 *   1. Look up `<cacheDir>/<sha256>.tar.gz` (populated by `lock` or
 *      `install`). Missing -> error for that entry, continue.
 *   2. mkdir <root>/config/<bucket>/<id>  (idempotent).
 *   3. tar.extract strip=1 (github tarballs always nest one wrapper
 *      directory <repo>-<sha>/).
 *
 * Buckets per kind:
 *   skill  -> skills/
 *   plugin -> plugins/
 *   mcp    -> mcp/
 *
 * Out of scope for v1: removing stale install dirs (entries that are
 * in the lock but absent / disabled in catalog stay on disk). A future
 * `--prune` flag can address that.
 *
 * Returns `{ applied, skipped, errors }` so the CLI can report each
 * outcome explicitly.
 *
 * @module @domains/catalog/sync-applier
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { extract as tarExtract } from 'tar';
import type { CatalogConfig, CatalogEntry, CatalogLock, CatalogLockEntry } from './schema.js';

const BUCKET_BY_KIND = {
  skill: 'skills',
  plugin: 'plugins',
  mcp: 'mcp',
} as const satisfies Record<CatalogEntry['kind'], string>;

export interface SyncApplyOpts {
  readonly root: string;
  readonly catalog: CatalogConfig;
  readonly lock: CatalogLock;
  readonly cacheDir: string;
  /** Strip leading path components on tar.extract. Default 1 (github wrapper). */
  readonly stripComponents?: number;
  /** Override tar.extract for tests. */
  readonly extract?: (opts: { file: string; cwd: string; strip: number }) => Promise<void>;
}

export interface SyncAppliedEntry {
  readonly id: string;
  readonly destination: string;
  readonly sha256: string;
}

export interface SyncSkipReason {
  readonly id: string;
  readonly reason: string;
}

export interface SyncError {
  readonly id: string;
  readonly message: string;
}

export interface SyncApplyResult {
  readonly applied: readonly SyncAppliedEntry[];
  readonly skipped: readonly SyncSkipReason[];
  readonly errors: readonly SyncError[];
}

function destinationFor(root: string, entry: CatalogEntry): string {
  return join(root, 'config', BUCKET_BY_KIND[entry.kind], entry.id);
}

export async function applyLock(opts: SyncApplyOpts): Promise<SyncApplyResult> {
  const strip = opts.stripComponents ?? 1;
  const extract =
    opts.extract ??
    (async (e) => {
      await tarExtract(e);
    });

  const catalogById = new Map<string, CatalogEntry>(opts.catalog.entries.map((e) => [e.id, e]));
  const applied: SyncAppliedEntry[] = [];
  const skipped: SyncSkipReason[] = [];
  const errors: SyncError[] = [];

  for (const lockEntry of opts.lock.entries) {
    const catalogEntry = catalogById.get(lockEntry.id);
    if (catalogEntry === undefined) {
      skipped.push({
        id: lockEntry.id,
        reason: 'present in lock but absent from catalog.json — run `catalog lock` to refresh',
      });
      continue;
    }
    if (!catalogEntry.enabled) {
      skipped.push({ id: lockEntry.id, reason: 'disabled in catalog.json' });
      continue;
    }
    const archive = join(opts.cacheDir, `${lockEntry.sha256}.tar.gz`);
    if (!existsSync(archive)) {
      errors.push({
        id: lockEntry.id,
        message: `cached tarball missing at ${archive} — run \`catalog lock\` to repopulate`,
      });
      continue;
    }
    const destination = destinationFor(opts.root, catalogEntry);
    try {
      mkdirSync(destination, { recursive: true });
      await extract({ file: archive, cwd: destination, strip });
    } catch (err) {
      errors.push({
        id: lockEntry.id,
        message: `tar extract failed for ${archive} -> ${destination}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      continue;
    }
    applied.push({ id: lockEntry.id, destination, sha256: lockEntry.sha256 });
  }

  return { applied, skipped, errors };
}

/** Exposed for the CLI / future sidecar diff views. */
export function installDestinationFor(root: string, entry: CatalogEntry): string {
  return destinationFor(root, entry);
}

/**
 * Internal helper for `update <id>`: produce a fresh lock that
 * preserves all existing entries EXCEPT `id`, which is replaced by
 * `newEntry`. If `id` is not in the existing lock the new entry is
 * appended.
 */
export function mergeLockEntry(
  existing: CatalogLock,
  id: string,
  newEntry: CatalogLockEntry | null,
  nowIso: string,
): CatalogLock {
  const others = existing.entries.filter((e) => e.id !== id);
  const entries = newEntry === null ? others : [...others, newEntry];
  return { version: 1, resolvedAt: nowIso, entries };
}
