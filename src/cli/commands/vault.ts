/**
 * `claude-os vault` — Vault-sync CLI (Phase 2f).
 *
 * Replaces the Phase 3a stub. Wires the domain modules together:
 *   - paths/machine-paths → resolves <dataRoot> for state + config files
 *   - vault-sync/snapshot → stage → commit → push
 *   - vault-sync/conflict-policy → push-rejection handling
 *   - vault-sync/busy-flag → crash-recovery + concurrency gate
 *   - vault-sync/vault-config → conflict-mode + scheduler-enabled persistence
 *   - vault-sync/gitignore-template → init-gitignore subcommand
 *
 * `vault schedule --enable/--disable` toggles the config flag the
 * Phase 6 Tauri sidecar reads at boot. A foreground watcher mode is
 * deferred to Phase 6 — the CLI process is short-lived by design.
 *
 * @module @cli/commands/vault
 */

import { join } from 'node:path';
import type { Command } from 'commander';
import { RootNotFoundError, resolveRoot } from '../../core/environment/index.js';
import { GitService } from '../../core/git/index.js';
import { resolveMachinePaths } from '../../core/paths/index.js';
import {
  applyConflictResolution,
  applyDefaultGitignore,
  BusyFlag,
  type ConflictMode,
  isPushConflictError,
  loadVaultConfig,
  snapshot,
  updateVaultConfig,
  type VaultConfig,
} from '../../domains/vault-sync/index.js';

interface GlobalOpts {
  readonly root?: string;
  readonly json?: boolean;
}

function printJson(payload: unknown): void {
  // biome-ignore lint/suspicious/noConsole: CLI presenter output by design
  console.log(JSON.stringify(payload, null, 2));
}

function printLine(line: string): void {
  // biome-ignore lint/suspicious/noConsole: CLI presenter output by design
  console.log(line);
}

function printErr(line: string): void {
  console.error(line);
}

interface ResolvedVaultPaths {
  readonly vaultPath: string;
  readonly busyFlagPath: string;
  readonly configPath: string;
}

function resolveVaultPaths(globals: GlobalOpts): ResolvedVaultPaths {
  const root = resolveRoot(globals.root === undefined ? {} : { explicit: globals.root });
  const paths = resolveMachinePaths();
  return {
    vaultPath: join(root.path, 'vault'),
    busyFlagPath: join(paths.dataDir, 'vault-sync-state.json'),
    configPath: join(paths.dataDir, 'vault-config.json'),
  };
}

async function actSnapshot(globals: GlobalOpts, skipPush: boolean): Promise<void> {
  let paths: ResolvedVaultPaths;
  try {
    paths = resolveVaultPaths(globals);
  } catch (err) {
    if (err instanceof RootNotFoundError) {
      printErr(`vault snapshot: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const flag = new BusyFlag({ filePath: paths.busyFlagPath });
  if (!flag.acquire('cli:snapshot')) {
    const held = flag.read();
    const detail =
      held === null ? 'unknown' : `${held.hostname} pid=${held.pid} since ${held.acquiredAt}`;
    if (globals.json === true) {
      printJson({ ok: false, action: 'snapshot', state: 'busy', heldBy: detail });
    } else {
      printErr(`vault snapshot: busy (held by ${detail}). Use \`vault unlock\` to override.`);
    }
    process.exit(1);
  }

  try {
    const config = loadVaultConfig(paths.configPath);
    const result = await snapshot({ workTree: paths.vaultPath, skipPush });

    if (result.state === 'push-failed' && isPushConflictError(new Error(result.error ?? ''))) {
      const git = new GitService(paths.vaultPath);
      const resolution = await applyConflictResolution({
        mode: config.conflictMode,
        git,
        branch: result.branch,
      });
      if (globals.json === true) {
        printJson({ ok: resolution.state !== 'error', snapshot: result, resolution });
      } else {
        printLine(`[WARN] ${result.summary}`);
        printLine(`  ${resolution.message}`);
        if (resolution.backupBranch !== undefined) {
          printLine(`  backup: ${resolution.backupBranch}`);
        }
      }
      if (resolution.state === 'aborted' || resolution.state === 'error') {
        process.exit(1);
      }
      return;
    }

    if (globals.json === true) {
      printJson({ ok: result.state !== 'error', snapshot: result });
    } else {
      const marker =
        result.state === 'error' || result.state === 'commit-failed'
          ? '[FAIL]'
          : result.state === 'push-failed'
            ? '[WARN]'
            : '[OK]  ';
      printLine(`${marker} ${result.summary}`);
      if (result.error !== undefined) printLine(`        Error: ${result.error}`);
    }
    if (result.state === 'error' || result.state === 'commit-failed') process.exit(1);
  } finally {
    flag.release();
  }
}

function actStatus(globals: GlobalOpts): void {
  let paths: ResolvedVaultPaths;
  try {
    paths = resolveVaultPaths(globals);
  } catch (err) {
    if (err instanceof RootNotFoundError) {
      printErr(`vault status: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const flag = new BusyFlag({ filePath: paths.busyFlagPath });
  const busy = flag.read();
  const config = loadVaultConfig(paths.configPath);

  if (globals.json === true) {
    printJson({
      vaultPath: paths.vaultPath,
      busy,
      config,
    });
    return;
  }
  printLine(`vault: ${paths.vaultPath}`);
  printLine(`conflict-mode: ${config.conflictMode}`);
  printLine(`schedule-enabled: ${config.scheduleEnabled} (idleSeconds=${config.idleSeconds})`);
  if (busy === null) {
    printLine('busy: false');
  } else {
    printLine(
      `busy: true (reason=${busy.reason}, host=${busy.hostname}, pid=${busy.pid}, since=${busy.acquiredAt})`,
    );
  }
}

function actConflictMode(globals: GlobalOpts, mode: string): void {
  if (mode !== 'abort' && mode !== 'prefer-local' && mode !== 'prefer-remote') {
    printErr(
      `vault conflict-mode: invalid mode "${mode}" (expected abort|prefer-local|prefer-remote)`,
    );
    process.exit(1);
  }
  let paths: ResolvedVaultPaths;
  try {
    paths = resolveVaultPaths(globals);
  } catch (err) {
    if (err instanceof RootNotFoundError) {
      printErr(`vault conflict-mode: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const next = updateVaultConfig(paths.configPath, { conflictMode: mode as ConflictMode });
  if (globals.json === true) {
    printJson({ ok: true, action: 'conflict-mode', config: next });
  } else {
    printLine(`[OK] conflict-mode set to ${next.conflictMode}`);
  }
}

function actSchedule(
  globals: GlobalOpts,
  opts: { enable?: boolean; disable?: boolean; idleSeconds?: string },
): void {
  let paths: ResolvedVaultPaths;
  try {
    paths = resolveVaultPaths(globals);
  } catch (err) {
    if (err instanceof RootNotFoundError) {
      printErr(`vault schedule: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const patch: { -readonly [K in keyof VaultConfig]?: VaultConfig[K] } = {};
  if (opts.enable === true && opts.disable === true) {
    printErr('vault schedule: cannot pass --enable and --disable together');
    process.exit(1);
  }
  if (opts.enable === true) patch.scheduleEnabled = true;
  if (opts.disable === true) patch.scheduleEnabled = false;
  if (opts.idleSeconds !== undefined) {
    const parsed = Number.parseInt(opts.idleSeconds, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      printErr(
        `vault schedule: --idle-seconds must be a positive integer, got "${opts.idleSeconds}"`,
      );
      process.exit(1);
    }
    patch.idleSeconds = parsed;
  }
  const next = updateVaultConfig(paths.configPath, patch);
  if (globals.json === true) {
    printJson({ ok: true, action: 'schedule', config: next });
  } else {
    printLine(
      `[OK] schedule-enabled=${next.scheduleEnabled}, idleSeconds=${next.idleSeconds} ` +
        '(actual watcher runs in the Phase 6 sidecar)',
    );
  }
}

function actUnlock(globals: GlobalOpts): void {
  let paths: ResolvedVaultPaths;
  try {
    paths = resolveVaultPaths(globals);
  } catch (err) {
    if (err instanceof RootNotFoundError) {
      printErr(`vault unlock: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const flag = new BusyFlag({ filePath: paths.busyFlagPath });
  const before = flag.read();
  flag.forceReset();
  if (globals.json === true) {
    printJson({ ok: true, action: 'unlock', previousState: before });
  } else if (before === null) {
    printLine('[OK] vault unlock: no flag was held');
  } else {
    printLine(
      `[OK] vault unlock: reset flag (was held by ${before.hostname} pid=${before.pid} since ${before.acquiredAt})`,
    );
  }
}

function actInitGitignore(globals: GlobalOpts): void {
  let paths: ResolvedVaultPaths;
  try {
    paths = resolveVaultPaths(globals);
  } catch (err) {
    if (err instanceof RootNotFoundError) {
      printErr(`vault init-gitignore: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const result = applyDefaultGitignore(paths.vaultPath);
  if (globals.json === true) {
    printJson({ ok: true, action: 'init-gitignore', result });
  } else {
    printLine(`[OK] .gitignore ${result.created ? 'created' : 'updated'} at ${result.path}`);
    printLine(`     added=${result.added.length}, already-present=${result.alreadyPresent.length}`);
  }
}

export function registerVaultCommand(program: Command): void {
  const vault = program.command('vault').description('Vault sync subsystem (ADR-0002)');

  vault
    .command('snapshot')
    .description('Stage all working-tree changes, commit, push to origin')
    .option('--no-push', 'commit locally but skip push (offline mode)')
    .action(async (opts: { push?: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      await actSnapshot(globals, opts.push === false);
    });

  vault
    .command('status')
    .description('Show current vault-sync state (config, busy-flag)')
    .action((_opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      actStatus(globals);
    });

  vault
    .command('conflict-mode <mode>')
    .description('Set conflict policy: abort | prefer-local | prefer-remote')
    .action((mode: string, _opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      actConflictMode(globals, mode);
    });

  vault
    .command('schedule')
    .description('Toggle the auto-snapshot scheduler (config; sidecar runs the watcher)')
    .option('--enable', 'enable scheduling')
    .option('--disable', 'disable scheduling')
    .option('--idle-seconds <n>', 'idle threshold in seconds (default 300)')
    .action(
      (opts: { enable?: boolean; disable?: boolean; idleSeconds?: string }, command: Command) => {
        const globals = command.optsWithGlobals<GlobalOpts>();
        actSchedule(globals, opts);
      },
    );

  vault
    .command('unlock')
    .description('Reset the persistent busy-flag (recover from crashed snapshot)')
    .action((_opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      actUnlock(globals);
    });

  vault
    .command('init-gitignore')
    .description('Apply the default vault .gitignore template (idempotent merge)')
    .action((_opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      actInitGitignore(globals);
    });
}
