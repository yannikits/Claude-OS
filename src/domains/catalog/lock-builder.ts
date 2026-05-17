/**
 * lockCatalog — produces a CatalogLock snapshot from a CatalogConfig.
 *
 * Closes the github branch of the "Phase 6 sidecar" mutation hint for
 * the `catalog lock` subcommand. For each catalog entry:
 *   - github:  download the tarball, compute sha256, cache it under
 *              `<cacheDir>/<sha256>.tar.gz` (same layout the Phase 5e
 *              tarball-installer uses, so a later `catalog sync` can
 *              reuse the file without re-downloading).
 *   - local:   skipped with a warning (no clean directory-hash story
 *              in v1).
 *   - marketplace: skipped with a warning (needs the resolved
 *              github:* coordinate from the registry — Phase 5n).
 *
 * Bindings stay empty until the full capability resolver integration
 * (Phase 5n) reads each entry's plugin.json + runs `resolveCapabilities`.
 *
 * Returns `{ lock, warnings }` so the CLI can both write the lock and
 * surface the skipped/failed entries.
 *
 * @module @domains/catalog/lock-builder
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogConfig, CatalogLock, CatalogLockEntry } from './schema.js';
import { githubTarballUrl, parseSource, SourceParseError } from './source-resolver.js';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class LockBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockBuilderError';
  }
}

export interface LockBuilderOpts {
  readonly catalog: CatalogConfig;
  /** Tarball cache (shared with tarball-installer). */
  readonly cacheDir: string;
  /** Injectable for tests. Defaults to `globalThis.fetch`. */
  readonly fetch?: FetchFn;
  /** Injectable clock for tests. Defaults to `() => new Date().toISOString()`. */
  readonly nowIso?: () => string;
}

export interface LockBuilderResult {
  readonly lock: CatalogLock;
  /**
   * Per-entry skip/fail messages (id-prefixed). Non-fatal; the caller
   * decides whether to render them or change exit codes.
   */
  readonly warnings: readonly string[];
}

async function fetchAndCacheTarball(
  url: string,
  cacheDir: string,
  fetchImpl: FetchFn,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    throw new LockBuilderError(
      `network fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new LockBuilderError(
      `fetch ${url} returned HTTP ${response.status} ${response.statusText}`,
    );
  }
  const buf = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(buf).digest('hex').toLowerCase();
  mkdirSync(cacheDir, { recursive: true });
  const finalPath = join(cacheDir, `${sha256}.tar.gz`);
  if (!existsSync(finalPath)) {
    const tmp = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, buf, { mode: 0o644 });
    renameSync(tmp, finalPath);
  }
  return sha256;
}

export async function lockCatalog(opts: LockBuilderOpts): Promise<LockBuilderResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new LockBuilderError(
      'lockCatalog requires a fetch implementation (none on globalThis, none injected)',
    );
  }
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());

  const entries: CatalogLockEntry[] = [];
  const warnings: string[] = [];

  for (const entry of opts.catalog.entries) {
    let parsed: ReturnType<typeof parseSource>;
    try {
      parsed = parseSource(entry.source);
    } catch (err) {
      warnings.push(
        `${entry.id}: source "${entry.source}" parse failed: ${
          err instanceof SourceParseError ? err.message : String(err)
        }`,
      );
      continue;
    }
    if (parsed.kind === 'marketplace') {
      warnings.push(
        `${entry.id}: marketplace: source skipped — needs registry resolution (Phase 5n)`,
      );
      continue;
    }
    if (parsed.kind === 'local') {
      warnings.push(`${entry.id}: local: source skipped — no directory-hash story in v1`);
      continue;
    }
    const url = githubTarballUrl(parsed);
    let sha256: string;
    try {
      sha256 = await fetchAndCacheTarball(url, opts.cacheDir, fetchImpl);
    } catch (err) {
      warnings.push(
        `${entry.id}: tarball fetch failed for ${url}: ${
          err instanceof LockBuilderError ? err.message : String(err)
        }`,
      );
      continue;
    }
    const resolvedRef = parsed.ref ?? 'HEAD';
    entries.push({
      id: entry.id,
      source: entry.source,
      sha256,
      resolvedRef,
      bindings: [],
    });
  }

  return {
    lock: {
      version: 1,
      resolvedAt: nowIso(),
      entries,
    },
    warnings,
  };
}
