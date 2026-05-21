/**
 * `claude-os secrets` — OS-keychain-backed secret store CLI per
 * ADR-0004. Backed by `createSecretStore()` which auto-detects keyring
 * availability and falls back to the encrypted-file store on headless
 * Linux (D-Bus absent) or wherever `$CLAUDE_OS_SECRETS_BACKEND` forces
 * `encrypted-file`.
 *
 * Output discipline: never print secret values to stdout except for
 * `secrets get` (the explicit retrieval path the user asked for).
 * `list` shows keys only. Stderr/log lines never include values.
 *
 * @module @cli/commands/secrets
 */
import type { Command } from 'commander';
import { createSecretStore } from '../../domains/secrets/index.js';
import { type GlobalOpts, printErr, printJson, printLine } from '../output.js';

export function registerSecretsCommand(program: Command): void {
  const secrets = program
    .command('secrets')
    .description('OS-keychain-backed secret store (ADR-0004)');

  secrets
    .command('set <key> <value>')
    .description('Store a secret value under <key>')
    .action(async (key: string, value: string, _opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      try {
        const store = createSecretStore();
        await store.set(key, value);
        if (globals.json === true) {
          printJson({ ok: true, action: 'set', key, backend: store.backend });
        } else {
          printLine(`[OK] secrets.set ${key} (backend=${store.backend})`);
        }
      } catch (err) {
        printErr(`secrets set: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  secrets
    .command('get <key>')
    .description('Retrieve a secret value (prints to stdout)')
    .action(async (key: string, _opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      try {
        const store = createSecretStore();
        const value = await store.get(key);
        if (value === null) {
          if (globals.json === true) {
            printJson({ ok: false, action: 'get', key, found: false });
          } else {
            printErr(`secrets get: "${key}" not found`);
          }
          process.exit(1);
        }
        if (globals.json === true) {
          printJson({ ok: true, action: 'get', key, value, backend: store.backend });
        } else {
          printLine(value);
        }
      } catch (err) {
        printErr(`secrets get: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  secrets
    .command('list')
    .description('List secret keys (values never printed)')
    .action(async (_opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      try {
        const store = createSecretStore();
        const items = await store.list();
        if (globals.json === true) {
          printJson({ ok: true, action: 'list', backend: store.backend, items });
          return;
        }
        if (items.length === 0) {
          printLine(`(no secrets stored; backend=${store.backend})`);
          return;
        }
        printLine(`# backend=${store.backend}`);
        for (const item of items) printLine(item.key);
      } catch (err) {
        printErr(`secrets list: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  secrets
    .command('delete <key>')
    .description('Remove a secret')
    .action(async (key: string, _opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      try {
        const store = createSecretStore();
        const removed = await store.delete(key);
        if (globals.json === true) {
          printJson({ ok: removed, action: 'delete', key, backend: store.backend });
        } else {
          printLine(
            removed
              ? `[OK] secrets.delete ${key} (backend=${store.backend})`
              : `[WARN] secrets.delete ${key}: not found`,
          );
        }
        if (!removed) process.exit(1);
      } catch (err) {
        printErr(`secrets delete: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
