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
 * Bindings (Phase 5o): for each `kind: 'plugin'` entry the cached
 * tarball is peeked for `plugin.json`. All successfully read manifests
 * are aggregated into a single `Catalog`, then `resolveCapabilities`
 * runs per plugin to compute the lock's `bindings` array. Resolver
 * errors emit warnings and degrade gracefully (the entry stays in the
 * lock with `bindings: []` rather than crashing the whole build).
 *
 * Skill and mcp entries remain binding-less by construction — they are
 * leaves in the capability graph (no requires/provides) per ADR-0010.
 *
 * Returns `{ lock, warnings }` so the CLI can both write the lock and
 * surface the skipped/failed entries.
 *
 * @module @domains/catalog/lock-builder
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BindingInput, resolveBindings } from './binding-resolver.js';
import type { PluginManifest } from './capability-resolver.js';
import type { CatalogConfig, CatalogEntry, CatalogLock, CatalogLockEntry } from './schema.js';
import { githubTarballUrl, parseSource, SourceParseError } from './source-resolver.js';
import {
  type ManifestReadResult,
  NO_MANIFEST_REASON,
  readPluginManifestFromTarball,
} from './tarball-manifest-reader.js';

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
  /**
   * Injectable manifest reader for tests. Defaults to the tarball-peek
   * implementation in `tarball-manifest-reader.ts`.
   */
  readonly readManifest?: (tarballPath: string) => Promise<ManifestReadResult>;
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

interface FetchedEntry {
  readonly entry: CatalogEntry;
  readonly sha256: string;
  readonly resolvedRef: string;
}

export async function lockCatalog(opts: LockBuilderOpts): Promise<LockBuilderResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new LockBuilderError(
      'lockCatalog requires a fetch implementation (none on globalThis, none injected)',
    );
  }
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const readManifest = opts.readManifest ?? readPluginManifestFromTarball;

  // ---- Pass 1: fetch+cache every github tarball, skip non-github. ----
  const fetched: FetchedEntry[] = [];
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
    fetched.push({ entry, sha256, resolvedRef: parsed.ref ?? 'HEAD' });
  }

  // ---- Pass 2: peek plugin.json out of every plugin-kind tarball. ----
  const bindingInputs: BindingInput[] = [];
  const manifestById = new Map<string, PluginManifest>();
  for (const f of fetched) {
    if (f.entry.kind !== 'plugin') continue;
    const tarballPath = join(opts.cacheDir, `${f.sha256}.tar.gz`);
    let manifestResult: ManifestReadResult;
    try {
      manifestResult = await readManifest(tarballPath);
    } catch (err) {
      warnings.push(
        `${f.entry.id}: manifest read errored: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (manifestResult.ok === false) {
      // A genuinely missing plugin.json is v1-reality for the long tail
      // of plugins that pre-date ADR-0010 manifests — keep silent.
      // Malformed manifests (parse/schema failures) are surfaced so the
      // author can fix them.
      if (manifestResult.reason !== NO_MANIFEST_REASON) {
        warnings.push(`${f.entry.id}: ${manifestResult.reason}`);
      }
      continue;
    }
    bindingInputs.push({ catalogId: f.entry.id, manifest: manifestResult.manifest });
    manifestById.set(f.entry.id, manifestResult.manifest);
  }

  // ---- Pass 3: resolve bindings against the aggregate catalog. ----
  const bindingResults = resolveBindings(bindingInputs);
  for (const result of bindingResults.values()) {
    if (result.warning !== undefined) warnings.push(result.warning);
  }

  // ---- Pass 4: emit lock entries with their (possibly empty) bindings. ----
  const entries: CatalogLockEntry[] = fetched.map((f) => ({
    id: f.entry.id,
    source: f.entry.source,
    sha256: f.sha256,
    resolvedRef: f.resolvedRef,
    bindings: [...(bindingResults.get(f.entry.id)?.bindings ?? [])],
  }));

  return {
    lock: {
      version: 1,
      resolvedAt: nowIso(),
      entries,
    },
    warnings,
  };
}
