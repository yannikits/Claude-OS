/**
 * Branch detection — explicitly avoids hardcoding `main` to fix the
 * Memory-S251 bug (vault on `master` was sync'd as `main`, branch
 * mismatch after first push).
 *
 * @module @domains/vault-sync/branch-detect
 */
import { GitError, type GitService } from '../../core/git/index.js';

export class DetachedHeadError extends GitError {
  constructor(message: string) {
    super(message);
    this.name = 'DetachedHeadError';
  }
}

/**
 * Returns the branch name the vault working-tree is currently on.
 * Throws {@link DetachedHeadError} when HEAD is detached — callers
 * should refuse to snapshot detached state.
 */
export async function detectVaultBranch(git: GitService): Promise<string> {
  const branch = await git.getCurrentBranch();
  if (branch === 'HEAD' || branch.length === 0) {
    throw new DetachedHeadError('Vault is in detached-HEAD state. Snapshot needs a named branch.');
  }
  return branch;
}
