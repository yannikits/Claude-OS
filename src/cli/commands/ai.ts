/**
 * `claude-os ai` — forwards all subsequent args to the Anthropic
 * `bin/claude{,.exe}` binary via the claude-bridge spawn-wrapper.
 *
 * Stub (Phase 3a). Full implementation lands in Phase 3c, where this
 * command becomes the user-facing entry-point for AI sessions and
 * propagates the child exit-code 1:1. The spawn-wrapper itself
 * (Phase 3b) handles streaming stdin/stdout without buffering — the
 * fix for the reproducible 120s buffer-cutoff regression
 * (Memory 569 / 577 / 578).
 *
 * @module @cli/commands/ai
 */
import type { Command } from 'commander';

export function registerAiCommand(program: Command): void {
  program
    .command('ai')
    .description(
      'Forward args to the Anthropic claude binary (Phase 3c). Stub — not yet implemented.',
    )
    .allowUnknownOption(true)
    .helpOption(false)
    .action(() => {
      // biome-ignore lint/suspicious/noConsole: CLI stub output
      console.log(
        'claude-os ai: not yet implemented (Phase 3c). Will spawn bin/claude{,.exe} with streamed stdio.',
      );
      process.exit(0);
    });
}
