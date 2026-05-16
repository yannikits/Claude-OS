import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkNodeVersion,
  checkGitAvailable,
  checkClaudeBinary,
  checkMountReachable,
  checkWritePermission,
} from '../../../src/core/doctor/index.js';
import type { ResolvedRoot } from '../../../src/core/environment/index.js';

describe('checkNodeVersion', () => {
  it('reports current Node version', async () => {
    const result = await checkNodeVersion();
    expect(result.name).toBe('node-version');
    expect(result.message).toMatch(/Node v\d+/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns ok for Node 20+ (test env)', async () => {
    const result = await checkNodeVersion();
    expect(result.severity).toBe('ok');
  });
});

describe('checkGitAvailable', () => {
  it('returns ok when git is in PATH (test env)', async () => {
    const result = await checkGitAvailable();
    expect(result.name).toBe('git-available');
    expect(result.severity).toBe('ok');
    expect(result.message).toMatch(/git version/i);
  });
});

describe('checkClaudeBinary', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'claude-os-doctor-test-'));
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns ok when bin/claude.exe exists', async () => {
    mkdirSync(join(tmpRoot, 'bin'));
    writeFileSync(join(tmpRoot, 'bin', 'claude.exe'), '');
    const result = await checkClaudeBinary(tmpRoot);
    expect(result.severity).toBe('ok');
    expect(result.message).toMatch(/claude\.exe/);
  });

  it('returns ok when bin/claude exists (POSIX)', async () => {
    mkdirSync(join(tmpRoot, 'bin'));
    writeFileSync(join(tmpRoot, 'bin', 'claude'), '');
    const result = await checkClaudeBinary(tmpRoot);
    expect(result.severity).toBe('ok');
  });

  it('returns warn (not fail) when no claude binary exists', async () => {
    const result = await checkClaudeBinary(tmpRoot);
    expect(result.severity).toBe('warn');
    expect(result.hint).toMatch(/claude-os ai/);
  });
});

describe('checkMountReachable', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'claude-os-doctor-test-'));
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns ok for existing path', async () => {
    const root: ResolvedRoot = {
      path: tmpRoot,
      source: 'explicit',
      cloudProvider: 'local',
    };
    const result = await checkMountReachable(root);
    expect(result.severity).toBe('ok');
    expect(result.message).toContain(tmpRoot);
  });

  it('returns fail for non-existent path', async () => {
    const root: ResolvedRoot = {
      path: join(tmpRoot, 'nonexistent'),
      source: 'env-var',
      cloudProvider: 'unknown',
    };
    const result = await checkMountReachable(root);
    expect(result.severity).toBe('fail');
  });
});

describe('checkWritePermission', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'claude-os-doctor-test-'));
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns ok for writable path', async () => {
    const result = await checkWritePermission(tmpRoot);
    expect(result.severity).toBe('ok');
  });

  it('returns fail for non-existent path', async () => {
    const result = await checkWritePermission(join(tmpRoot, 'nonexistent'));
    expect(result.severity).toBe('fail');
  });
});
