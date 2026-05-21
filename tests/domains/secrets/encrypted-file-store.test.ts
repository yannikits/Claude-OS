import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EncryptedFileStore,
  SecretsError,
  SecretsLockedError,
} from '../../../src/domains/secrets/index.js';

describe('EncryptedFileStore', () => {
  let tmpBase: string;
  let filePath: string;
  const masterKey = 'unit-test-master-key-42';

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-secrets-'));
    filePath = join(tmpBase, 'secrets.enc');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  function makeStore(): EncryptedFileStore {
    return new EncryptedFileStore({ filePath, masterKey });
  }

  it('returns null for missing key when file does not exist', async () => {
    const store = makeStore();
    expect(await store.get('any')).toBeNull();
  });

  it('round-trips a single value via set + get', async () => {
    const store = makeStore();
    await store.set('github_pat', 'ghp_synth-12345');
    expect(await store.get('github_pat')).toBe('ghp_synth-12345');
  });

  it('persists across instances via filesystem', async () => {
    await makeStore().set('openai_key', 'sk-test-abc');
    const replay = new EncryptedFileStore({ filePath, masterKey });
    expect(await replay.get('openai_key')).toBe('sk-test-abc');
  });

  it('lists all stored keys without leaking values', async () => {
    const store = makeStore();
    await store.set('a', 'v1');
    await store.set('b', 'v2');
    const items = await store.list();
    expect(items.map((i) => i.key).sort()).toEqual(['a', 'b']);
    for (const item of items) expect(item.backend).toBe('encrypted-file');
  });

  it('overwrites an existing key', async () => {
    const store = makeStore();
    await store.set('k', 'v1');
    await store.set('k', 'v2');
    expect(await store.get('k')).toBe('v2');
  });

  it('returns true on successful delete and false otherwise', async () => {
    const store = makeStore();
    await store.set('keep', 'k');
    await store.set('remove', 'r');
    expect(await store.delete('remove')).toBe(true);
    expect(await store.delete('remove')).toBe(false);
    expect(await store.get('remove')).toBeNull();
    expect(await store.get('keep')).toBe('k');
  });

  it('removes the file when the last key is deleted', async () => {
    const store = makeStore();
    await store.set('only', 'v');
    expect(existsSync(filePath)).toBe(true);
    await store.delete('only');
    expect(existsSync(filePath)).toBe(false);
  });

  it('rejects with SecretsError when decrypting with a different master key', async () => {
    await makeStore().set('k', 'v');
    const wrong = new EncryptedFileStore({ filePath, masterKey: 'WRONG-KEY' });
    await expect(wrong.get('k')).rejects.toThrow(SecretsError);
  });

  it('throws SecretsLockedError when no master key is configured', async () => {
    const locked = new EncryptedFileStore({ filePath, env: {} });
    await expect(locked.set('k', 'v')).rejects.toThrow(SecretsLockedError);
  });

  it('falls back to $CLAUDE_OS_SECRETS_KEY when no explicit master key is given', async () => {
    const fromEnv = new EncryptedFileStore({
      filePath,
      env: { CLAUDE_OS_SECRETS_KEY: 'env-derived-key' },
    });
    await fromEnv.set('k', 'v');
    expect(await fromEnv.get('k')).toBe('v');
  });

  it('rejects with SecretsError on malformed envelope on disk', async () => {
    writeFileSync(filePath, '{"not": "a real envelope"}');
    const store = makeStore();
    await expect(store.get('k')).rejects.toThrow();
  });

  it('persists each write as JSON envelope with the expected shape', async () => {
    await makeStore().set('k', 'v');
    const envelope = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(envelope.version).toBe(1);
    expect(envelope.kdf).toMatchObject({ algo: 'pbkdf2-sha256' });
    expect(typeof envelope.ivHex).toBe('string');
    expect(typeof envelope.ciphertextHex).toBe('string');
    expect(typeof envelope.tagHex).toBe('string');
  });

  it('M6: wrong master-key wirft opake error-message (kein Node-GCM-Internal-Leak)', async () => {
    await makeStore().set('key', 'value');
    const wrongKey = new EncryptedFileStore({ filePath, masterKey: 'totally-different-key' });
    try {
      await wrongKey.get('key');
      throw new Error('expected SecretsError');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsError);
      const msg = (err as Error).message;
      // Genau die opake message — KEIN Node-internal-detail wie
      // "Unsupported state or unable to authenticate data".
      expect(msg).toBe('Decryption failed — wrong master key or corrupted file');
      expect(msg).not.toMatch(/Unsupported state/);
      expect(msg).not.toMatch(/unable to authenticate/);
    }
  });

  it('M5: concurrent set() calls serialisieren — alle entries landen ohne torn writes', async () => {
    // Reproducer: vor dem Lock wuerden zwei concurrent `set(k1)` + `set(k2)`
    // beide den gleichen `readEntries`-snapshot lesen und einander
    // ueberschreiben. Mit proper-lockfile serialisiert das.
    const store = makeStore();
    const N = 10;
    await Promise.all(Array.from({ length: N }, (_, i) => store.set(`key-${i}`, `value-${i}`)));
    const items = await store.list();
    expect(items.length).toBe(N);
    const keys = items.map((i) => i.key).sort();
    expect(keys).toEqual(Array.from({ length: N }, (_, i) => `key-${i}`).sort());
    // Verify every value is actually retrievable + correct
    for (let i = 0; i < N; i++) {
      expect(await store.get(`key-${i}`)).toBe(`value-${i}`);
    }
  }, 15_000);

  it('M5: concurrent set() + delete() bleiben konsistent', async () => {
    const store = makeStore();
    // Seed: 5 entries
    for (let i = 0; i < 5; i++) await store.set(`k${i}`, `v${i}`);

    // Race: 5 setters + 5 deleters parallel auf disjoint keys
    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => store.set(`new-${i}`, `nv${i}`)),
      ...Array.from({ length: 5 }, (_, i) => store.delete(`k${i}`)),
    ]);

    const items = await store.list();
    const keys = items.map((i) => i.key).sort();
    expect(keys).toEqual(['new-0', 'new-1', 'new-2', 'new-3', 'new-4']);
  }, // PBKDF2-600k Re-Derive bei jeder Mutation summieren sich auf // Windows-CI: proper-lockfile retries (10 × 25-250ms exponential) +
  // langsamen GitHub-Actions-Runnern auf > 5s default-timeout. 15s ist
  // konservativ; local-Run faellt typically in < 2s ab.
  15_000);
});
