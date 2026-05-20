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
import { registerAgentCommand } from './commands/agent.js';
import { registerAiCommand } from './commands/ai.js';
import { registerAuthCommand } from './commands/auth.js';
import { registerCatalogCommand } from './commands/catalog.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerMcpCommand } from './commands/mcp.js';
import { registerMigrateCommand } from './commands/migrate.js';
import { registerSecretsCommand } from './commands/secrets.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerVaultCommand } from './commands/vault.js';

const program = new Command();

program
  .name('claude-os')
  .description('Claude Develop Environment OS — Tauri GUI + Node CLI + cloud-mount vault sync')
  .version('0.1.0-alpha.1')
  .option('--root <path>', 'Override claude-os root path (default: $CLAUDE_OS_ROOT or repo-detect)')
  .option('--json', 'Output as JSON (for machine consumption)')
  .option('-v, --verbose', 'Verbose logging');

registerDoctorCommand(program);
registerUpdateCommand(program);
registerVaultCommand(program);
registerCatalogCommand(program);
registerSecretsCommand(program);
registerAgentCommand(program);
registerAuthCommand(program);
registerAiCommand(program);
registerMcpCommand(program);
registerMigrateCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
