import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CatalogConfig,
  type CatalogLock,
  catalogPathsFor,
  EMPTY_CATALOG,
  InvalidCatalogError,
  readCatalog,
  readCatalogLock,
  writeCatalog,
  writeCatalogLock,
} from '../../../src/domains/catalog/index.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-os-catalog-store-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sampleCatalog: CatalogConfig = {
  version: 1,
  entries: [
    {
      id: 'sample-plugin',
      kind: 'plugin',
      source: 'github:acme/sample-plugin@v1.0.0',
      enabled: true,
      scope: 'user',
    },
  ],
};

const sampleLock: CatalogLock = {
  version: 1,
  resolvedAt: '2026-05-17T08:30:00Z',
  entries: [
    {
      id: 'sample-plugin',
      source: 'github:acme/sample-plugin@v1.0.0',
      sha256: 'b'.repeat(64),
      resolvedRef: 'v1.0.0',
      bindings: [],
    },
  ],
};

describe('catalogPathsFor', () => {
  it('places catalog.json + catalog.lock.json under <root>/config/', () => {
    const paths = catalogPathsFor(root);
    expect(paths.catalogPath).toBe(join(root, 'config', 'catalog.json'));
    expect(paths.lockPath).toBe(join(root, 'config', 'catalog.lock.json'));
  });
});

describe('readCatalog', () => {
  it('returns EMPTY_CATALOG when file does not exist', () => {
    const { catalogPath } = catalogPathsFor(root);
    const cat = readCatalog(catalogPath);
    expect(cat).toEqual(EMPTY_CATALOG);
    // returned object is a fresh copy — caller can mutate without
    // poisoning the module-level constant
    expect(cat).not.toBe(EMPTY_CATALOG);
  });

  it('reads and validates a well-formed catalog', () => {
    const { catalogPath } = catalogPathsFor(root);
    mkdirSync(join(root, 'config'));
    writeFileSync(catalogPath, JSON.stringify(sampleCatalog), 'utf8');
    expect(readCatalog(catalogPath)).toEqual(sampleCatalog);
  });

  it('throws InvalidCatalogError on malformed JSON', () => {
    const { catalogPath } = catalogPathsFor(root);
    mkdirSync(join(root, 'config'));
    writeFileSync(catalogPath, '{ not json', 'utf8');
    expect(() => readCatalog(catalogPath)).toThrowError(InvalidCatalogError);
  });

  it('throws InvalidCatalogError on schema violations and includes field paths', () => {
    const { catalogPath } = catalogPathsFor(root);
    mkdirSync(join(root, 'config'));
    writeFileSync(
      catalogPath,
      JSON.stringify({
        version: 1,
        entries: [{ id: 'x', kind: 'agent', source: 'github:a/b', enabled: true, scope: 'user' }],
      }),
      'utf8',
    );
    try {
      readCatalog(catalogPath);
      throw new Error('expected InvalidCatalogError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidCatalogError);
      const ie = err as InvalidCatalogError;
      expect(ie.message).toContain('catalog.json');
      expect(ie.message).toContain('entries[0].kind');
      expect(ie.file).toBe(catalogPath);
    }
  });
});

describe('writeCatalog', () => {
  it('writes pretty-printed JSON with trailing newline + mode 0o600 atomicity', () => {
    const { catalogPath } = catalogPathsFor(root);
    writeCatalog(catalogPath, sampleCatalog);
    const written = readFileSync(catalogPath, 'utf8');
    expect(written).toMatch(/\n$/);
    expect(JSON.parse(written)).toEqual(sampleCatalog);
  });

  it('refuses to write a schema-violating catalog', () => {
    const { catalogPath } = catalogPathsFor(root);
    const bad = {
      version: 1,
      entries: [{ id: '', kind: 'plugin', source: 'github:a/b', enabled: true, scope: 'user' }],
    } as unknown as CatalogConfig;
    expect(() => writeCatalog(catalogPath, bad)).toThrowError(/Invalid catalog\.json/);
  });

  it('round-trips a multi-entry catalog through write+read', () => {
    const { catalogPath } = catalogPathsFor(root);
    const multi: CatalogConfig = {
      version: 1,
      entries: [
        ...sampleCatalog.entries,
        {
          id: 'second',
          kind: 'mcp',
          source: 'local:./mcp/server',
          enabled: false,
          scope: 'project',
        },
      ],
    };
    writeCatalog(catalogPath, multi);
    expect(readCatalog(catalogPath)).toEqual(multi);
  });
});

describe('readCatalogLock', () => {
  it('returns null when the lock file does not exist', () => {
    const { lockPath } = catalogPathsFor(root);
    expect(readCatalogLock(lockPath)).toBeNull();
  });

  it('reads and validates a well-formed lock', () => {
    const { lockPath } = catalogPathsFor(root);
    mkdirSync(join(root, 'config'));
    writeFileSync(lockPath, JSON.stringify(sampleLock), 'utf8');
    expect(readCatalogLock(lockPath)).toEqual(sampleLock);
  });

  it('throws InvalidCatalogError on schema violations', () => {
    const { lockPath } = catalogPathsFor(root);
    mkdirSync(join(root, 'config'));
    writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        resolvedAt: '2026-05-17 not iso',
        entries: [],
      }),
      'utf8',
    );
    expect(() => readCatalogLock(lockPath)).toThrowError(InvalidCatalogError);
  });
});

describe('writeCatalogLock', () => {
  it('round-trips through write+read', () => {
    const { lockPath } = catalogPathsFor(root);
    writeCatalogLock(lockPath, sampleLock);
    expect(readCatalogLock(lockPath)).toEqual(sampleLock);
  });

  it('refuses bad sha256', () => {
    const { lockPath } = catalogPathsFor(root);
    const bad = {
      version: 1,
      resolvedAt: '2026-05-17T08:30:00Z',
      entries: [
        {
          id: 'x',
          source: 'github:a/b',
          sha256: 'too-short',
          bindings: [],
        },
      ],
    } as unknown as CatalogLock;
    expect(() => writeCatalogLock(lockPath, bad)).toThrowError(/Invalid catalog\.lock\.json/);
  });
});
