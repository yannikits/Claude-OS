import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitError, GitNotInstalledError, GitService } from '../../../src/core/git/index.js';

describe('GitService', () => {
  let tmpBase: string;
  let workTree: string;
  let service: GitService;

  beforeEach(async () => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-git-'));
    workTree = join(tmpBase, 'repo');
    mkdirSync(workTree, { recursive: true });
    service = new GitService(workTree);
    await service.init();
    // Suppress identity prompts on hosts without global git user config.
    await service.setConfig('user.email', 'tests@example.com');
    await service.setConfig('user.name', 'Tests');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  it('reports git version in the form "git X.Y.Z"', async () => {
    const v = await service.version();
    expect(v).toMatch(/^git \d+\.\d+\.\d+/);
  });

  it('detects the current branch after the initial commit', async () => {
    writeFileSync(join(workTree, 'README.md'), '# Test\n');
    await service.addAll();
    await service.commit('initial');
    const branch = await service.getCurrentBranch();
    // git init may default to 'main' or 'master' depending on host config.
    expect(branch).toMatch(/^(main|master)$/);
  });

  it('reports a clean status for an empty repo', async () => {
    const status = await service.status();
    expect(status.clean).toBe(true);
  });

  it('classifies untracked, modified, deleted files in status', async () => {
    writeFileSync(join(workTree, 'committed.md'), 'v1\n');
    await service.addAll();
    await service.commit('initial');

    writeFileSync(join(workTree, 'committed.md'), 'v2\n');
    writeFileSync(join(workTree, 'untracked.md'), 'new\n');
    const status = await service.status();
    expect(status.clean).toBe(false);
    expect(status.modified).toContain('committed.md');
    expect(status.untracked).toContain('untracked.md');
  });

  it('stages and commits in one round-trip', async () => {
    writeFileSync(join(workTree, 'a.md'), 'a\n');
    await service.addAll();
    const result = await service.commit('add a');
    expect(result.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(result.message).toBe('add a');
    expect(result.branch).toMatch(/^(main|master)$/);
  });

  it('round-trips git config at local scope', async () => {
    await service.setConfig('custom.key', 'hello-value');
    expect(await service.getConfig('custom.key')).toBe('hello-value');
  });

  it('returns null for an unset config key', async () => {
    expect(await service.getConfig('custom.does-not-exist')).toBeNull();
  });

  it('maps unknown raw errors to plain GitError', async () => {
    await expect(service.raw(['this-is-not-a-git-subcommand'])).rejects.toThrow(GitError);
  });
});

describe('GitNotInstalledError mapping', () => {
  it('surfaces as GitNotInstalledError when the git binary cannot be found', async () => {
    let tmpBase = '';
    try {
      tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-git-missing-'));
      const svc = new GitService(tmpBase, {
        options: { binary: '__definitely-no-such-binary__' },
      });
      await expect(svc.version()).rejects.toThrow(GitNotInstalledError);
    } finally {
      if (tmpBase.length > 0 && existsSync(tmpBase)) {
        rmSync(tmpBase, { recursive: true, force: true });
      }
    }
  });
});
