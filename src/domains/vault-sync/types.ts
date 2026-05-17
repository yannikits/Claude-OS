/**
 * Vault-sync domain types (Phase 2, ADR-0002).
 *
 * @module @domains/vault-sync/types
 */

/**
 * Outcome of a single snapshot invocation. The snapshot pipeline is:
 *   1. Detect branch (no main-hardcoding — Memory-S251).
 *   2. `git add .` — stage all working-tree changes.
 *   3. If nothing staged → `clean`, done.
 *   4. `git commit -m "claude-os snapshot <ISO>"`.
 *   5. `git push origin <branch>` — best-effort.
 */
export type SnapshotState =
  | 'clean' // nothing to commit
  | 'committed' // committed locally, push not attempted
  | 'pushed' // committed + pushed successfully
  | 'commit-failed' // commit step failed
  | 'push-failed' // committed locally but push failed
  | 'error'; // pre-flight (branch detection, status) failed

export interface SnapshotResult {
  readonly state: SnapshotState;
  /** Branch that was (or would have been) targeted. */
  readonly branch: string;
  /** Commit SHA when state is `committed`, `pushed`, or `push-failed`. */
  readonly sha?: string;
  /** Commit message used. */
  readonly message: string;
  /** Number of files staged for this snapshot. */
  readonly fileCount: number;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  /** Human-readable single-line summary. */
  readonly summary: string;
  /** Error string when state is `*-failed` or `error`. */
  readonly error?: string;
}
