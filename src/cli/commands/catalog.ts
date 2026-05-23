/**
 * `claude-os catalog` — plugin/skill catalog CLI (Phase 5h).
 *
 * Replaces the Phase 3a stub. v1 surfaces:
 *   install <source>     resolve + fetch + extract a tarball
 *   resolve <plugin>     dry-run capability resolution against a
 *                        passed-in manifest file (JSON)
 *   list / lock / sync / enable / disable / uninstall / update
 *     not in v1 MVP — emit a hint pointing to Phase 6 sidecar where
 *     the full catalog.json + lock-file lifecycle will land
 *
 * @module @cli/commands/catalog
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { resolveMachinePaths } from '../../core/paths/index.js';
import {
  AutoDepsInstallError,
  applyLock,
  type Catalog,
  type CatalogConfig,
  type CatalogEntry,
  type CatalogLock,
  catalogPathsFor,
  githubTarballUrl,
  InvalidCatalogError,
  installFromGithubWithAutoDeps,
  installFromTarball,
  LockBuilderError,
  lockCatalog,
  mergeLockEntry,
  type PluginManifest,
  parseSource,
  readCatalog,
  readCatalogLock,
  removeCatalogEntry,
  resolveCapabilities,
  SourceParseError,
  setCatalogEntryEnabled,
  TarballInstallError,
  tarballCacheDirFor,
  UnknownCatalogEntryError,
  writeCatalogLock,
} from '../../domains/catalog/index.js';
import { type GlobalOpts, printErr, printJson, printLine, resolveRootOrExit } from '../output.js';

interface InstallOpts {
  readonly autoDeps?: boolean;
  readonly registry?: string;
}

/**
 * M18 (2026-05-21 code-review): Map `AutoDepsInstallError.code` auf die
 * historischen exit-codes des CLI. Domain-Funktion ist code-agnostisch;
 * CLI behaelt die etablierten Codes (4=missing-provider, 5=auto-deps-
 * error, 6=ambiguous, 7=lock-build, 8=marketplace-resolution, 1=alles
 * andere) damit Skripte die `claude-os catalog install --auto-deps`
 * wrappen back-compat bleiben.
 */
function exitCodeForAutoDepsError(code: string): number {
  switch (code) {
    case 'missing-provider':
      return 4;
    case 'auto-deps-error':
      return 5;
    case 'ambiguous-provider':
      return 6;
    case 'lock-build':
      return 7;
    case 'marketplace-resolution':
      return 8;
    default:
      return 1;
  }
}

async function actAutoDeps(globals: GlobalOpts, raw: string, opts: InstallOpts): Promise<void> {
  if (opts.registry === undefined) {
    printErr(
      'catalog install --auto-deps: braucht --registry <pfad-zur-marketplace-registry.json>',
    );
    process.exit(2);
  }
  const root = resolveRootOrExit(globals, 'catalog install');
  const machine = resolveMachinePaths();
  const cacheDir = tarballCacheDirFor(machine.dataRoot);

  // M18: Domain-Funktion macht den eigentlichen Flow — wir uebernehmen
  // nur CLI-Validation, exit-code-mapping und User-facing-Output.
  let result: Awaited<ReturnType<typeof installFromGithubWithAutoDeps>>;
  try {
    result = await installFromGithubWithAutoDeps({
      source: raw,
      registryPath: opts.registry,
      root: root.path,
      cacheDir,
      dryRun: globals.json === true,
    });
  } catch (err) {
    if (err instanceof AutoDepsInstallError) {
      // Spezielle Behandlung fuer "unsupported-source" (CLI-friendly Text).
      // v1.5+: github: und marketplace: werden unterstuetzt; local: nicht.
      if (err.code === 'unsupported-source') {
        printErr(
          'catalog install --auto-deps: nur github: oder marketplace: Sources unterstuetzt (local: deferred zu v1.6)',
        );
        process.exit(2);
      }
      // source-parse, target-fetch, target-manifest, missing-provider,
      // ambiguous-provider, auto-deps-error, lock-build, marketplace-resolution
      const prefix =
        err.code === 'missing-provider' ||
        err.code === 'ambiguous-provider' ||
        err.code === 'auto-deps-error' ||
        err.code === 'lock-build' ||
        err.code === 'marketplace-resolution'
          ? '[FAIL] auto-deps: '
          : 'catalog install --auto-deps: ';
      printErr(`${prefix}${err.message}`);
      process.exit(exitCodeForAutoDepsError(err.code));
    }
    throw err;
  }

  // Plan-Output: was waere neu installiert?
  if (result.dryRun) {
    printJson({
      target: { id: result.targetManifest.id, source: raw },
      newEntries: result.newEntries,
      iterations: result.iterations,
    });
    return;
  }
  printLine(
    `[OK] auto-deps fuer ${result.targetManifest.id}@${result.targetManifest.version} aufgeloest`,
  );
  printLine(`     Iterationen bis Fixpoint: ${result.iterations}`);
  if (result.newEntries.length === 0) {
    printLine('     Keine zusaetzlichen Provider noetig — Target ist autark.');
  } else {
    printLine(`     Neue Catalog-Eintraege (${result.newEntries.length}):`);
    for (const entry of result.newEntries) {
      printLine(`       + ${entry.id}  (${entry.kind}, ${entry.scope})  source=${entry.source}`);
    }
  }
  printLine(`     catalog.json aktualisiert: ${result.catalogPath}`);
  if (result.lockWarnings.length > 0) {
    printLine('     Lock-Build Warnings:');
    for (const w of result.lockWarnings) printLine(`       ! ${w}`);
  }
  printLine(`     catalog.lock.json geschrieben: ${result.lockPath}`);
  printLine(
    `     Sync abgeschlossen: ${result.applyResult.applied.length} installiert, ${result.applyResult.skipped.length} skipped, ${result.applyResult.errors.length} fehlgeschlagen`,
  );
  if (result.applyResult.errors.length > 0) {
    for (const e of result.applyResult.errors) printLine(`       ! ${e.id}: ${e.message}`);
    process.exit(9);
  }
}

async function actInstall(globals: GlobalOpts, raw: string, opts: InstallOpts = {}): Promise<void> {
  if (opts.autoDeps === true) {
    await actAutoDeps(globals, raw, opts);
    return;
  }
  let parsed: ReturnType<typeof parseSource>;
  try {
    parsed = parseSource(raw);
  } catch (err) {
    if (err instanceof SourceParseError) {
      printErr(`catalog install: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  if (parsed.kind === 'marketplace') {
    printErr(
      'catalog install: marketplace: sources require a marketplace registry. v1 ships ' +
        'the registry primitives (Phase 5f) but no curated registry yet. Use a ' +
        'github: source for now.',
    );
    process.exit(2);
  }

  if (parsed.kind === 'local') {
    printErr(
      'catalog install: local: sources are recognised by the parser but the install path ' +
        'is staged for a later iteration. Copy the directory manually for now.',
    );
    process.exit(2);
  }

  const root = resolveRootOrExit(globals, 'catalog install');
  const machinePaths = resolveMachinePaths();
  const destination = join(root.path, 'config', 'skills', parsed.repo);
  const cacheDir = tarballCacheDirFor(machinePaths.dataRoot);
  const url = githubTarballUrl(parsed);

  try {
    const result = await installFromTarball({
      url,
      cacheDir,
      destination,
      stripComponents: 1,
    });
    if (globals.json === true) {
      printJson({ ok: true, source: parsed, install: result });
    } else {
      printLine(`[OK] installed ${parsed.owner}/${parsed.repo} -> ${destination}`);
      printLine(
        `     sha256=${result.sha256.slice(0, 12)}... cached=${result.alreadyCached} bytes=${result.bytesDownloaded}`,
      );
    }
  } catch (err) {
    if (err instanceof TarballInstallError) {
      printErr(`catalog install: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

function actResolve(globals: GlobalOpts, manifestPath: string): void {
  if (!existsSync(manifestPath)) {
    printErr(`catalog resolve: manifest file does not exist: ${manifestPath}`);
    process.exit(1);
  }
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (err) {
    printErr(
      `catalog resolve: cannot read ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(raw) as PluginManifest;
  } catch {
    printErr(`catalog resolve: ${manifestPath} is not valid JSON`);
    process.exit(1);
  }
  const catalog: Catalog = { plugins: [] };
  const result = resolveCapabilities(manifest, catalog);
  if (globals.json === true) {
    printJson(result);
    return;
  }
  if (result.ok) {
    printLine(`[OK] resolved ${manifest.id}@${manifest.version}`);
    if (result.result.installOrder.length === 1) {
      printLine('     no dependencies to install.');
    } else {
      printLine(`     install order: ${result.result.installOrder.map((m) => m.id).join(' -> ')}`);
    }
    return;
  }
  printErr(`[FAIL] catalog resolve ${manifest.id}: ${result.error.name}: ${result.error.message}`);
  process.exit(1);
}

function actList(globals: GlobalOpts): void {
  const root = resolveRootOrExit(globals, 'catalog list');
  const paths = catalogPathsFor(root.path);
  let entries: readonly CatalogEntry[];
  let lockResolvedAt: string | null;
  try {
    entries = readCatalog(paths.catalogPath).entries;
    lockResolvedAt = readCatalogLock(paths.lockPath)?.resolvedAt ?? null;
  } catch (err) {
    if (err instanceof InvalidCatalogError) {
      printErr(`catalog list: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  if (globals.json === true) {
    printJson({
      catalogPath: paths.catalogPath,
      lockPath: paths.lockPath,
      lockResolvedAt,
      entries,
    });
    return;
  }
  if (entries.length === 0) {
    printLine(`(no catalog entries at ${paths.catalogPath})`);
    if (lockResolvedAt !== null) {
      printLine(`lock present, resolved ${lockResolvedAt}`);
    }
    return;
  }
  for (const e of entries) {
    const flag = e.enabled ? '[on] ' : '[off]';
    printLine(`${flag} ${e.kind.padEnd(7)} ${e.scope.padEnd(7)} ${e.id}  <-  ${e.source}`);
  }
  printLine('');
  printLine(`${entries.length} entries from ${paths.catalogPath}`);
  if (lockResolvedAt !== null) {
    printLine(`lock resolved ${lockResolvedAt}`);
  } else {
    printLine('no catalog.lock.json yet (run `catalog lock` once it lands).');
  }
}

function resolveCatalogPath(globals: GlobalOpts, action: string): string {
  const root = resolveRootOrExit(globals, `catalog ${action}`);
  return catalogPathsFor(root.path).catalogPath;
}

function actSetEnabled(globals: GlobalOpts, id: string, enabled: boolean): void {
  const verb = enabled ? 'enable' : 'disable';
  const catalogPath = resolveCatalogPath(globals, verb);
  try {
    const result = setCatalogEntryEnabled(catalogPath, id, enabled);
    if (globals.json === true) {
      printJson({ ok: true, action: verb, id, ...result });
      return;
    }
    if (!result.changed) {
      printLine(`[OK] ${id} already ${enabled ? 'enabled' : 'disabled'} (no change)`);
      return;
    }
    printLine(`[OK] ${verb}d ${id}`);
  } catch (err) {
    if (err instanceof UnknownCatalogEntryError || err instanceof InvalidCatalogError) {
      printErr(`catalog ${verb}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

function actUninstall(globals: GlobalOpts, id: string): void {
  const catalogPath = resolveCatalogPath(globals, 'uninstall');
  try {
    const result = removeCatalogEntry(catalogPath, id);
    if (globals.json === true) {
      printJson({ ok: true, action: 'uninstall', removed: result.removed });
      return;
    }
    printLine(`[OK] uninstalled ${id} (source ${result.removed.source})`);
    printLine(
      '     note: on-disk install directory was NOT removed. Delete manually if you no longer need it.',
    );
  } catch (err) {
    if (err instanceof UnknownCatalogEntryError || err instanceof InvalidCatalogError) {
      printErr(`catalog uninstall: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

async function actLock(globals: GlobalOpts): Promise<void> {
  const root = resolveRootOrExit(globals, 'catalog lock');
  const paths = catalogPathsFor(root.path);
  const machinePaths = resolveMachinePaths();
  const cacheDir = tarballCacheDirFor(machinePaths.dataRoot);

  let catalog: ReturnType<typeof readCatalog>;
  try {
    catalog = readCatalog(paths.catalogPath);
  } catch (err) {
    if (err instanceof InvalidCatalogError) {
      printErr(`catalog lock: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  if (catalog.entries.length === 0) {
    printErr(`catalog lock: catalog.json is empty (${paths.catalogPath})`);
    process.exit(2);
  }

  let result: Awaited<ReturnType<typeof lockCatalog>>;
  try {
    result = await lockCatalog({ catalog, cacheDir });
  } catch (err) {
    if (err instanceof LockBuilderError) {
      printErr(`catalog lock: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  writeCatalogLock(paths.lockPath, result.lock);

  if (globals.json === true) {
    printJson({
      lockPath: paths.lockPath,
      lock: result.lock,
      warnings: result.warnings,
    });
    return;
  }
  printLine(
    `[OK] wrote ${paths.lockPath} (${result.lock.entries.length}/${catalog.entries.length} entries, resolved ${result.lock.resolvedAt})`,
  );
  for (const w of result.warnings) {
    printLine(`     [WARN] ${w}`);
  }
}

async function actSync(globals: GlobalOpts): Promise<void> {
  const root = resolveRootOrExit(globals, 'catalog sync');
  const paths = catalogPathsFor(root.path);
  const machinePaths = resolveMachinePaths();
  const cacheDir = tarballCacheDirFor(machinePaths.dataRoot);

  let catalog: ReturnType<typeof readCatalog>;
  let lock: CatalogLock | null;
  try {
    catalog = readCatalog(paths.catalogPath);
    lock = readCatalogLock(paths.lockPath);
  } catch (err) {
    if (err instanceof InvalidCatalogError) {
      printErr(`catalog sync: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  if (lock === null) {
    printErr(
      `catalog sync: no catalog.lock.json at ${paths.lockPath} — run \`catalog lock\` first`,
    );
    process.exit(2);
  }

  const result = await applyLock({
    root: root.path,
    catalog,
    lock,
    cacheDir,
  });

  if (globals.json === true) {
    printJson({ applied: result.applied, skipped: result.skipped, errors: result.errors });
  } else {
    printLine(
      `[OK] synced ${result.applied.length} entries (${result.skipped.length} skipped, ${result.errors.length} errors)`,
    );
    for (const a of result.applied) printLine(`     [OK]   ${a.id} -> ${a.destination}`);
    for (const s of result.skipped) printLine(`     [SKIP] ${s.id}: ${s.reason}`);
    for (const e of result.errors) printLine(`     [FAIL] ${e.id}: ${e.message}`);
  }
  if (result.errors.length > 0) process.exit(1);
}

async function actUpdate(globals: GlobalOpts, id: string | undefined): Promise<void> {
  const root = resolveRootOrExit(globals, 'catalog update');
  const paths = catalogPathsFor(root.path);
  const machinePaths = resolveMachinePaths();
  const cacheDir = tarballCacheDirFor(machinePaths.dataRoot);

  let catalog: ReturnType<typeof readCatalog>;
  let existingLock: CatalogLock | null;
  try {
    catalog = readCatalog(paths.catalogPath);
    existingLock = readCatalogLock(paths.lockPath);
  } catch (err) {
    if (err instanceof InvalidCatalogError) {
      printErr(`catalog update: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  if (catalog.entries.length === 0) {
    printErr(`catalog update: catalog.json is empty (${paths.catalogPath})`);
    process.exit(2);
  }

  // Without an id this is a full re-lock = alias for `catalog lock`.
  if (id === undefined) {
    let lockResult: Awaited<ReturnType<typeof lockCatalog>>;
    try {
      lockResult = await lockCatalog({ catalog, cacheDir });
    } catch (err) {
      if (err instanceof LockBuilderError) {
        printErr(`catalog update: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
    writeCatalogLock(paths.lockPath, lockResult.lock);
    if (globals.json === true) {
      printJson({ lock: lockResult.lock, warnings: lockResult.warnings, scope: 'all' });
      return;
    }
    printLine(
      `[OK] re-locked ${lockResult.lock.entries.length}/${catalog.entries.length} entries (${lockResult.lock.resolvedAt})`,
    );
    for (const w of lockResult.warnings) printLine(`     [WARN] ${w}`);
    return;
  }

  // Single-entry update: re-lock just `id`, merge into existing lock.
  const targetEntry = catalog.entries.find((e) => e.id === id);
  if (targetEntry === undefined) {
    printErr(`catalog update: unknown id "${id}" in ${paths.catalogPath}`);
    process.exit(1);
  }
  const slice: CatalogConfig = {
    version: 1,
    entries: [targetEntry],
  };
  let sliceResult: Awaited<ReturnType<typeof lockCatalog>>;
  try {
    sliceResult = await lockCatalog({ catalog: slice, cacheDir });
  } catch (err) {
    if (err instanceof LockBuilderError) {
      printErr(`catalog update: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const newEntry = sliceResult.lock.entries[0] ?? null;
  const baseLock: CatalogLock = existingLock ?? {
    version: 1,
    resolvedAt: sliceResult.lock.resolvedAt,
    entries: [],
  };
  const merged = mergeLockEntry(baseLock, id, newEntry, sliceResult.lock.resolvedAt);
  writeCatalogLock(paths.lockPath, merged);

  if (globals.json === true) {
    printJson({
      lock: merged,
      warnings: sliceResult.warnings,
      scope: 'one',
      id,
      replaced: newEntry !== null,
    });
    return;
  }
  if (newEntry === null) {
    printLine(`[WARN] update ${id}: lock-builder produced no entry`);
    for (const w of sliceResult.warnings) printLine(`     [WARN] ${w}`);
    process.exit(1);
  }
  printLine(
    `[OK] updated ${id} -> sha256=${newEntry.sha256.slice(0, 12)}..., resolvedRef=${newEntry.resolvedRef ?? 'HEAD'}, lock at ${merged.resolvedAt}`,
  );
  for (const w of sliceResult.warnings) printLine(`     [WARN] ${w}`);
}

export function registerCatalogCommand(program: Command): void {
  const catalog = program.command('catalog').description('Plugin/skill catalog (ADR-0009 + 0010)');

  catalog
    .command('install <source>')
    .description('Install a plugin from github:owner/repo source (marketplace + local staged)')
    .option('--auto-deps', 'Resolve transitive marketplace-Anforderungen automatisch')
    .option(
      '--registry <path>',
      'Pfad zur marketplace-registry.json (Pflicht zusammen mit --auto-deps)',
    )
    .action(
      async (source: string, opts: { autoDeps?: boolean; registry?: string }, command: Command) => {
        const globals = command.optsWithGlobals<GlobalOpts>();
        await actInstall(globals, source, opts);
      },
    );

  catalog
    .command('resolve <manifestFile>')
    .description('Dry-run capability resolution against a passed-in plugin.json file')
    .action((manifestPath: string, _opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      actResolve(globals, manifestPath);
    });

  catalog
    .command('list')
    .description('List catalog.json entries (with catalog.lock.json status)')
    .action((_opts: unknown, command: Command) => {
      actList(command.optsWithGlobals<GlobalOpts>());
    });

  catalog
    .command('enable <id>')
    .description('Set catalog.json entry to enabled: true (atomic, schema-validated)')
    .action((id: string, _opts: unknown, command: Command) => {
      actSetEnabled(command.optsWithGlobals<GlobalOpts>(), id, true);
    });

  catalog
    .command('disable <id>')
    .description('Set catalog.json entry to enabled: false')
    .action((id: string, _opts: unknown, command: Command) => {
      actSetEnabled(command.optsWithGlobals<GlobalOpts>(), id, false);
    });

  catalog
    .command('uninstall <id>')
    .description('Remove an entry from catalog.json (on-disk install dir is NOT deleted)')
    .action((id: string, _opts: unknown, command: Command) => {
      actUninstall(command.optsWithGlobals<GlobalOpts>(), id);
    });

  catalog
    .command('lock')
    .description('Compute catalog.lock.json from catalog.json (sha256 + resolvedRef per entry)')
    .action(async (_opts: unknown, command: Command) => {
      await actLock(command.optsWithGlobals<GlobalOpts>());
    });

  catalog
    .command('sync')
    .description('Extract enabled lock entries into <root>/config/<bucket>/<id> install dirs')
    .action(async (_opts: unknown, command: Command) => {
      await actSync(command.optsWithGlobals<GlobalOpts>());
    });

  catalog
    .command('update [id]')
    .description('Re-lock entries: all (alias for `lock`) or just <id> (merged into existing lock)')
    .action(async (id: string | undefined, _opts: unknown, command: Command) => {
      await actUpdate(command.optsWithGlobals<GlobalOpts>(), id);
    });
}
