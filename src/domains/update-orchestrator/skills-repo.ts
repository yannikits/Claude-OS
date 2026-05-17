/**
 * skills-repo update — clones `iteenschmiede/claude-config` (or any
 * configured source) into `<root>/config/skills/` on first run, then
 * `git pull --ff-only` on subsequent invocations.
 *
 * The selective-merge layer (ADR-0005) — backup, diff-review, zone-
 * classification, interactive review — is built on top of this in
 * Phase 4b–4d. This module ships only the basic pull step, with
 * `aborted-dirty`/`aborted-diverged` fail-fast semantics so callers
 * know when to escalate to the review layer.
 *
 * @module @domains/update-orchestrator/skills-repo
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GitService } from '../../core/git/index.js';
import type { UpdateResult, UpdateState } from './types.js';

interface UpdateSkillsRepoOpts {
  /** Destination directory, e.g. `<root>/config/skills`. */
  readonly destination: string;
  /** Source repo URL or local path. */
  readonly source: string;
  /** Branch to track. Default `main`. */
  readonly branch?: string;
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

function hasGitDir(path: string): boolean {
  if (!existsSync(path)) return false;
  const dotGit = join(path, '.git');
  if (!existsSync(dotGit)) return false;
  try {
    const stat = statSync(dotGit);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

function buildResult(
  state: UpdateState,
  partial: Omit<UpdateResult, 'scope' | 'state' | 'durationMs'>,
  startedAt: number,
): UpdateResult {
  return { scope: 'skills', state, ...partial, durationMs: Date.now() - startedAt };
}

export async function updateSkillsRepo(opts: UpdateSkillsRepoOpts): Promise<UpdateResult> {
  const startedAt = Date.now();
  const branchPref = opts.branch ?? 'main';

  if (!hasGitDir(opts.destination)) {
    try {
      mkdirSync(dirname(opts.destination), { recursive: true });
      const git = await GitService.clone(opts.source, opts.destination, { branch: branchPref });
      const newSha = (await git.raw(['rev-parse', 'HEAD'])).trim();
      const actualBranch = await git.getCurrentBranch();
      return buildResult(
        'cloned',
        {
          branch: actualBranch,
          newSha,
          message: `skills-repo cloned from ${opts.source} (${actualBranch} @ ${newSha.slice(0, 7)})`,
        },
        startedAt,
      );
    } catch (err) {
      return buildResult(
        'error',
        {
          message: `clone of ${opts.source} into ${opts.destination} failed`,
          error: err instanceof Error ? err.message : String(err),
        },
        startedAt,
      );
    }
  }

  const git = new GitService(opts.destination);
  let branch: string;
  try {
    branch = await git.getCurrentBranch();
  } catch (err) {
    return buildResult(
      'error',
      {
        message: 'failed to detect skills-repo branch',
        error: err instanceof Error ? err.message : String(err),
      },
      startedAt,
    );
  }

  let previousSha: string | undefined;
  try {
    previousSha = (await git.raw(['rev-parse', 'HEAD'])).trim();
  } catch {
    /* best-effort */
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
        message: 'skills-repo status check failed',
        error: err instanceof Error ? err.message : String(err),
      },
      startedAt,
    );
  }
  if (!status.clean) {
    const dirtyCount = status.modified.length + status.staged.length + status.untracked.length;
    return buildResult(
      'aborted-dirty',
      {
        branch,
        ...(previousSha === undefined ? {} : { previousSha }),
        message: `skills-repo working tree dirty (${dirtyCount} files); selective-merge needed (Phase 4d)`,
      },
      startedAt,
    );
  }

  try {
    await git.pull('origin', branch, { ffOnly: true });
  } catch (err) {
    if (isDivergedError(err)) {
      return buildResult(
        'aborted-diverged',
        {
          branch,
          ...(previousSha === undefined ? {} : { previousSha }),
          message: `skills-repo diverged from origin/${branch}; ff-only pull refused`,
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
        message: 'skills-repo pull failed',
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
          ? `skills-repo already at origin/${branch}`
          : `skills-repo updated ${previousSha?.slice(0, 7) ?? '?'} -> ${newSha?.slice(0, 7) ?? '?'}`,
    },
    startedAt,
  );
}
