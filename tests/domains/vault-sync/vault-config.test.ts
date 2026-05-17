import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_VAULT_CONFIG,
  loadVaultConfig,
  updateVaultConfig,
  type VaultConfig,
} from '../../../src/domains/vault-sync/index.js';

describe('VaultConfig', () => {
  let tmpBase: string;
  let filePath: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-vcfg-'));
    filePath = join(tmpBase, 'vault-config.json');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  it('returns defaults when no file exists', () => {
    expect(loadVaultConfig(filePath)).toEqual(DEFAULT_VAULT_CONFIG);
  });

  it('updates and persists a single field', () => {
    const next = updateVaultConfig(filePath, { conflictMode: 'prefer-local' });
    expect(next.conflictMode).toBe('prefer-local');
    expect(next.idleSeconds).toBe(DEFAULT_VAULT_CONFIG.idleSeconds);
    const reloaded = loadVaultConfig(filePath);
    expect(reloaded).toEqual(next);
  });

  it('round-trips multiple fields', () => {
    const next = updateVaultConfig(filePath, {
      conflictMode: 'prefer-remote',
      idleSeconds: 60,
      scheduleEnabled: true,
    });
    expect(next).toEqual({
      conflictMode: 'prefer-remote',
      idleSeconds: 60,
      scheduleEnabled: true,
    });
  });

  it('throws on invalid conflictMode patch', () => {
    expect(() => updateVaultConfig(filePath, { conflictMode: 'invalid-mode' as never })).toThrow();
  });

  it('throws on non-positive idleSeconds', () => {
    expect(() => updateVaultConfig(filePath, { idleSeconds: 0 })).toThrow();
    expect(() => updateVaultConfig(filePath, { idleSeconds: -5 })).toThrow();
  });

  it('returns defaults when the on-disk JSON is corrupt', () => {
    writeFileSync(filePath, '{not real json');
    expect(loadVaultConfig(filePath)).toEqual(DEFAULT_VAULT_CONFIG);
  });

  it('returns defaults when the on-disk shape is invalid', () => {
    writeFileSync(
      filePath,
      JSON.stringify({ conflictMode: 'bogus', idleSeconds: 1, scheduleEnabled: true }),
    );
    expect(loadVaultConfig(filePath)).toEqual(DEFAULT_VAULT_CONFIG);
  });

  it('persists pretty-printed JSON', () => {
    updateVaultConfig(filePath, { conflictMode: 'abort' });
    const raw = readFileSync(filePath, 'utf8');
    expect(raw).toContain('\n');
    const parsed = JSON.parse(raw) as VaultConfig;
    expect(parsed.conflictMode).toBe('abort');
  });
});
