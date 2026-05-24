import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAppEnv } from '../../../src/core/config/index.js';

const ENV_VARS = ['CLAUDE_OS_VAULT_PATH', 'CLAUDE_OS_DEFAULT_WORKSPACE'];

describe('loadAppEnv', () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cfg-test-'));
    for (const k of ENV_VARS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    for (const k of ENV_VARS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('returns empty AppEnv when neither .env nor process.env has the keys', () => {
    const env = loadAppEnv({ envFilePath: join(tmpDir, 'does-not-exist'), env: {} });
    expect(env.vaultPath).toBeUndefined();
    expect(env.defaultWorkspace).toBeUndefined();
  });

  it('loads CLAUDE_OS_VAULT_PATH from a real .env file', () => {
    const envFile = join(tmpDir, '.env');
    writeFileSync(envFile, 'CLAUDE_OS_VAULT_PATH=/tmp/my-vault\n');
    const env = loadAppEnv({ envFilePath: envFile });
    expect(env.vaultPath).toBe('/tmp/my-vault');
  });

  it('respects CLAUDE_OS_DEFAULT_WORKSPACE from .env', () => {
    const envFile = join(tmpDir, '.env');
    writeFileSync(
      envFile,
      'CLAUDE_OS_VAULT_PATH=/tmp/v\nCLAUDE_OS_DEFAULT_WORKSPACE=msp-internal\n',
    );
    const env = loadAppEnv({ envFilePath: envFile });
    expect(env.defaultWorkspace).toBe('msp-internal');
  });

  it('trims whitespace from values', () => {
    const env = loadAppEnv({
      envFilePath: join(tmpDir, 'does-not-exist'),
      env: { CLAUDE_OS_VAULT_PATH: '   /tmp/v   ' },
    });
    expect(env.vaultPath).toBe('/tmp/v');
  });

  it('treats empty string as undefined (after trim)', () => {
    const env = loadAppEnv({
      envFilePath: join(tmpDir, 'does-not-exist'),
      env: { CLAUDE_OS_VAULT_PATH: '   ' },
    });
    expect(env.vaultPath).toBeUndefined();
  });
});
