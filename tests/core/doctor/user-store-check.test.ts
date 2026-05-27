import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkUserStore } from '../../../src/core/doctor/checks.js';
import { resolveUsersDbPath, UserRepository } from '../../../src/domains/users/index.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'doctor-user-store-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('checkUserStore', () => {
  it('returns ok with "not in server mode" message when CLAUDE_OS_AUTH_TOKEN is unset', async () => {
    const res = await checkUserStore({ env: {}, dataDirOverride: dataDir });
    expect(res.severity).toBe('ok');
    expect(res.message).toMatch(/not in server mode/);
  });

  it('returns ok with "no users.sqlite" when file is absent (Stage-1 token-only)', async () => {
    const res = await checkUserStore({
      env: { CLAUDE_OS_AUTH_TOKEN: 'some-token' },
      dataDirOverride: dataDir,
    });
    expect(res.severity).toBe('ok');
    expect(res.message).toMatch(/no users\.sqlite/);
  });

  it('returns ok with user-count when users.sqlite is openable', async () => {
    const repo = await UserRepository.open({ dataDir });
    await repo.createUser('alice@example.com', 'correct-horse-battery-staple');
    repo.close();

    const res = await checkUserStore({
      env: { CLAUDE_OS_AUTH_TOKEN: 'some-token' },
      dataDirOverride: dataDir,
    });
    expect(res.severity).toBe('ok');
    expect(res.message).toMatch(/users\.sqlite ok \(1 user\)/);
  });

  it('returns fail when users.sqlite is present but unreadable', async () => {
    writeFileSync(resolveUsersDbPath(dataDir), 'this is not a sqlite file');
    const res = await checkUserStore({
      env: { CLAUDE_OS_AUTH_TOKEN: 'some-token' },
      dataDirOverride: dataDir,
    });
    expect(res.severity).toBe('fail');
    expect(res.message).toMatch(/unreadable/);
    expect(res.hint).toMatch(/users create/);
  });

  it('reports durationMs', async () => {
    const res = await checkUserStore({ env: {}, dataDirOverride: dataDir });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });
});
