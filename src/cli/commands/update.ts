/**
 * `claude-os update` — tiered update orchestrator per ADR-0005
 * (Selective-Merge-Pattern). Stub (Phase 3a); full implementation in
 * Phase 4.
 *
 * Planned surface:
 *   --env          pull env-repo (ff-only)
 *   --skills       sync iteenschmiede/claude-config skills via Selective-Merge
 *   --plugins      explicit plugin updates (separate log file)
 *   --all          all three above
 *   --auto-accept  apply clean diffs without prompting
 *   --resume       continue an interrupted update from checklist
 *   --rollback     restore from a backup snapshot
 *
 * @module @cli/commands/update
 */
import type { Command } from 'commander';

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('Tiered auto-update (env, skills, plugins) — stub, full impl in Phase 4')
    .option('--env', 'env-repo ff-only pull')
    .option('--skills', 'skills selective-merge sync')
    .option('--plugins', 'explicit plugin updates')
    .option('--all', 'run env + skills + plugins')
    .option('--auto-accept', 'apply clean diffs without prompting')
    .option('--resume', 'continue an interrupted update')
    .option('--rollback [timestamp]', 'restore from a backup snapshot')
    .action(() => {
      // biome-ignore lint/suspicious/noConsole: CLI stub output
      console.log('claude-os update: not yet implemented (Phase 4).');
      process.exit(0);
    });
}
