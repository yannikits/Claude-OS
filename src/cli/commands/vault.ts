/**
 * `claude-os vault` — vault-sync subsystem (Phase 2). Stub.
 *
 * Planned subcommands:
 *   snapshot                 stage all -> commit -> push
 *   status                   current sync state + busy-flag
 *   schedule                 --enable/--disable [--idle-seconds N]
 *   conflict-mode <mode>     abort | prefer-local | prefer-remote
 *   unlock                   manually reset persistent busy-flag
 *
 * @module @cli/commands/vault
 */
import type { Command } from 'commander';

function notImplemented(): void {
  // biome-ignore lint/suspicious/noConsole: CLI stub output
  console.log('claude-os vault: not yet implemented (Phase 2).');
  process.exit(0);
}

export function registerVaultCommand(program: Command): void {
  const vault = program
    .command('vault')
    .description('Vault sync (Phase 2). Stub — full impl in Phase 2.');

  vault.command('snapshot').description('Stage + commit + push').action(notImplemented);
  vault.command('status').description('Current sync state').action(notImplemented);
  vault
    .command('schedule')
    .description('Enable/disable idle-detection scheduler')
    .option('--enable', 'enable scheduler')
    .option('--disable', 'disable scheduler')
    .option('--idle-seconds <n>', 'idle threshold (default 300)')
    .action(notImplemented);
  vault
    .command('conflict-mode <mode>')
    .description('Set conflict policy (abort|prefer-local|prefer-remote)')
    .action(notImplemented);
  vault.command('unlock').description('Reset persistent busy-flag').action(notImplemented);
}
