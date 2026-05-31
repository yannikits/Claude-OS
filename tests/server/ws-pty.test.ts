/**
 * MC-C: spawn-gate unit tests. Exercises the pure `resolveSpawnDecision`
 * directly (the WS handler is a thin wrapper around it) so we don't need a
 * live WebSocket to prove the chat/code role split.
 */
import { describe, expect, it } from 'vitest';
import { resolveSpawnDecision } from '../../src/server/ws-pty.js';

const NO_ADMINS = new Set<string>();

describe('resolveSpawnDecision — chat mode', () => {
  it('always allows and forces --tools "" for any authed user', () => {
    const d = resolveSpawnDecision('chat', { email: 'v@x', role: 'viewer' }, NO_ADMINS, []);
    expect(d).toEqual({ ok: true, args: ['--tools', ''] });
  });

  it('allows in bearer-token mode (no user)', () => {
    const d = resolveSpawnDecision('chat', null, NO_ADMINS, []);
    expect(d).toEqual({ ok: true, args: ['--tools', ''] });
  });

  it('ignores client args (cannot re-enable tools via a crafted frame)', () => {
    const d = resolveSpawnDecision('chat', { email: 'v@x', role: 'viewer' }, NO_ADMINS, [
      '--tools',
      'default',
      '--dangerously-skip-permissions',
    ]);
    expect(d).toEqual({ ok: true, args: ['--tools', ''] });
  });
});

describe('resolveSpawnDecision — code mode', () => {
  it('denies a viewer', () => {
    const d = resolveSpawnDecision('code', { email: 'v@x', role: 'viewer' }, NO_ADMINS, []);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe('forbidden');
  });

  it('allows an operator and passes client args through', () => {
    const d = resolveSpawnDecision('code', { email: 'o@x', role: 'operator' }, NO_ADMINS, [
      '--help',
    ]);
    expect(d).toEqual({ ok: true, args: ['--help'] });
  });

  it('allows an admin', () => {
    const d = resolveSpawnDecision('code', { email: 'a@x', role: 'admin' }, NO_ADMINS, []);
    expect(d).toEqual({ ok: true, args: [] });
  });

  it('allows a viewer whose email is in the admin allowlist (effectiveRole=admin)', () => {
    const admins = new Set(['boss@x']);
    const d = resolveSpawnDecision('code', { email: 'boss@x', role: 'viewer' }, admins, []);
    expect(d.ok).toBe(true);
  });

  it('allows bearer-token mode (no user = trusted owner)', () => {
    const d = resolveSpawnDecision('code', null, NO_ADMINS, ['--help']);
    expect(d).toEqual({ ok: true, args: ['--help'] });
  });
});
