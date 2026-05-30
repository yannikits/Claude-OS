import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import { formatErrors } from '../../../src/core/validation/index.js';
import { RuleSchema } from '../../../src/domains/automation/index.js';

const minimalRule = {
  id: 'sophos-offline-alert',
  trigger: { bridge: 'sophos', customers: 'all' },
  condition: { statusIn: ['unreachable'] },
  actions: [{ type: 'dashboard-alert', message: 'Sophos nicht erreichbar' }],
};

describe('RuleSchema — valid inputs', () => {
  it('accepts a minimal valid rule', () => {
    expect(formatErrors(RuleSchema, minimalRule)).toEqual([]);
    expect(Value.Check(RuleSchema, minimalRule)).toBe(true);
  });

  it('accepts a full rule with optional fields and customer list', () => {
    const fullRule = {
      id: 'veeam-failed-comment',
      description: 'Veeam-Backup fehlgeschlagen — Hinweis ins Dashboard',
      enabled: true,
      armed: false,
      trigger: { bridge: 'veeam', customers: ['acme-gmbh', 'beta-ag'] },
      condition: { statusIn: ['auth-failed', 'unreachable', 'timeout'] },
      actions: [
        { type: 'dashboard-alert', message: 'Backup-Status kritisch' },
        { type: 'audit-log', message: 'veeam-degraded' },
      ],
    };
    expect(formatErrors(RuleSchema, fullRule)).toEqual([]);
  });
});

describe('RuleSchema — invalid inputs', () => {
  it('rejects an unknown bridge kind', () => {
    const rule = { ...minimalRule, trigger: { bridge: 'fortinet', customers: 'all' } };
    expect(Value.Check(RuleSchema, rule)).toBe(false);
  });

  it('rejects an empty actions array', () => {
    const rule = { ...minimalRule, actions: [] };
    expect(Value.Check(RuleSchema, rule)).toBe(false);
  });

  it('rejects an unknown action type', () => {
    const rule = {
      ...minimalRule,
      actions: [{ type: 'delete-everything', message: 'boom' }],
    };
    expect(Value.Check(RuleSchema, rule)).toBe(false);
  });

  it('rejects an unknown status value in statusIn', () => {
    const rule = { ...minimalRule, condition: { statusIn: ['exploded'] } };
    expect(Value.Check(RuleSchema, rule)).toBe(false);
  });

  it('rejects unknown top-level properties', () => {
    const rule = { ...minimalRule, surpriseField: 42 };
    expect(Value.Check(RuleSchema, rule)).toBe(false);
  });

  it('rejects an id with uppercase or whitespace', () => {
    const rule = { ...minimalRule, id: 'Sophos Alert' };
    expect(Value.Check(RuleSchema, rule)).toBe(false);
  });
});
