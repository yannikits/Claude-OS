/**
 * Conflict-policy for vault-sync push failures (ADR-0002, Phase 2e).
 *
 * The vault-sync push-only model produces exactly one kind of common
 * conflict in practice: a non-fast-forward push rejection because
 * another machine pushed first. v1 handles this with three modes:
 *
 *   `abort` (default)
 *       Hard-fail. Caller surfaces a doctor-style hint instructing the
 *       user to manually `git pull --rebase` or run with a different
 *       mode for this run.
 *
 *   `prefer-local`
 *       Local wins. Uses `git push --force-with-lease` so the operation
 *       still refuses if the remote has new commits we have not seen
 *       in our remote-tracking branch (avoids the blind --force
 *       footgun of overwriting unknown work).
 *
 *   `prefer-remote`
 *       Remote wins, but local commits are NOT lost. A backup branch
 *       `claude-os/backup/<branch>/<ISO-timestamp>` is created at the
 *       current HEAD, then `git fetch` + `git reset --hard
 *       origin/<branch>` rewinds the working tree to the remote.
 *
 * Working-tree merge conflicts (UU markers) are out of scope for v1's
 * automatic policy; they always force `aborted` with a doctor hint.
 *
 * @module @domains/vault-sync/conflict-policy
 */
import type { GitService } from '../../core/git/index.js';

export type ConflictMode = 'abort' | 'prefer-local' | 'prefer-remote';

export type ConflictResolutionState =
  | 'aborted' // mode = abort, no-op + reason returned
  | 'forced-push' // mode = prefer-local, --force-with-lease succeeded
  | 'reset-with-backup' // mode = prefer-remote, local saved on backup branch
  | 'error'; // resolution attempt itself failed

export interface ConflictResolutionResult {
  readonly mode: ConflictMode;
  readonly state: ConflictResolutionState;
  readonly branch: string;
  readonly remote: string;
  /** Present when state is `reset-with-backup`. */
  readonly backupBranch?: string;
  readonly message: string;
  readonly error?: string;
  readonly durationMs: number;
}

interface ConflictResolutionOpts {
  readonly mode: ConflictMode;
  readonly git: GitService;
  readonly branch: string;
  readonly remote?: string;
  /** Override timestamp source for the backup-branch name (tests). */
  readonly now?: () => Date;
}

const CONFLICT_PATTERNS = [
  'non-fast-forward',
  'updates were rejected',
  'fetch first',
  'tip of your current branch is behind',
  'failed to push some refs',
];

/**
 * Pattern-matches a push-rejection error. Used by callers (snapshot
 * pipeline / CLI) to decide whether to invoke `applyConflictResolution`.
 */
export function isPushConflictError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return CONFLICT_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** ISO timestamp with millisecond precision, safe for git ref names. */
function refSafeIso(d: Date): string {
  // git refnames cannot contain `:`. Replace HH:MM:SS:ms with HH-MM-SS-ms.
  return d.toISOString().replaceAll(':', '-').replace('.', '-');
}

function buildResult(
  state: ConflictResolutionState,
  partial: Omit<ConflictResolutionResult, 'durationMs' | 'state'>,
  startedAt: number,
): ConflictResolutionResult {
  return { ...partial, state, durationMs: Date.now() - startedAt };
}

export async function applyConflictResolution(
  opts: ConflictResolutionOpts,
): Promise<ConflictResolutionResult> {
  const startedAt = Date.now();
  const remote = opts.remote ?? 'origin';
  const now = (opts.now ?? (() => new Date()))();

  if (opts.mode === 'abort') {
    return buildResult(
      'aborted',
      {
        mode: 'abort',
        branch: opts.branch,
        remote,
        message:
          'Conflict aborted (mode=abort). Run `git pull --rebase` ' +
          `inside the vault, or rerun with a different conflict-mode.`,
      },
      startedAt,
    );
  }

  if (opts.mode === 'prefer-local') {
    // Refresh remote-tracking so --force-with-lease has an accurate
    // "expected remote tip" reference. Without this, prior push
    // rejections leave the tracking ref stale and the lease check
    // would refuse to operate at all. The lease still protects us
    // against races between this fetch and the subsequent push.
    try {
      await opts.git.raw(['fetch', remote, opts.branch]);
    } catch (err) {
      return buildResult(
        'error',
        {
          mode: 'prefer-local',
          branch: opts.branch,
          remote,
          message: `fetch from ${remote} failed before force-push`,
          error: err instanceof Error ? err.message : String(err),
        },
        startedAt,
      );
    }
    try {
      await opts.git.raw(['push', '--force-with-lease', remote, opts.branch]);
      return buildResult(
        'forced-push',
        {
          mode: 'prefer-local',
          branch: opts.branch,
          remote,
          message: `${opts.branch}: forced push to ${remote} (--force-with-lease)`,
        },
        startedAt,
      );
    } catch (err) {
      return buildResult(
        'error',
        {
          mode: 'prefer-local',
          branch: opts.branch,
          remote,
          message:
            'force-with-lease push refused — remote changed between fetch and push (concurrent writer?)',
          error: err instanceof Error ? err.message : String(err),
        },
        startedAt,
      );
    }
  }

  // prefer-remote
  const backupBranch = `claude-os/backup/${opts.branch}/${refSafeIso(now)}`;
  try {
    await opts.git.raw(['branch', backupBranch, 'HEAD']);
  } catch (err) {
    return buildResult(
      'error',
      {
        mode: 'prefer-remote',
        branch: opts.branch,
        remote,
        message: `failed to create backup branch ${backupBranch}`,
        error: err instanceof Error ? err.message : String(err),
      },
      startedAt,
    );
  }

  try {
    await opts.git.raw(['fetch', remote]);
  } catch (err) {
    return buildResult(
      'error',
      {
        mode: 'prefer-remote',
        branch: opts.branch,
        remote,
        backupBranch,
        message: `fetch from ${remote} failed; local commits preserved on ${backupBranch}`,
        error: err instanceof Error ? err.message : String(err),
      },
      startedAt,
    );
  }

  try {
    await opts.git.raw(['reset', '--hard', `${remote}/${opts.branch}`]);
  } catch (err) {
    return buildResult(
      'error',
      {
        mode: 'prefer-remote',
        branch: opts.branch,
        remote,
        backupBranch,
        message: `reset to ${remote}/${opts.branch} failed; local commits preserved on ${backupBranch}`,
        error: err instanceof Error ? err.message : String(err),
      },
      startedAt,
    );
  }

  return buildResult(
    'reset-with-backup',
    {
      mode: 'prefer-remote',
      branch: opts.branch,
      remote,
      backupBranch,
      message: `${opts.branch}: reset to ${remote}/${opts.branch}; local saved on ${backupBranch}`,
    },
    startedAt,
  );
}
