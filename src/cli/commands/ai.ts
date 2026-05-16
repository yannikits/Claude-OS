/**
 * `claude-os ai` — forwards all subsequent args to the Anthropic
 * `bin/claude{,.exe}` binary via the streaming claude-bridge spawn
 * wrapper (Phase 3b/3c).
 *
 * Behavior:
 *   - `--root` is honored from the global option layer
 *   - All other args land in the child via `command.args` (we set
 *     `allowUnknownOption(true)` so commander does not reject claude's
 *     own flags) and are passed verbatim
 *   - Child exit code is propagated 1:1; binary-not-found exits 127
 *
 * @module @cli/commands/ai
 */
import type { Command } from 'commander';
import { resolveRoot, RootNotFoundError } from '../../core/environment/index.js';
import {
  BinaryNotFoundError,
  spawnClaudeBridge,
} from '../../domains/claude-bridge/index.js';

interface GlobalOpts {
  readonly root?: string;
}

function exitCodeFor(exitCode: number | null, signal: NodeJS.Signals | null): number {
  if (exitCode !== null) return exitCode;
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  if (signal === 'SIGKILL') return 137;
  return signal === null ? 0 : 1;
}

export function registerAiCommand(program: Command): void {
  program
    .command('ai')
    .description(
      'Forward args to the Anthropic claude binary; streams stdio without buffering.',
    )
    .allowUnknownOption(true)
    .helpOption(false)
    .argument('[claudeArgs...]', 'arguments to forward to the claude binary')
    .action(async (claudeArgs: readonly string[], _opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      // Mix positional and unknown-option args so flags like `-p hello`
      // are forwarded as-is. commander stashes unknowns in command.args
      // when allowUnknownOption is enabled.
      const args = [...claudeArgs, ...command.args.slice(claudeArgs.length)];

      let rootPath: string | undefined;
      try {
        const root = resolveRoot(
          globals.root === undefined ? {} : { explicit: globals.root },
        );
        rootPath = root.path;
      } catch (err) {
        if (!(err instanceof RootNotFoundError)) throw err;
        // No root — bridge will fall back to $PATH for the binary.
      }

      try {
        const result = await spawnClaudeBridge({
          args,
          ...(rootPath === undefined ? {} : { rootPath }),
        });
        process.exit(exitCodeFor(result.exitCode, result.signal));
      } catch (err) {
        if (err instanceof BinaryNotFoundError) {
          // biome-ignore lint/suspicious/noConsole: user-facing error
          console.error(`claude-os ai: ${err.message}`);
          process.exit(127); // POSIX "command not found"
        }
        throw err;
      }
    });
}
