/**
 * Git domain types and error hierarchy (Phase 2a, ADR-0008).
 *
 * All git operations go through {@link GitService}; this file declares
 * its public surface and the DomainError-style errors callers expect.
 *
 * @module @core/git/types
 */

/** Base class for all errors emitted by the git abstraction. */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

/** System `git` binary missing from PATH or otherwise unreachable. */
export class GitNotInstalledError extends GitError {
  constructor(message: string) {
    super(message);
    this.name = 'GitNotInstalledError';
  }
}

/**
 * `.git/index.lock` or `.git/HEAD.lock` blocks an operation — usually
 * another git process is running or a previous run crashed.
 */
export class GitLockfileError extends GitError {
  readonly lockfilePath: string;
  constructor(message: string, lockfilePath: string) {
    super(message);
    this.name = 'GitLockfileError';
    this.lockfilePath = lockfilePath;
  }
}

/** Automatic merge produced unresolved conflicts. */
export class GitMergeConflictError extends GitError {
  readonly conflictedFiles: readonly string[];
  constructor(message: string, conflictedFiles: readonly string[]) {
    super(message);
    this.name = 'GitMergeConflictError';
    this.conflictedFiles = conflictedFiles;
  }
}

/** Outcome of `git status --porcelain` flattened into a typed shape. */
export interface GitStatusSummary {
  /** Working tree has no staged or unstaged changes. */
  readonly clean: boolean;
  /** Files staged for the next commit. */
  readonly staged: readonly string[];
  /** Files modified in the working tree but not staged. */
  readonly modified: readonly string[];
  /** Untracked files (not in .gitignore). */
  readonly untracked: readonly string[];
  /** Files with merge conflict markers. */
  readonly conflicted: readonly string[];
  /** Files deleted in the working tree. */
  readonly deleted: readonly string[];
}

/** Result of a successful commit. */
export interface CommitResult {
  readonly sha: string;
  readonly branch: string;
  readonly message: string;
}

/** Result of `git push`. */
export interface PushResult {
  readonly pushed: boolean;
  readonly remote: string;
  readonly branch: string;
}

export type GitConfigScope = 'local' | 'global' | 'system';
