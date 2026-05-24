import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveVaultRoot,
  VaultPathNotConfiguredError,
  WorkspaceError,
} from '../../../src/domains/workspace/index.js';

describe('resolveVaultRoot', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'vr-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('accepts explicit override when path exists', () => {
    expect(resolveVaultRoot({ explicit: tmp })).toBe(tmp);
  });

  it('reads from env-arg when explicit not given', () => {
    expect(resolveVaultRoot({ env: { vaultPath: tmp } })).toBe(tmp);
  });

  it('throws VaultPathNotConfiguredError when nothing supplied', () => {
    expect(() => resolveVaultRoot({ env: {} })).toThrow(VaultPathNotConfiguredError);
  });

  it('throws when path does not exist', () => {
    const missing = join(tmp, 'does-not-exist');
    expect(() => resolveVaultRoot({ explicit: missing })).toThrow(WorkspaceError);
  });

  it('throws when path is a file, not a directory', () => {
    const filePath = join(tmp, 'a-file.txt');
    writeFileSync(filePath, 'hello', 'utf8');
    expect(() => resolveVaultRoot({ explicit: filePath })).toThrow(WorkspaceError);
  });

  it('explicit takes precedence over env-arg', () => {
    const second = mkdtempSync(join(tmpdir(), 'vr2-'));
    try {
      expect(resolveVaultRoot({ explicit: second, env: { vaultPath: tmp } })).toBe(second);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });
});
