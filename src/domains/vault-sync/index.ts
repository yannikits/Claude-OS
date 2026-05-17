/**
 * Vault-sync domain — Phase 2 (ADR-0002).
 *
 * @module @domains/vault-sync
 */

export { DetachedHeadError, detectVaultBranch } from './branch-detect.js';
export { BusyFlag, BusyFlagError, type BusyState } from './busy-flag.js';
export {
  applyConflictResolution,
  type ConflictMode,
  type ConflictResolutionResult,
  type ConflictResolutionState,
  isPushConflictError,
} from './conflict-policy.js';
export {
  type ApplyGitignoreResult,
  applyDefaultGitignore,
  DEFAULT_GITIGNORE_LINES,
} from './gitignore-template.js';
export {
  type SchedulerOpts,
  type SchedulerStatus,
  VaultScheduler,
} from './scheduler.js';
export { snapshot } from './snapshot.js';
export type { SnapshotResult, SnapshotState } from './types.js';
export {
  DEFAULT_VAULT_CONFIG,
  loadVaultConfig,
  updateVaultConfig,
  type VaultConfig,
} from './vault-config.js';
