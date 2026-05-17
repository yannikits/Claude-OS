/**
 * Snapshot pipeline — stage → commit → push, branch-aware.
 *
 * Pipeline:
 *   1. Resolve current branch (no main-hardcoding).
 *   2. Read porcelain status; bail with `clean` if nothing changed.
 *   3. `git add .` to stage everything (.gitignore is respected).
 *   4. Build commit message `claude-os snapshot <ISO-timestamp>`.
 *   5. Commit. On failure → `commit-failed`.
 *   6. Best-effort push to `origin` on the detected branch. On failure
 *      → `push-failed` with the local commit still in place.
 *
 * Caller is expected to have set the busy-flag (Phase 2c) before
 * invoking; snapshot itself does not manage concurrency.
 *
 * @module @domains/vault-sync/snapshot
 */
import { GitService } from '../../core/git/index.js';
import { detectVaultBranch } from './branch-detect.js';
import type { SnapshotResult, SnapshotState } from './types.js';

interface SnapshotOpts {
  /** Vault working-tree path. */
  readonly workTree: string;
  /** Override the remote name. Default: `origin`. */
  readonly remote?: string;
  /** Override the timestamp source (tests). */
  readonly now?: () => Date;
  /** Skip the push step entirely (e.g. no remote configured). */
  readonly skipPush?: boolean;
  /** Pre-constructed GitService (tests). */
  readonly git?: GitService;
}

function buildResult(
  state: SnapshotState,
  partial: {
    branch: string;
    message: string;
    fileCount: number;
    summary: string;
    sha?: string;
    error?: string;
  },
  startedAt: number,
): SnapshotResult {
  return {
    state,
    branch: partial.branch,
    message: partial.message,
    fileCount: partial.fileCount,
    summary: partial.summary,
    durationMs: Date.now() - startedAt,
    ...(partial.sha === undefined ? {} : { sha: partial.sha }),
    ...(partial.error === undefined ? {} : { error: partial.error }),
  };
}

export async function snapshot(opts: SnapshotOpts): Promise<SnapshotResult> {
  const startedAt = Date.now();
  const git = opts.git ?? new GitService(opts.workTree);
  const remote = opts.remote ?? 'origin';
  const now = (opts.now ?? (() => new Date()))();
  const isoTimestamp = now.toISOString();
  const message = `claude-os snapshot ${isoTimestamp}`;

  let branch: string;
  try {
    branch = await detectVaultBranch(git);
  } catch (err) {
    return buildResult(
      'error',
      {
        branch: '<unknown>',
        message,
        fileCount: 0,
        summary: 'branch detection failed',
        error: err instanceof Error ? err.message : String(err),
      },
      startedAt,
    );
  }

  let preStatus: Awaited<ReturnType<typeof git.status>>;
  try {
    preStatus = await git.status();
  } catch (err) {
    return buildResult(
      'error',
      {
        branch,
        message,
        fileCount: 0,
        summary: 'status failed',
        error: err instanceof Error ? err.message : String(err),
      },
      startedAt,
    );
  }

  if (preStatus.clean) {
    return buildResult(
      'clean',
      { branch, message, fileCount: 0, summary: `${branch}: clean, nothing to snapshot` },
      startedAt,
    );
  }

  const fileCount =
    preStatus.staged.length +
    preStatus.modified.length +
    preStatus.untracked.length +
    preStatus.deleted.length;

  try {
    await git.addAll();
  } catch (err) {
    return buildResult(
      'error',
      {
        branch,
        message,
        fileCount,
        summary: 'add failed',
        error: err instanceof Error ? err.message : String(err),
      },
      startedAt,
    );
  }

  let commitSha: string;
  try {
    const committed = await git.commit(message);
    commitSha = committed.sha;
  } catch (err) {
    return buildResult(
      'commit-failed',
      {
        branch,
        message,
        fileCount,
        summary: 'commit failed',
        error: err instanceof Error ? err.message : String(err),
      },
      startedAt,
    );
  }

  if (opts.skipPush === true) {
    return buildResult(
      'committed',
      {
        branch,
        message,
        fileCount,
        sha: commitSha,
        summary: `${branch}: committed ${fileCount} files (push skipped)`,
      },
      startedAt,
    );
  }

  try {
    await git.push(remote, branch);
  } catch (err) {
    return buildResult(
      'push-failed',
      {
        branch,
        message,
        fileCount,
        sha: commitSha,
        summary: `${branch}: committed but push to ${remote} failed`,
        error: err instanceof Error ? err.message : String(err),
      },
      startedAt,
    );
  }

  return buildResult(
    'pushed',
    {
      branch,
      message,
      fileCount,
      sha: commitSha,
      summary: `${branch}: pushed ${fileCount} files to ${remote}`,
    },
    startedAt,
  );
}
