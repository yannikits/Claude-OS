/**
 * env-repo update — runs `git pull --ff-only` on the claude-os repo
 * root (the "environment" that this CLI itself lives in).
 *
 * Behaviour:
 *   - Refuses to pull when the working tree is dirty (`aborted-dirty`).
 *   - Uses fast-forward-only — never creates merges. Divergence yields
 *     `aborted-diverged` so the user can resolve manually.
 *   - On clean fast-forward, returns previous/new SHAs.
 *
 * The selective-merge pattern from ADR-0005 applies to the skills-repo,
 * NOT here — the env-repo is the CLI's own source and the user is
 * expected to either not modify it or fork it explicitly.
 *
 * @module @domains/update-orchestrator/env-repo
 */
import { GitService } from '../../core/git/index.js';
import type { UpdateResult, UpdateState } from './types.js';

interface UpdateEnvRepoOpts {
  /** Path to the claude-os repo root. */
  readonly repoPath: string;
  /** Remote name. Default `origin`. */
  readonly remote?: string;
  /** Branch to pull. Default: current. */
  readonly branch?: string;
  /** Pre-constructed GitService (tests). */
  readonly git?: GitService;
}

const DIVERGED_PATTERNS = [
  'non-fast-forward',
  'not possible to fast-forward',
  'fast-forward',
  'divergent',
  'refusing to merge unrelated histories',
];

function isDivergedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const lower = err.message.toLowerCase();
  return DIVERGED_PATTERNS.some((p) => lower.includes(p));
}

function isNoRemoteError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const lower = err.message.toLowerCase();
  return (
    lower.includes('does not appear to be a git repository') ||
    lower.includes('no such remote') ||
    lower.includes('no upstream') ||
    lower.includes("couldn't find remote ref")
  );
}

function buildResult(
  state: UpdateState,
  partial: Omit<UpdateResult, 'scope' | 'state' | 'durationMs'>,
  startedAt: number,
): UpdateResult {
  return { scope: 'env', state, ...partial, durationMs: Date.now() - startedAt };
}

export async function updateEnvRepo(opts: UpdateEnvRepoOpts): Promise<UpdateResult> {
  const startedAt = Date.now();
  const git = opts.git ?? new GitService(opts.repoPath);
  const remote = opts.remote ?? 'origin';

  let branch: string;
  try {
    branch = opts.branch ?? (await git.getCurrentBranch());
  } catch (err) {
    return buildResult(
      'error',
      {
        message: 'failed to detect current branch',
        error: err instanceof Error ? err.message : String(err),
      },
      startedAt,
    );
  }

  let previousSha: string | undefined;
  try {
    previousSha = (await git.raw(['rev-parse', 'HEAD'])).trim();
  } catch {
    // ignore — sha-tracking is best-effort
  }

  let status: Awaited<ReturnType<typeof git.status>>;
  try {
    status = await git.status();
  } catch (err) {
    return buildResult(
      'error',
      {
        branch,
        ...(previousSha === undefined ? {} : { previousSha }),
        message: 'status check failed',
        error: err instanceof Error ? err.message : String(err),
      },
      startedAt,
    );
  }
  if (!status.clean) {
    return buildResult(
      'aborted-dirty',
      {
        branch,
        ...(previousSha === undefined ? {} : { previousSha }),
        message: `env-repo working tree dirty (${status.modified.length + status.staged.length + status.untracked.length} files); refusing to pull`,
      },
      startedAt,
    );
  }

  try {
    await git.pull(remote, branch, { ffOnly: true });
  } catch (err) {
    if (isNoRemoteError(err)) {
      return buildResult(
        'no-remote',
        {
          branch,
          ...(previousSha === undefined ? {} : { previousSha }),
          message: `no remote "${remote}" configured for env-repo`,
          error: err instanceof Error ? err.message : String(err),
        },
        startedAt,
      );
    }
    if (isDivergedError(err)) {
      return buildResult(
        'aborted-diverged',
        {
          branch,
          ...(previousSha === undefined ? {} : { previousSha }),
          message: `env-repo diverged from ${remote}/${branch}; ff-only pull refused`,
          error: err instanceof Error ? err.message : String(err),
        },
        startedAt,
      );
    }
    return buildResult(
      'error',
      {
        branch,
        ...(previousSha === undefined ? {} : { previousSha }),
        message: `pull from ${remote}/${branch} failed`,
        error: err instanceof Error ? err.message : String(err),
      },
      startedAt,
    );
  }

  let newSha: string | undefined;
  try {
    newSha = (await git.raw(['rev-parse', 'HEAD'])).trim();
  } catch {
    /* best-effort */
  }

  const state: UpdateState =
    newSha === undefined || newSha === previousSha ? 'up-to-date' : 'updated';
  return buildResult(
    state,
    {
      branch,
      ...(previousSha === undefined ? {} : { previousSha }),
      ...(newSha === undefined ? {} : { newSha }),
      message:
        state === 'up-to-date'
          ? `env-repo already at ${remote}/${branch}`
          : `env-repo updated ${previousSha?.slice(0, 7) ?? '?'} -> ${newSha?.slice(0, 7) ?? '?'}`,
    },
    startedAt,
  );
}
