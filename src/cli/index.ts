#!/usr/bin/env node
/**
 * claude-os CLI entry point.
 *
 * Per ADR-0003 (Hybrid CLI), this module is the single entry-point for
 * management commands. AI sessions are delegated to the Anthropic
 * `bin/claude{,.exe}` binary via the `ai` subcommand (Phase 3+).
 *
 * M12 (2026-05-21 code-review): lazy subcommand registration. Vorher
 * wurden ALLE 11 command-Module eagerly importiert (jedes zog tar /
 * simple-git / chokidar / etc. ueber Domain-Barrels). Selbst
 * `claude-os doctor --json` zahlte ~50-150 ms cold-start dafuer.
 *
 * Jetzt: das aktiv aufgerufene Subcommand wird DYNAMISCH importiert.
 * Fuer `--help`/`-h`/kein-arg laden wir alle (commander braucht sie zum
 * help-Build). Fuer ein unbekanntes Subcommand laden wir auch alle
 * (commander muss den Fehler korrekt rendern).
 *
 * @module @cli/index
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

/**
 * M40 (2026-05-21 code-review): version aus package.json lesen statt
 * hardcoden. Vorher: `'0.1.0-alpha.1'` driftete von `package.json:1.5.3`.
 * Geht via import.meta.url-Aufloesung → relativ zum kompilierten
 * `dist/cli/index.js` ist package.json zwei Levels rauf.
 */
function resolveVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8')) as {
      version?: unknown;
    };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
  } catch {
    /* fall through to unknown */
  }
  return 'unknown';
}

const program = new Command();

program
  .name('claude-os')
  .description('Claude Develop Environment OS — Tauri GUI + Node CLI + cloud-mount vault sync')
  .version(resolveVersion())
  .option('--root <path>', 'Override claude-os root path (default: $CLAUDE_OS_ROOT or repo-detect)')
  .option(
    '--vault <path>',
    'Override Obsidian vault root for memory commands (default: $CLAUDE_OS_VAULT_PATH from .env)',
  )
  .option('--json', 'Output as JSON (for machine consumption)')
  .option('-v, --verbose', 'Verbose logging');

// Subcommand → dynamic-import-loader. Wird nur fuer den tatsaechlich
// gerufenen Subcommand evaluated, sodass `tar`/`simple-git`/`chokidar`
// nicht geladen werden wenn nur `doctor` laeuft.
type Loader = (program: Command) => Promise<void> | void;

const SUBCOMMAND_LOADERS: Record<string, Loader> = {
  doctor: async (p) => (await import('./commands/doctor.js')).registerDoctorCommand(p),
  update: async (p) => (await import('./commands/update.js')).registerUpdateCommand(p),
  vault: async (p) => (await import('./commands/vault.js')).registerVaultCommand(p),
  catalog: async (p) => (await import('./commands/catalog.js')).registerCatalogCommand(p),
  secrets: async (p) => (await import('./commands/secrets.js')).registerSecretsCommand(p),
  agent: async (p) => (await import('./commands/agent.js')).registerAgentCommand(p),
  auth: async (p) => (await import('./commands/auth.js')).registerAuthCommand(p),
  ai: async (p) => (await import('./commands/ai.js')).registerAiCommand(p),
  mcp: async (p) => (await import('./commands/mcp.js')).registerMcpCommand(p),
  migrate: async (p) => (await import('./commands/migrate.js')).registerMigrateCommand(p),
  schedule: async (p) => (await import('./commands/schedule.js')).registerScheduleCommand(p),
  workspace: async (p) => (await import('./commands/workspace.js')).registerWorkspaceCommand(p),
  ask: async (p) => (await import('./commands/ask.js')).registerAskCommand(p),
  'save-note': async (p) => (await import('./commands/save-note.js')).registerSaveNoteCommand(p),
};

async function loadAll(p: Command): Promise<void> {
  await Promise.all(Object.values(SUBCOMMAND_LOADERS).map((load) => load(p)));
}

async function main(): Promise<void> {
  const subcommand = process.argv[2];
  const wantsHelp =
    subcommand === undefined ||
    subcommand === '--help' ||
    subcommand === '-h' ||
    subcommand === '--version' ||
    subcommand === '-V';

  if (wantsHelp) {
    await loadAll(program);
  } else if (subcommand !== undefined && subcommand in SUBCOMMAND_LOADERS) {
    const loader = SUBCOMMAND_LOADERS[subcommand];
    if (loader !== undefined) await loader(program);
  } else {
    // Unknown subcommand — commander needs all loaded to render the
    // help-on-error correctly.
    await loadAll(program);
  }

  await program.parseAsync(process.argv);
}

/**
 * n3 (2026-05-23 todo-audit): --verbose oder -v zeigt zusaetzlich den
 * Error-Stack. Commander parsed das normalerweise zu globalOpts.verbose,
 * aber wenn main() vor der Action-Phase throwt, koennen wir die parsed
 * opts nicht mehr lesen — daher direkter argv-Scan. CLAUDE_OS_VERBOSE
 * als zweiter Pfad fuer Skripte die argv nicht beeinflussen koennen.
 */
function wantsVerboseError(): boolean {
  if (process.env.CLAUDE_OS_VERBOSE === '1') return true;
  return process.argv.slice(2).some((a) => a === '-v' || a === '--verbose');
}

main().catch((err: unknown) => {
  if (err instanceof Error) {
    console.error(err.message);
    if (wantsVerboseError() && err.stack !== undefined) {
      console.error(err.stack);
    }
  } else {
    console.error(String(err));
  }
  process.exit(1);
});
