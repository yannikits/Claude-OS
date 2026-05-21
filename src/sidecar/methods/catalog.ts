/**
 * Catalog-Namespace RPCs: list / removeEntry / installAutoDeps.
 * Split aus `sidecar/methods.ts` (M21).
 *
 * @module @sidecar/methods/catalog
 */
import {
  AutoDepsInstallError,
  catalogPathsFor,
  InvalidCatalogError,
  installFromGithubWithAutoDeps,
  readCatalog,
  readCatalogLock,
  removeCatalogEntry,
  tarballCacheDirFor,
  UnknownCatalogEntryError,
} from '../../domains/catalog/index.js';
import { mtimeCached } from '../mtime-cache.js';
import type { RpcDispatcher } from '../rpc.js';
import { type MethodsContext, requireString } from './_shared.js';

export function registerCatalogMethods(dispatcher: RpcDispatcher, ctx: MethodsContext): void {
  dispatcher.register('catalog.list', () => {
    const paths = catalogPathsFor(ctx.rootPath());
    // M11 (2026-05-21 code-review): InvalidCatalogError propagiert sonst
    // den File-Path in der Error-Message — RPC-Peers (GUI) bekommen die
    // interne Pfad-Struktur zu sehen. Catch + opaque error-shape, success
    // shape bleibt back-compat-stabil.
    try {
      const catalog = mtimeCached(
        paths.catalogPath,
        () => readCatalog(paths.catalogPath),
        ctx.catalogCache,
      );
      const lock = mtimeCached(
        paths.lockPath,
        () => readCatalogLock(paths.lockPath),
        ctx.catalogLockCache,
      );
      return {
        catalogPath: paths.catalogPath,
        lockPath: paths.lockPath,
        lockResolvedAt: lock?.resolvedAt ?? null,
        entries: catalog.entries,
      };
    } catch (err) {
      if (err instanceof InvalidCatalogError) {
        return { ok: false as const, code: 'invalid-catalog' as const };
      }
      throw err;
    }
  });

  dispatcher.register('catalog.removeEntry', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { id?: string };
    const id = requireString(params.id, 'id', 'catalog.removeEntry');
    // m16 (2026-05-21 code-review): id-pattern matched gegen
    // CatalogEntrySchema (`^[A-Za-z0-9._-]+$`). Defense gegen Inject-
    // Attempts via crafted id (z. B. path-traversal-Segmente in
    // catalog.json-Lookups).
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new Error(
        `catalog.removeEntry: params.id "${id}" enthaelt invalid characters (allowed: A-Za-z0-9._-)`,
      );
    }
    const paths = catalogPathsFor(ctx.rootPath());
    try {
      const result = removeCatalogEntry(paths.catalogPath, id);
      return { ok: true as const, id, removedEntry: result.removed };
    } catch (err) {
      if (err instanceof UnknownCatalogEntryError) {
        return { ok: false as const, code: 'unknown-id', id, message: err.message };
      }
      throw err;
    }
  });

  dispatcher.register('catalog.installAutoDeps', async (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { source?: string; registryPath?: string };
    const source = requireString(params.source, 'source', 'catalog.installAutoDeps');
    const registryPath = requireString(
      params.registryPath,
      'registryPath',
      'catalog.installAutoDeps',
    );
    const root = ctx.rootPath();
    const machine = ctx.machinePaths();
    const cacheDir = tarballCacheDirFor(machine.dataRoot);
    try {
      const result = await installFromGithubWithAutoDeps({
        source,
        registryPath,
        root,
        cacheDir,
      });
      return {
        ok: true as const,
        target: { id: result.targetManifest.id, version: result.targetManifest.version },
        newEntries: result.newEntries,
        iterations: result.iterations,
        catalogPath: result.catalogPath,
        lockPath: result.lockPath,
        lockWarnings: result.lockWarnings,
        applied: result.applyResult.applied.length,
        skipped: result.applyResult.skipped.length,
        errors: result.applyResult.errors,
      };
    } catch (err) {
      if (err instanceof AutoDepsInstallError) {
        return { ok: false as const, code: err.code, message: err.message };
      }
      throw err;
    }
  });
}
