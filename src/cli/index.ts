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
import { Command } from 'commander';

const program = new Command();

program
  .name('claude-os')
  .description('Claude Develop Environment OS — Tauri GUI + Node CLI + cloud-mount vault sync')
  .version('0.1.0-alpha.1')
  .option('--root <path>', 'Override claude-os root path (default: $CLAUDE_OS_ROOT or repo-detect)')
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

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
