/**
 * `claude-os agent` — agent-runs browser (Phase 5h).
 *
 * Replaces the Phase 3a stub. Backed by AgentRunsRepository
 * (Phase 5c) which reads the per-machine JSONL files + JSON index.
 *
 * Subcommands:
 *   list    --project <name> --limit <n>   list recorded runs
 *   show    <runId>                        full record + paths
 *   replay  <runId>                        prints the recorded prompt
 *                                          and hints at the deferred
 *                                          full re-spawn path
 *
 * @module @cli/commands/agent
 */

import { join } from 'node:path';
import type { Command } from 'commander';
import { RootNotFoundError, resolveRoot } from '../../core/environment/index.js';
import { resolveMachinePaths } from '../../core/paths/index.js';
import { AgentRunsRepository, agentRunsIndexPathFor } from '../../domains/agent-runs/index.js';
import { type GlobalOpts, printErr, printJson, printLine } from '../output.js';

function resolveRepoFromGlobals(globals: GlobalOpts): AgentRunsRepository {
  const root = resolveRoot(globals.root === undefined ? {} : { explicit: globals.root });
  const machine = resolveMachinePaths();
  return new AgentRunsRepository({
    agentRunsRoot: join(root.path, 'vault', 'agent-runs'),
    indexPath: agentRunsIndexPathFor(machine.dataDir),
    vaultRoot: join(root.path, 'vault'),
  });
}

function actList(globals: GlobalOpts, opts: { project?: string; limit?: string }): void {
  let repo: AgentRunsRepository;
  try {
    repo = resolveRepoFromGlobals(globals);
  } catch (err) {
    if (err instanceof RootNotFoundError) {
      printErr(`agent list: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const limit = opts.limit === undefined ? undefined : Number.parseInt(opts.limit, 10);
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
    printErr(`agent list: --limit must be a non-negative integer, got "${opts.limit}"`);
    process.exit(1);
  }
  const items = repo.list({
    ...(opts.project === undefined ? {} : { project: opts.project }),
    ...(limit === undefined ? {} : { limit }),
  });
  if (globals.json === true) {
    printJson({ ok: true, count: items.length, items });
    return;
  }
  if (items.length === 0) {
    printLine('(no agent runs recorded yet)');
    return;
  }
  for (const r of items) {
    const status =
      r.exitCode === 0 ? 'ok' : r.exitCode === null ? (r.signal ?? 'signal') : `exit ${r.exitCode}`;
    printLine(`${r.timestamp}  ${r.runId.slice(0, 8)}  ${r.project}  [${status}]  ${r.prompt}`);
  }
}

function actShow(globals: GlobalOpts, runId: string): void {
  let repo: AgentRunsRepository;
  try {
    repo = resolveRepoFromGlobals(globals);
  } catch (err) {
    if (err instanceof RootNotFoundError) {
      printErr(`agent show: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const record = repo.show(runId);
  if (record === null) {
    printErr(`agent show: no run with id "${runId}"`);
    process.exit(1);
  }
  if (globals.json === true) {
    printJson(record);
    return;
  }
  printLine(`runId:      ${record.runId}`);
  printLine(`timestamp:  ${record.timestamp}`);
  printLine(`project:    ${record.project}`);
  printLine(`machine:    ${record.machineId}`);
  printLine(`binary:     ${record.binaryPath} (source=${record.binarySource})`);
  printLine(`exitCode:   ${record.exitCode}`);
  printLine(`signal:     ${record.signal ?? 'null'}`);
  printLine(`duration:   ${record.durationMs}ms`);
  printLine('');
  printLine(`prompt:`);
  printLine(record.prompt);
}

function actReplay(globals: GlobalOpts, runId: string): void {
  let repo: AgentRunsRepository;
  try {
    repo = resolveRepoFromGlobals(globals);
  } catch (err) {
    if (err instanceof RootNotFoundError) {
      printErr(`agent replay: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const record = repo.show(runId);
  if (record === null) {
    printErr(`agent replay: no run with id "${runId}"`);
    process.exit(1);
  }
  if (globals.json === true) {
    printJson({
      ok: false,
      hint: 'real replay is staged for a later iteration. The recorded prompt is included so you can manually re-run.',
      record,
    });
    return;
  }
  printLine(`# Replay run ${record.runId} (deferred — print-only for v1)`);
  printLine('# To actually re-run, manually invoke:');
  printLine(`#   claude-os ai -p "${record.prompt.replace(/"/g, '\\"')}"`);
  printLine('');
  printLine(record.prompt);
}

export function registerAgentCommand(program: Command): void {
  const agent = program.command('agent').description('Agent-runs browser (ADR-0002)');

  agent
    .command('list')
    .description('List recorded agent runs (newest first)')
    .option('--project <name>', 'filter by project')
    .option('--limit <n>', 'maximum number of rows')
    .action((opts: { project?: string; limit?: string }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      actList(globals, opts);
    });

  agent
    .command('show <runId>')
    .description('Show a run by id')
    .action((runId: string, _opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      actShow(globals, runId);
    });

  agent
    .command('replay <runId>')
    .description('Print the recorded prompt (full re-spawn is deferred)')
    .action((runId: string, _opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      actReplay(globals, runId);
    });
}
