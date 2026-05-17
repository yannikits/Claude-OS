/**
 * Update-orchestrator domain types (Phase 4, ADR-0005).
 *
 * @module @domains/update-orchestrator/types
 */

export type UpdateScope = 'env' | 'skills' | 'plugins';

export type UpdateState =
  | 'up-to-date' // remote already at the local HEAD
  | 'updated' // pulled new commits successfully (ff)
  | 'cloned' // skills-repo first-time install
  | 'aborted-dirty' // working tree has uncommitted changes
  | 'aborted-diverged' // local + remote diverged; ff impossible
  | 'no-remote' // no remote configured
  | 'error'; // unexpected failure (see `error` field)

export interface UpdateResult {
  readonly scope: UpdateScope;
  readonly state: UpdateState;
  /** HEAD SHA before the pull attempt. */
  readonly previousSha?: string;
  /** HEAD SHA after the pull (equals `previousSha` for `up-to-date`). */
  readonly newSha?: string;
  /** Branch that was operated on (or `<unknown>` on pre-flight failure). */
  readonly branch?: string;
  /** Human-readable single-line summary. */
  readonly message: string;
  readonly error?: string;
  readonly durationMs: number;
}
