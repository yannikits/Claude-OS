#!/usr/bin/env node
/**
 * claude-os CLI entry point.
 *
 * Per ADR-0003 (Hybrid CLI), this module is the single entry-point for
 * management commands. AI sessions are delegated to the Anthropic
 * `bin/claude{,.exe}` binary via the `ai` subcommand (Phase 3+).
 *
 * @module @cli/index
 */
import { Command } from 'commander';
import { registerDoctorCommand } from './commands/doctor.js';

const program = new Command();

program
  .name('claude-os')
  .description(
    'Claude Develop Environment OS — Tauri GUI + Node CLI + cloud-mount vault sync',
  )
  .version('0.1.0-alpha.1')
  .option(
    '--root <path>',
    'Override claude-os root path (default: $CLAUDE_OS_ROOT or repo-detect)',
  )
  .option('--json', 'Output as JSON (for machine consumption)')
  .option('-v, --verbose', 'Verbose logging');

registerDoctorCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  // biome-ignore lint/suspicious/noConsole: top-level error reporter goes to stderr
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
