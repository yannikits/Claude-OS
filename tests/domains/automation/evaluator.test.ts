import { describe, expect, it } from 'vitest';
import type { Rule, StateChange } from '../../../src/domains/automation/index.js';
import { evaluateRules } from '../../../src/domains/automation/index.js';

const sophosOffline: Rule = {
  id: 'sophos-offline',
  trigger: { bridge: 'sophos', customers: 'all' },
  condition: { statusIn: ['unreachable'] },
  actions: [{ type: 'dashboard-alert', message: 'Sophos down' }],
};

const change = (over: Partial<StateChange> = {}): StateChange => ({
  slug: 'acme',
  bridge: 'sophos',
  from: 'ok',
  to: 'unreachable',
  ...over,
});

describe('evaluateRules', () => {
  it('fires the action when bridge, customer (all) and status match', () => {
    expect(evaluateRules([sophosOffline], [change()])).toEqual([
      {
        ruleId: 'sophos-offline',
        slug: 'acme',
        bridge: 'sophos',
        action: { type: 'dashboard-alert', message: 'Sophos down' },
      },
    ]);
  });

  it('matches a customer allowlist and skips non-listed customers', () => {
    const scoped: Rule = {
      ...sophosOffline,
      trigger: { bridge: 'sophos', customers: ['acme'] },
    };
    expect(evaluateRules([scoped], [change({ slug: 'acme' })])).toHaveLength(1);
    expect(evaluateRules([scoped], [change({ slug: 'beta' })])).toEqual([]);
  });

  it('does not fire when the new status is not in statusIn', () => {
    expect(evaluateRules([sophosOffline], [change({ to: 'ok' })])).toEqual([]);
  });

  it('does not fire when the bridge differs', () => {
    expect(evaluateRules([sophosOffline], [change({ bridge: 'veeam' })])).toEqual([]);
  });

  it('skips disabled rules', () => {
    const disabled: Rule = { ...sophosOffline, enabled: false };
    expect(evaluateRules([disabled], [change()])).toEqual([]);
  });

  it('fires every action of every matching rule', () => {
    const multiAction: Rule = {
      ...sophosOffline,
      actions: [
        { type: 'dashboard-alert', message: 'down' },
        { type: 'audit-log', message: 'sophos-down' },
      ],
    };
    const fired = evaluateRules([multiAction], [change()]);
    expect(fired).toHaveLength(2);
    expect(fired.map((f) => f.action.type)).toEqual(['dashboard-alert', 'audit-log']);
  });
});
