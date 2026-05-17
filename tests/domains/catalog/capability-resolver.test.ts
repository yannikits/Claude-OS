import { describe, expect, it } from 'vitest';
import {
  AmbiguousProviderError,
  type Catalog,
  CyclicDependencyError,
  MissingProviderError,
  type PluginManifest,
  resolveCapabilities,
  VersionConflictError,
} from '../../../src/domains/catalog/index.js';

function mfst(
  id: string,
  version: string,
  opts: { requires?: string[]; provides?: string[] } = {},
): PluginManifest {
  return {
    id,
    version,
    ...(opts.requires === undefined ? {} : { requires: opts.requires }),
    ...(opts.provides === undefined ? {} : { provides: opts.provides }),
  };
}

describe('resolveCapabilities', () => {
  it('returns target-only install order when target has no requires', () => {
    const target = mfst('solo', '1.0.0');
    const r = resolveCapabilities(target, { plugins: [] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.installOrder.map((m) => m.id)).toEqual(['solo']);
      expect(r.result.bindings).toEqual([]);
    }
  });

  it('resolves a single capability against a provider', () => {
    const fs = mfst('fs', '1.0.0', { provides: ['mcp:filesystem'] });
    const target = mfst('git-workflow', '1.2.3', { requires: ['mcp:filesystem'] });
    const catalog: Catalog = { plugins: [fs] };
    const r = resolveCapabilities(target, catalog);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.installOrder.map((m) => m.id)).toEqual(['fs', 'git-workflow']);
      expect(r.result.bindings[0]?.capability).toBe('mcp:filesystem');
      expect(r.result.bindings[0]?.providedBy.id).toBe('fs');
    }
  });

  it('honours version constraint with >=', () => {
    const gh1 = mfst('github', '1.0.0', { provides: ['mcp:github'] });
    const gh2 = mfst('github', '2.5.0', { provides: ['mcp:github'] });
    const target = mfst('plugin', '1.0', { requires: ['mcp:github>=2.0'] });
    const r = resolveCapabilities(target, { plugins: [gh1, gh2] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const binding = r.result.bindings.find((b) => b.capability === 'mcp:github>=2.0');
      expect(binding?.providedBy.version).toBe('2.5.0');
    }
  });

  it('returns VersionConflictError when no compatible version found', () => {
    const gh = mfst('github', '1.0.0', { provides: ['mcp:github'] });
    const target = mfst('plugin', '1.0', { requires: ['mcp:github>=2.0'] });
    const r = resolveCapabilities(target, { plugins: [gh] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(VersionConflictError);
  });

  it('returns MissingProviderError when no provider exists', () => {
    const target = mfst('plugin', '1.0', { requires: ['mcp:never-existed'] });
    const r = resolveCapabilities(target, { plugins: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(MissingProviderError);
  });

  it('returns AmbiguousProviderError when two distinct plugins claim the same capability', () => {
    const a = mfst('plugin-a', '1.0.0', { provides: ['mcp:shared'] });
    const b = mfst('plugin-b', '1.0.0', { provides: ['mcp:shared'] });
    const target = mfst('client', '1.0', { requires: ['mcp:shared'] });
    const r = resolveCapabilities(target, { plugins: [a, b] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(AmbiguousProviderError);
  });

  it('detects cyclic dependency', () => {
    const a = mfst('a', '1.0', { requires: ['mcp:b'], provides: ['mcp:a'] });
    const b = mfst('b', '1.0', { requires: ['mcp:a'], provides: ['mcp:b'] });
    const r = resolveCapabilities(a, { plugins: [a, b] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(CyclicDependencyError);
  });

  it('produces a topological install order through a transitive chain', () => {
    const base = mfst('base', '1.0', { provides: ['mcp:base'] });
    const mid = mfst('mid', '1.0', { requires: ['mcp:base'], provides: ['skill:mid'] });
    const target = mfst('top', '1.0', { requires: ['skill:mid'] });
    const r = resolveCapabilities(target, { plugins: [base, mid] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.installOrder.map((m) => m.id)).toEqual(['base', 'mid', 'top']);
    }
  });

  it('is deterministic — repeated runs return identical output', () => {
    const a = mfst('a', '1.0', { provides: ['mcp:x'] });
    const b = mfst('b', '2.0', { provides: ['mcp:y'] });
    const target = mfst('t', '1.0', { requires: ['mcp:x', 'mcp:y'] });
    const r1 = resolveCapabilities(target, { plugins: [a, b] });
    const r2 = resolveCapabilities(target, { plugins: [b, a] });
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.result.installOrder.map((m) => m.id)).toEqual(
        r2.result.installOrder.map((m) => m.id),
      );
    }
  });

  it('Regression: ruflo #1676 — two providers same id different version, highest wins', () => {
    const old = mfst('claude-flow-memory', '1.5.0', { provides: ['mcp:cf-memory'] });
    const fresh = mfst('claude-flow-memory', '2.1.0', { provides: ['mcp:cf-memory'] });
    const target = mfst('claude-flow-cli', '3.7.0', {
      requires: ['mcp:cf-memory'],
    });
    const r = resolveCapabilities(target, { plugins: [old, fresh] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const bound = r.result.bindings.find((b) => b.capability === 'mcp:cf-memory');
      expect(bound?.providedBy.version).toBe('2.1.0');
    }
  });

  it('Regression: Memory 587-593 — peer-deps cluster replaced by clean capability bindings', () => {
    const memory = mfst('cf-memory', '1.0.0', { provides: ['mcp:cf-memory'] });
    const hooks = mfst('cf-hooks', '1.0.0', { provides: ['hook:cf-pre-edit'] });
    const target = mfst('cf-cli', '3.7.0', {
      requires: ['mcp:cf-memory', 'hook:cf-pre-edit'],
    });
    const r = resolveCapabilities(target, { plugins: [memory, hooks] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.bindings.map((b) => b.capability).sort()).toEqual([
        'hook:cf-pre-edit',
        'mcp:cf-memory',
      ]);
    }
  });
});
