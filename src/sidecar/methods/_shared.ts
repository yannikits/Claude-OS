/**
 * Shared types + helpers fuer die per-namespace methods-Module.
 *
 * M21 (2026-05-21 code-review): Vorher war alles in einer 549-LOC
 * `sidecar/methods.ts`. Split in `methods/<namespace>.ts` + shared
 * `MethodsContext`. Public API (`registerMethods`) unveraendert.
 *
 * @module @sidecar/methods/_shared
 */
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { resolveRoot } from '../../core/environment/index.js';
import type { resolveMachinePaths } from '../../core/paths/index.js';
import type { AgentRunsRepository } from '../../domains/agent-runs/index.js';
import type { readCatalog, readCatalogLock } from '../../domains/catalog/index.js';
import type { readSchedules } from '../../domains/scheduler/index.js';
import type { loadVaultConfig } from '../../domains/vault-sync/index.js';
import type { MtimeCache } from '../mtime-cache.js';

/** Wird vom Orchestrator `registerMethods` einmalig gebaut und an
 *  jede `register<Namespace>Methods` weitergegeben. */
export interface MethodsContext {
  readonly env: () => NodeJS.ProcessEnv;
  readonly home: () => string;
  readonly rootPath: () => string;
  readonly machinePaths: () => ReturnType<typeof resolveMachinePaths>;
  readonly catalogCache: MtimeCache<ReturnType<typeof readCatalog>>;
  readonly catalogLockCache: MtimeCache<ReturnType<typeof readCatalogLock>>;
  readonly vaultConfigCache: MtimeCache<ReturnType<typeof loadVaultConfig>>;
  readonly schedulesCache: MtimeCache<ReturnType<typeof readSchedules>>;
  /** Lazily-instantiated AgentRunsRepository (M13 singleton). */
  readonly getAgentRunsRepo: () => AgentRunsRepository;
}

/**
 * Resolves the current claude-os root via `core/environment`. Wrapped so
 * Tests koennen via context-injection oder env-override steuern.
 */
export function rootPath(): string {
  return resolveRoot({}).path;
}

/**
 * Input-Validation-Helper: forciert `value` als non-empty string oder
 * throwt einen einheitlichen `Error` mit `methodName: paramName muss ein
 * non-empty string sein`. M21-spec hat das als explizites Item gefuehrt
 * (vorher wurde der Check in 9+ Methods kopiert).
 */
export function requireString(value: unknown, paramName: string, methodName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${methodName}: params.${paramName} muss ein non-empty string sein`);
  }
  return value;
}

/**
 * Symmetrisch zu `requireString`: forciert boolean oder wirft.
 */
export function requireBoolean(value: unknown, paramName: string, methodName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${methodName}: params.${paramName} muss boolean sein`);
  }
  return value;
}

/**
 * Canonicalisiert eine Liste von Root-Pfaden via `realpathSync`. Fehler
 * (z. B. wenn die Pfad noch nicht existiert) werden geschluckt: dann
 * bleibt der raw-Pfad in der Liste — `isUnder` wird sich auf Mismatch
 * konservativ verhalten. Genutzt vom inbox.import handler (C2).
 */
export function canonicalizeRoots(roots: readonly string[]): readonly string[] {
  return roots.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  });
}

/**
 * C2 (2026-05-21 code-review): true wenn `candidate` denselben Pfad ODER
 * eine Subdirectory von `root` ist. Beide muessen bereits canonical /
 * absolute sein. Plattform-unabhaengig via `path.relative`.
 */
export function isUnder(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '' || rel === '.') return true;
  if (rel.startsWith('..')) return false;
  // Auf Windows kann relative absolute paths zurueckgeben (verschiedene
  // Laufwerke). Solche Pfade sind NICHT unter `root`.
  if (/^[A-Za-z]:[/\\]/.test(rel) || rel.startsWith('/')) return false;
  return true;
}
