/**
 * Paths domain types.
 *
 * @module @core/paths/types
 */

/**
 * Resolved per-machine data directories. Layout per ADR-0002:
 * Windows → `%APPDATA%/claude-os/`, POSIX → `~/.config/claude-os/`.
 */
export interface MachinePaths {
  /** Root of per-machine state (e.g. `%APPDATA%/claude-os/`). */
  readonly dataRoot: string;
  /** Git-metadata parent dir holding `<repo>.git/` directories. */
  readonly gitMetadataDir: string;
  /** Structured-log directory for pino (Phase 6 transport). */
  readonly logsDir: string;
  /** SQLite read-cache directory (e.g. agent-runs-index, vault-sync-state). */
  readonly dataDir: string;
}

export class PathsResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathsResolutionError';
  }
}
