import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRules } from '../../../src/domains/automation/index.js';

let dir: string;

const VALID_RULE = `id: sophos-offline-alert
trigger:
  bridge: sophos
  customers: all
condition:
  statusIn:
    - unreachable
actions:
  - type: dashboard-alert
    message: Sophos nicht erreichbar
`;

function writeRule(name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rule-loader-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadRules', () => {
  it('returns an empty result for a missing directory (no throw)', () => {
    const result = loadRules(join(dir, 'does-not-exist'));
    expect(result.rules).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('loads a single valid rule file', () => {
    writeRule('sophos.yaml', VALID_RULE);
    const result = loadRules(dir);
    expect(result.errors).toEqual([]);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]?.id).toBe('sophos-offline-alert');
  });

  it('loads multiple valid rule files', () => {
    writeRule('sophos.yaml', VALID_RULE);
    writeRule(
      'veeam.yaml',
      VALID_RULE.replace('sophos-offline-alert', 'veeam-alert').replace(
        'bridge: sophos',
        'bridge: veeam',
      ),
    );
    const result = loadRules(dir);
    expect(result.errors).toEqual([]);
    expect(result.rules.map((r) => r.id).sort()).toEqual(['sophos-offline-alert', 'veeam-alert']);
  });

  it('records an issue for malformed YAML but still loads valid files', () => {
    writeRule('sophos.yaml', VALID_RULE);
    writeRule('broken.yaml', 'id: [unterminated, flow');
    const result = loadRules(dir);
    expect(result.rules).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.file).toBe('broken.yaml');
  });

  it('records an issue for a schema-invalid rule but still loads valid files', () => {
    writeRule('sophos.yaml', VALID_RULE);
    writeRule(
      'bad-bridge.yaml',
      VALID_RULE.replace('bridge: sophos', 'bridge: fortinet').replace(
        'sophos-offline-alert',
        'bad-bridge',
      ),
    );
    const result = loadRules(dir);
    expect(result.rules.map((r) => r.id)).toEqual(['sophos-offline-alert']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.file).toBe('bad-bridge.yaml');
  });

  it('records an issue for a duplicate rule id and keeps the first', () => {
    writeRule('a.yaml', VALID_RULE);
    writeRule('b.yaml', VALID_RULE);
    const result = loadRules(dir);
    expect(result.rules).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/duplicate/i);
  });
});
