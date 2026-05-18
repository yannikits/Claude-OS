/**
 * Environment domain types.
 *
 * @module @core/environment/types
 */

/**
 * Detected cloud-sync client managing the claude-os root path.
 * Used for telemetry, doctor-recommendations, and provider-specific
 * fallback strategies (e.g. chokidar usePolling on cloud-mounts per
 * the Round-3 Researcher-Spike).
 */
export type CloudProvider =
  | 'onedrive'
  | 'gdrive'
  | 'dropbox'
  | 'rclone'
  | 'icloud'
  | 'local'
  | 'unknown';

/**
 * Source of the resolved root, indicating which lookup strategy
 * succeeded. Used by `claude-os doctor` to explain to the user
 * how the root was found.
 */
export type RootSource = 'explicit' | 'env-var' | 'repo-detect' | 'portable';

/**
 * Result of {@link resolveRoot}.
 */
export interface ResolvedRoot {
  /** Absolute, normalized path to the claude-os root directory. */
  readonly path: string;
  /** Which resolution strategy produced this result. */
  readonly source: RootSource;
  /** Detected cloud-sync provider, if any. */
  readonly cloudProvider: CloudProvider;
}

/**
 * Thrown when no claude-os root can be resolved by any strategy.
 * Carries a human-readable message documenting which strategies
 * were attempted and why each failed.
 */
export class RootNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RootNotFoundError';
  }
}
