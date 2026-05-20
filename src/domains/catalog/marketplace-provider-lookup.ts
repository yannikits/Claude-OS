/**
 * marketplace-provider-lookup — baut einen `ProviderLookup`
 * (siehe auto-deps-resolver.ts) gegen eine `MarketplaceRegistry`.
 *
 * Approach (v1.5-pragmatisch):
 *  1. Beim ersten Call iteriert der Lookup alle Marketplaces × alle
 *     Plugins, ruft `MarketplaceRegistry.resolve(marketplace, plugin)`
 *     fuer den github-Source, fetcht das Tarball, peekt das
 *     plugin.json. Manifest landet in einer in-memory Map mit Key
 *     `<marketplace>:<plugin>`.
 *  2. Pro Capability werden alle Plugins durchsucht deren manifest
 *     `provides`-Eintrag matched.
 *  3. Resultat wird gecached fuer die Dauer eines Lookup-Runs.
 *
 * Optimierung deferred (v1.6):
 *  - On-Disk-Index (`<dataDir>/marketplace-capability-index.json`)
 *  - ETag-basierte Re-Validierung pro Manifest
 *  - Parallel-Fetches mit Concurrency-Cap
 *
 * @module @domains/catalog/marketplace-provider-lookup
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MarketplaceCandidate, ProviderLookup } from './auto-deps-resolver.js';
import { type Capability, parseCapability } from './capability.js';
import type { PluginManifest } from './capability-resolver.js';
import type { MarketplaceRegistry } from './marketplace-registry.js';
import { githubTarballUrl, type ParsedGithubSource } from './source-resolver.js';
import {
  type ManifestReadResult,
  readPluginManifestFromTarball,
} from './tarball-manifest-reader.js';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type ReadManifest = (tarballPath: string) => Promise<ManifestReadResult>;

export interface MarketplaceProviderLookupOpts {
  readonly registry: MarketplaceRegistry;
  /** Cache-Dir fuer Tarballs (typischerweise `<dataDir>/marketplace-cache`). */
  readonly cacheDir: string;
  /** Injectable fuer Tests. Default `globalThis.fetch`. */
  readonly fetch?: FetchFn;
  /** Injectable fuer Tests. Default `readPluginManifestFromTarball`. */
  readonly readManifest?: ReadManifest;
}

interface ResolvedMarketplaceEntry {
  readonly marketplace: string;
  readonly plugin: string;
  readonly source: string; // `marketplace:<marketplace>:<plugin>`
  readonly parsed: ParsedGithubSource;
}

async function fetchAndCacheTarball(
  url: string,
  cacheDir: string,
  fetchImpl: FetchFn,
): Promise<string> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`fetch ${url} returned HTTP ${response.status} ${response.statusText}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex').toLowerCase();
  mkdirSync(cacheDir, { recursive: true });
  const finalPath = join(cacheDir, `${sha}.tar.gz`);
  if (!existsSync(finalPath)) {
    const tmp = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, buf, { mode: 0o644 });
    renameSync(tmp, finalPath);
  }
  return finalPath;
}

/**
 * Erstellt den `ProviderLookup` fuer `resolveAutoDeps`. Lazy-initialisiert:
 * die Marketplace-Iteration + Manifest-Peek passiert beim ersten Call.
 *
 * Wirft NICHT bei einzelnen Manifest-Lese-Fehlern — die werden als
 * "kein passender Provider" interpretiert und nur die Plugins die
 * sauber laden zaehlen.
 */
export function createMarketplaceProviderLookup(
  opts: MarketplaceProviderLookupOpts,
): ProviderLookup {
  const resolvedFetch = opts.fetch ?? (globalThis.fetch as FetchFn | undefined);
  const readManifest = opts.readManifest ?? readPluginManifestFromTarball;
  if (typeof resolvedFetch !== 'function') {
    throw new Error(
      'createMarketplaceProviderLookup: no fetch implementation (globalThis.fetch unavailable, none injected)',
    );
  }
  const fetchImpl: FetchFn = resolvedFetch;

  const manifestsBySource = new Map<string, PluginManifest>();
  let indexBuilt = false;

  async function buildIndex(): Promise<void> {
    if (indexBuilt) return;
    const marketplaces = await opts.registry.marketplaces();
    const entries: ResolvedMarketplaceEntry[] = [];
    for (const marketplace of marketplaces) {
      const plugins = await opts.registry.plugins(marketplace);
      for (const plugin of plugins) {
        try {
          const parsed = await opts.registry.resolve(marketplace, plugin);
          entries.push({
            marketplace,
            plugin,
            source: `marketplace:${marketplace}:${plugin}`,
            parsed,
          });
        } catch {
          // einzelner Resolve-Fail soll andere Plugins nicht blockieren
        }
      }
    }
    for (const entry of entries) {
      let tarballPath: string;
      try {
        tarballPath = await fetchAndCacheTarball(
          githubTarballUrl(entry.parsed),
          opts.cacheDir,
          fetchImpl,
        );
      } catch {
        continue; // Tarball nicht erreichbar -> Plugin nicht beruecksichtigen
      }
      let manifestResult: ManifestReadResult;
      try {
        manifestResult = await readManifest(tarballPath);
      } catch {
        continue;
      }
      if (manifestResult.ok === false) continue;
      manifestsBySource.set(entry.source, manifestResult.manifest);
    }
    indexBuilt = true;
  }

  return async (wanted: Capability): Promise<readonly MarketplaceCandidate[]> => {
    await buildIndex();
    const matches: MarketplaceCandidate[] = [];
    for (const [source, manifest] of manifestsBySource.entries()) {
      const provides = manifest.provides ?? [];
      for (const rawProvided of provides) {
        let providedCap: Capability;
        try {
          providedCap = parseCapability(rawProvided);
        } catch {
          continue;
        }
        if (providedCap.kind === wanted.kind && providedCap.name === wanted.name) {
          // Wenn Version-Constraint da war, muesste hier zusaetzlich
          // gegen die provider-Version gematcht werden. Fuer v1.5
          // delegieren wir das an den binding-resolver (der ohnehin
          // die finale Version-Pruefung macht). Hier matchen wir nur
          // auf kind+name.
          matches.push({ manifest, source });
          break;
        }
      }
    }
    // Deterministische Reihenfolge: nach manifest.id alphabetisch.
    matches.sort((a, b) =>
      a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0,
    );
    return matches;
  };
}

/** Helper fuer Tests + Sidecar — Probe-Cache fuer den Index reset. */
export function clearMarketplaceProviderCache(_lookup: ProviderLookup): void {
  // No-op v1.5 — der Lookup-State ist closure-scoped. Caller muss
  // einen frischen Lookup bauen wenn ein Refresh gewuenscht ist.
  // Folge-PR baut einen explizit invalidierbaren Cache.
  void _lookup;
}
