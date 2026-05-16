import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveClaudeBinary,
  BinaryNotFoundError,
} from '../../../src/domains/claude-bridge/index.js';

describe('resolveClaudeBinary', () => {
  let tmpBase: string;
  let rootPath: string;
  let pathDir: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-bridge-rb-'));
    rootPath = join(tmpBase, 'root');
    pathDir = join(tmpBase, 'path-dir');
    mkdirSync(join(rootPath, 'bin'), { recursive: true });
    mkdirSync(pathDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  it('prefers an explicit binaryPath override', () => {
    const override = join(tmpBase, 'override-claude');
    writeFileSync(override, '#!/bin/sh\n');
    const result = resolveClaudeBinary({ binaryPath: override, platform: 'linux' });
    expect(result.source).toBe('override');
    expect(result.path).toBe(override);
  });

  it('throws when binaryPath override points to a non-existent file', () => {
    expect(() =>
      resolveClaudeBinary({ binaryPath: join(tmpBase, 'no-such'), platform: 'linux' }),
    ).toThrow(BinaryNotFoundError);
  });

  it('finds bin/claude under rootPath on POSIX', () => {
    const binFile = join(rootPath, 'bin', 'claude');
    writeFileSync(binFile, '#!/bin/sh\n');
    const result = resolveClaudeBinary({ rootPath, platform: 'linux' });
    expect(result.source).toBe('bin');
    expect(result.path).toBe(binFile);
  });

  it('finds bin/claude.exe under rootPath on win32', () => {
    const binFile = join(rootPath, 'bin', 'claude.exe');
    writeFileSync(binFile, '');
    const result = resolveClaudeBinary({ rootPath, platform: 'win32' });
    expect(result.source).toBe('bin');
    expect(result.path).toBe(binFile);
  });

  it('falls back to $PATH walk when rootPath/bin is empty', () => {
    const onPath = join(pathDir, 'claude');
    writeFileSync(onPath, '#!/bin/sh\n');
    const result = resolveClaudeBinary({
      rootPath,
      env: { PATH: pathDir },
      platform: 'linux',
    });
    expect(result.source).toBe('path');
    expect(result.path).toBe(onPath);
  });

  it('throws BinaryNotFoundError when neither rootPath nor PATH yields a match', () => {
    expect(() =>
      resolveClaudeBinary({
        rootPath,
        env: { PATH: pathDir },
        platform: 'linux',
      }),
    ).toThrow(BinaryNotFoundError);
  });

  it('reads $PATH from lowercase env on platforms that use it', () => {
    const onPath = join(pathDir, 'claude');
    writeFileSync(onPath, '');
    const result = resolveClaudeBinary({
      env: { path: pathDir },
      platform: 'linux',
    });
    expect(result.path).toBe(onPath);
  });
});
