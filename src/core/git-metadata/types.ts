/**
 * Git-metadata migration domain types (Phase 1.5, ADR-0002).
 *
 * @module @core/git-metadata/types
 */

/**
 * Outcome of a single migration invocation. The migrator is idempotent —
 * the same set of states is reachable on repeated runs.
 */
export type MigrationState =
  | 'not-needed' // working-tree does not exist
  | 'no-git-dir' // working-tree has no .git at all (nothing to migrate)
  | 'already-migrated' // .git is a gitfile already pointing to the external target
  | 'migrated' // this run moved .git contents into the external target
  | 'error'; // a precondition failed; see `error` field

export interface MigrationResult {
  readonly state: MigrationState;
  /** Path of the in-mount working tree (e.g. `<root>/vault`). */
  readonly workTree: string;
  /** Resolved external `.git/` target (`<gitMetadataDir>/<name>.git`). */
  readonly externalGitDir: string;
  /** Human-readable single-line summary. */
  readonly message: string;
  /** Optional extra detail (used for diagnostics or recovery hints). */
  readonly detail?: string;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  /** Present only when `state === 'error'`. */
  readonly error?: string;
}

export class GitMetadataMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitMetadataMigrationError';
  }
}
