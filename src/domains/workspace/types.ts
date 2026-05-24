/**
 * Workspace-domain types (ADR-0031).
 *
 * Workspaces are structural tenant-isolation containers under the
 * Obsidian vault. Three top-level kinds per ADR-0031:
 *   - `personal`         — Yannik privat (default)
 *   - `msp-internal`     — allgemeine MSP-Doku (firmenintern)
 *   - `msp-customers/<customer-id>` — tenant-isoliert pro Customer
 *
 * `_unsorted` is a synthetic id used for notes that lack a `workspace`
 * frontmatter field — surfaced in the GUI as a fix-me bucket.
 *
 * @module @domains/workspace/types
 */

/**
 * Workspace identifier. Format follows ADR-0031:
 *   `personal`
 *   `msp-internal`
 *   `msp-customers/<customer-id>`  (sub-id required)
 *   `_unsorted`                     (synthetic, no on-disk dir)
 *
 * Customer ids are restricted to `[a-z0-9][a-z0-9_-]*` to avoid path
 * traversal / shell metachar surprises in the workspace tree.
 */
export type WorkspaceId = string;

export const WORKSPACE_LAYOUT_DIR = 'Claude-OS';
export const WORKSPACES_SUBDIR = 'workspaces';
export const DEFAULT_WORKSPACE: WorkspaceId = 'personal';
export const UNSORTED_WORKSPACE: WorkspaceId = '_unsorted';

/**
 * Top-level workspace kinds known to claude-os. Used as discriminator
 * when listing/filtering and for FTS-Schema (ADR-0025).
 */
export type WorkspaceKind = 'personal' | 'msp-internal' | 'msp-customers' | 'unsorted';

export interface Workspace {
  readonly id: WorkspaceId;
  readonly kind: WorkspaceKind;
  /** Absolute on-disk path; `null` for the synthetic `_unsorted` bucket. */
  readonly path: string | null;
}

export interface ActiveWorkspaceState {
  readonly active: WorkspaceId;
  /** ISO-8601 timestamp of the last switch. */
  readonly switchedAt: string;
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export class VaultPathNotConfiguredError extends WorkspaceError {
  constructor() {
    super(
      'CLAUDE_OS_VAULT_PATH is not set. Copy .env.example to .env and ' +
        'fill in the absolute path to your Obsidian vault (per ADR-0031).',
    );
    this.name = 'VaultPathNotConfiguredError';
  }
}

export class UnknownWorkspaceError extends WorkspaceError {
  constructor(id: WorkspaceId) {
    super(
      `Unknown workspace "${id}". Use \`claude-os workspace list\` to see ` +
        `available workspaces or create the directory under Claude-OS/workspaces/.`,
    );
    this.name = 'UnknownWorkspaceError';
  }
}

export class InvalidWorkspaceIdError extends WorkspaceError {
  constructor(id: string, reason: string) {
    super(`Invalid workspace id "${id}": ${reason}`);
    this.name = 'InvalidWorkspaceIdError';
  }
}
