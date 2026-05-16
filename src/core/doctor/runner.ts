/**
 * Doctor runner — orchestrates all checks and produces a structured report.
 *
 * @module @core/doctor/runner
 */
import type { CheckResult, DoctorReport, CheckSeverity } from './types.js';
import { resolveRoot, RootNotFoundError, type ResolvedRoot } from '../environment/index.js';
import {
  checkNodeVersion,
  checkGitAvailable,
  checkClaudeBinary,
  checkMountReachable,
  checkWritePermission,
} from './checks.js';

function summarize(checks: readonly CheckResult[], totalDurationMs: number): DoctorReport {
  const ok = checks.filter((c) => c.severity === 'ok').length;
  const warn = checks.filter((c) => c.severity === 'warn').length;
  const fail = checks.filter((c) => c.severity === 'fail').length;
  const overall: CheckSeverity = fail > 0 ? 'fail' : warn > 0 ? 'warn' : 'ok';
  return {
    checks,
    summary: { ok, warn, fail, totalDurationMs },
    overall,
  };
}

export async function runDoctor(
  opts: {
    readonly explicitRoot?: string;
  } = {},
): Promise<DoctorReport> {
  const startedAt = Date.now();

  let root: ResolvedRoot | null = null;
  let rootErr: RootNotFoundError | null = null;
  try {
    root = resolveRoot(opts.explicitRoot === undefined ? {} : { explicit: opts.explicitRoot });
  } catch (err) {
    if (err instanceof RootNotFoundError) {
      rootErr = err;
    } else {
      throw err;
    }
  }

  if (root !== null) {
    const checks = await Promise.all([
      checkMountReachable(root),
      checkNodeVersion(),
      checkGitAvailable(),
      checkClaudeBinary(root.path),
      checkWritePermission(root.path),
    ]);
    return summarize(checks, Date.now() - startedAt);
  }

  // Root not resolvable — report it and run only root-independent checks.
  const rootResolutionFail: CheckResult = {
    name: 'root-resolution',
    severity: 'fail',
    message: 'Could not resolve claude-os root',
    detail: rootErr?.message ?? 'unknown error',
    hint: 'Set $CLAUDE_OS_ROOT or run claude-os from within a claude-os repo',
    durationMs: 0,
  };
  const independent = await Promise.all([checkNodeVersion(), checkGitAvailable()]);
  return summarize([rootResolutionFail, ...independent], Date.now() - startedAt);
}
