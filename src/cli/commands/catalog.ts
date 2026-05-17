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
import { RootNotFoundError, resolveRoot } from '../../core/environment/index.js';
import { resolveMachinePaths } from '../../core/paths/index.js';
import {
  type Catalog,
  type CatalogEntry,
  catalogPathsFor,
  githubTarballUrl,
  InvalidCatalogError,
  installFromTarball,
  type PluginManifest,
  parseSource,
  readCatalog,
  readCatalogLock,
  resolveCapabilities,
  SourceParseError,
  TarballInstallError,
  tarballCacheDirFor,
} from '../../domains/catalog/index.js';

interface GlobalOpts {
  readonly root?: string;
  readonly json?: boolean;
}

function printJson(payload: unknown): void {
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(JSON.stringify(payload, null, 2));
}

function printLine(line: string): void {
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(line);
}

function printErr(line: string): void {
  console.error(line);
}

async function actInstall(globals: GlobalOpts, raw: string): Promise<void> {
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

  let machinePaths: ReturnType<typeof resolveMachinePaths>;
  let destination: string;
  try {
    const root = resolveRoot(globals.root === undefined ? {} : { explicit: globals.root });
    machinePaths = resolveMachinePaths();
    destination = join(root.path, 'config', 'skills', parsed.repo);
  } catch (err) {
    if (err instanceof RootNotFoundError) {
      printErr(`catalog install: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
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
  let root: ReturnType<typeof resolveRoot>;
  try {
    root = resolveRoot(globals.root === undefined ? {} : { explicit: globals.root });
  } catch (err) {
    if (err instanceof RootNotFoundError) {
      printErr(`catalog list: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
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

function notInMvp(globals: GlobalOpts, action: string): void {
  const hint =
    `catalog ${action}: not in v1 MVP. The catalog.json + catalog.lock.json ` +
    'lifecycle is staged for Phase 6 sidecar integration. The Phase 5 domain ' +
    'primitives (BackupManager, MarketplaceRegistry, ScopeMerger, ' +
    'CapabilityResolver) are shipped and unit-tested.';
  if (globals.json === true) {
    printJson({ ok: false, action, hint });
  } else {
    printErr(hint);
  }
  process.exit(2);
}

export function registerCatalogCommand(program: Command): void {
  const catalog = program.command('catalog').description('Plugin/skill catalog (ADR-0009 + 0010)');

  catalog
    .command('install <source>')
    .description('Install a plugin from github:owner/repo source (marketplace + local staged)')
    .action(async (source: string, _opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      await actInstall(globals, source);
    });

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

  for (const sub of ['uninstall', 'enable', 'disable', 'update', 'lock', 'sync']) {
    catalog
      .command(sub)
      .description(`${sub} — staged for catalog.json lifecycle (Phase 6 sidecar)`)
      .action((_opts: unknown, command: Command) => {
        notInMvp(command.optsWithGlobals<GlobalOpts>(), sub);
      });
  }
}
