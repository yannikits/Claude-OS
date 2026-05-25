/**
 * `claude-os ask <prompt>` — MVP one-shot workflow.
 *
 * Pipeline:
 *   1. Resolve vault + active workspace (with --vault/--workspace overrides)
 *   2. Run BM25 retrieval over workspace notes
 *   3. Compose prompt with context-injection
 *   4. Delegate to `bin/claude.exe -p "<composed>"` via Phase-1 bridge
 *
 * `--no-context` skips the retrieval step entirely (raw prompt
 * delegation). `--dry-run` prints the composed prompt without invoking
 * claude.exe — useful for debugging context selection.
 *
 * @module @cli/commands/ask
 */
import type { Command } from 'commander';
import { composePrompt } from '../../domains/ask/index.js';
import { spawnClaudeBridge } from '../../domains/claude-bridge/index.js';
import { searchWorkspace } from '../../domains/retrieval/index.js';
import {
  readActiveWorkspace,
  resolveVaultRoot,
  WorkspaceError,
} from '../../domains/workspace/index.js';
import type { GlobalOpts } from '../output.js';

interface AskCmdOpts {
  readonly workspace?: string;
  readonly topK?: string;
  readonly noContext?: boolean;
  readonly includeEphemeral?: boolean;
  readonly dryRun?: boolean;
}

function printAndExit(output: string, code: number): never {
  // biome-ignore lint/suspicious/noConsole: CLI presenter output by design
  console.log(output);
  process.exit(code);
}

function printErr(line: string): void {
  console.error(line);
}

function parseTopK(raw: string | undefined): number {
  if (raw === undefined) return 5;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--top-k must be a positive integer, got "${raw}"`);
  }
  return n;
}

export function registerAskCommand(program: Command): void {
  program
    .command('ask <prompt...>')
    .description(
      'Compose a prompt with vault context (Phase 2c retrieval) and ' +
        'delegate to bin/claude.exe (ADR-0003 — no own provider).',
    )
    .option('--workspace <id>', 'Override the active workspace for this call')
    .option('--top-k <n>', 'Number of context notes to inject (default 5)', '5')
    .option('--no-context', 'Skip retrieval and send the raw prompt')
    .option('--include-ephemeral', 'Include ephemeral notes in retrieval (default: excluded)')
    .option('--dry-run', 'Print the composed prompt instead of invoking claude.exe')
    .action(async function (this: Command, promptParts: string[], cmdOpts: AskCmdOpts) {
      const globalOpts = program.opts<GlobalOpts>();
      const json = globalOpts.json === true;
      const query = promptParts.join(' ').trim();
      if (query.length === 0) {
        printErr('ask: empty prompt');
        process.exit(2);
      }

      try {
        const vault = resolveVaultRoot(
          globalOpts.vault === undefined ? {} : { explicit: globalOpts.vault },
        );
        const workspaceId = cmdOpts.workspace ?? readActiveWorkspace().active;

        let composed = { text: query, contextHits: [], chars: query.length } as ReturnType<
          typeof composePrompt
        >;

        if (cmdOpts.noContext !== true) {
          const topK = parseTopK(cmdOpts.topK);
          const result = searchWorkspace(vault, workspaceId, {
            text: query,
            topK,
            excludeClassifications: cmdOpts.includeEphemeral === true ? [] : undefined,
          });
          composed = composePrompt(query, result.hits, { workspaceId });
        }

        if (cmdOpts.dryRun === true) {
          const out = json
            ? JSON.stringify(
                {
                  ok: true,
                  workspaceId,
                  contextHits: composed.contextHits.length,
                  chars: composed.chars,
                  prompt: composed.text,
                },
                null,
                2,
              )
            : composed.text;
          printAndExit(out, 0);
        }

        if (json) {
          printErr(
            `[INFO] --json is ignored when invoking claude.exe (stdio:'inherit' streams directly)`,
          );
        }

        const bridge = await spawnClaudeBridge({
          args: ['-p', composed.text],
        });
        process.exit(bridge.exitCode ?? 0);
      } catch (err) {
        if (err instanceof WorkspaceError) {
          printErr(`ask: ${err.message}`);
          process.exit(1);
        }
        if (err instanceof Error) {
          printErr(`ask: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }
    });
}
