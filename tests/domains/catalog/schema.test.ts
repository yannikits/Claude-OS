import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  type CatalogConfig,
  CatalogConfigJsonSchema,
  CatalogConfigSchema,
  type CatalogLock,
  CatalogLockJsonSchema,
  CatalogLockSchema,
} from '../../../src/domains/catalog/index.js';

const validCatalog: CatalogConfig = {
  version: 1,
  entries: [
    {
      id: 'sample-plugin',
      kind: 'plugin',
      source: 'github:acme/sample-plugin@v1.2.0',
      enabled: true,
      scope: 'user',
    },
    {
      id: 'team-skills',
      kind: 'skill',
      source: 'github:acme/team-skills',
      enabled: false,
      scope: 'project',
    },
  ],
};

const validLock: CatalogLock = {
  version: 1,
  resolvedAt: '2026-05-17T08:30:00Z',
  entries: [
    {
      id: 'sample-plugin',
      source: 'github:acme/sample-plugin@v1.2.0',
      sha256: 'a'.repeat(64),
      resolvedRef: 'v1.2.0',
      bindings: [{ capability: 'mcp-server>=1.0.0', providedBy: 'other-plugin' }],
    },
  ],
};

describe('CatalogConfigSchema', () => {
  it('accepts the empty catalog', () => {
    expect(Value.Check(CatalogConfigSchema, { version: 1, entries: [] })).toBe(true);
  });

  it('accepts a multi-entry catalog with all kinds and scopes', () => {
    expect(Value.Check(CatalogConfigSchema, validCatalog)).toBe(true);
  });

  it('accepts mcp kind', () => {
    const cat: CatalogConfig = {
      version: 1,
      entries: [
        {
          id: 'a-mcp-server',
          kind: 'mcp',
          source: 'local:./mcp/my-server',
          enabled: true,
          scope: 'user',
        },
      ],
    };
    expect(Value.Check(CatalogConfigSchema, cat)).toBe(true);
  });

  it('rejects version != 1', () => {
    expect(Value.Check(CatalogConfigSchema, { version: 2, entries: [] })).toBe(false);
  });

  it('rejects unknown kind', () => {
    const bad = {
      version: 1,
      entries: [
        {
          id: 'x',
          kind: 'agent',
          source: 'github:acme/x',
          enabled: true,
          scope: 'user',
        },
      ],
    };
    expect(Value.Check(CatalogConfigSchema, bad)).toBe(false);
  });

  it('rejects unknown scope', () => {
    const bad = {
      version: 1,
      entries: [
        {
          id: 'x',
          kind: 'plugin',
          source: 'github:acme/x',
          enabled: true,
          scope: 'global',
        },
      ],
    };
    expect(Value.Check(CatalogConfigSchema, bad)).toBe(false);
  });

  it('rejects malformed source prefix', () => {
    const bad = {
      version: 1,
      entries: [
        {
          id: 'x',
          kind: 'plugin',
          source: 'http://example.com/x',
          enabled: true,
          scope: 'user',
        },
      ],
    };
    expect(Value.Check(CatalogConfigSchema, bad)).toBe(false);
  });

  it('rejects empty id', () => {
    const bad = {
      version: 1,
      entries: [{ id: '', kind: 'plugin', source: 'github:acme/x', enabled: true, scope: 'user' }],
    };
    expect(Value.Check(CatalogConfigSchema, bad)).toBe(false);
  });

  it('rejects id with disallowed characters', () => {
    const bad = {
      version: 1,
      entries: [
        { id: 'has space', kind: 'plugin', source: 'github:acme/x', enabled: true, scope: 'user' },
      ],
    };
    expect(Value.Check(CatalogConfigSchema, bad)).toBe(false);
  });

  it('rejects additional properties on entries', () => {
    const bad = {
      version: 1,
      entries: [
        {
          id: 'x',
          kind: 'plugin',
          source: 'github:acme/x',
          enabled: true,
          scope: 'user',
          installedAt: '2026-05-17',
        },
      ],
    };
    expect(Value.Check(CatalogConfigSchema, bad)).toBe(false);
  });

  it('rejects additional properties at the root', () => {
    expect(Value.Check(CatalogConfigSchema, { version: 1, entries: [], comment: 'x' })).toBe(false);
  });
});

describe('CatalogLockSchema', () => {
  it('accepts a minimal empty lock', () => {
    expect(
      Value.Check(CatalogLockSchema, {
        version: 1,
        resolvedAt: '2026-05-17T08:30:00Z',
        entries: [],
      }),
    ).toBe(true);
  });

  it('accepts a populated lock with bindings', () => {
    expect(Value.Check(CatalogLockSchema, validLock)).toBe(true);
  });

  it('rejects non-hex sha256', () => {
    const bad = {
      version: 1,
      resolvedAt: '2026-05-17T08:30:00Z',
      entries: [
        {
          id: 'x',
          source: 'github:acme/x',
          sha256: 'NOTHEX'.padEnd(64, 'g'),
          bindings: [],
        },
      ],
    };
    expect(Value.Check(CatalogLockSchema, bad)).toBe(false);
  });

  it('rejects sha256 of wrong length', () => {
    const bad = {
      version: 1,
      resolvedAt: '2026-05-17T08:30:00Z',
      entries: [
        {
          id: 'x',
          source: 'github:acme/x',
          sha256: 'a'.repeat(63),
          bindings: [],
        },
      ],
    };
    expect(Value.Check(CatalogLockSchema, bad)).toBe(false);
  });

  it('rejects malformed resolvedAt', () => {
    const bad = {
      version: 1,
      resolvedAt: '2026-05-17 08:30:00',
      entries: [],
    };
    expect(Value.Check(CatalogLockSchema, bad)).toBe(false);
  });

  it('rejects binding without providedBy', () => {
    const bad = {
      version: 1,
      resolvedAt: '2026-05-17T08:30:00Z',
      entries: [
        {
          id: 'x',
          source: 'github:acme/x',
          sha256: 'a'.repeat(64),
          bindings: [{ capability: 'mcp-server>=1.0.0' }],
        },
      ],
    };
    expect(Value.Check(CatalogLockSchema, bad)).toBe(false);
  });
});

describe('JSON-Schema exports', () => {
  it('CatalogConfigJsonSchema has no Symbol-keyed metadata', () => {
    expect(Object.getOwnPropertySymbols(CatalogConfigJsonSchema)).toEqual([]);
  });

  it('CatalogLockJsonSchema has no Symbol-keyed metadata', () => {
    expect(Object.getOwnPropertySymbols(CatalogLockJsonSchema)).toEqual([]);
  });

  it('CatalogConfigJsonSchema preserves required + nested entries shape', () => {
    const s = CatalogConfigJsonSchema as {
      type: string;
      required: readonly string[];
      properties: { entries: { type: string; items: { required: readonly string[] } } };
    };
    expect(s.type).toBe('object');
    expect(s.required).toEqual(expect.arrayContaining(['version', 'entries']));
    expect(s.properties.entries.type).toBe('array');
    expect(s.properties.entries.items.required).toEqual(
      expect.arrayContaining(['id', 'kind', 'source', 'enabled', 'scope']),
    );
  });
});
