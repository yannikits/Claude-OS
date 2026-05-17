/**
 * Git domain — simple-git abstraction layer per ADR-0008 (Phase 2a).
 *
 * @module @core/git
 */

export { GitService } from './git-service.js';
export type {
  CommitResult,
  GitConfigScope,
  GitStatusSummary,
  PushResult,
} from './types.js';
export {
  GitError,
  GitLockfileError,
  GitMergeConflictError,
  GitNotInstalledError,
} from './types.js';
