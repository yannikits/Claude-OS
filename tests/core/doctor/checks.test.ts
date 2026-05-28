import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkClaudeBinary,
  checkGitAvailable,
  checkMountReachable,
  checkNodeVersion,
  checkServerEnv,
  checkWindowsLongPaths,
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

describe('checkWindowsLongPaths', () => {
  it('returns ok with "not applicable" on non-Windows', async () => {
    if (process.platform === 'win32') return; // platform-specific test
    const result = await checkWindowsLongPaths();
    expect(result.severity).toBe('ok');
    expect(result.message).toContain('not applicable');
  });

  it('returns ok or warn on Windows depending on global git config', async () => {
    if (process.platform !== 'win32') return;
    const result = await checkWindowsLongPaths();
    expect(['ok', 'warn']).toContain(result.severity);
    expect(result.name).toBe('windows-long-paths');
  });
});

describe('checkServerEnv', () => {
  let tmpVault: string;

  beforeEach(() => {
    tmpVault = mkdtempSync(join(tmpdir(), 'claude-os-server-env-test-'));
  });

  afterEach(() => {
    if (existsSync(tmpVault)) rmSync(tmpVault, { recursive: true, force: true });
  });

  it('skips with ok when CLAUDE_OS_AUTH_TOKEN is unset (Tauri mode)', async () => {
    const result = await checkServerEnv({});
    expect(result.severity).toBe('ok');
    expect(result.message).toContain('not in server mode');
  });

  it('returns ok when all server-mode env-vars are set correctly', async () => {
    const result = await checkServerEnv({
      CLAUDE_OS_AUTH_TOKEN: 'deadbeef',
      CLAUDE_OS_SECRETS_BACKEND: 'encrypted-file',
      CLAUDE_OS_VAULT_PATH: tmpVault,
    });
    expect(result.severity).toBe('ok');
    expect(result.message).toContain('server-mode env complete');
  });

  it('returns ok when CLAUDE_OS_SECRETS_BACKEND is unset (factory falls back)', async () => {
    const result = await checkServerEnv({
      CLAUDE_OS_AUTH_TOKEN: 'deadbeef',
      CLAUDE_OS_VAULT_PATH: tmpVault,
    });
    expect(result.severity).toBe('ok');
  });

  it('fails when CLAUDE_OS_SECRETS_BACKEND is keyring (needs desktop session)', async () => {
    const result = await checkServerEnv({
      CLAUDE_OS_AUTH_TOKEN: 'deadbeef',
      CLAUDE_OS_SECRETS_BACKEND: 'keyring',
      CLAUDE_OS_VAULT_PATH: tmpVault,
    });
    expect(result.severity).toBe('fail');
    expect(result.detail).toContain('CLAUDE_OS_SECRETS_BACKEND');
    expect(result.detail).toContain('keyring');
  });

  it('fails when CLAUDE_OS_SECRETS_BACKEND is an unknown value', async () => {
    const result = await checkServerEnv({
      CLAUDE_OS_AUTH_TOKEN: 'deadbeef',
      CLAUDE_OS_SECRETS_BACKEND: 'plaintext',
      CLAUDE_OS_VAULT_PATH: tmpVault,
    });
    expect(result.severity).toBe('fail');
    expect(result.detail).toContain('unknown backend');
  });

  it('fails when CLAUDE_OS_VAULT_PATH is unset', async () => {
    const result = await checkServerEnv({
      CLAUDE_OS_AUTH_TOKEN: 'deadbeef',
      CLAUDE_OS_SECRETS_BACKEND: 'encrypted-file',
    });
    expect(result.severity).toBe('fail');
    expect(result.detail).toContain('CLAUDE_OS_VAULT_PATH is unset');
  });

  it('fails when CLAUDE_OS_VAULT_PATH does not exist', async () => {
    const result = await checkServerEnv({
      CLAUDE_OS_AUTH_TOKEN: 'deadbeef',
      CLAUDE_OS_SECRETS_BACKEND: 'encrypted-file',
      CLAUDE_OS_VAULT_PATH: join(tmpVault, 'nope'),
    });
    expect(result.severity).toBe('fail');
    expect(result.detail).toContain('does not exist');
  });

  it('aggregates multiple problems in one detail string', async () => {
    const result = await checkServerEnv({
      CLAUDE_OS_AUTH_TOKEN: 'deadbeef',
      CLAUDE_OS_SECRETS_BACKEND: 'keyring',
      // backend wrong + vault missing → both surface
    });
    expect(result.severity).toBe('fail');
    expect(result.detail).toContain('CLAUDE_OS_SECRETS_BACKEND');
    expect(result.detail).toContain('CLAUDE_OS_VAULT_PATH');
  });

  it('hint points at docs/server-deployment.md', async () => {
    const result = await checkServerEnv({ CLAUDE_OS_AUTH_TOKEN: 'x' });
    expect(result.hint).toContain('server-deployment.md');
  });
});
