import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../../src/core/git/index.js';
import { updateEnvRepo } from '../../../src/domains/update-orchestrator/index.js';

describe('updateEnvRepo', () => {
  let tmpBase: string;
  let bareDir: string;
  let envRepo: string;
  let originUpstream: string;
  let envGit: GitService;
  let branch: string;

  beforeEach(async () => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-envrepo-'));
    bareDir = join(tmpBase, 'origin.git');
    envRepo = join(tmpBase, 'env-repo');
    originUpstream = join(tmpBase, 'upstream-author');
    mkdirSync(bareDir, { recursive: true });
    mkdirSync(envRepo, { recursive: true });
    mkdirSync(originUpstream, { recursive: true });

    await new GitService(bareDir).init(['--bare']);

    const author = new GitService(originUpstream);
    await author.init();
    await author.setConfig('user.email', 'a@example.com');
    await author.setConfig('user.name', 'A');
    await author.raw(['remote', 'add', 'origin', bareDir]);
    writeFileSync(join(originUpstream, 'README.md'), 'seed\n');
    await author.addAll();
    await author.commit('seed');
    branch = await author.getCurrentBranch();
    await author.push('origin', branch);

    await GitService.clone(bareDir, envRepo);
    envGit = new GitService(envRepo);
    await envGit.setConfig('user.email', 'me@example.com');
    await envGit.setConfig('user.name', 'Me');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  it('returns up-to-date when remote has no new commits', async () => {
    const result = await updateEnvRepo({ repoPath: envRepo });
    expect(result.state).toBe('up-to-date');
    expect(result.scope).toBe('env');
    expect(result.branch).toBe(branch);
    expect(result.previousSha).toBe(result.newSha);
  });

  it('fast-forwards when origin has new commits', async () => {
    const author = new GitService(originUpstream);
    writeFileSync(join(originUpstream, 'feature.md'), 'feature\n');
    await author.addAll();
    await author.commit('feature');
    await author.push('origin', branch);

    const result = await updateEnvRepo({ repoPath: envRepo });
    expect(result.state).toBe('updated');
    expect(result.previousSha).not.toBe(result.newSha);
    expect(result.message).toMatch(/env-repo updated [0-9a-f]+ -> [0-9a-f]+/);
  });

  it('aborts when working tree is dirty', async () => {
    writeFileSync(join(envRepo, 'local-change.md'), 'dirty\n');
    const result = await updateEnvRepo({ repoPath: envRepo });
    expect(result.state).toBe('aborted-dirty');
    expect(result.message).toMatch(/working tree dirty/);
  });

  it('aborts on divergence (ff-only refused)', async () => {
    const author = new GitService(originUpstream);
    writeFileSync(join(originUpstream, 'upstream.md'), 'u\n');
    await author.addAll();
    await author.commit('upstream');
    await author.push('origin', branch);

    writeFileSync(join(envRepo, 'local.md'), 'l\n');
    await envGit.addAll();
    await envGit.commit('local commit');

    const result = await updateEnvRepo({ repoPath: envRepo });
    expect(result.state).toBe('aborted-diverged');
    expect(result.error).toBeDefined();
  });
});
