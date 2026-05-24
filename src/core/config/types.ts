/**
 * App-level environment configuration types.
 *
 * Distinct from `core/environment/` which resolves the *install-tree*
 * (`<claude-os-root>` per ADR-0002). This module covers user-facing
 * runtime config loaded from `.env` (per ADR-0031 — vault location).
 *
 * @module @core/config/types
 */

export interface AppEnv {
  /**
   * Obsidian vault root (ADR-0031). Workspaces live under
   * `<vaultPath>/Claude-OS/workspaces/<workspace-id>/`.
   *
   * Required for memory-related commands (workspace/notes/retrieval).
   * Optional for install-only commands (doctor, ai, secrets, ...).
   */
  readonly vaultPath?: string;

  /**
   * Default workspace at startup. Falls back to `personal` (ADR-0031).
   * Allowed shapes: `personal` | `msp-internal` | `msp-customers/<id>`.
   */
  readonly defaultWorkspace?: string;
}

export class EnvConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvConfigError';
  }
}
