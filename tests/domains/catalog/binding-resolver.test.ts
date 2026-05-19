import { describe, expect, it } from 'vitest';
import {
  type BindingInput,
  resolveBindings,
} from '../../../src/domains/catalog/binding-resolver.js';

const mcpServer: BindingInput = {
  catalogId: 'mcp-foo',
  manifest: {
    id: 'mcp-foo',
    version: '1.0.0',
    provides: ['mcp:foo>=1.0.0'],
  },
};

const skillUserPlugin: BindingInput = {
  catalogId: 'skill-user',
  manifest: {
    id: 'skill-user',
    version: '2.1.0',
    requires: ['mcp:foo>=1.0.0'],
    provides: ['skill:my-skill=2.0.0'],
  },
};

describe('resolveBindings', () => {
  it('resolves capability requirements between sibling plugins', () => {
    const out = resolveBindings([mcpServer, skillUserPlugin]);
    const userResult = out.get('skill-user');
    expect(userResult).toBeDefined();
    expect(userResult?.warning).toBeUndefined();
    expect(userResult?.bindings).toEqual([{ capability: 'mcp:foo>=1.0.0', providedBy: 'mcp-foo' }]);
  });

  it('emits an empty binding set for plugins without any requires', () => {
    const out = resolveBindings([mcpServer]);
    expect(out.get('mcp-foo')?.bindings).toEqual([]);
    expect(out.get('mcp-foo')?.warning).toBeUndefined();
  });

  it('returns a per-entry warning when a require cannot be satisfied', () => {
    const broken: BindingInput = {
      catalogId: 'needs-missing',
      manifest: {
        id: 'needs-missing',
        version: '1.0.0',
        requires: ['mcp:does-not-exist'],
      },
    };
    const out = resolveBindings([mcpServer, broken]);
    const brokenResult = out.get('needs-missing');
    expect(brokenResult?.bindings).toEqual([]);
    expect(brokenResult?.warning).toMatch(/needs-missing/);
    expect(brokenResult?.warning).toMatch(/binding resolution failed/);
    // Other entries still resolve unaffected.
    expect(out.get('mcp-foo')?.warning).toBeUndefined();
  });

  it('keeps bindings sorted deterministically (capability asc, providedBy asc)', () => {
    const multi: BindingInput = {
      catalogId: 'multi-req',
      manifest: {
        id: 'multi-req',
        version: '0.1.0',
        requires: ['mcp:foo>=1.0.0', 'skill:my-skill=2.0.0'],
      },
    };
    const out = resolveBindings([mcpServer, skillUserPlugin, multi]);
    const bindings = out.get('multi-req')?.bindings ?? [];
    const caps = bindings.map((b) => b.capability);
    expect(caps).toEqual([...caps].sort());
  });

  it('produces resolver errors when a version constraint is unsatisfiable', () => {
    const wantNewer: BindingInput = {
      catalogId: 'want-newer',
      manifest: {
        id: 'want-newer',
        version: '0.5.0',
        requires: ['mcp:foo>=2.0.0'],
      },
    };
    const out = resolveBindings([mcpServer, wantNewer]);
    const r = out.get('want-newer');
    expect(r?.bindings).toEqual([]);
    expect(r?.warning).toMatch(/want-newer/);
  });

  it('returns an empty map when called with zero inputs', () => {
    const out = resolveBindings([]);
    expect(out.size).toBe(0);
  });
});
