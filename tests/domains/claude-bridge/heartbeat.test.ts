import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startHeartbeat } from '../../../src/domains/claude-bridge/index.js';

describe('startHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires tick at the configured interval', () => {
    const tick = vi.fn();
    const hb = startHeartbeat(100, tick);
    vi.advanceTimersByTime(350);
    expect(tick).toHaveBeenCalledTimes(3);
    hb.stop();
  });

  it('passes elapsedMs based on real start time', () => {
    const tick = vi.fn();
    const hb = startHeartbeat(100, tick);
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenCalledTimes(2);
    const firstArg = tick.mock.calls[0]?.[0];
    const secondArg = tick.mock.calls[1]?.[0];
    expect(firstArg).toBeGreaterThanOrEqual(100);
    expect(secondArg).toBeGreaterThanOrEqual(200);
    hb.stop();
  });

  it('stops emitting after .stop()', () => {
    const tick = vi.fn();
    const hb = startHeartbeat(50, tick);
    vi.advanceTimersByTime(100);
    const callsBeforeStop = tick.mock.calls.length;
    hb.stop();
    vi.advanceTimersByTime(500);
    expect(tick).toHaveBeenCalledTimes(callsBeforeStop);
  });

  it('returns a no-op heartbeat when intervalMs <= 0', () => {
    const tick = vi.fn();
    const hb = startHeartbeat(0, tick);
    vi.advanceTimersByTime(1000);
    expect(tick).not.toHaveBeenCalled();
    expect(() => hb.stop()).not.toThrow();
  });

  it('is idempotent on multiple stop() calls', () => {
    const tick = vi.fn();
    const hb = startHeartbeat(50, tick);
    hb.stop();
    expect(() => hb.stop()).not.toThrow();
  });
});
