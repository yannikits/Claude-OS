import { describe, expect, it } from 'vitest';
import { effectiveRole, requireRole, roleAtLeast } from '../../src/server/rbac.js';

const ADMINS = new Set(['boss@example.com']);

function fakeReply() {
  const calls: { code: number; body: unknown }[] = [];
  return {
    calls,
    code(n: number) {
      return {
        send(body: unknown) {
          calls.push({ code: n, body });
        },
      };
    },
  };
}

describe('effectiveRole', () => {
  it('returns the DB role for a non-allowlisted user', () => {
    expect(effectiveRole({ email: 'a@x.com', role: 'operator' }, ADMINS)).toBe('operator');
    expect(effectiveRole({ email: 'a@x.com', role: 'viewer' }, ADMINS)).toBe('viewer');
  });

  it('forces admin for an allowlisted email regardless of DB role (anti-lockout)', () => {
    expect(effectiveRole({ email: 'boss@example.com', role: 'viewer' }, ADMINS)).toBe('admin');
    expect(effectiveRole({ email: 'BOSS@example.com', role: 'viewer' }, ADMINS)).toBe('admin');
  });
});

describe('roleAtLeast', () => {
  it('orders viewer < operator < admin', () => {
    expect(roleAtLeast('admin', 'operator')).toBe(true);
    expect(roleAtLeast('operator', 'operator')).toBe(true);
    expect(roleAtLeast('viewer', 'operator')).toBe(false);
    expect(roleAtLeast('viewer', 'viewer')).toBe(true);
  });
});

describe('requireRole', () => {
  it('401 when no user', () => {
    const reply = fakeReply();
    expect(requireRole('viewer', ADMINS, {}, reply)).toBeNull();
    expect(reply.calls[0]?.code).toBe(401);
  });

  it('403 when DB role is below the required role', () => {
    const reply = fakeReply();
    expect(
      requireRole('operator', ADMINS, { user: { email: 'a@x.com', role: 'viewer' } }, reply),
    ).toBeNull();
    expect(reply.calls[0]?.code).toBe(403);
  });

  it('allows when role meets the requirement', () => {
    const reply = fakeReply();
    expect(
      requireRole('operator', ADMINS, { user: { email: 'a@x.com', role: 'operator' } }, reply),
    ).toBe('a@x.com');
    expect(reply.calls).toHaveLength(0);
  });

  it('allows an allowlisted admin even when the DB role is viewer', () => {
    const reply = fakeReply();
    expect(
      requireRole('admin', ADMINS, { user: { email: 'boss@example.com', role: 'viewer' } }, reply),
    ).toBe('boss@example.com');
    expect(reply.calls).toHaveLength(0);
  });
});
