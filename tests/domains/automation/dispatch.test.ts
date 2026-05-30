import { describe, expect, it, vi } from 'vitest';
import type { FiredAction } from '../../../src/domains/automation/index.js';
import { dispatchFiredAction } from '../../../src/domains/automation/index.js';

const fired = (type: string): FiredAction => ({
  ruleId: 'r1',
  slug: 'acme',
  bridge: 'sophos',
  action: { type, message: 'm' } as FiredAction['action'],
});

describe('dispatchFiredAction', () => {
  it('routes dashboard-alert to the alert sink', () => {
    const sink = { alert: vi.fn(), audit: vi.fn() };
    dispatchFiredAction(fired('dashboard-alert'), sink);
    expect(sink.alert).toHaveBeenCalledTimes(1);
    expect(sink.audit).not.toHaveBeenCalled();
  });

  it('routes notify to the alert sink', () => {
    const sink = { alert: vi.fn(), audit: vi.fn() };
    dispatchFiredAction(fired('notify'), sink);
    expect(sink.alert).toHaveBeenCalledTimes(1);
    expect(sink.audit).not.toHaveBeenCalled();
  });

  it('routes audit-log to the audit sink', () => {
    const sink = { alert: vi.fn(), audit: vi.fn() };
    dispatchFiredAction(fired('audit-log'), sink);
    expect(sink.audit).toHaveBeenCalledTimes(1);
    expect(sink.alert).not.toHaveBeenCalled();
  });
});
