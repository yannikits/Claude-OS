import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectCloudProvider,
  RootNotFoundError,
  resolveRoot,
} from '../../../src/core/environment/index.js';

describe('detectCloudProvider', () => {
  it.each([
    ['C:\\Users\\foo\\OneDrive\\Claude\\Project', 'onedrive'],
    ['/Users/foo/Library/CloudStorage/OneDrive-Personal/Claude', 'onedrive'],
    ['/Users/foo/Google Drive/Claude', 'gdrive'],
    ['/Users/foo/Library/CloudStorage/GoogleDrive-foo/Claude', 'gdrive'],
    ['/Users/foo/Dropbox/Claude', 'dropbox'],
    ['/mnt/rclone/onedrive/Claude', 'rclone'],
    ['/Users/foo/Library/Mobile Documents/com~apple~CloudDocs/Claude', 'icloud'],
    ['/Users/foo/Documents/Claude', 'unknown'],
    ['', 'unknown'],
  ] as const)('detects "%s" as "%s"', (path, expected) => {
    expect(detectCloudProvider(path)).toBe(expected);
  });
});

describe('resolveRoot', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'claude-os-test-'));
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('resolves explicit path when marker file exists', () => {
    writeFileSync(join(tmpRoot, '.claude-os-root'), '');
    const result = resolveRoot({ explicit: tmpRoot });
    expect(result.source).toBe('explicit');
    expect(result.path).toBe(tmpRoot);
  });

  it('resolves explicit path when bin/claude exists (claude-portable evolution)', () => {
    mkdirSync(join(tmpRoot, 'bin'));
    writeFileSync(join(tmpRoot, 'bin', 'claude'), '');
    const result = resolveRoot({ explicit: tmpRoot });
    expect(result.source).toBe('explicit');
    expect(result.path).toBe(tmpRoot);
  });

  it('resolves explicit path when bin/claude.exe exists (Windows evolution)', () => {
    mkdirSync(join(tmpRoot, 'bin'));
    writeFileSync(join(tmpRoot, 'bin', 'claude.exe'), '');
    const result = resolveRoot({ explicit: tmpRoot });
    expect(result.source).toBe('explicit');
  });

  it('throws RootNotFoundError when explicit path has no marker', () => {
    expect(() => resolveRoot({ explicit: tmpRoot })).toThrow(RootNotFoundError);
  });

  it('resolves $CLAUDE_OS_ROOT when env-var points at valid root', () => {
    writeFileSync(join(tmpRoot, '.claude-os-root'), '');
    const result = resolveRoot({ env: { CLAUDE_OS_ROOT: tmpRoot } });
    expect(result.source).toBe('env-var');
    expect(result.path).toBe(tmpRoot);
  });

  it('throws RootNotFoundError when $CLAUDE_OS_ROOT points at invalid path', () => {
    expect(() => resolveRoot({ env: { CLAUDE_OS_ROOT: tmpRoot } })).toThrow(RootNotFoundError);
  });

  it('treats empty CLAUDE_OS_ROOT as unset and falls through to repo-detect', () => {
    writeFileSync(join(tmpRoot, '.claude-os-root'), '');
    const result = resolveRoot({ env: { CLAUDE_OS_ROOT: '   ' }, cwd: tmpRoot });
    expect(result.source).toBe('repo-detect');
  });

  it('walks up from nested cwd to find marker', () => {
    writeFileSync(join(tmpRoot, '.claude-os-root'), '');
    const nested = join(tmpRoot, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    const result = resolveRoot({ env: {}, cwd: nested });
    expect(result.source).toBe('repo-detect');
    expect(result.path).toBe(tmpRoot);
  });

  it('throws RootNotFoundError when no root found in any strategy', () => {
    expect(() => resolveRoot({ env: {}, cwd: tmpRoot })).toThrow(RootNotFoundError);
  });

  it('priorities: explicit > env-var > repo-detect', () => {
    writeFileSync(join(tmpRoot, '.claude-os-root'), '');
    const result = resolveRoot({
      explicit: tmpRoot,
      env: { CLAUDE_OS_ROOT: '/some/other/path' },
      cwd: '/yet/another/path',
    });
    expect(result.source).toBe('explicit');
  });

  it('attaches cloudProvider to result', () => {
    writeFileSync(join(tmpRoot, '.claude-os-root'), '');
    const result = resolveRoot({ explicit: tmpRoot });
    expect(result.cloudProvider).toBeDefined();
    expect(['onedrive', 'gdrive', 'dropbox', 'rclone', 'icloud', 'local', 'unknown']).toContain(
      result.cloudProvider,
    );
  });
});
