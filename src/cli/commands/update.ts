/**
 * `claude-os update` — tiered update orchestrator (Phase 4f).
 *
 * Replaces the Phase 3a stub. Wires the update-orchestrator domain
 * pieces (env-repo, skills-repo, BackupManager, plugins) together
 * behind the CLI surface declared in the Phase-4 tracker.
 *
 * Flags:
 *   --env             pull env-repo only (ff-only)
 *   --skills          pull skills-repo only (ff-only; selective-merge
 *                     hint surfaced on aborted-dirty)
 *   --plugins         delegates to plugins.ts (v1 returns no-remote
 *                     pointing at Phase 5 catalog)
 *   --all             env + skills + plugins (plugins skipped in v1)
 *   --auto-accept     forward to review-loop autoAccept (no-op in v1
 *                     where the review loop isn't yet wired through
 *                     the CLI)
 *   --rollback [ts]   restore from BackupManager (default: latest)
 *   --resume          surfaces a pointer to the planned full flow
 *
 * v1 deviation from ADR-0005: the full selective-merge orchestrator
 * (upstream-mirror + ZoneClassifier + DiffEngine + ReviewLoop +
 * ResumableChecklist composition) is staged for a later iteration.
 * The individual pieces are shipped and unit-tested (Phase 4b-4e);
 * the CLI wire layer here covers the env/skills happy path.
 *
 * @module @cli/commands/update
 */
import type { Command } from 'commander';
import { join } from 'node:path';
import { resolveRoot, RootNotFoundError } from '../../core/environment/index.js';
import { resolveMachinePaths } from '../../core/paths/index.js';
import {
  BackupManager,
  backupsDirFor,
  updateEnvRepo,
  updatePlugins,
  updateSkillsRepo,
  type UpdateResult,
} from '../../domains/update-orchestrator/index.js';

const SKILLS_REPO_SOURCE = 'https://github.com/iteenschmiede/claude-config.git';
const SKILLS_REPO_BRANCH = 'main';

interface GlobalOpts {
  readonly root?: string;
  readonly json?: boolean;
}

interface UpdateOpts {
  readonly env?: boolean;
  readonly skills?: boolean;
  readonly plugins?: boolean;
  readonly all?: boolean;
  readonly autoAccept?: boolean;
  readonly resume?: boolean;
  readonly rollback?: string | boolean;
}

interface ResolvedUpdatePaths {
  readonly envRepoPath: string;
  readonly skillsDir: string;
  readonly backupsDir: string;
  readonly logsDir: string;
  readonly dataDir: string;
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
  // biome-ignore lint/suspicious/noConsole: error reporter to stderr
  console.error(line);
}

function resolveUpdatePaths(globals: GlobalOpts): ResolvedUpdatePaths {
  const root = resolveRoot(globals.root === undefined ? {} : { explicit: globals.root });
  const machine = resolveMachinePaths();
  return {
    envRepoPath: process.cwd(),
    skillsDir: join(root.path, 'config', 'skills'),
    backupsDir: backupsDirFor(machine.dataRoot),
    logsDir: machine.logsDir,
    dataDir: machine.dataDir,
  };
}

function severityFor(result: UpdateResult): '[OK]  ' | '[WARN]' | '[FAIL]' {
  if (result.state === 'error') return '[FAIL]';
  if (
    result.state === 'aborted-dirty' ||
    result.state === 'aborted-diverged' ||
    result.state === 'no-remote'
  ) {
    return '[WARN]';
  }
  return '[OK]  ';
}

function printResult(result: UpdateResult, json: boolean): void {
  if (json) {
    printJson(result);
    return;
  }
  printLine(`${severityFor(result)} ${result.scope}: ${result.message}`);
  if (
    result.previousSha !== undefined &&
    result.newSha !== undefined &&
    result.previousSha !== result.newSha
  ) {
    printLine(`        ${result.previousSha.slice(0, 7)} -> ${result.newSha.slice(0, 7)}`);
  }
  if (result.error !== undefined) {
    printLine(`        Error: ${result.error}`);
  }
  printLine(`        (${result.durationMs}ms)`);
}

async function doRollback(
  globals: GlobalOpts,
  rollbackArg: string | boolean,
): Promise<void> {
  let paths: ResolvedUpdatePaths;
  try {
    paths = resolveUpdatePaths(globals);
  } catch (err) {
    if (err instanceof RootNotFoundError) {
      printErr(`update --rollback: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const mgr = new BackupManager({ backupsDir: paths.backupsDir });
  const timestamp = typeof rollbackArg === 'string' ? rollbackArg : 'latest';
  const list = mgr.list();
  if (list.length === 0) {
    printErr(`update --rollback: no backups present in ${paths.backupsDir}`);
    process.exit(1);
  }
  const explicit = list.find((e) => e.timestamp === timestamp) ?? null;
  const target = timestamp === 'latest' ? list[list.length - 1] : explicit;
  if (target === undefined || target === null) {
    printErr(`update --rollback: no backup matching "${timestamp}"`);
    process.exit(1);
  }
  const restored = mgr.restore(target.timestamp, target.sourceDir);
  if (globals.json === true) {
    printJson({ ok: true, action: 'rollback', restored });
  } else {
    printLine(`[OK] rolled back to ${target.timestamp}`);
    printLine(`     restored ${target.fileCount} files to ${target.sourceDir}`);
  }
}

async function doEnv(globals: GlobalOpts, paths: ResolvedUpdatePaths): Promise<UpdateResult> {
  const result = await updateEnvRepo({ repoPath: paths.envRepoPath });
  printResult(result, globals.json === true);
  return result;
}

async function doSkills(
  globals: GlobalOpts,
  paths: ResolvedUpdatePaths,
): Promise<UpdateResult> {
  const result = await updateSkillsRepo({
    destination: paths.skillsDir,
    source: SKILLS_REPO_SOURCE,
    branch: SKILLS_REPO_BRANCH,
  });
  printResult(result, globals.json === true);
  if (result.state === 'aborted-dirty' && globals.json !== true) {
    printLine(
      '        Hint: skills-repo has local modifications. Selective-merge ' +
        'review (ADR-0005 §48) ships in a later iteration. For now: ' +
        'manually resolve or `git stash` inside the skills directory.',
    );
  }
  return result;
}

async function doPlugins(
  globals: GlobalOpts,
  paths: ResolvedUpdatePaths,
): Promise<UpdateResult> {
  const result = await updatePlugins({ logsDir: paths.logsDir });
  printResult(result, globals.json === true);
  return result;
}

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description(
      'Tiered auto-update for env-repo + skills-repo + plugins (ADR-0005).',
    )
    .option('--env', 'env-repo ff-only pull')
    .option('--skills', 'skills-repo selective-merge')
    .option('--plugins', 'explicit plugin updates (Phase 5 catalog)')
    .option('--all', 'run env + skills + plugins')
    .option('--auto-accept', 'apply clean diffs without prompting')
    .option('--resume', 'continue an interrupted update from checklist')
    .option(
      '--rollback [timestamp]',
      'restore from backup (default: latest); accepts an explicit timestamp',
    )
    .action(async (opts: UpdateOpts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      const json = globals.json === true;

      if (opts.rollback !== undefined && opts.rollback !== false) {
        await doRollback(globals, opts.rollback);
        return;
      }

      if (opts.resume === true) {
        const hint =
          'update --resume: full selective-merge orchestrator ships in a later iteration. ' +
          'The ResumableChecklist module is wired (Phase 4e) but the CLI orchestration ' +
          'is still pending.';
        if (json) printJson({ ok: false, action: 'resume', hint });
        else printErr(hint);
        process.exit(2);
      }

      const wantEnv = opts.env === true || opts.all === true;
      const wantSkills = opts.skills === true || opts.all === true;
      const wantPlugins = opts.plugins === true || opts.all === true;

      if (!wantEnv && !wantSkills && !wantPlugins) {
        if (json) {
          printJson({
            ok: false,
            hint: 'no flag selected — use --env, --skills, --plugins, or --all',
          });
        } else {
          printErr(
            'update: no flag selected (use --env, --skills, --plugins, --all, --rollback, or --resume)',
          );
        }
        process.exit(1);
      }

      let paths: ResolvedUpdatePaths;
      try {
        paths = resolveUpdatePaths(globals);
      } catch (err) {
        if (err instanceof RootNotFoundError) {
          printErr(`update: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }

      const results: UpdateResult[] = [];
      if (wantEnv) results.push(await doEnv(globals, paths));
      if (wantSkills) results.push(await doSkills(globals, paths));
      if (wantPlugins) results.push(await doPlugins(globals, paths));

      if (json) printJson({ ok: true, results });

      const hasError = results.some((r) => r.state === 'error');
      const hasAborted = results.some(
        (r) =>
          r.state === 'aborted-dirty' ||
          r.state === 'aborted-diverged' ||
          r.state === 'no-remote',
      );
      if (hasError) process.exit(1);
      if (hasAborted) process.exit(2);
    });
}
