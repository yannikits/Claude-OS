/**
 * `claude-os users` — admin CLI for the Web-7-5 multi-user store
 * (ADR-0036 draft). Provides the provisioning surface for the
 * `MultiUserConfig.userRepo` exposed by the headless HTTP server.
 *
 * The same `UserRepository` (sql.js, `<dataDir>/users.sqlite`) is used
 * by the server; running `claude-os users create` on the host opens
 * the on-disk file directly. The server must be stopped or running
 * with `$CLAUDE_OS_SESSION_PERSIST=0` (default) — sql.js doesn't
 * support concurrent writers. We document the constraint, not enforce
 * it (the file-lock would surface as an explicit "EBUSY"-style error).
 *
 * Subcommands:
 *   - create   --email <e> --password <p> [--tenant-override <id>]
 *   - list     [--include-disabled] [--json]
 *   - disable  <id-or-email>
 *   - enable   <id-or-email>
 *   - reset-password <id-or-email> [--password <p> | --random]
 *   - sessions list   [--user <id-or-email>]
 *   - sessions revoke <session-id>
 *
 * **Persistence-Caveat:** sessions live in process memory. The `sessions`
 * subcommand operates against an EMPTY in-memory store unless the server
 * happens to be running in the same process. For Web-7-5 v1 we surface
 * a clear warning + exit code so the user knows the limit.
 *
 * @module @cli/commands/users
 */
import { randomBytes } from 'node:crypto';
import type { Command } from 'commander';
import { resolveMachinePaths } from '../../core/paths/index.js';
import { SessionRepository } from '../../domains/sessions/index.js';
import {
  DuplicateEmailError,
  InvalidEmailError,
  UserError,
  UserNotFoundError,
  UserRepository,
  WeakPasswordError,
} from '../../domains/users/index.js';
import { type GlobalOpts, printErr, printJson, printLine } from '../output.js';

interface CreateOpts {
  readonly email: string;
  readonly password: string;
  readonly tenantOverride?: string;
}
interface ResetOpts {
  readonly password?: string;
  readonly random?: boolean;
}

function dataDirFromEnv(): string {
  return resolveMachinePaths().dataDir;
}

function makeRandomPassword(): string {
  // 24 base64url-Zeichen ~ 144 bits — comfortable for MIN_PASSWORD_LEN=12.
  return randomBytes(18).toString('base64url');
}

function formatUserRow(u: {
  id: string;
  email: string;
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  tenantIdOverride: string | null;
}): string {
  const last = u.lastLoginAt === null ? 'never' : new Date(u.lastLoginAt).toISOString();
  const created = new Date(u.createdAt).toISOString();
  const flags = u.disabled ? '[disabled]' : '         ';
  const override = u.tenantIdOverride === null ? '' : ` tenant=${u.tenantIdOverride}`;
  return `${flags} ${u.id}  ${u.email}  created=${created}  last-login=${last}${override}`;
}

export function registerUsersCommand(program: Command): void {
  const users = program
    .command('users')
    .description('Admin CLI for the multi-user store (ADR-0036, Phase Web-7-5)');

  // ---- create ----
  users
    .command('create')
    .description('Create a new user account')
    .requiredOption('--email <email>', 'Email address')
    .requiredOption('--password <password>', 'Plaintext password (MIN 12 chars)')
    .option('--tenant-override <id>', 'Shared tenant-id (power feature)')
    .action(async (opts: CreateOpts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      let repo: UserRepository | null = null;
      try {
        repo = await UserRepository.open({ dataDir: dataDirFromEnv() });
        const user = await repo.createUser(opts.email, opts.password, {
          ...(opts.tenantOverride !== undefined ? { tenantIdOverride: opts.tenantOverride } : {}),
        });
        if (globals.json === true) {
          printJson({ ok: true, action: 'create', user: { id: user.id, email: user.email } });
        } else {
          printLine(`[OK] users.create ${user.email} (id=${user.id})`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code =
          err instanceof DuplicateEmailError
            ? 'duplicate-email'
            : err instanceof InvalidEmailError
              ? 'invalid-email'
              : err instanceof WeakPasswordError
                ? 'weak-password'
                : 'create-failed';
        if (globals.json === true) {
          printJson({ ok: false, action: 'create', code, message: msg });
        } else {
          printErr(`users create: ${msg}`);
        }
        process.exit(1);
      } finally {
        repo?.close();
      }
    });

  // ---- list ----
  users
    .command('list')
    .description('List user accounts')
    .option('--include-disabled', 'Include disabled accounts in the output')
    .action(async (opts: { includeDisabled?: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      let repo: UserRepository | null = null;
      try {
        repo = await UserRepository.open({ dataDir: dataDirFromEnv() });
        const items = repo.list({ includeDisabled: opts.includeDisabled === true });
        if (globals.json === true) {
          printJson({
            ok: true,
            action: 'list',
            count: items.length,
            users: items.map((u) => ({
              id: u.id,
              email: u.email,
              disabled: u.disabled,
              createdAt: u.createdAt,
              lastLoginAt: u.lastLoginAt,
              tenantIdOverride: u.tenantIdOverride,
            })),
          });
        } else if (items.length === 0) {
          printLine('(no users registered)');
        } else {
          for (const u of items) printLine(formatUserRow(u));
        }
      } catch (err) {
        printErr(`users list: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      } finally {
        repo?.close();
      }
    });

  // ---- disable ----
  users
    .command('disable <id-or-email>')
    .description('Disable an account (keeps the row but blocks login)')
    .action(async (target: string, _opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      let repo: UserRepository | null = null;
      try {
        repo = await UserRepository.open({ dataDir: dataDirFromEnv() });
        const ok = repo.disable(target);
        if (globals.json === true) {
          printJson({ ok, action: 'disable', target });
        } else {
          printLine(
            ok
              ? `[OK] users.disable ${target}`
              : `[NOOP] users.disable ${target} (not found / already disabled)`,
          );
        }
        if (!ok) process.exit(2);
      } catch (err) {
        printErr(`users disable: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      } finally {
        repo?.close();
      }
    });

  // ---- enable ----
  users
    .command('enable <id-or-email>')
    .description('Re-enable a previously disabled account')
    .action(async (target: string, _opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      let repo: UserRepository | null = null;
      try {
        repo = await UserRepository.open({ dataDir: dataDirFromEnv() });
        const ok = repo.enable(target);
        if (globals.json === true) {
          printJson({ ok, action: 'enable', target });
        } else {
          printLine(
            ok
              ? `[OK] users.enable ${target}`
              : `[NOOP] users.enable ${target} (not found / already enabled)`,
          );
        }
        if (!ok) process.exit(2);
      } catch (err) {
        printErr(`users enable: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      } finally {
        repo?.close();
      }
    });

  // ---- reset-password ----
  users
    .command('reset-password <id-or-email>')
    .description('Set a new password for an existing account')
    .option('--password <password>', 'Explicit new password (MIN 12 chars)')
    .option('--random', 'Generate a random password and print it once')
    .action(async (target: string, opts: ResetOpts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      if ((opts.password === undefined) === (opts.random !== true)) {
        printErr('users reset-password: exactly one of --password or --random is required');
        process.exit(1);
        return;
      }
      let repo: UserRepository | null = null;
      try {
        repo = await UserRepository.open({ dataDir: dataDirFromEnv() });
        const newPassword = opts.random === true ? makeRandomPassword() : opts.password!;
        await repo.setPassword(target, newPassword);
        if (globals.json === true) {
          printJson({
            ok: true,
            action: 'reset-password',
            target,
            ...(opts.random === true ? { generatedPassword: newPassword } : {}),
          });
        } else {
          printLine(`[OK] users.reset-password ${target}`);
          if (opts.random === true) {
            printLine(`New password: ${newPassword}`);
            printLine("# Save this now — it won't be shown again.");
          }
        }
      } catch (err) {
        const code =
          err instanceof WeakPasswordError
            ? 'weak-password'
            : err instanceof UserNotFoundError
              ? 'not-found'
              : err instanceof UserError
                ? 'user-error'
                : 'unknown';
        const msg = err instanceof Error ? err.message : String(err);
        if (globals.json === true) {
          printJson({ ok: false, action: 'reset-password', code, message: msg });
        } else {
          printErr(`users reset-password: ${msg}`);
        }
        process.exit(1);
      } finally {
        repo?.close();
      }
    });

  // ---- sessions list ----
  const sessions = users
    .command('sessions')
    .description('Inspect / revoke session-cookies (Phase Web-7-5 caveat: in-memory)');

  sessions
    .command('list')
    .description('List active sessions (process-local — empty unless server runs in same process)')
    .option('--user <id-or-email>', 'Filter to one user (id or email)')
    .action(async (opts: { user?: string }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      // Sessions live in process memory; this CLI subcommand always
      // opens a fresh empty store. We surface that explicitly.
      const sessionStore = new SessionRepository();
      let repo: UserRepository | null = null;
      let userId: string | null = null;
      try {
        if (opts.user !== undefined) {
          repo = await UserRepository.open({ dataDir: dataDirFromEnv() });
          const user = opts.user.includes('@')
            ? repo.findByEmail(opts.user)
            : repo.findById(opts.user);
          if (user === null) {
            printErr(`users sessions list: user "${opts.user}" not found`);
            process.exit(2);
            return;
          }
          userId = user.id;
        }
        const items = userId !== null ? sessionStore.listForUser(userId) : [];
        const note =
          'NOTE: session store is in-process only; this CLI sees an empty snapshot. ' +
          'For live data attach to the running server.';
        if (globals.json === true) {
          printJson({
            ok: true,
            action: 'sessions.list',
            count: items.length,
            sessions: items,
            note,
          });
        } else {
          printLine(`# ${note}`);
          if (items.length === 0) printLine('(no sessions visible to this CLI process)');
          else
            for (const s of items)
              printLine(
                `${s.id}  user=${s.userId}  expires=${new Date(s.expiresAt).toISOString()}`,
              );
        }
      } catch (err) {
        printErr(`users sessions list: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      } finally {
        repo?.close();
      }
    });

  sessions
    .command('revoke <session-id>')
    .description('Revoke a session by id (Web-7-5 caveat: in-memory only)')
    .action(async (sessionId: string, _opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      const sessionStore = new SessionRepository();
      const ok = sessionStore.revoke(sessionId);
      const note =
        'NOTE: session store is in-process only; running this CLI does not affect a separate server.';
      if (globals.json === true) {
        printJson({ ok, action: 'sessions.revoke', sessionId, note });
      } else {
        printLine(`# ${note}`);
        printLine(
          ok
            ? `[OK] users.sessions.revoke ${sessionId}`
            : `[NOOP] users.sessions.revoke ${sessionId} (not found in this process)`,
        );
      }
      if (!ok) process.exit(2);
    });
}
