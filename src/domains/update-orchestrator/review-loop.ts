/**
 * ReviewLoop — iterates a list of files-to-review and applies an
 * upgrade per the caller's decide() function. Phase 4d.
 *
 * The loop is policy-aware but presentation-agnostic:
 *   - locked / personal files skip the decide call (auto `keep`).
 *   - In `autoAccept` mode, `added` and `unchanged` system files
 *     auto-upgrade (clean diffs) without prompting; `modified` still
 *     calls decide so user-modified files are never silently overwritten.
 *   - Otherwise every system-zone file goes through decide.
 *
 * `decide` is injected by the caller — the CLI provides an enquirer-
 * driven prompt; tests provide a deterministic fake.
 *
 * The actual file write is delegated via `applyUpgrade(file)`; the
 * loop never touches the FS itself so it can be unit-tested without
 * tmpdirs.
 *
 * @module @domains/update-orchestrator/review-loop
 */
import type { DiffSummary } from './diff-engine.js';
import type { Zone } from './zone-classifier.js';

export type ReviewDecision = 'keep' | 'upgrade' | 'skip';

export interface FileToReview {
  readonly relPath: string;
  readonly upstreamPath: string;
  readonly localPath: string;
  readonly zone: Zone;
  readonly diff: DiffSummary;
}

export interface ReviewOutcome {
  readonly relPath: string;
  readonly decision: ReviewDecision;
  readonly zone: Zone;
  readonly status: DiffSummary['status'];
  readonly reason: string;
}

export interface ReviewLoopOpts {
  readonly files: readonly FileToReview[];
  /** Returns the user's choice for a single file. Only called for ambiguous cases. */
  readonly decide: (file: FileToReview) => Promise<ReviewDecision>;
  /** Performs the actual upgrade (copy upstream over local). */
  readonly applyUpgrade: (file: FileToReview) => Promise<void>;
  /** Auto-accept clean diffs (`added`). Default false. */
  readonly autoAccept?: boolean;
}

export interface ReviewLoopResult {
  readonly outcomes: readonly ReviewOutcome[];
  readonly upgraded: readonly string[];
  readonly kept: readonly string[];
  readonly skipped: readonly string[];
}

async function decideFor(
  file: FileToReview,
  opts: ReviewLoopOpts,
): Promise<{ decision: ReviewDecision; reason: string }> {
  if (file.zone === 'locked') {
    return { decision: 'keep', reason: 'locked zone' };
  }
  if (file.zone === 'personal') {
    return { decision: 'keep', reason: 'personal zone (no upstream)' };
  }
  if (file.diff.status === 'unchanged') {
    return { decision: 'keep', reason: 'no upstream change' };
  }
  if (file.diff.status === 'added') {
    if (opts.autoAccept === true) return { decision: 'upgrade', reason: 'new file, auto-accept' };
    const choice = await opts.decide(file);
    return { decision: choice, reason: 'new file, user choice' };
  }
  if (file.diff.status === 'removed') {
    return { decision: 'keep', reason: 'upstream removed; preserving local copy' };
  }
  if (file.diff.status === 'binary') {
    const choice = await opts.decide(file);
    return { decision: choice, reason: 'binary differs, user choice' };
  }
  const choice = await opts.decide(file);
  return { decision: choice, reason: 'user choice on modified file' };
}

export async function runReviewLoop(opts: ReviewLoopOpts): Promise<ReviewLoopResult> {
  const outcomes: ReviewOutcome[] = [];
  const upgraded: string[] = [];
  const kept: string[] = [];
  const skipped: string[] = [];

  for (const file of opts.files) {
    const { decision, reason } = await decideFor(file, opts);
    outcomes.push({
      relPath: file.relPath,
      decision,
      zone: file.zone,
      status: file.diff.status,
      reason,
    });
    if (decision === 'upgrade') {
      try {
        await opts.applyUpgrade(file);
        upgraded.push(file.relPath);
      } catch {
        skipped.push(file.relPath);
      }
    } else if (decision === 'skip') {
      skipped.push(file.relPath);
    } else {
      kept.push(file.relPath);
    }
  }

  return { outcomes, upgraded, kept, skipped };
}
