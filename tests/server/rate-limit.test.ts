import { describe, expect, it } from 'vitest';
import { LoginRateLimiter } from '../../src/server/rate-limit.js';

describe('LoginRateLimiter', () => {
  it('allows the first capacity attempts without blocking', () => {
    const rl = new LoginRateLimiter({ capacity: 5 });
    for (let i = 0; i < 5; i++) {
      expect(rl.check('1.2.3.4').allowed).toBe(true);
    }
  });

  it('blocks after capacity failed attempts', () => {
    const rl = new LoginRateLimiter({ capacity: 3, now: () => 1_000_000 });
    for (let i = 0; i < 3; i++) {
      rl.recordFailed('1.2.3.4');
    }
    const decision = rl.check('1.2.3.4');
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSec).toBeGreaterThan(0);
  });

  it('isolates buckets per IP', () => {
    const rl = new LoginRateLimiter({ capacity: 2 });
    rl.recordFailed('1.2.3.4');
    rl.recordFailed('1.2.3.4');
    expect(rl.check('1.2.3.4').allowed).toBe(false);
    expect(rl.check('5.6.7.8').allowed).toBe(true);
  });

  it('successful login wipes failure history', () => {
    const rl = new LoginRateLimiter({ capacity: 2 });
    rl.recordFailed('1.2.3.4');
    rl.recordFailed('1.2.3.4');
    expect(rl.check('1.2.3.4').allowed).toBe(false);
    rl.recordSuccess('1.2.3.4');
    expect(rl.check('1.2.3.4').allowed).toBe(true);
  });

  it('refills capacity after refillIntervalMs', () => {
    let t = 0;
    const rl = new LoginRateLimiter({
      capacity: 3,
      refillIntervalMs: 60_000,
      now: () => t,
    });
    for (let i = 0; i < 3; i++) rl.recordFailed('1.2.3.4');
    expect(rl.check('1.2.3.4').allowed).toBe(false);

    t = 60_001;
    expect(rl.check('1.2.3.4').allowed).toBe(true);
    expect(rl.remaining('1.2.3.4')).toBe(3);
  });

  it('retryAfterSec is non-negative and ceil-rounded', () => {
    let t = 0;
    const rl = new LoginRateLimiter({
      capacity: 1,
      refillIntervalMs: 60_000,
      now: () => t,
    });
    rl.recordFailed('1.2.3.4');
    t = 30_000;
    const decision = rl.check('1.2.3.4');
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSec).toBe(30);
  });

  it('evicts oldest IP when maxTrackedIps exceeded', () => {
    const rl = new LoginRateLimiter({ capacity: 5, maxTrackedIps: 2 });
    rl.recordFailed('a');
    rl.recordFailed('b');
    expect(rl.size()).toBe(2);
    rl.recordFailed('c');
    expect(rl.size()).toBe(2);
    // 'a' should have been evicted — its bucket is now reset.
    expect(rl.remaining('a')).toBe(5);
  });

  it('reset clears all buckets', () => {
    const rl = new LoginRateLimiter();
    rl.recordFailed('1.2.3.4');
    rl.reset();
    expect(rl.size()).toBe(0);
  });
});
