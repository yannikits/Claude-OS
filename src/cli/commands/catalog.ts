/**
 * `claude-os catalog` — plugin/skill catalog per ADR-0009 + ADR-0010.
 * Stub (Phase 3a); full implementation in Phase 5.
 *
 * Planned subcommands:
 *   list                    list installed plugins/skills
 *   install <source>        marketplace:* | github:* | local:*
 *   uninstall <name>        with cleanup-hook
 *   enable <name>           toggle activation
 *   disable <name>          toggle deactivation
 *   update                  refresh from lock-file
 *   lock                    rewrite catalog.lock.json
 *   sync                    install from lock-file (reproducible)
 *   resolve <plugin>        dry-run capability-resolution plan
 *
 * @module @cli/commands/catalog
 */
import type { Command } from 'commander';

function notImplemented(): void {
  // biome-ignore lint/suspicious/noConsole: CLI stub output
  console.log('claude-os catalog: not yet implemented (Phase 5).');
  process.exit(0);
}

export function registerCatalogCommand(program: Command): void {
  const catalog = program
    .command('catalog')
    .description('Plugin/skill catalog (Phase 5). Stub.');

  catalog.command('list').description('List installed').action(notImplemented);
  catalog.command('install <source>').description('Install from source').action(notImplemented);
  catalog.command('uninstall <name>').description('Remove').action(notImplemented);
  catalog.command('enable <name>').description('Activate').action(notImplemented);
  catalog.command('disable <name>').description('Deactivate').action(notImplemented);
  catalog.command('update').description('Refresh from lock-file').action(notImplemented);
  catalog.command('lock').description('Rewrite lock-file').action(notImplemented);
  catalog.command('sync').description('Reproducible install from lock').action(notImplemented);
  catalog
    .command('resolve <plugin>')
    .description('Dry-run capability resolution')
    .action(notImplemented);
}
