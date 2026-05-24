/**
 * Workspace domain — multi-workspace tenant-isolation under the
 * Obsidian vault (ADR-0031).
 *
 * @module @domains/workspace
 */

export { logWorkspaceSwitch, type WorkspaceSwitchEvent } from './audit-log.js';
export {
  assertValidWorkspaceId,
  classifyWorkspace,
  listWorkspaces,
  resolveWorkspacePath,
  workspaceExists,
  workspacesDir,
} from './paths.js';
export { readActiveWorkspace, writeActiveWorkspace } from './state.js';
export {
  type ActiveWorkspaceState,
  DEFAULT_WORKSPACE,
  InvalidWorkspaceIdError,
  UNSORTED_WORKSPACE,
  UnknownWorkspaceError,
  VaultPathNotConfiguredError,
  WORKSPACE_LAYOUT_DIR,
  WORKSPACES_SUBDIR,
  type Workspace,
  WorkspaceError,
  type WorkspaceId,
  type WorkspaceKind,
} from './types.js';
export { resolveVaultRoot } from './vault-resolver.js';
