/**
 * `claude-os skill` — lifecycle CLI for Skill-Promotion (Phase 5c-2,
 * ADR-0026 Gate 3). Thin wrapper around `@domains/skill-lifecycle`
 * `promote.ts` transitions — every state change goes through one
 * code path no matter who calls it (CLI here, sidecar-RPC in 5c-3,
 * GUI in 5c-4).
 *
 * The legacy `claude-os skills` (plural) command keeps the read-only
 * surface (`list/show/match`). The new `skill` (singular) command is
 * **write-oriented**: list-by-bucket + the six promote/demote
 * transitions.
 *
 * Subcommands:
 *   skill list-drafts          [--workspace <ws>] [--json]
 *   skill list-quarantined     [--workspace <ws>] [--json]
 *   skill list-pending-review  (alias for list-quarantined)
 *   skill promote <name>
 *     --to-quarantined                             # move _drafts/ → _quarantined/
 *     --run-sandbox --script-path <p> [--input-json <p>] [--timeout-ms <n>]
 *     --to-active --signed-envelope <path>         # approveReview
 *     --deprecate | --disable | --reactivate
 *
 * @module @cli/commands/skill-promote
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { AuditLogger } from '../../core/audit/index.js';
import { resolveMachinePaths } from '../../core/paths/index.js';
import {
  approveReview,
  deprecateSkill,
  disableSkill,
  draftsDir,
  PromoteError,
  promoteDraftToQuarantined,
  proposeReview,
  quarantinedDir,
  type ReviewApprovalPayload,
  reactivateSkill,
  runQuarantinedSandbox,
  type SignedEnvelope,
} from '../../domains/skill-lifecycle/index.js';
import { readActiveWorkspace, resolveVaultRoot } from '../../domains/workspace/index.js';
import { type GlobalOpts, printErr, printJson, printLine } from '../output.js';

interface SkillCmdOpts {
  readonly workspace?: string;
}

interface PromoteCmdOpts {
  readonly toQuarantined?: boolean;
  readonly runSandbox?: boolean;
  readonly scriptPath?: string;
  readonly inputJson?: string;
  readonly timeoutMs?: string;
  readonly toActive?: boolean;
  readonly signedEnvelope?: string;
  readonly deprecate?: boolean;
  readonly disable?: boolean;
  readonly reactivate?: boolean;
  readonly workspace?: string;
}

interface BucketEntry {
  readonly name: string;
  readonly path: string;
  readonly mtimeMs: number;
}

function resolveContext(
  globalOpts: GlobalOpts,
  cmdOpts: SkillCmdOpts | PromoteCmdOpts,
): { vault: string; workspaceId: string } {
  const vault = resolveVaultRoot(
    globalOpts.vault === undefined ? {} : { explicit: globalOpts.vault },
  );
  const workspaceId = cmdOpts.workspace ?? readActiveWorkspace().active;
  return { vault, workspaceId };
}

function listBucket(bucketDir: string): BucketEntry[] {
  if (!existsSync(bucketDir)) return [];
  const out: BucketEntry[] = [];
  for (const name of readdirSync(bucketDir)) {
    const dir = join(bucketDir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const skillMd = join(dir, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    out.push({ name, path: dir, mtimeMs: st.mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function renderBucketText(label: string, entries: readonly BucketEntry[]): string {
  if (entries.length === 0) return `(no ${label})`;
  return entries
    .map((e) => `${new Date(e.mtimeMs).toISOString()}  ${e.name.padEnd(32, ' ')} ${e.path}`)
    .join('\n');
}

function exclusiveAction(opts: PromoteCmdOpts): string | null {
  const flags: Array<[string, boolean | undefined]> = [
    ['to-quarantined', opts.toQuarantined],
    ['run-sandbox', opts.runSandbox],
    ['to-active', opts.toActive],
    ['deprecate', opts.deprecate],
    ['disable', opts.disable],
    ['reactivate', opts.reactivate],
  ];
  const active = flags.filter(([, v]) => v === true).map(([k]) => k);
  if (active.length === 0) return null;
  if (active.length > 1) {
    throw new Error(`skill promote: choose exactly one of --${active.join(' / --')}`);
  }
  return active[0] ?? null;
}

function loadEnvelope(envelopePath: string): SignedEnvelope<ReviewApprovalPayload> {
  if (!existsSync(envelopePath)) {
    throw new Error(`--signed-envelope file not found: ${envelopePath}`);
  }
  const raw = readFileSync(envelopePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--signed-envelope is not valid JSON: ${(err as Error).message}`);
  }
  // Caller is responsible for shape — approveReview will fail-loud
  // on tamper / structural problems with a typed PromoteError.
  return parsed as SignedEnvelope<ReviewApprovalPayload>;
}

function loadInputJson(inputPath: string | undefined): unknown {
  if (inputPath === undefined) return {};
  if (!existsSync(inputPath)) throw new Error(`--input-json file not found: ${inputPath}`);
  return JSON.parse(readFileSync(inputPath, 'utf8'));
}

function parseTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1000 || n > 5 * 60 * 1000) {
    throw new Error(`--timeout-ms must be 1000..300000, got "${raw}"`);
  }
  return n;
}

function makeAudit(): AuditLogger {
  return new AuditLogger({ auditDir: join(resolveMachinePaths().dataDir, 'audit') });
}

export function registerSkillPromoteCommand(program: Command): void {
  const skill = program
    .command('skill')
    .description(
      'Skill-lifecycle (Phase 5c, ADR-0026): list-by-state + promote/demote. ' +
        'See also `claude-os skills` (plural) for read-only list/show/match.',
    )
    .option('--workspace <ws>', 'Workspace (default: active from config)');

  // ─── list-drafts ──────────────────────────────────────────────────
  skill
    .command('list-drafts')
    .description('List skills in the _drafts/ bucket (newest first)')
    .action(function (this: Command) {
      const globals = program.opts<GlobalOpts>();
      const cmdOpts = skill.opts<SkillCmdOpts>();
      try {
        const { vault, workspaceId } = resolveContext(globals, cmdOpts);
        const entries = listBucket(draftsDir(vault, workspaceId));
        if (globals.json === true) {
          printJson({
            ok: true,
            action: 'list-drafts',
            workspace: workspaceId,
            count: entries.length,
            entries,
          });
        } else {
          printLine(renderBucketText('drafts', entries));
        }
      } catch (err) {
        printErr(`skill list-drafts: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // ─── list-quarantined ─────────────────────────────────────────────
  const renderQuarantinedAction = function (this: Command, alias: string): void {
    const globals = program.opts<GlobalOpts>();
    const cmdOpts = skill.opts<SkillCmdOpts>();
    try {
      const { vault, workspaceId } = resolveContext(globals, cmdOpts);
      const entries = listBucket(quarantinedDir(vault, workspaceId));
      if (globals.json === true) {
        printJson({
          ok: true,
          action: alias,
          workspace: workspaceId,
          count: entries.length,
          entries,
        });
      } else {
        printLine(renderBucketText('quarantined skills', entries));
      }
    } catch (err) {
      printErr(`skill ${alias}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  };

  skill
    .command('list-quarantined')
    .description('List skills awaiting review/sandbox-run in the _quarantined/ bucket')
    .action(function (this: Command) {
      renderQuarantinedAction.call(this, 'list-quarantined');
    });

  skill
    .command('list-pending-review')
    .description("Alias for list-quarantined — what awaits Yannik's approval")
    .action(function (this: Command) {
      renderQuarantinedAction.call(this, 'list-pending-review');
    });

  // ─── promote <name> ───────────────────────────────────────────────
  skill
    .command('promote <name>')
    .description('State-transition the named skill (exactly one mode flag required)')
    .option('--to-quarantined', 'Move _drafts/<name>/ → _quarantined/<name>/')
    .option('--run-sandbox', 'Run quarantined skill in child_process.fork sandbox')
    .option('--script-path <path>', 'Required with --run-sandbox: absolute path to skill script')
    .option('--input-json <path>', 'Optional JSON file passed as input to the sandboxed skill')
    .option('--timeout-ms <ms>', 'Sandbox timeout in ms (1000..300000, default 30000)')
    .option('--to-active', 'Approve a quarantined skill (requires --signed-envelope)')
    .option('--signed-envelope <path>', 'Path to a signed approval envelope (JSON)')
    .option('--deprecate', 'Mark an active skill as deprecated')
    .option('--disable', 'Mark an active/deprecated skill as disabled')
    .option('--reactivate', 'Bring a deprecated/disabled skill back to active')
    .action(async function (this: Command, name: string, localOpts: PromoteCmdOpts) {
      const globals = program.opts<GlobalOpts>();
      const cmdOpts = skill.opts<SkillCmdOpts>();
      try {
        const { vault, workspaceId } = resolveContext(globals, { ...cmdOpts, ...localOpts });
        const audit = makeAudit();
        const action = exclusiveAction(localOpts);
        if (action === null) {
          throw new Error(
            'skill promote: pick one of --to-quarantined | --run-sandbox | --to-active | ' +
              '--deprecate | --disable | --reactivate',
          );
        }

        const base = { vaultRoot: vault, workspaceId, audit };

        if (action === 'to-quarantined') {
          const result = await promoteDraftToQuarantined(name, base);
          if (globals.json === true) printJson({ ok: true, ...result });
          else printLine(`[OK] skill.promote ${name}: draft → quarantined (${result.path})`);
          return;
        }

        if (action === 'run-sandbox') {
          if (localOpts.scriptPath === undefined) {
            throw new Error('--run-sandbox requires --script-path <absolute path>');
          }
          const timeoutMs = parseTimeoutMs(localOpts.timeoutMs);
          const summary = await runQuarantinedSandbox(name, {
            ...base,
            input: {
              skillScriptPath: localOpts.scriptPath,
              skillId: name,
              input: loadInputJson(localOpts.inputJson),
            },
            sandboxOpts: {
              sandboxRoot: quarantinedDir(vault, workspaceId),
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            },
          });
          if (globals.json === true) printJson({ ok: true, ...summary });
          else
            printLine(
              `[${summary.outcome.toUpperCase()}] skill.sandbox ${name} — duration=${summary.durationMs}ms` +
                (summary.killedBy !== null ? ` killedBy=${summary.killedBy}` : '') +
                (summary.errorMessage !== null ? ` error=${summary.errorMessage}` : ''),
            );
          return;
        }

        if (action === 'to-active') {
          if (localOpts.signedEnvelope === undefined) {
            throw new Error('--to-active requires --signed-envelope <path-to-json>');
          }
          const envelope = loadEnvelope(localOpts.signedEnvelope);
          const result = await approveReview(name, envelope, base);
          if (globals.json === true) printJson({ ok: true, ...result });
          else printLine(`[OK] skill.promote ${name}: quarantined → active (${result.path})`);
          return;
        }

        if (action === 'deprecate') {
          const result = await deprecateSkill(name, base);
          if (globals.json === true) printJson({ ok: true, ...result });
          else printLine(`[OK] skill.deprecate ${name}`);
          return;
        }

        if (action === 'disable') {
          const result = await disableSkill(name, base);
          if (globals.json === true) printJson({ ok: true, ...result });
          else printLine(`[OK] skill.disable ${name}`);
          return;
        }

        if (action === 'reactivate') {
          const result = await reactivateSkill(name, base);
          if (globals.json === true) printJson({ ok: true, ...result });
          else printLine(`[OK] skill.reactivate ${name}`);
          return;
        }

        throw new Error(`skill promote: unreachable action "${action}"`);
      } catch (err) {
        if (err instanceof PromoteError) {
          if (globals.json === true) {
            printJson({ ok: false, code: err.code, message: err.message });
          } else {
            printErr(`skill promote: [${err.code}] ${err.message}`);
          }
          process.exit(1);
        }
        printErr(`skill promote: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // ─── propose-review <name> ────────────────────────────────────────
  // Dump a ReviewProposal (diff + classification + diffHash) so a
  // script can sign it externally without round-tripping through the
  // GUI. Convenient for CI promote-flows.
  skill
    .command('propose-review <name>')
    .description('Print the ReviewProposal (diff + diffHash) for a quarantined skill')
    .action(async function (this: Command, name: string) {
      const globals = program.opts<GlobalOpts>();
      const cmdOpts = skill.opts<SkillCmdOpts>();
      try {
        const { vault, workspaceId } = resolveContext(globals, cmdOpts);
        const proposal = await proposeReview(name, { vaultRoot: vault, workspaceId });
        if (globals.json === true) printJson({ ok: true, ...proposal });
        else
          printLine(
            `name=${proposal.name}\n` +
              `classification=${proposal.classification}\n` +
              `diffHash=${proposal.diffHash}\n` +
              `--- BEFORE (active version) ---\n${proposal.beforeContent}\n` +
              `--- AFTER (quarantined) ---\n${proposal.afterContent}`,
          );
      } catch (err) {
        if (err instanceof PromoteError) {
          printErr(`skill propose-review: [${err.code}] ${err.message}`);
          process.exit(1);
        }
        printErr(`skill propose-review: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
