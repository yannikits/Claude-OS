/**
 * `claude-os auth` — Anthropic-CLI auth integration per ADR-0011.
 * Stub (Phase 3a); full implementation in Phase 5.
 *
 * Planned subcommands:
 *   status                  show current auth state (token-expiry, profile)
 *   login                   delegate to `claude auth login`
 *   profile create <name>   new profile (sets $ANTHROPIC_CONFIG_DIR)
 *   profile use <name>      switch active profile
 *   profile list            list profiles
 *
 * @module @cli/commands/auth
 */
import type { Command } from 'commander';

function notImplemented(): void {
  // biome-ignore lint/suspicious/noConsole: CLI stub output
  console.log('claude-os auth: not yet implemented (Phase 5).');
  process.exit(0);
}

export function registerAuthCommand(program: Command): void {
  const auth = program
    .command('auth')
    .description('Anthropic-CLI auth integration (Phase 5). Stub.');

  auth.command('status').description('Show current auth state').action(notImplemented);
  auth.command('login').description('Delegate to claude auth login').action(notImplemented);

  const profile = auth.command('profile').description('Multi-profile management');
  profile.command('create <name>').description('New profile').action(notImplemented);
  profile.command('use <name>').description('Switch active profile').action(notImplemented);
  profile.command('list').description('List profiles').action(notImplemented);
}
