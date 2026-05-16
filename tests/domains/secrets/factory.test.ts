import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createSecretStore,
  SecretsError,
} from '../../../src/domains/secrets/index.js';

describe('createSecretStore', () => {
  let tmpBase: string;
  let encryptedFilePathOverride: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-factory-'));
    encryptedFilePathOverride = join(tmpBase, 'secrets.enc');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  it('uses encrypted-file when the keyring probe fails', () => {
    const store = createSecretStore({
      env: {},
      probeFn: () => false,
      encryptedFilePathOverride,
    });
    expect(store.backend).toBe('encrypted-file');
  });

  it('uses keyring when the probe succeeds', () => {
    const store = createSecretStore({
      env: {},
      probeFn: () => true,
      encryptedFilePathOverride,
    });
    expect(store.backend).toBe('keyring');
  });

  it('honours $CLAUDE_OS_SECRETS_BACKEND=encrypted-file even if probe would succeed', () => {
    const store = createSecretStore({
      env: { CLAUDE_OS_SECRETS_BACKEND: 'encrypted-file' },
      probeFn: () => true,
      encryptedFilePathOverride,
    });
    expect(store.backend).toBe('encrypted-file');
  });

  it('honours $CLAUDE_OS_SECRETS_BACKEND=keyring even if probe would fail', () => {
    const store = createSecretStore({
      env: { CLAUDE_OS_SECRETS_BACKEND: 'keyring' },
      probeFn: () => false,
      encryptedFilePathOverride,
    });
    expect(store.backend).toBe('keyring');
  });

  it('throws SecretsError on an unrecognised $CLAUDE_OS_SECRETS_BACKEND value', () => {
    expect(() =>
      createSecretStore({
        env: { CLAUDE_OS_SECRETS_BACKEND: 'redis' },
        probeFn: () => true,
        encryptedFilePathOverride,
      }),
    ).toThrow(SecretsError);
  });
});
