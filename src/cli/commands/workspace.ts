/**
 * `claude-os workspace` command — multi-workspace switch/list (ADR-0031).
 *
 * Subcommands:
 *   current             Print the active workspace id (+ path if it exists)
 *   list                List all workspaces under <vault>/Claude-OS/workspaces/
 *   use <id>            Switch the active workspace (validates id, logs audit-event)
 *   where [<id>]        Print the on-disk path for an id (defaults to active)
 *
 * Honours global `--json` for machine-consumable output and `--vault <path>`
 * as a per-invocation override of `CLAUDE_OS_VAULT_PATH`.
 *
 * @module @cli/commands/workspace
 */
import type { Command } from 'commander';
import {
  type ActiveWorkspaceState,
  classifyWorkspace,
  InvalidWorkspaceIdError,
  listWorkspaces,
  logWorkspaceSwitch,
  readActiveWorkspace,
  resolveVaultRoot,
  resolveWorkspacePath,
  type Workspace,
  WorkspaceError,
  type WorkspaceId,
  workspaceExists,
  writeActiveWorkspace,
} from '../../domains/workspace/index.js';
import type { GlobalOpts } from '../output.js';

interface WorkspaceCmdOpts {
  readonly vault?: string;
}

function printAndExit(output: string, code: number): never {
  // biome-ignore lint/suspicious/noConsole: CLI presenter output by design
  console.log(output);
  process.exit(code);
}

function resolveVaultArg(globalOpts: GlobalOpts, cmdOpts: WorkspaceCmdOpts): string {
  const explicit = cmdOpts.vault ?? globalOpts.vault;
  return resolveVaultRoot(explicit === undefined ? {} : { explicit });
}

function handleError(err: unknown, json: boolean): never {
  if (err instanceof WorkspaceError) {
    const text = json
      ? JSON.stringify({ ok: false, error: err.name, message: err.message }, null, 2)
      : `[FAIL] ${err.name}: ${err.message}`;
    printAndExit(text, err instanceof InvalidWorkspaceIdError ? 2 : 1);
  }
  throw err;
}

function renderCurrentText(state: ActiveWorkspaceState, path: string | null): string {
  const lines = [
    `Active workspace: ${state.active}`,
    `Last switch:      ${state.switchedAt}`,
    `Kind:             ${classifyWorkspace(state.active)}`,
  ];
  if (path !== null) lines.push(`Path:             ${path}`);
  else lines.push('Path:             (not yet created on disk)');
  return lines.join('\n');
}

function renderListText(active: WorkspaceId, items: readonly Workspace[]): string {
  const lines = ['ID                                  KIND            ON-DISK'];
  for (const w of items) {
    const marker = w.id === active ? '*' : ' ';
    const id = w.id.padEnd(34, ' ');
    const kind = w.kind.padEnd(15, ' ');
    const status = w.path === null ? '(not yet created)' : 'yes';
    lines.push(`${marker} ${id}${kind} ${status}`);
  }
  return lines.join('\n');
}

export function registerWorkspaceCommand(program: Command): void {
  const ws = program
    .command('workspace')
    .description('Multi-workspace switch/list under the Obsidian vault (ADR-0031)')
    .option('--vault <path>', 'Override $CLAUDE_OS_VAULT_PATH for this invocation');

  ws.command('current')
    .description('Print the active workspace id (and on-disk path if it exists)')
    .action(function (this: Command) {
      const globalOpts = program.opts<GlobalOpts>();
      const cmdOpts = ws.opts<WorkspaceCmdOpts>();
      const json = globalOpts.json === true;
      try {
        const vault = resolveVaultArg(globalOpts, cmdOpts);
        const state = readActiveWorkspace();
        const path = workspaceExists(vault, state.active)
          ? resolveWorkspacePath(vault, state.active)
          : null;
        const out = json
          ? JSON.stringify(
              {
                ok: true,
                active: state.active,
                kind: classifyWorkspace(state.active),
                switchedAt: state.switchedAt,
                path,
              },
              null,
              2,
            )
          : renderCurrentText(state, path);
        printAndExit(out, 0);
      } catch (err) {
        handleError(err, json);
      }
    });

  ws.command('list')
    .description('List all workspaces under <vault>/Claude-OS/workspaces/')
    .action(function (this: Command) {
      const globalOpts = program.opts<GlobalOpts>();
      const cmdOpts = ws.opts<WorkspaceCmdOpts>();
      const json = globalOpts.json === true;
      try {
        const vault = resolveVaultArg(globalOpts, cmdOpts);
        const items = listWorkspaces(vault);
        const state = readActiveWorkspace();
        const out = json
          ? JSON.stringify({ ok: true, active: state.active, workspaces: items }, null, 2)
          : renderListText(state.active, items);
        printAndExit(out, 0);
      } catch (err) {
        handleError(err, json);
      }
    });

  ws.command('use <id>')
    .description('Switch the active workspace (validates id, emits audit event)')
    .action(function (this: Command, id: string) {
      const globalOpts = program.opts<GlobalOpts>();
      const cmdOpts = ws.opts<WorkspaceCmdOpts>();
      const json = globalOpts.json === true;
      try {
        // Resolve vault to validate config; the on-disk dir is allowed
        // to be absent (lazy bootstrap on first note write in Phase 2b).
        resolveVaultArg(globalOpts, cmdOpts);
        const prev = readActiveWorkspace();
        const next = writeActiveWorkspace(id);
        logWorkspaceSwitch({
          from: prev.active === next.active ? null : prev.active,
          to: next.active,
          source: 'cli',
        });
        const out = json
          ? JSON.stringify(
              { ok: true, from: prev.active, to: next.active, switchedAt: next.switchedAt },
              null,
              2,
            )
          : `[OK] active workspace: ${prev.active} -> ${next.active}`;
        printAndExit(out, 0);
      } catch (err) {
        handleError(err, json);
      }
    });

  ws.command('where [id]')
    .description('Print the absolute on-disk path for a workspace (defaults to active)')
    .action(function (this: Command, id: string | undefined) {
      const globalOpts = program.opts<GlobalOpts>();
      const cmdOpts = ws.opts<WorkspaceCmdOpts>();
      const json = globalOpts.json === true;
      try {
        const vault = resolveVaultArg(globalOpts, cmdOpts);
        const target = id ?? readActiveWorkspace().active;
        const path = resolveWorkspacePath(vault, target);
        const exists = workspaceExists(vault, target);
        const out = json
          ? JSON.stringify({ ok: true, id: target, path, exists }, null, 2)
          : `${path}${exists ? '' : '  (not yet created)'}`;
        printAndExit(out, 0);
      } catch (err) {
        handleError(err, json);
      }
    });
}
