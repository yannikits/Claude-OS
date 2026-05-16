/**
 * `claude-os secrets` — OS-keychain-backed secret store per ADR-0004.
 * Stub (Phase 3a); full implementation in Phase 3d using
 * @napi-rs/keyring with encrypted-file fallback.
 *
 * @module @cli/commands/secrets
 */
import type { Command } from 'commander';

function notImplemented(): void {
  // biome-ignore lint/suspicious/noConsole: CLI stub output
  console.log('claude-os secrets: not yet implemented (Phase 3d).');
  process.exit(0);
}

export function registerSecretsCommand(program: Command): void {
  const secrets = program
    .command('secrets')
    .description('OS-keychain-backed secret store (Phase 3d). Stub.');

  secrets
    .command('set <key> [value]')
    .description('Store a secret (prompts for value if omitted)')
    .action(notImplemented);
  secrets.command('get <key>').description('Retrieve a secret').action(notImplemented);
  secrets.command('list').description('List secret keys (values redacted)').action(notImplemented);
  secrets.command('delete <key>').description('Remove a secret').action(notImplemented);
}
