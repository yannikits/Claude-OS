import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveTenantFromToken,
  resolveTenantFromUser,
  userToTenantId,
} from '../../../src/domains/tenant/index.js';
import { UserRepository } from '../../../src/domains/users/index.js';

let dataDir: string;
let repo: UserRepository;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'user-tenant-'));
  repo = await UserRepository.open({ dataDir });
});

afterEach(() => {
  repo.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('userToTenantId', () => {
  it('is deterministic across calls for the same user', async () => {
    const u = await repo.createUser('alice@example.com', 'correct-horse-battery-staple');
    expect(userToTenantId(u)).toBe(userToTenantId(u));
  });

  it('differs across users (no collision on id)', async () => {
    const a = await repo.createUser('alice@example.com', 'correct-horse-battery-staple');
    const b = await repo.createUser('bob@example.com', 'correct-horse-battery-staple');
    expect(userToTenantId(a)).not.toBe(userToTenantId(b));
  });

  it('honours tenantIdOverride (power-feature)', async () => {
    const u = await repo.createUser('alice@example.com', 'correct-horse-battery-staple', {
      tenantIdOverride: 'shared-family',
    });
    expect(userToTenantId(u)).toBe('shared-family');
  });

  it('falls back to default prefix when tenantIdOverride is null', async () => {
    const u = await repo.createUser('alice@example.com', 'correct-horse-battery-staple');
    expect(userToTenantId(u)).toMatch(/^user-[0-9a-f]{12}$/);
  });

  it('cannot collide with token-derived tenant-ids (different namespace prefix)', async () => {
    const u = await repo.createUser('alice@example.com', 'correct-horse-battery-staple');
    const userTenant = userToTenantId(u);
    const tokenCtx = resolveTenantFromToken('some-bearer-token-32-chars-padding-x');
    expect(userTenant.startsWith('user-')).toBe(true);
    expect(tokenCtx.tokenTenantId?.startsWith('user-')).toBe(false);
  });
});

describe('resolveTenantFromUser', () => {
  it('returns a ServerTenantContext with workspace=personal and the user tenant-id', async () => {
    const u = await repo.createUser('alice@example.com', 'correct-horse-battery-staple');
    const ctx = resolveTenantFromUser(u);
    expect(ctx.workspace).toBe('personal');
    expect(ctx.tenant).toBeNull();
    expect(ctx.tokenTenantId).toBe(userToTenantId(u));
  });
});
