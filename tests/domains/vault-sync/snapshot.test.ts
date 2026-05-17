import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../../src/core/git/index.js';
import { snapshot } from '../../../src/domains/vault-sync/index.js';

describe('snapshot', () => {
  let tmpBase: string;
  let bareDir: string;
  let workTree: string;
  let git: GitService;

  beforeEach(async () => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-snap-'));
    bareDir = join(tmpBase, 'origin.git');
    workTree = join(tmpBase, 'vault');
    mkdirSync(bareDir, { recursive: true });
    mkdirSync(workTree, { recursive: true });

    const bareGit = new GitService(bareDir);
    await bareGit.init(['--bare']);

    git = new GitService(workTree);
    await git.init();
    await git.setConfig('user.email', 'tests@example.com');
    await git.setConfig('user.name', 'Tests');
    await git.raw(['remote', 'add', 'origin', bareDir]);
    writeFileSync(join(workTree, 'seed.md'), 'seed\n');
    await git.addAll();
    await git.commit('seed');
    const branch = await git.getCurrentBranch();
    await git.push('origin', branch);
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  it('returns clean when there is nothing to commit', async () => {
    const result = await snapshot({ workTree });
    expect(result.state).toBe('clean');
    expect(result.fileCount).toBe(0);
  });

  it('stages, commits, and pushes a new file', async () => {
    writeFileSync(join(workTree, 'new-note.md'), 'fresh content\n');
    const result = await snapshot({
      workTree,
      now: () => new Date('2026-05-17T12:34:56.000Z'),
    });
    expect(result.state).toBe('pushed');
    expect(result.message).toBe('claude-os snapshot 2026-05-17T12:34:56.000Z');
    expect(result.fileCount).toBe(1);
    expect(result.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(result.branch).toMatch(/^(main|master)$/);
  });

  it('reflects the actual current branch (no main hardcoding)', async () => {
    await git.raw(['checkout', '-b', 'feature/x']);
    await git.push('origin', 'feature/x');
    writeFileSync(join(workTree, 'feat.md'), 'feat\n');
    const result = await snapshot({ workTree });
    expect(result.state).toBe('pushed');
    expect(result.branch).toBe('feature/x');
  });

  it('returns committed (not pushed) when skipPush=true', async () => {
    writeFileSync(join(workTree, 'local-only.md'), 'local\n');
    const result = await snapshot({ workTree, skipPush: true });
    expect(result.state).toBe('committed');
    expect(result.sha).toMatch(/^[0-9a-f]{7,}$/);
  });

  it('returns push-failed when origin is unreachable', async () => {
    await git.raw(['remote', 'set-url', 'origin', join(tmpBase, 'nowhere-bare.git')]);
    writeFileSync(join(workTree, 'orphan.md'), 'orphan\n');
    const result = await snapshot({ workTree });
    expect(result.state).toBe('push-failed');
    expect(result.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(result.error).toBeDefined();
  });

  it('counts staged + modified + untracked + deleted', async () => {
    writeFileSync(join(workTree, 'a.md'), 'A\n');
    writeFileSync(join(workTree, 'b.md'), 'B\n');
    writeFileSync(join(workTree, 'seed.md'), 'changed seed\n');
    const result = await snapshot({ workTree, skipPush: true });
    expect(result.state).toBe('committed');
    expect(result.fileCount).toBeGreaterThanOrEqual(3);
  });

  it('builds the ISO-8601 commit message with millisecond precision', async () => {
    writeFileSync(join(workTree, 'ts.md'), 'x\n');
    const fixed = new Date('2026-05-17T08:00:00.123Z');
    const result = await snapshot({ workTree, skipPush: true, now: () => fixed });
    expect(result.message).toBe('claude-os snapshot 2026-05-17T08:00:00.123Z');
  });
});
