import { describe, expect, it } from 'vitest';
import type { FiredAction } from '../../../src/domains/automation/index.js';
import { createFiredActionLog } from '../../../src/domains/automation/index.js';

const fired = (ruleId: string): FiredAction => ({
  ruleId,
  slug: 'acme',
  bridge: 'sophos',
  action: { type: 'dashboard-alert', message: 'down' },
});

describe('createFiredActionLog', () => {
  it('records a firing and returns it with a firedAt timestamp', () => {
    const log = createFiredActionLog({ now: () => new Date('2026-05-30T10:00:00Z') });
    log.record(fired('r1'));
    const recent = log.recent();
    expect(recent).toHaveLength(1);
    expect(recent[0]?.ruleId).toBe('r1');
    expect(recent[0]?.firedAt).toBe('2026-05-30T10:00:00.000Z');
  });

  it('returns firings newest-first', () => {
    const log = createFiredActionLog();
    log.record(fired('r1'));
    log.record(fired('r2'));
    log.record(fired('r3'));
    expect(log.recent().map((f) => f.ruleId)).toEqual(['r3', 'r2', 'r1']);
  });

  it('caps at the configured capacity, dropping the oldest', () => {
    const log = createFiredActionLog({ capacity: 2 });
    log.record(fired('r1'));
    log.record(fired('r2'));
    log.record(fired('r3'));
    expect(log.recent().map((f) => f.ruleId)).toEqual(['r3', 'r2']);
  });
});
