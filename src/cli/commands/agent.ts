/**
 * `claude-os agent` — agent-runs browser (Phase 5). Stub.
 *
 * Planned subcommands:
 *   list                    list runs (optionally --project filter)
 *   show <id>               display a run with metadata
 *   replay <id>             re-run with same inputs
 *
 * @module @cli/commands/agent
 */
import type { Command } from 'commander';

function notImplemented(): void {
  // biome-ignore lint/suspicious/noConsole: CLI stub output
  console.log('claude-os agent: not yet implemented (Phase 5).');
  process.exit(0);
}

export function registerAgentCommand(program: Command): void {
  const agent = program
    .command('agent')
    .description('Agent-runs browser (Phase 5). Stub.');

  agent
    .command('list')
    .description('List runs')
    .option('--project <name>', 'filter by project')
    .action(notImplemented);
  agent.command('show <id>').description('Show a run').action(notImplemented);
  agent.command('replay <id>').description('Re-run with same inputs').action(notImplemented);
}
