import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../../src/core/git/index.js';
import { DetachedHeadError, detectVaultBranch } from '../../../src/domains/vault-sync/index.js';

describe('detectVaultBranch', () => {
  let tmpBase: string;
  let workTree: string;
  let git: GitService;

  beforeEach(async () => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-branch-'));
    workTree = join(tmpBase, 'vault');
    mkdirSync(workTree, { recursive: true });
    git = new GitService(workTree);
    await git.init();
    await git.setConfig('user.email', 'tests@example.com');
    await git.setConfig('user.name', 'Tests');
    writeFileSync(join(workTree, 'seed.md'), 'seed\n');
    await git.addAll();
    await git.commit('seed');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  it('returns the default branch (main or master) after init+commit', async () => {
    const branch = await detectVaultBranch(git);
    expect(branch).toMatch(/^(main|master)$/);
  });

  it('returns a custom branch name after checkout -b', async () => {
    await git.raw(['checkout', '-b', 'feature/notes-rework']);
    const branch = await detectVaultBranch(git);
    expect(branch).toBe('feature/notes-rework');
  });

  it('also detects plain master', async () => {
    await git.raw(['checkout', '-b', 'master-fixture']);
    const branch = await detectVaultBranch(git);
    expect(branch).toBe('master-fixture');
  });

  it('throws DetachedHeadError when HEAD is detached', async () => {
    const sha = await git.raw(['rev-parse', 'HEAD']);
    await git.raw(['checkout', sha.trim()]);
    await expect(detectVaultBranch(git)).rejects.toThrow(DetachedHeadError);
  });
});
