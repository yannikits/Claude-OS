import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EncryptedFileStore } from '../../src/domains/secrets/encrypted-file-store.js';
import { registerMethods } from '../../src/sidecar/methods.js';
import { RpcDispatcher } from '../../src/sidecar/rpc.js';

describe('secrets.list + secrets.delete RPC', () => {
  let tmpRoot: string;
  let tmpData: string;
  let testEnv: NodeJS.ProcessEnv;
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'claude-os-secrets-root-'));
    tmpData = mkdtempSync(join(tmpdir(), 'claude-os-secrets-data-'));
    mkdirSync(join(tmpData, 'data'), { recursive: true });
    writeFileSync(join(tmpRoot, '.claude-os-root'), '');
    envBackup = { ...process.env };
    process.env.CLAUDE_OS_ROOT = tmpRoot;
    process.env.CLAUDE_OS_DATA_DIR = tmpData;
    testEnv = {
      CLAUDE_OS_SECRETS_BACKEND: 'encrypted-file',
      CLAUDE_OS_DATA_DIR: tmpData,
      CLAUDE_OS_SECRETS_KEY: 'a'.repeat(64),
    };
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
    process.env = envBackup;
  });

  async function call(method: string, params: unknown = null) {
    const d = new RpcDispatcher();
    registerMethods(d, { env: testEnv });
    const env = await d.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    return env as { result?: unknown; error?: { message: string } };
  }

  async function seedStore(entries: Record<string, string>) {
    // createSecretStore() puts the file at <dataRoot>/secrets.enc, where
    // dataRoot is the CLAUDE_OS_DATA_DIR override directly (no '/data' suffix).
    const store = new EncryptedFileStore({
      filePath: join(tmpData, 'secrets.enc'),
      env: testEnv,
    });
    for (const [k, v] of Object.entries(entries)) await store.set(k, v);
  }

  it('returns empty list when no secrets are stored', async () => {
    const r = await call('secrets.list');
    expect(r.result).toEqual({
      backend: 'encrypted-file',
      count: 0,
      entries: [],
      locked: false,
    });
  });

  it('returns locked=true when secrets file exists but master key is missing', async () => {
    await seedStore({ whatever: 'value' });
    delete testEnv.CLAUDE_OS_SECRETS_KEY;
    const r = (await call('secrets.list')) as {
      result: { locked: boolean; entries: unknown[]; lockedReason?: string };
    };
    expect(r.result.locked).toBe(true);
    expect(r.result.entries).toEqual([]);
    expect(r.result.lockedReason).toMatch(/master key/i);
  });

  it('returns key + backend for each stored secret without exposing values', async () => {
    await seedStore({ 'anthropic-api-key': 'sk-secret', 'github-token': 'ghp-secret' });
    const r = (await call('secrets.list')) as {
      result: { count: number; entries: { key: string; backend: string }[] };
    };
    expect(r.result.count).toBe(2);
    const keys = r.result.entries.map((e) => e.key).sort();
    expect(keys).toEqual(['anthropic-api-key', 'github-token']);
    for (const entry of r.result.entries) {
      expect(entry.backend).toBe('encrypted-file');
      expect(JSON.stringify(entry)).not.toContain('sk-secret');
      expect(JSON.stringify(entry)).not.toContain('ghp-secret');
    }
  });

  it('deletes an existing secret and reports deleted=true', async () => {
    await seedStore({ 'doomed-key': 'value' });
    const r = (await call('secrets.delete', { key: 'doomed-key' })) as {
      result: { deleted: boolean; key: string; backend: string };
    };
    expect(r.result).toEqual({
      key: 'doomed-key',
      deleted: true,
      backend: 'encrypted-file',
    });

    const after = (await call('secrets.list')) as { result: { count: number } };
    expect(after.result.count).toBe(0);
  });

  it('returns deleted=false when the key does not exist', async () => {
    const r = (await call('secrets.delete', { key: 'never-existed' })) as {
      result: { deleted: boolean };
    };
    expect(r.result.deleted).toBe(false);
  });

  it('rejects empty or missing key param', async () => {
    const r1 = await call('secrets.delete', { key: '' });
    expect(r1.error?.message).toMatch(/non-empty string/);
    const r2 = await call('secrets.delete', {});
    expect(r2.error?.message).toMatch(/non-empty string/);
  });
});
