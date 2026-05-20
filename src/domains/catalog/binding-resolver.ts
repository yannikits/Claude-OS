/**
 * binding-resolver — runs the capability resolver over the manifests
 * peeled out of plugin tarballs and returns the lock bindings each
 * plugin entry should carry.
 *
 * Closes the Phase 5o v1-simplification (lockCatalog used to emit
 * `bindings: []` for every entry).
 *
 * Inputs:
 *   - `plugins[]` — one entry per catalog item *with* a manifest. Lock
 *     entries built from skill / mcp sources are leaves and aren't
 *     passed here (they don't have requires/provides).
 *   - Each `BindingInput` carries the catalog id (used for the lock
 *     entry key) plus the parsed `PluginManifest` (used by the
 *     resolver).
 *
 * Output: a map `catalogId -> { bindings, warning? }`. Successful
 * resolves give `bindings: CatalogLockBinding[]` (sorted by capability
 * for determinism); resolver errors give `bindings: []` plus a
 * human-readable warning string the lock-builder can surface.
 *
 * @module @domains/catalog/binding-resolver
 */
import {
  type Catalog,
  type PluginManifest,
  type ResolutionBinding,
  resolveCapabilities,
} from './capability-resolver.js';
import type { CatalogLockBinding } from './schema.js';

export interface BindingInput {
  readonly catalogId: string;
  readonly manifest: PluginManifest;
}

export interface BindingResult {
  readonly bindings: readonly CatalogLockBinding[];
  /**
   * Present only when the resolver failed. The lock-builder forwards
   * this string into `LockBuilderResult.warnings` so the CLI / sidecar
   * can show it.
   */
  readonly warning?: string;
}

function mapBinding(b: ResolutionBinding): CatalogLockBinding {
  return { capability: b.capability, providedBy: b.providedBy.id };
}

function sortBindings(arr: readonly CatalogLockBinding[]): readonly CatalogLockBinding[] {
  return [...arr].sort((a, b) => {
    if (a.capability !== b.capability) return a.capability < b.capability ? -1 : 1;
    return a.providedBy < b.providedBy ? -1 : 1;
  });
}

/**
 * Resolves bindings for every input. The aggregate `Catalog` passed to
 * the resolver is *all* known manifests (so cross-plugin requires
 * actually find their provider). Failures stay scoped to the entry
 * they originate in — other entries still receive their bindings.
 */
export function resolveBindings(inputs: readonly BindingInput[]): Map<string, BindingResult> {
  const catalog: Catalog = { plugins: inputs.map((i) => i.manifest) };
  const results = new Map<string, BindingResult>();
  for (const input of inputs) {
    const outcome = resolveCapabilities(input.manifest, catalog);
    if (outcome.ok === false) {
      results.set(input.catalogId, {
        bindings: [],
        warning: `${input.catalogId}: binding resolution failed: ${outcome.error.message}`,
      });
      continue;
    }
    const lockBindings = outcome.result.bindings.map(mapBinding);
    results.set(input.catalogId, { bindings: sortBindings(lockBindings) });
  }
  return results;
}
