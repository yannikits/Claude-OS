import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../../src/core/git/index.js';
import {
  applyConflictResolution,
  isPushConflictError,
} from '../../../src/domains/vault-sync/index.js';

describe('isPushConflictError', () => {
  it('matches non-fast-forward', () => {
    expect(isPushConflictError(new Error('error: failed to push some refs to bare.git'))).toBe(
      true,
    );
  });
  it('matches "Updates were rejected"', () => {
    expect(isPushConflictError(new Error('Updates were rejected because the tip'))).toBe(true);
  });
  it('matches fetch-first', () => {
    expect(isPushConflictError(new Error('hint: Updates were rejected, fetch first'))).toBe(true);
  });
  it('returns false for unrelated errors', () => {
    expect(isPushConflictError(new Error('Permission denied'))).toBe(false);
    expect(isPushConflictError(null)).toBe(false);
    expect(isPushConflictError('')).toBe(false);
  });
});

describe('applyConflictResolution', () => {
  let tmpBase: string;
  let bareDir: string;
  let machineA: string;
  let machineB: string;
  let gitB: GitService;
  let branch: string;

  beforeEach(async () => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-conflict-'));
    bareDir = join(tmpBase, 'origin.git');
    machineA = join(tmpBase, 'machine-A');
    machineB = join(tmpBase, 'machine-B');
    mkdirSync(bareDir, { recursive: true });
    mkdirSync(machineA, { recursive: true });
    mkdirSync(machineB, { recursive: true });

    await new GitService(bareDir).init(['--bare']);

    const gitA = new GitService(machineA);
    await gitA.init();
    await gitA.setConfig('user.email', 'a@example.com');
    await gitA.setConfig('user.name', 'A');
    await gitA.raw(['remote', 'add', 'origin', bareDir]);
    writeFileSync(join(machineA, 'seed.md'), 'seed\n');
    await gitA.addAll();
    await gitA.commit('seed');
    branch = await gitA.getCurrentBranch();
    await gitA.push('origin', branch);

    gitB = new GitService(machineB);
    await gitB.init();
    await gitB.setConfig('user.email', 'b@example.com');
    await gitB.setConfig('user.name', 'B');
    await gitB.raw(['remote', 'add', 'origin', bareDir]);
    await gitB.raw(['fetch', 'origin']);
    await gitB.raw(['checkout', '-B', branch, `origin/${branch}`]);

    writeFileSync(join(machineA, 'from-A.md'), 'A2\n');
    await gitA.addAll();
    await gitA.commit('A second commit');
    await gitA.push('origin', branch);

    writeFileSync(join(machineB, 'from-B.md'), 'B2\n');
    await gitB.addAll();
    await gitB.commit('B second commit');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  it('mode=abort returns aborted with a doctor hint', async () => {
    const result = await applyConflictResolution({ mode: 'abort', git: gitB, branch });
    expect(result.state).toBe('aborted');
    expect(result.mode).toBe('abort');
    expect(result.message).toMatch(/git pull --rebase|conflict-mode/i);
  });

  it('mode=prefer-local force-pushes B over A', async () => {
    const result = await applyConflictResolution({
      mode: 'prefer-local',
      git: gitB,
      branch,
    });
    expect(result.state).toBe('forced-push');

    const bareGit = new GitService(bareDir);
    const bareTip = (await bareGit.raw(['rev-parse', branch])).trim();
    const bTip = (await gitB.raw(['rev-parse', 'HEAD'])).trim();
    expect(bareTip).toBe(bTip);
  });

  it('mode=prefer-remote creates backup branch and resets to origin', async () => {
    const fixed = new Date('2026-05-17T08:00:00.123Z');
    const bHeadBefore = (await gitB.raw(['rev-parse', 'HEAD'])).trim();
    const result = await applyConflictResolution({
      mode: 'prefer-remote',
      git: gitB,
      branch,
      now: () => fixed,
    });
    expect(result.state).toBe('reset-with-backup');
    expect(result.backupBranch).toBe(`claude-os/backup/${branch}/2026-05-17T08-00-00-123Z`);

    const newHead = (await gitB.raw(['rev-parse', 'HEAD'])).trim();
    const originTip = (await gitB.raw(['rev-parse', `origin/${branch}`])).trim();
    expect(newHead).toBe(originTip);

    const backupTip = (await gitB.raw(['rev-parse', result.backupBranch as string])).trim();
    expect(backupTip).toBe(bHeadBefore);
  });

  it('mode=prefer-local succeeds even after multiple intervening pushes from A', async () => {
    // Stress the fetch+force-with-lease pattern: another machine has
    // pushed multiple commits since gitB last fetched. Our flow
    // fetches first, then force-pushes, so the lease check passes.
    const gitA = new GitService(machineA);
    writeFileSync(join(machineA, 'from-A-2.md'), 'A3\n');
    await gitA.addAll();
    await gitA.commit('A third commit');
    await gitA.push('origin', branch);

    const result = await applyConflictResolution({
      mode: 'prefer-local',
      git: gitB,
      branch,
    });
    expect(result.state).toBe('forced-push');
    const bareGit = new GitService(bareDir);
    const bareTip = (await bareGit.raw(['rev-parse', branch])).trim();
    const bTip = (await gitB.raw(['rev-parse', 'HEAD'])).trim();
    expect(bareTip).toBe(bTip);
  });
});
