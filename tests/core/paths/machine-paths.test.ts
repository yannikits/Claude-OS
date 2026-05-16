import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  resolveMachinePaths,
  externalGitDirFor,
  PathsResolutionError,
} from '../../../src/core/paths/index.js';

describe('resolveMachinePaths', () => {
  it('uses $APPDATA on win32', () => {
    const paths = resolveMachinePaths({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
      home: 'C:\\Users\\test',
    });
    expect(paths.dataRoot.toLowerCase()).toBe(
      'C:\\Users\\test\\AppData\\Roaming\\claude-os'.toLowerCase(),
    );
    expect(paths.gitMetadataDir).toBe(join(paths.dataRoot, 'git-metadata'));
    expect(paths.dataDir).toBe(join(paths.dataRoot, 'data'));
    expect(paths.logsDir).toBe(join(paths.dataRoot, 'logs'));
  });

  it('falls back to ~/AppData/Roaming on win32 when $APPDATA empty', () => {
    const paths = resolveMachinePaths({
      platform: 'win32',
      env: {},
      home: 'C:\\Users\\test',
    });
    expect(paths.dataRoot.toLowerCase()).toContain('appdata\\roaming\\claude-os');
  });

  it('uses $XDG_CONFIG_HOME on linux', () => {
    const paths = resolveMachinePaths({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/home/test/.config' },
      home: '/home/test',
    });
    expect(paths.dataRoot).toBe('/home/test/.config/claude-os');
    expect(paths.gitMetadataDir).toBe('/home/test/.config/claude-os/git-metadata');
  });

  it('falls back to ~/.config on linux without XDG_CONFIG_HOME', () => {
    const paths = resolveMachinePaths({
      platform: 'linux',
      env: {},
      home: '/home/test',
    });
    expect(paths.dataRoot).toBe('/home/test/.config/claude-os');
  });

  it('falls back to ~/.config on darwin', () => {
    const paths = resolveMachinePaths({
      platform: 'darwin',
      env: {},
      home: '/Users/test',
    });
    expect(paths.dataRoot).toBe('/Users/test/.config/claude-os');
  });

  it('$CLAUDE_OS_DATA_DIR overrides platform defaults', () => {
    const paths = resolveMachinePaths({
      platform: 'linux',
      env: {
        CLAUDE_OS_DATA_DIR: '/tmp/override',
        XDG_CONFIG_HOME: '/home/test/.config',
      },
      home: '/home/test',
    });
    expect(paths.dataRoot).toBe('/tmp/override');
    expect(paths.gitMetadataDir).toBe('/tmp/override/git-metadata');
  });

  it('treats whitespace-only $CLAUDE_OS_DATA_DIR as unset', () => {
    const paths = resolveMachinePaths({
      platform: 'linux',
      env: { CLAUDE_OS_DATA_DIR: '   ', XDG_CONFIG_HOME: '/x' },
      home: '/home/test',
    });
    expect(paths.dataRoot).toBe('/x/claude-os');
  });

  it('throws when no resolution strategy succeeds on linux', () => {
    expect(() =>
      resolveMachinePaths({ platform: 'linux', env: {}, home: '' }),
    ).toThrow(PathsResolutionError);
  });

  it('throws when $APPDATA unset and home empty on win32', () => {
    expect(() =>
      resolveMachinePaths({ platform: 'win32', env: {}, home: '' }),
    ).toThrow(PathsResolutionError);
  });
});

describe('externalGitDirFor', () => {
  it('returns <gitMetadataDir>/<repoName>.git', () => {
    const target = externalGitDirFor('vault', {
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/home/test/.config' },
      home: '/home/test',
    });
    expect(target).toBe('/home/test/.config/claude-os/git-metadata/vault.git');
  });

  it('supports arbitrary repo names', () => {
    const target = externalGitDirFor('docs-repo', {
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/c' },
      home: '/h',
    });
    expect(target).toBe('/c/claude-os/git-metadata/docs-repo.git');
  });

  it('rejects empty repo-name', () => {
    expect(() => externalGitDirFor('', { platform: 'linux', env: {}, home: '/h' })).toThrow(
      PathsResolutionError,
    );
  });

  it('rejects repo-name with path separators', () => {
    expect(() =>
      externalGitDirFor('foo/bar', { platform: 'linux', env: {}, home: '/h' }),
    ).toThrow(PathsResolutionError);
    expect(() =>
      externalGitDirFor('foo\\bar', { platform: 'linux', env: {}, home: '/h' }),
    ).toThrow(PathsResolutionError);
  });
});
