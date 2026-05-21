/**
 * Pure-Function-Wrapper um den Auto-Deps-Install-Flow (Phase 5p/5q/5r).
 *
 * Extrahiert aus `src/cli/commands/catalog.ts:actAutoDeps`. Print-freie
 * Variante: throws bei jedem Fehler, returnt strukturiertes Ergebnis bei
 * Erfolg. Wird vom CLI UND vom Sidecar verwendet (damit die GUI den
 * gleichen Flow ueber einen RPC-Call anstossen kann).
 *
 * Sequence:
 *  1. Target-Tarball fetchen via lockCatalog-Stub
 *  2. plugin.json peeken
 *  3. Marketplace-Provider-Lookup bauen
 *  4. resolveAutoDeps gegen den existierenden Catalog
 *  5. writeCatalog mit merged Eintraegen
 *  6. lockCatalog + writeCatalogLock
 *  7. applyLock fuer FS-Extract
 *
 * @module @domains/catalog/auto-deps-install
 */

import { join } from 'node:path';
import {
  AmbiguousProviderError as AutoDepsAmbiguousProviderError,
  AutoDepsError,
  MissingProviderError as AutoDepsMissingProviderError,
  resolveAutoDeps,
} from './auto-deps-resolver.js';
import type { PluginManifest } from './capability-resolver.js';
import { catalogPathsFor, readCatalog, writeCatalog, writeCatalogLock } from './catalog-store.js';
import { LockBuilderError, lockCatalog } from './lock-builder.js';
import { createMarketplaceProviderLookup } from './marketplace-provider-lookup.js';
import { fileLoader, MarketplaceRegistry } from './marketplace-registry.js';
import type { CatalogEntry } from './schema.js';
import { parseSource, SourceParseError } from './source-resolver.js';
import { applyLock, type SyncApplyResult } from './sync-applier.js';
import { readPluginManifestFromTarball } from './tarball-manifest-reader.js';

export interface AutoDepsInstallOpts {
  /** Source-String (nur `github:` in v1.5 unterstuetzt). */
  readonly source: string;
  /** Pfad zur marketplace-registry.json. */
  readonly registryPath: string;
  /** Claude-OS-Root (typically resolveRoot().path). */
  readonly root: string;
  /** Cache-Dir fuer Tarballs (typically dataRoot/tarballs). */
  readonly cacheDir: string;
}

export interface AutoDepsInstallResult {
  readonly targetManifest: PluginManifest;
  readonly newEntries: readonly CatalogEntry[];
  readonly iterations: number;
  readonly applyResult: SyncApplyResult;
  readonly catalogPath: string;
  readonly lockPath: string;
  readonly lockWarnings: readonly string[];
}

export class AutoDepsInstallError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'AutoDepsInstallError';
    this.code = code;
  }
}

export async function installFromGithubWithAutoDeps(
  opts: AutoDepsInstallOpts,
): Promise<AutoDepsInstallResult> {
  // Parse Source
  let parsed: ReturnType<typeof parseSource>;
  try {
    parsed = parseSource(opts.source);
  } catch (err) {
    throw new AutoDepsInstallError(
      `Source parse fehlgeschlagen: ${err instanceof SourceParseError ? err.message : String(err)}`,
      'source-parse',
    );
  }
  if (parsed.kind !== 'github') {
    throw new AutoDepsInstallError(
      `Nur github: Sources unterstuetzt (got ${parsed.kind})`,
      'unsupported-source',
    );
  }

  // Target Tarball ueber Stub-Catalog fetchen
  const stubCatalog = {
    version: 1 as const,
    entries: [
      {
        id: `auto-deps-target-${parsed.owner}-${parsed.repo}`,
        kind: 'plugin' as const,
        source: opts.source,
        enabled: true,
        scope: 'user' as const,
      },
    ],
  };
  let stubLock: Awaited<ReturnType<typeof lockCatalog>>;
  try {
    stubLock = await lockCatalog({ catalog: stubCatalog, cacheDir: opts.cacheDir });
  } catch (err) {
    throw new AutoDepsInstallError(
      `Target-Fetch fehlgeschlagen: ${err instanceof LockBuilderError ? err.message : String(err)}`,
      'target-fetch',
    );
  }
  const targetLockEntry = stubLock.lock.entries[0];
  if (targetLockEntry === undefined) {
    throw new AutoDepsInstallError(
      `Target-Tarball konnte nicht gefetched werden (${stubLock.warnings.join('; ')})`,
      'target-fetch',
    );
  }
  const targetTarball = join(opts.cacheDir, `${targetLockEntry.sha256}.tar.gz`);
  const targetManifestRead = await readPluginManifestFromTarball(targetTarball);
  if (targetManifestRead.ok === false) {
    throw new AutoDepsInstallError(
      `Target hat kein lesbares plugin.json (${targetManifestRead.reason})`,
      'target-manifest',
    );
  }
  const targetManifest = targetManifestRead.manifest;

  // Provider-Lookup + Resolver
  const registry = new MarketplaceRegistry({ load: fileLoader(opts.registryPath) });
  const providerLookup = createMarketplaceProviderLookup({
    registry,
    cacheDir: opts.cacheDir,
  });

  const catalogPaths = catalogPathsFor(opts.root);
  const existingCatalog = readCatalog(catalogPaths.catalogPath);
  const existingManifests = new Map<string, PluginManifest>();
  existingManifests.set(targetManifest.id, targetManifest);

  // Codex-Review HIGH/MEDIUM finding #3: existing catalog-entries
  // hydraten damit der Resolver weiss welche Capabilities bereits durch
  // installierte Plugins gedeckt sind. Ohne diese Hydration installiert
  // auto-deps Duplikate oder schlaegt mit "missing provider" fehl wenn
  // die Capability lokal eigentlich schon vorhanden ist.
  //
  // Wir lesen die Manifests aus dem existing lock.json (jedes lockEntry
  // hat eine sha256 -> Tarball im cacheDir). Wenn ein Plugin noch nicht
  // gelockt ist (z. B. weil catalog lock noch nicht lief), wird es
  // einfach uebersprungen — pessimistic-by-default ist OK.
  const existingLockPath = catalogPaths.lockPath;
  try {
    const existingLockMod = await import('./catalog-store.js');
    const existingLock = existingLockMod.readCatalogLock(existingLockPath);
    if (existingLock !== null) {
      for (const lockEntry of existingLock.entries) {
        if (lockEntry.sha256.length === 0) continue;
        const installedTarball = join(opts.cacheDir, `${lockEntry.sha256}.tar.gz`);
        try {
          const installedManifest = await readPluginManifestFromTarball(installedTarball);
          if (installedManifest.ok === true) {
            // Bereits durch Target gesetzt? -> Target hat Vorrang.
            if (!existingManifests.has(installedManifest.manifest.id)) {
              existingManifests.set(installedManifest.manifest.id, installedManifest.manifest);
            }
          }
        } catch {
          // Tarball nicht lesbar -> Plugin nicht hydraten, Resolver
          // sieht es als nicht-installiert. Saubere graceful degradation.
        }
      }
    }
  } catch {
    // readCatalogLock kann throwen wenn die lock.json malformed ist —
    // wir lassen den Resolver dann mit nur dem Target arbeiten.
  }

  let resolution: Awaited<ReturnType<typeof resolveAutoDeps>>;
  try {
    resolution = await resolveAutoDeps({
      catalog: existingCatalog,
      existingManifests,
      lookupProvider: providerLookup,
    });
  } catch (err) {
    if (err instanceof AutoDepsMissingProviderError) {
      throw new AutoDepsInstallError(
        `Missing provider: capability "${err.capability}" (required by "${err.requiredBy}")`,
        'missing-provider',
      );
    }
    if (err instanceof AutoDepsAmbiguousProviderError) {
      throw new AutoDepsInstallError(
        `Ambiguous provider fuer "${err.capability}": ${err.candidates.join(', ')}`,
        'ambiguous-provider',
      );
    }
    if (err instanceof AutoDepsError) {
      throw new AutoDepsInstallError(err.message, 'auto-deps-error');
    }
    throw err;
  }

  // Codex-Review HIGH finding #2: TRANSAKTIONALE Persistence.
  //
  // Vorher: writeCatalog -> lockCatalog -> writeCatalogLock -> applyLock.
  // Problem: bei lockCatalog-Failure wurde die catalog.json bereits
  // ueberschrieben, aber die lock.json verweist noch auf alten Stand.
  // Resultat: User hat Catalog mit Entries fuer die kein Lock existiert
  // (Bindings koennen nicht resolvt werden, sync schlaegt fehl).
  //
  // Neue Reihenfolge: erst Lock IN-MEMORY bauen, erst dann beide Files
  // gemeinsam persistieren. applyLock kommt danach — wenn es throwt sind
  // catalog+lock zumindest konsistent zueinander und ein nachtraegliches
  // `catalog sync` reicht zum Reparieren.
  const targetEntry: CatalogEntry = {
    id: targetManifest.id,
    kind: 'plugin',
    source: opts.source,
    enabled: true,
    scope: 'user',
  };
  const mergedEntries: CatalogEntry[] = [];
  for (const e of existingCatalog.entries) {
    if (e.id === targetEntry.id) continue;
    mergedEntries.push(e);
  }
  mergedEntries.push(targetEntry);
  for (const e of resolution.newEntries) {
    if (mergedEntries.some((m) => m.id === e.id)) continue;
    mergedEntries.push(e);
  }
  const newCatalog = { version: 1 as const, entries: mergedEntries };

  // Phase 1: Lock IN-MEMORY bauen — kein FS-Write bisher
  let newLock: Awaited<ReturnType<typeof lockCatalog>>;
  try {
    newLock = await lockCatalog({ catalog: newCatalog, cacheDir: opts.cacheDir });
  } catch (err) {
    throw new AutoDepsInstallError(
      `Lock-Build nach Catalog-Update fehlgeschlagen: ${err instanceof LockBuilderError ? err.message : String(err)}`,
      'lock-build',
    );
  }

  // Phase 2: BEIDE Files persistieren — catalog.json + catalog.lock.json
  // sind ab jetzt konsistent zueinander.
  writeCatalog(catalogPaths.catalogPath, newCatalog);
  writeCatalogLock(catalogPaths.lockPath, newLock.lock);

  // Phase 3: applyLock — extrahiert Tarballs auf das FS. Wenn das
  // fehlschlaegt, sind catalog+lock konsistent aber das FS evtl. nicht.
  // applyLock ist idempotent (skip-on-existing), ein nachtraegliches
  // `catalog sync` repariert.
  const applyResult = await applyLock({
    root: opts.root,
    catalog: newCatalog,
    lock: newLock.lock,
    cacheDir: opts.cacheDir,
  });

  return {
    targetManifest,
    newEntries: resolution.newEntries,
    iterations: resolution.iterations,
    applyResult,
    catalogPath: catalogPaths.catalogPath,
    lockPath: catalogPaths.lockPath,
    lockWarnings: newLock.warnings,
  };
}
