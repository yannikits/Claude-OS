import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DuplicateEmailError,
  resolveUsersDbPath,
  UserNotFoundError,
  UserRepository,
  WeakPasswordError,
} from '../../../src/domains/users/index.js';

const STRONG = 'correct-horse-battery-staple';
const STRONG2 = 'new-secret-passphrase-2026';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'users-repo-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('UserRepository.open', () => {
  it('creates a fresh DB and stamps schema_version', async () => {
    const repo = await UserRepository.open({ dataDir });
    expect(repo.countAll()).toBe(0);
    expect(statSync(resolveUsersDbPath(dataDir)).isFile()).toBe(true);
    repo.close();
  });

  it('re-opens an existing DB without losing data', async () => {
    const first = await UserRepository.open({ dataDir });
    const created = await first.createUser('alice@example.com', STRONG);
    first.close();

    const second = await UserRepository.open({ dataDir });
    expect(second.countAll()).toBe(1);
    const found = second.findById(created.id);
    expect(found?.email).toBe('alice@example.com');
    second.close();
  });
});

describe('createUser', () => {
  it('persists a user with normalized email', async () => {
    const repo = await UserRepository.open({ dataDir });
    const user = await repo.createUser('Alice@Example.COM ', STRONG);
    expect(user.email).toBe('alice@example.com');
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user.createdAt).toBeGreaterThan(0);
    expect(user.lastLoginAt).toBeNull();
    expect(user.disabled).toBe(false);
    expect(user.tenantIdOverride).toBeNull();
    expect(user.passwordHash.startsWith('scrypt$')).toBe(true);
    repo.close();
  });

  it('refuses a duplicate email (case-insensitive)', async () => {
    const repo = await UserRepository.open({ dataDir });
    await repo.createUser('alice@example.com', STRONG);
    await expect(repo.createUser('ALICE@example.com', STRONG)).rejects.toBeInstanceOf(
      DuplicateEmailError,
    );
    expect(repo.countAll()).toBe(1);
    repo.close();
  });

  it('rejects an invalid email format', async () => {
    const repo = await UserRepository.open({ dataDir });
    await expect(repo.createUser('not-an-email', STRONG)).rejects.toThrow(/Invalid email/);
    await expect(repo.createUser('a@b', STRONG)).rejects.toThrow(/Invalid email/);
    await expect(repo.createUser('@example.com', STRONG)).rejects.toThrow(/Invalid email/);
    repo.close();
  });

  it('rejects a weak password', async () => {
    const repo = await UserRepository.open({ dataDir });
    await expect(repo.createUser('alice@example.com', 'short')).rejects.toBeInstanceOf(
      WeakPasswordError,
    );
    expect(repo.countAll()).toBe(0);
    repo.close();
  });

  it('persists tenantIdOverride when provided', async () => {
    const repo = await UserRepository.open({ dataDir });
    const user = await repo.createUser('alice@example.com', STRONG, {
      tenantIdOverride: 'shared-fam',
    });
    expect(user.tenantIdOverride).toBe('shared-fam');
    repo.close();

    const reopened = await UserRepository.open({ dataDir });
    expect(reopened.findById(user.id)?.tenantIdOverride).toBe('shared-fam');
    reopened.close();
  });
});

describe('findByEmail', () => {
  it('finds an existing user case-insensitively', async () => {
    const repo = await UserRepository.open({ dataDir });
    const created = await repo.createUser('alice@example.com', STRONG);
    expect(repo.findByEmail('Alice@Example.COM')?.id).toBe(created.id);
    repo.close();
  });

  it('returns null for an unknown email', async () => {
    const repo = await UserRepository.open({ dataDir });
    expect(repo.findByEmail('nobody@example.com')).toBeNull();
    repo.close();
  });

  it('returns null for a malformed email (does not throw)', async () => {
    const repo = await UserRepository.open({ dataDir });
    expect(repo.findByEmail('not-an-email')).toBeNull();
    repo.close();
  });
});

describe('verifyPassword', () => {
  it('returns the user on a correct password', async () => {
    const repo = await UserRepository.open({ dataDir });
    const created = await repo.createUser('alice@example.com', STRONG);
    const got = await repo.verifyPassword('alice@example.com', STRONG);
    expect(got?.id).toBe(created.id);
    repo.close();
  });

  it('returns null on a wrong password', async () => {
    const repo = await UserRepository.open({ dataDir });
    await repo.createUser('alice@example.com', STRONG);
    expect(await repo.verifyPassword('alice@example.com', 'wrong-password-here')).toBeNull();
    repo.close();
  });

  it('returns null for an unknown user (without throwing)', async () => {
    const repo = await UserRepository.open({ dataDir });
    expect(await repo.verifyPassword('nobody@example.com', STRONG)).toBeNull();
    repo.close();
  });

  it('returns null when the email is malformed', async () => {
    const repo = await UserRepository.open({ dataDir });
    expect(await repo.verifyPassword('not-an-email', STRONG)).toBeNull();
    repo.close();
  });

  it('returns null for a disabled user (even with correct password)', async () => {
    const repo = await UserRepository.open({ dataDir });
    const created = await repo.createUser('alice@example.com', STRONG);
    repo.disable(created.id);
    expect(await repo.verifyPassword('alice@example.com', STRONG)).toBeNull();
    repo.close();
  });
});

describe('setPassword', () => {
  it('updates the hash so the old password no longer verifies', async () => {
    const repo = await UserRepository.open({ dataDir });
    const created = await repo.createUser('alice@example.com', STRONG);
    await repo.setPassword(created.id, STRONG2);

    expect(await repo.verifyPassword('alice@example.com', STRONG)).toBeNull();
    expect((await repo.verifyPassword('alice@example.com', STRONG2))?.id).toBe(created.id);
    repo.close();
  });

  it('accepts email instead of id', async () => {
    const repo = await UserRepository.open({ dataDir });
    await repo.createUser('alice@example.com', STRONG);
    await repo.setPassword('alice@example.com', STRONG2);
    expect((await repo.verifyPassword('alice@example.com', STRONG2)) !== null).toBe(true);
    repo.close();
  });

  it('throws UserNotFoundError for unknown id/email', async () => {
    const repo = await UserRepository.open({ dataDir });
    await expect(repo.setPassword('does-not-exist', STRONG2)).rejects.toBeInstanceOf(
      UserNotFoundError,
    );
    repo.close();
  });

  it('rejects a weak new password', async () => {
    const repo = await UserRepository.open({ dataDir });
    const created = await repo.createUser('alice@example.com', STRONG);
    await expect(repo.setPassword(created.id, 'short')).rejects.toBeInstanceOf(WeakPasswordError);
    expect((await repo.verifyPassword('alice@example.com', STRONG))?.id).toBe(created.id);
    repo.close();
  });
});

describe('disable + enable', () => {
  it('disables and re-enables a user', async () => {
    const repo = await UserRepository.open({ dataDir });
    const created = await repo.createUser('alice@example.com', STRONG);

    expect(repo.disable(created.id)).toBe(true);
    expect(repo.findById(created.id)?.disabled).toBe(true);
    expect(repo.disable(created.id)).toBe(false); // already disabled

    expect(repo.enable(created.id)).toBe(true);
    expect(repo.findById(created.id)?.disabled).toBe(false);
    expect(repo.enable(created.id)).toBe(false); // already enabled
    repo.close();
  });

  it('returns false when target does not exist', async () => {
    const repo = await UserRepository.open({ dataDir });
    expect(repo.disable('does-not-exist')).toBe(false);
    expect(repo.enable('does-not-exist')).toBe(false);
    repo.close();
  });

  it('accepts email instead of id', async () => {
    const repo = await UserRepository.open({ dataDir });
    await repo.createUser('alice@example.com', STRONG);
    expect(repo.disable('alice@example.com')).toBe(true);
    expect(repo.enable('Alice@Example.COM')).toBe(true);
    repo.close();
  });
});

describe('list', () => {
  it('excludes disabled users by default; includes them on opt-in', async () => {
    const repo = await UserRepository.open({ dataDir });
    const alice = await repo.createUser('alice@example.com', STRONG);
    const bob = await repo.createUser('bob@example.com', STRONG);
    repo.disable(bob.id);

    const onlyActive = repo.list();
    expect(onlyActive.map((u) => u.id)).toEqual([alice.id]);

    const all = repo.list({ includeDisabled: true });
    expect(all.map((u) => u.id).sort()).toEqual([alice.id, bob.id].sort());
    repo.close();
  });

  it('returns empty array on a fresh DB', async () => {
    const repo = await UserRepository.open({ dataDir });
    expect(repo.list()).toEqual([]);
    expect(repo.list({ includeDisabled: true })).toEqual([]);
    repo.close();
  });
});

describe('recordLogin', () => {
  it('updates lastLoginAt and returns true', async () => {
    const repo = await UserRepository.open({ dataDir });
    const created = await repo.createUser('alice@example.com', STRONG);
    const stamp = 1_700_000_000_000;
    expect(repo.recordLogin(created.id, stamp)).toBe(true);
    expect(repo.findById(created.id)?.lastLoginAt).toBe(stamp);
    repo.close();
  });

  it('returns false for unknown id', async () => {
    const repo = await UserRepository.open({ dataDir });
    expect(repo.recordLogin('does-not-exist')).toBe(false);
    repo.close();
  });
});

describe('persistence + permissions', () => {
  it('survives close + reopen with all fields intact', async () => {
    const first = await UserRepository.open({ dataDir });
    const created = await first.createUser('alice@example.com', STRONG, {
      tenantIdOverride: 'shared',
    });
    first.recordLogin(created.id, 1_700_000_000_000);
    first.close();

    const second = await UserRepository.open({ dataDir });
    const found = second.findById(created.id);
    expect(found).not.toBeNull();
    expect(found?.email).toBe('alice@example.com');
    expect(found?.tenantIdOverride).toBe('shared');
    expect(found?.lastLoginAt).toBe(1_700_000_000_000);
    expect(found?.disabled).toBe(false);
    second.close();
  });

  it.skipIf(process.platform === 'win32')(
    'writes the sqlite file with mode 0o600 on POSIX',
    async () => {
      const repo = await UserRepository.open({ dataDir });
      await repo.createUser('alice@example.com', STRONG);
      const mode = statSync(resolveUsersDbPath(dataDir)).mode & 0o777;
      expect(mode).toBe(0o600);
      repo.close();
    },
  );

  it('refuses operations after close', async () => {
    const repo = await UserRepository.open({ dataDir });
    repo.close();
    expect(() => repo.findById('x')).toThrow(/closed/);
    expect(() => repo.list()).toThrow(/closed/);
    await expect(repo.createUser('alice@example.com', STRONG)).rejects.toThrow(/closed/);
  });
});
