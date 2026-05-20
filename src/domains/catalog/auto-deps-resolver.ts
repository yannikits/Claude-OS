/**
 * Auto-Deps-Resolver — implementiert `catalog install --auto-deps` per
 * docs/specs/auto-deps-flag.md (v1.5).
 *
 * Approach: iterative-fixed-point ueber `lockCatalog` + Marketplace-
 * Provider-Lookup. Pro Iteration:
 *  1. lockCatalog laeuft, gibt fuer jeden Plugin-Entry ein
 *     ResolutionResult oder per-Entry-Warning zurueck.
 *  2. Warnings vom Form `binding resolution failed: no installed
 *     plugin provides capability "X" (required by "Y")` werden
 *     extrahiert.
 *  3. Fuer jede unerfuellbare Capability sucht der MarketplaceProvider-
 *     Index nach einem Plugin das sie `provides`.
 *  4. Die gefundenen Provider werden in `newEntries` aufgenommen
 *     und dem Catalog hinzugefuegt.
 *  5. Naechste Iteration — solange noch unmet requires existieren UND
 *     der Visited-Set NICHT cycled.
 *
 * Cycle-Detection: pro Run wird ein `visited`-Set gefuehrt; wenn
 * ein bereits visited Plugin erneut als neuer Provider auftaucht,
 * wirft der Resolver `CyclicDependencyError`.
 *
 * @module @domains/catalog/auto-deps-resolver
 */

import { resolveBindings } from './binding-resolver.js';
import type { Capability } from './capability.js';
import { parseCapability } from './capability.js';
import type { PluginManifest } from './capability-resolver.js';
import type { CatalogConfig, CatalogEntry } from './schema.js';
import type { ManifestReadResult, ReadOpts } from './tarball-manifest-reader.js';

export class AutoDepsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutoDepsError';
  }
}

export class CyclicAutoDepsError extends AutoDepsError {
  constructor(public readonly cycle: readonly string[]) {
    super(`cyclic dependency in auto-deps: ${cycle.join(' -> ')}`);
    this.name = 'CyclicAutoDepsError';
  }
}

export class MissingProviderError extends AutoDepsError {
  constructor(
    public readonly capability: string,
    public readonly requiredBy: string,
  ) {
    super(
      `no marketplace provider found for capability "${capability}" (required by "${requiredBy}")`,
    );
    this.name = 'MissingProviderError';
  }
}

export class AmbiguousProviderError extends AutoDepsError {
  constructor(
    public readonly capability: string,
    public readonly candidates: readonly string[],
  ) {
    super(
      `multiple marketplace providers for capability "${capability}": ${candidates.join(', ')}`,
    );
    this.name = 'AmbiguousProviderError';
  }
}

/**
 * Beschreibt einen Marketplace-Provider-Kandidaten: Plugin-Manifest
 * (mit `provides`) + zugehoeriger `source`-String, den wir spaeter
 * in den Catalog schreiben.
 */
export interface MarketplaceCandidate {
  readonly manifest: PluginManifest;
  readonly source: string;
}

/**
 * Lookup-Funktion die fuer eine gewuenschte Capability alle
 * Marketplace-Plugins zurueckgibt die diese providen. Wird vom
 * Caller (CLI) gestellt — z. B. via MarketplaceRegistry +
 * Manifest-Reader.
 */
export type ProviderLookup = (cap: Capability) => Promise<readonly MarketplaceCandidate[]>;

export interface ResolveAutoDepsOpts {
  /** Catalog vor dem auto-deps-Run. */
  readonly catalog: CatalogConfig;
  /**
   * Manifeste der Plugin-Entries aus dem Catalog. Brauchen wir um die
   * binding-resolver-Logik mit den existierenden Plugins zu fuettern.
   * Caller liefert sie typically via tarball-manifest-reader.
   */
  readonly existingManifests: ReadonlyMap<string, PluginManifest>;
  /** Marketplace-Provider-Lookup. */
  readonly lookupProvider: ProviderLookup;
  /** Max-Iterations Cap — Schutz gegen Bug-Cycles (default 5). */
  readonly maxIterations?: number;
}

export interface AutoDepsResolution {
  /**
   * Neue Plugin-Entries die der Catalog ergaenzen muss, in
   * DFS-Reihenfolge (Provider vor Consumer).
   */
  readonly newEntries: readonly CatalogEntry[];
  /** Bindings die nach allen Iterationen RESOLVED sind. */
  readonly resolvedBindings: ReadonlyMap<
    string,
    readonly { capability: string; providedBy: string }[]
  >;
  /**
   * Manifeste die hinzugekommen sind (catalogId -> manifest). Enthaelt
   * sowohl existing als auch new — vereinfacht spaetere lockCatalog-
   * Calls.
   */
  readonly aggregateManifests: ReadonlyMap<string, PluginManifest>;
  /** Iterations-Anzahl bis Fixpoint. */
  readonly iterations: number;
}

/**
 * Pure-Function-Resolver. FETCHT NICHTS — der Caller liefert die
 * `lookupProvider`-Funktion, die intern Tarballs herunterladen und
 * Manifeste peeken kann.
 *
 * Wirft `AutoDepsError`-Subtypen bei nicht-resolvebaren Konflikten.
 */
export async function resolveAutoDeps(opts: ResolveAutoDepsOpts): Promise<AutoDepsResolution> {
  const maxIterations = opts.maxIterations ?? 5;
  const aggregateManifests = new Map<string, PluginManifest>(opts.existingManifests);
  const newEntries: CatalogEntry[] = [];
  const visited = new Set<string>([...aggregateManifests.keys()]);

  let iteration = 0;
  while (iteration < maxIterations) {
    iteration++;

    // Build current binding inputs from all known manifests
    const inputs = Array.from(aggregateManifests.entries()).map(([id, manifest]) => ({
      catalogId: id,
      manifest,
    }));
    const bindings = resolveBindings(inputs);

    // Find first unmet requirement to resolve in this iteration. We
    // process one capability at a time to keep cycle-detection simple
    // and the install-order deterministic.
    const unmet = collectUnmetCapabilities(bindings);
    if (unmet.length === 0) {
      // Fixed-point reached — alle Bindings sind resolved.
      const resolvedBindings = new Map(
        Array.from(bindings.entries()).map(([id, r]) => [id, r.bindings] as const),
      );
      return {
        newEntries,
        resolvedBindings,
        aggregateManifests,
        iterations: iteration,
      };
    }

    // Resolve genau EIN unmet capability per Iteration — fairnes
    // gegenueber Cycle-Detection. Andere unmet caps werden in der
    // naechsten Iteration adressiert (wo sie evtl. schon durch den
    // jetzt-installierten Provider mit-gelöst sind).
    const next = unmet[0];
    if (next === undefined) break;
    const cap = parseCapability(next.capability);
    const candidates = await opts.lookupProvider(cap);
    if (candidates.length === 0) {
      throw new MissingProviderError(next.capability, next.requiredBy);
    }
    if (candidates.length > 1) {
      throw new AmbiguousProviderError(
        next.capability,
        candidates.map((c) => c.manifest.id),
      );
    }
    const chosen = candidates[0];
    if (chosen === undefined) {
      throw new MissingProviderError(next.capability, next.requiredBy);
    }
    if (visited.has(chosen.manifest.id)) {
      // Cycle detected — same id already added; further requires
      // refer back to it.
      throw new CyclicAutoDepsError([...visited, chosen.manifest.id]);
    }
    visited.add(chosen.manifest.id);
    aggregateManifests.set(chosen.manifest.id, chosen.manifest);
    newEntries.push({
      id: chosen.manifest.id,
      kind: 'plugin',
      source: chosen.source,
      enabled: true,
      scope: 'user',
    });
  }

  throw new AutoDepsError(
    `auto-deps did not converge after ${maxIterations} iterations — möglicher Bug-Cycle ohne erkennbare wiederholte Provider-ID`,
  );
}

interface UnmetCapability {
  readonly capability: string;
  readonly requiredBy: string;
}

function collectUnmetCapabilities(
  bindings: ReadonlyMap<string, { readonly warning?: string }>,
): UnmetCapability[] {
  const out: UnmetCapability[] = [];
  for (const [id, result] of bindings.entries()) {
    const warning = result.warning;
    if (warning === undefined) continue;
    // Pattern aus binding-resolver: `${catalogId}: binding resolution failed: no installed plugin provides capability "${cap}" (required by "${requiredBy}")`
    const match = warning.match(/no installed plugin provides capability "([^"]+)"/);
    if (match === null) continue;
    out.push({ capability: match[1] ?? '', requiredBy: id });
  }
  return out;
}

/**
 * Helper fuer den CLI-Layer: wandelt ein lookup-result um in eine
 * read-Funktion die `tarball-manifest-reader` simuliert wenn nur die
 * Manifest-Daten verfuegbar sind (z. B. aus dem Marketplace-Cache).
 */
export function manifestReaderFromMap(
  manifests: ReadonlyMap<string, PluginManifest>,
): (path: string, _opts?: ReadOpts) => Promise<ManifestReadResult> {
  return async (path) => {
    const manifest = manifests.get(path);
    if (manifest === undefined) {
      return { ok: false, reason: 'tarball does not contain a plugin.json entry' };
    }
    return { ok: true, manifest };
  };
}
