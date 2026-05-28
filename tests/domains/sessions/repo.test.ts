import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_TTL_MS,
  looksLikeSessionId,
  newSessionId,
  SessionRepository,
} from '../../../src/domains/sessions/index.js';

describe('newSessionId', () => {
  it('returns a base64url string of expected length', () => {
    const id = newSessionId();
    expect(looksLikeSessionId(id)).toBe(true);
  });

  it('produces unique values', () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).not.toBe(b);
  });
});

describe('SessionRepository', () => {
  it('issues a session with the expected shape', () => {
    const t = 1_700_000_000_000;
    const repo = new SessionRepository({ now: () => t });
    const s = repo.issue({ userId: 'u-1', userAgent: 'curl/8', ip: '1.2.3.4' });
    expect(s.userId).toBe('u-1');
    expect(s.userAgent).toBe('curl/8');
    expect(s.ip).toBe('1.2.3.4');
    expect(s.createdAt).toBe(t);
    expect(s.lastUsedAt).toBe(t);
    expect(s.expiresAt).toBe(t + DEFAULT_SESSION_TTL_MS);
  });

  it('resolves an issued session and slides the TTL', () => {
    let t = 1_700_000_000_000;
    const repo = new SessionRepository({ now: () => t });
    const s = repo.issue({ userId: 'u-1' });

    t += 10_000;
    const resolved = repo.resolve(s.id);
    expect(resolved).not.toBeNull();
    expect(resolved?.lastUsedAt).toBe(t);
    expect(resolved?.expiresAt).toBe(t + DEFAULT_SESSION_TTL_MS);
  });

  it('returns null for an expired session and evicts it', () => {
    let t = 1_700_000_000_000;
    const ttlMs = 60_000;
    const repo = new SessionRepository({ now: () => t, ttlMs });
    const s = repo.issue({ userId: 'u-1' });

    t += ttlMs + 1;
    expect(repo.resolve(s.id)).toBeNull();
    expect(repo.size()).toBe(0);
  });

  it('returns null for a malformed id', () => {
    const repo = new SessionRepository();
    expect(repo.resolve('not-a-valid-id')).toBeNull();
    expect(repo.resolve('')).toBeNull();
  });

  it('peek() does not slide the TTL', () => {
    let t = 1_700_000_000_000;
    const repo = new SessionRepository({ now: () => t });
    const s = repo.issue({ userId: 'u-1' });

    t += 5_000;
    const peeked = repo.peek(s.id);
    expect(peeked?.expiresAt).toBe(s.expiresAt);
  });

  it('revoke removes a session', () => {
    const repo = new SessionRepository();
    const s = repo.issue({ userId: 'u-1' });
    expect(repo.revoke(s.id)).toBe(true);
    expect(repo.resolve(s.id)).toBeNull();
    expect(repo.revoke(s.id)).toBe(false);
  });

  it('revokeAllForUser removes every session of one user', () => {
    const repo = new SessionRepository();
    const a1 = repo.issue({ userId: 'alice' });
    const a2 = repo.issue({ userId: 'alice' });
    const b1 = repo.issue({ userId: 'bob' });
    expect(repo.revokeAllForUser('alice')).toBe(2);
    expect(repo.resolve(a1.id)).toBeNull();
    expect(repo.resolve(a2.id)).toBeNull();
    expect(repo.resolve(b1.id)).not.toBeNull();
  });

  it('listForUser excludes expired sessions', () => {
    let t = 1_700_000_000_000;
    const ttlMs = 60_000;
    const repo = new SessionRepository({ now: () => t, ttlMs });
    const a = repo.issue({ userId: 'alice' });
    t += ttlMs + 1;
    const a2 = repo.issue({ userId: 'alice' });
    const active = repo.listForUser('alice');
    expect(active.map((s) => s.id)).toEqual([a2.id]);
    expect(active.map((s) => s.id)).not.toContain(a.id);
  });

  it('prune removes all expired sessions', () => {
    let t = 1_700_000_000_000;
    const ttlMs = 60_000;
    const repo = new SessionRepository({ now: () => t, ttlMs });
    repo.issue({ userId: 'u-1' });
    repo.issue({ userId: 'u-2' });
    t += ttlMs + 1;
    repo.issue({ userId: 'u-3' });
    expect(repo.prune()).toBe(2);
    expect(repo.size()).toBe(1);
  });

  it('LRU evicts oldest session when over capacity', () => {
    const repo = new SessionRepository({ capacity: 2 });
    const s1 = repo.issue({ userId: 'u-1' });
    const s2 = repo.issue({ userId: 'u-2' });
    repo.issue({ userId: 'u-3' });
    expect(repo.peek(s1.id)).toBeNull();
    expect(repo.peek(s2.id)).not.toBeNull();
  });
});
