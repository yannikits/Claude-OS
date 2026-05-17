/**
 * CapabilityResolver — deterministic dependency resolver for catalog
 * plugin installs per ADR-0010.
 *
 * Targets the bug-cluster from Memory-587/593 + ruflo #174/#1676:
 * npm-peer-deps with hoisting collapse the moment two plugins want
 * incompatible nested versions of a shared package. Capabilities
 * replace those edges with a deterministic resolver over a declared
 * provides/requires graph.
 *
 * Outputs are deterministic: same input → same install-order +
 * same bindings (sorted by plugin id and version), so lock-files
 * are reproducible.
 *
 * @module @domains/catalog/capability-resolver
 */
import {
  type Capability,
  type CapabilityParseError,
  capabilityToString,
  compareVersions,
  parseCapability,
  satisfies,
  type VersionConstraint,
} from './capability.js';

/** v1 plugin manifest shape (ADR-0010 §27). */
export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly requires?: readonly string[];
  readonly provides?: readonly string[];
}

/** Catalog of installable plugins indexed by id. */
export interface Catalog {
  readonly plugins: readonly PluginManifest[];
}

export interface ResolutionBinding {
  readonly capability: string;
  readonly providedBy: PluginManifest;
}

export interface ResolutionResult {
  /**
   * Topological install order — direct dependencies first, then the
   * target. The target is always the last entry.
   */
  readonly installOrder: readonly PluginManifest[];
  /** Capability → resolving provider. */
  readonly bindings: readonly ResolutionBinding[];
}

export type ResolutionError =
  | MissingProviderError
  | VersionConflictError
  | CyclicDependencyError
  | AmbiguousProviderError
  | CapabilityParseError;

export class ResolverError extends Error {}

export class MissingProviderError extends ResolverError {
  readonly capability: string;
  readonly requiredBy: string;
  constructor(capability: string, requiredBy: string) {
    super(`no installed plugin provides capability "${capability}" (required by "${requiredBy}")`);
    this.name = 'MissingProviderError';
    this.capability = capability;
    this.requiredBy = requiredBy;
  }
}

export class VersionConflictError extends ResolverError {
  readonly capability: string;
  readonly providerVersion: string;
  readonly requiredBy: string;
  constructor(capability: string, providerVersion: string, requiredBy: string) {
    super(
      `capability "${capability}" found provider version "${providerVersion}" which does not satisfy the constraint (required by "${requiredBy}")`,
    );
    this.name = 'VersionConflictError';
    this.capability = capability;
    this.providerVersion = providerVersion;
    this.requiredBy = requiredBy;
  }
}

export class CyclicDependencyError extends ResolverError {
  readonly cycle: readonly string[];
  constructor(cycle: readonly string[]) {
    super(`cyclic dependency detected: ${cycle.join(' -> ')}`);
    this.name = 'CyclicDependencyError';
    this.cycle = cycle;
  }
}

export class AmbiguousProviderError extends ResolverError {
  readonly capability: string;
  readonly candidates: readonly string[];
  constructor(capability: string, candidates: readonly string[]) {
    super(
      `capability "${capability}" is ambiguous — multiple providers match: ${candidates.join(', ')}`,
    );
    this.name = 'AmbiguousProviderError';
    this.capability = capability;
    this.candidates = candidates;
  }
}

function pluginKey(manifest: PluginManifest): string {
  return `${manifest.id}@${manifest.version}`;
}

function parseProvides(manifest: PluginManifest): readonly Capability[] {
  const provides = manifest.provides ?? [];
  return provides.map((s) => parseCapability(s));
}

function parseRequires(manifest: PluginManifest): readonly Capability[] {
  const requires = manifest.requires ?? [];
  return requires.map((s) => parseCapability(s));
}

/**
 * Returns the providers that expose a capability matching `wanted`
 * (kind + name + optional version constraint). Multiple providers
 * sorted deterministically by id, then by version DESC.
 */
function findProviders(
  catalog: Catalog,
  wanted: Capability,
): readonly { manifest: PluginManifest; providedCap: Capability }[] {
  const matches: { manifest: PluginManifest; providedCap: Capability }[] = [];
  for (const manifest of catalog.plugins) {
    let provides: readonly Capability[];
    try {
      provides = parseProvides(manifest);
    } catch {
      continue;
    }
    for (const p of provides) {
      if (p.kind !== wanted.kind) continue;
      if (p.name !== wanted.name) continue;
      matches.push({ manifest, providedCap: p });
    }
  }
  matches.sort((a, b) => {
    if (a.manifest.id !== b.manifest.id) return a.manifest.id < b.manifest.id ? -1 : 1;
    return -compareVersions(a.manifest.version, b.manifest.version);
  });
  return matches;
}

function constraintSatisfied(providerVersion: string, constraint?: VersionConstraint): boolean {
  if (constraint === undefined) return true;
  return satisfies(providerVersion, constraint);
}

function appendIfMissing<T>(arr: T[], value: T, isSame: (a: T, b: T) => boolean): void {
  if (!arr.some((existing) => isSame(existing, value))) arr.push(value);
}

interface WalkState {
  readonly installOrder: PluginManifest[];
  readonly bindings: ResolutionBinding[];
  readonly visited: Set<string>;
  readonly stack: string[];
}

function walk(
  manifest: PluginManifest,
  catalog: Catalog,
  state: WalkState,
): ResolutionError | null {
  const key = pluginKey(manifest);
  if (state.stack.includes(key)) {
    const idx = state.stack.indexOf(key);
    return new CyclicDependencyError([...state.stack.slice(idx), key]);
  }
  if (state.visited.has(key)) return null;
  state.stack.push(key);

  let requires: readonly Capability[];
  try {
    requires = parseRequires(manifest);
  } catch (err) {
    state.stack.pop();
    return err as CapabilityParseError;
  }

  for (const wanted of requires) {
    const providers = findProviders(catalog, wanted);
    if (providers.length === 0) {
      state.stack.pop();
      return new MissingProviderError(capabilityToString(wanted), manifest.id);
    }
    const compatible = providers.filter((p) =>
      constraintSatisfied(p.manifest.version, wanted.constraint),
    );
    if (compatible.length === 0) {
      state.stack.pop();
      return new VersionConflictError(
        capabilityToString(wanted),
        providers[0]?.manifest.version ?? '?',
        manifest.id,
      );
    }
    if (compatible.length > 1) {
      const distinctIds = new Set(compatible.map((p) => p.manifest.id));
      if (distinctIds.size > 1) {
        state.stack.pop();
        return new AmbiguousProviderError(capabilityToString(wanted), [...distinctIds].sort());
      }
    }
    const chosen = compatible[0]?.manifest;
    if (chosen === undefined) {
      // unreachable: line 202 returns early when compatible.length === 0
      state.stack.pop();
      return new VersionConflictError(capabilityToString(wanted), '?', manifest.id);
    }
    appendIfMissing(
      state.bindings,
      { capability: capabilityToString(wanted), providedBy: chosen },
      (a, b) => a.capability === b.capability && a.providedBy.id === b.providedBy.id,
    );
    const recurseErr = walk(chosen, catalog, state);
    if (recurseErr !== null) {
      state.stack.pop();
      return recurseErr;
    }
  }

  state.stack.pop();
  if (!state.visited.has(key)) {
    state.visited.add(key);
    state.installOrder.push(manifest);
  }
  return null;
}

/**
 * Resolves the install plan for `target` against `catalog`. The result
 * carries an explicit ok/err discriminator so callers can switch
 * cleanly without try/catch sprawl.
 */
export function resolveCapabilities(
  target: PluginManifest,
  catalog: Catalog,
): { ok: true; result: ResolutionResult } | { ok: false; error: ResolutionError } {
  const state: WalkState = {
    installOrder: [],
    bindings: [],
    visited: new Set(),
    stack: [],
  };
  const err = walk(target, catalog, state);
  if (err !== null) return { ok: false, error: err };
  return {
    ok: true,
    result: {
      installOrder: state.installOrder,
      bindings: state.bindings,
    },
  };
}
