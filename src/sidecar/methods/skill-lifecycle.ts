/**
 * Skill-lifecycle RPCs (Phase 5c-3, ADR-0026 Gate 3).
 *
 * Read + mutate the four skill-buckets via the same `promote.ts`
 * transitions used by the CLI (Phase 5c-2). The GUI (Phase 5c-4)
 * binds to these endpoints. All mutating RPCs are
 * MCP-non-exportable — approval doesn't belong over tool-calls.
 *
 *   skill.listDrafts({workspace?})              → BucketSummary[]
 *   skill.listQuarantined({workspace?})         → QuarantinedSummary[]
 *   skill.runQuarantined({name, scriptPath, input?, timeoutMs?})
 *                                               → SandboxRunSummary
 *   skill.proposeReview({name, workspace?})     → ReviewProposal
 *   skill.approveReview({name, signedEnvelope, workspace?})
 *                                               → {ok: true, ...PromoteResult}
 *   skill.deprecate({name, workspace?})         → PromoteResult
 *   skill.disable({name, workspace?})           → PromoteResult
 *   skill.reactivate({name, workspace?})        → PromoteResult
 *
 * Error path: PromoteError → typed JSON envelope
 *   {ok: false, code: <PromoteErrorCode>, message}
 *
 * @module @sidecar/methods/skill-lifecycle
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLogger } from '../../core/audit/index.js';
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
import type { RpcDispatcher } from '../rpc.js';
import { type MethodsContext, requireString } from './_shared.js';

interface BucketSummary {
  readonly name: string;
  readonly path: string;
  readonly mtimeMs: number;
}

interface QuarantinedSummary extends BucketSummary {
  readonly hasSandboxRun: boolean;
}

function resolveWorkspaceId(params: { workspace?: unknown }): string {
  const raw = params.workspace;
  return typeof raw === 'string' && raw.length > 0 ? raw : readActiveWorkspace().active;
}

function listBucket(bucketDir: string): BucketSummary[] {
  if (!existsSync(bucketDir)) return [];
  const out: BucketSummary[] = [];
  for (const name of readdirSync(bucketDir)) {
    const dir = join(bucketDir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (!existsSync(join(dir, 'SKILL.md'))) continue;
    out.push({ name, path: dir, mtimeMs: st.mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function promoteErrEnvelope(err: PromoteError): {
  ok: false;
  code: string;
  message: string;
} {
  return { ok: false, code: err.code, message: err.message };
}

export function registerSkillLifecycleMethods(
  dispatcher: RpcDispatcher,
  ctx: MethodsContext,
): void {
  const makeAudit = (): AuditLogger =>
    new AuditLogger({ auditDir: join(ctx.machinePaths().dataDir, 'audit') });

  dispatcher.register('skill.listDrafts', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { workspace?: unknown };
    const vault = resolveVaultRoot();
    const workspaceId = resolveWorkspaceId(params);
    return {
      ok: true as const,
      workspace: workspaceId,
      entries: listBucket(draftsDir(vault, workspaceId)),
    };
  });

  dispatcher.register('skill.listQuarantined', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { workspace?: unknown };
    const vault = resolveVaultRoot();
    const workspaceId = resolveWorkspaceId(params);
    const dir = quarantinedDir(vault, workspaceId);
    const base = listBucket(dir);
    const entries: QuarantinedSummary[] = base.map((e) => ({
      ...e,
      hasSandboxRun: existsSync(join(e.path, '.sandbox-run.json')),
    }));
    return { ok: true as const, workspace: workspaceId, entries };
  });

  dispatcher.register('skill.proposeReview', async (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { name?: unknown; workspace?: unknown };
    const name = requireString(params.name, 'name', 'skill.proposeReview');
    const vault = resolveVaultRoot();
    const workspaceId = resolveWorkspaceId(params);
    try {
      const proposal = await proposeReview(name, { vaultRoot: vault, workspaceId });
      return { ok: true as const, ...proposal };
    } catch (err) {
      if (err instanceof PromoteError) return promoteErrEnvelope(err);
      throw err;
    }
  });

  dispatcher.register('skill.runQuarantined', async (rawParams: unknown) => {
    const params = (rawParams ?? {}) as {
      name?: unknown;
      scriptPath?: unknown;
      input?: unknown;
      timeoutMs?: unknown;
      workspace?: unknown;
    };
    const name = requireString(params.name, 'name', 'skill.runQuarantined');
    const scriptPath = requireString(params.scriptPath, 'scriptPath', 'skill.runQuarantined');
    const timeoutMs =
      typeof params.timeoutMs === 'number' &&
      Number.isFinite(params.timeoutMs) &&
      params.timeoutMs >= 1000 &&
      params.timeoutMs <= 5 * 60 * 1000
        ? params.timeoutMs
        : undefined;
    const vault = resolveVaultRoot();
    const workspaceId = resolveWorkspaceId(params);
    try {
      const summary = await runQuarantinedSandbox(name, {
        vaultRoot: vault,
        workspaceId,
        audit: makeAudit(),
        input: {
          skillScriptPath: scriptPath,
          skillId: name,
          input: params.input ?? {},
        },
        sandboxOpts: {
          sandboxRoot: quarantinedDir(vault, workspaceId),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        },
      });
      return { ok: true as const, ...summary };
    } catch (err) {
      if (err instanceof PromoteError) return promoteErrEnvelope(err);
      throw err;
    }
  });

  dispatcher.register('skill.promoteDraftToQuarantined', async (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { name?: unknown; workspace?: unknown };
    const name = requireString(params.name, 'name', 'skill.promoteDraftToQuarantined');
    const vault = resolveVaultRoot();
    const workspaceId = resolveWorkspaceId(params);
    try {
      const result = await promoteDraftToQuarantined(name, {
        vaultRoot: vault,
        workspaceId,
        audit: makeAudit(),
      });
      return { ok: true as const, ...result };
    } catch (err) {
      if (err instanceof PromoteError) return promoteErrEnvelope(err);
      throw err;
    }
  });

  dispatcher.register('skill.approveReview', async (rawParams: unknown) => {
    const params = (rawParams ?? {}) as {
      name?: unknown;
      signedEnvelope?: unknown;
      expectedPublicKeyB64?: unknown;
      workspace?: unknown;
    };
    const name = requireString(params.name, 'name', 'skill.approveReview');
    if (
      typeof params.signedEnvelope !== 'object' ||
      params.signedEnvelope === null ||
      Array.isArray(params.signedEnvelope)
    ) {
      throw new Error(
        'skill.approveReview: params.signedEnvelope muss ein SignedEnvelope-Objekt sein',
      );
    }
    const vault = resolveVaultRoot();
    const workspaceId = resolveWorkspaceId(params);
    try {
      const envelope = params.signedEnvelope as SignedEnvelope<ReviewApprovalPayload>;
      const result = await approveReview(name, envelope, {
        vaultRoot: vault,
        workspaceId,
        audit: makeAudit(),
        ...(typeof params.expectedPublicKeyB64 === 'string' &&
        params.expectedPublicKeyB64.length > 0
          ? { expectedPublicKeyB64: params.expectedPublicKeyB64 }
          : {}),
      });
      return { ok: true as const, ...result };
    } catch (err) {
      if (err instanceof PromoteError) return promoteErrEnvelope(err);
      throw err;
    }
  });

  // ─── deprecate / disable / reactivate ─────────────────────────────
  const flipHandler =
    (label: string, fn: typeof deprecateSkill | typeof disableSkill | typeof reactivateSkill) =>
    async (rawParams: unknown) => {
      const params = (rawParams ?? {}) as { name?: unknown; workspace?: unknown };
      const name = requireString(params.name, 'name', `skill.${label}`);
      const vault = resolveVaultRoot();
      const workspaceId = resolveWorkspaceId(params);
      try {
        const result = await fn(name, {
          vaultRoot: vault,
          workspaceId,
          audit: makeAudit(),
        });
        return { ok: true as const, ...result };
      } catch (err) {
        if (err instanceof PromoteError) return promoteErrEnvelope(err);
        throw err;
      }
    };

  dispatcher.register('skill.deprecate', flipHandler('deprecate', deprecateSkill));
  dispatcher.register('skill.disable', flipHandler('disable', disableSkill));
  dispatcher.register('skill.reactivate', flipHandler('reactivate', reactivateSkill));

  // Convenience pass-through so the GUI can fetch the .sandbox-run.json
  // raw (it's small, < 4KB) without re-walking the quarantined dir.
  dispatcher.register('skill.readSandboxRun', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { name?: unknown; workspace?: unknown };
    const name = requireString(params.name, 'name', 'skill.readSandboxRun');
    const vault = resolveVaultRoot();
    const workspaceId = resolveWorkspaceId(params);
    const path = join(quarantinedDir(vault, workspaceId), name, '.sandbox-run.json');
    if (!existsSync(path)) return { ok: false as const, code: 'not-found' as const };
    try {
      const summary = JSON.parse(readFileSync(path, 'utf8'));
      return { ok: true as const, summary };
    } catch (err) {
      return {
        ok: false as const,
        code: 'invalid-json' as const,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
