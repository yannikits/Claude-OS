import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyLock,
  type CatalogConfig,
  type CatalogLock,
  installDestinationFor,
  mergeLockEntry,
} from '../../../src/domains/catalog/index.js';

let root: string;
let cacheDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-os-sync-root-'));
  cacheDir = mkdtempSync(join(tmpdir(), 'claude-os-sync-cache-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
});

function seedTarball(sha: string): string {
  const path = join(cacheDir, `${sha}.tar.gz`);
  writeFileSync(path, 'fake-tar-bytes', 'utf8');
  return path;
}

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
    {
      id: 'disabled-skill',
      kind: 'skill',
      source: 'github:acme/disabled-skill',
      enabled: false,
      scope: 'project',
    },
    {
      id: 'an-mcp',
      kind: 'mcp',
      source: 'github:acme/an-mcp',
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
      sha256: 'a'.repeat(64),
      resolvedRef: 'v1.0.0',
      bindings: [],
    },
    {
      id: 'disabled-skill',
      source: 'github:acme/disabled-skill',
      sha256: 'b'.repeat(64),
      resolvedRef: 'HEAD',
      bindings: [],
    },
    {
      id: 'an-mcp',
      source: 'github:acme/an-mcp',
      sha256: 'c'.repeat(64),
      resolvedRef: 'HEAD',
      bindings: [],
    },
  ],
};

describe('installDestinationFor', () => {
  it('routes each kind to its bucket directory', () => {
    expect(installDestinationFor(root, sampleCatalog.entries[0] as never)).toBe(
      join(root, 'config', 'plugins', 'sample-plugin'),
    );
    expect(installDestinationFor(root, sampleCatalog.entries[1] as never)).toBe(
      join(root, 'config', 'skills', 'disabled-skill'),
    );
    expect(installDestinationFor(root, sampleCatalog.entries[2] as never)).toBe(
      join(root, 'config', 'mcp', 'an-mcp'),
    );
  });
});

describe('applyLock — happy path', () => {
  it('extracts enabled entries and skips disabled ones', async () => {
    seedTarball('a'.repeat(64));
    seedTarball('b'.repeat(64));
    seedTarball('c'.repeat(64));
    const extractSpy = vi.fn().mockResolvedValue(undefined);

    const result = await applyLock({
      root,
      catalog: sampleCatalog,
      lock: sampleLock,
      cacheDir,
      extract: extractSpy,
    });

    expect(result.applied.map((a) => a.id)).toEqual(['sample-plugin', 'an-mcp']);
    expect(result.skipped.map((s) => s.id)).toEqual(['disabled-skill']);
    expect(result.errors).toEqual([]);
    expect(extractSpy).toHaveBeenCalledTimes(2);
    const firstCall = extractSpy.mock.calls[0]?.[0] as { file: string; cwd: string; strip: number };
    expect(firstCall.file).toBe(join(cacheDir, `${'a'.repeat(64)}.tar.gz`));
    expect(firstCall.cwd).toBe(join(root, 'config', 'plugins', 'sample-plugin'));
    expect(firstCall.strip).toBe(1);
  });

  it('honours custom stripComponents', async () => {
    seedTarball('a'.repeat(64));
    const lockOne: CatalogLock = { ...sampleLock, entries: [sampleLock.entries[0] as never] };
    const catalogOne: CatalogConfig = {
      version: 1,
      entries: [sampleCatalog.entries[0] as never],
    };
    const extractSpy = vi.fn().mockResolvedValue(undefined);
    await applyLock({
      root,
      catalog: catalogOne,
      lock: lockOne,
      cacheDir,
      stripComponents: 0,
      extract: extractSpy,
    });
    expect(extractSpy.mock.calls[0]?.[0].strip).toBe(0);
  });
});

describe('applyLock — error paths', () => {
  it('errors per entry when the cached tarball is missing', async () => {
    seedTarball('a'.repeat(64));
    // skip seeding c -> an-mcp should error
    const extractSpy = vi.fn().mockResolvedValue(undefined);
    const result = await applyLock({
      root,
      catalog: sampleCatalog,
      lock: sampleLock,
      cacheDir,
      extract: extractSpy,
    });
    expect(result.applied.map((a) => a.id)).toEqual(['sample-plugin']);
    expect(result.errors.map((e) => e.id)).toEqual(['an-mcp']);
    expect(result.errors[0]?.message).toMatch(/cached tarball missing/);
    expect(extractSpy).toHaveBeenCalledTimes(1);
  });

  it('captures tar.extract failures as per-entry errors', async () => {
    seedTarball('a'.repeat(64));
    const catalogOne: CatalogConfig = {
      version: 1,
      entries: [sampleCatalog.entries[0] as never],
    };
    const lockOne: CatalogLock = { ...sampleLock, entries: [sampleLock.entries[0] as never] };
    const extractSpy = vi.fn().mockRejectedValueOnce(new Error('archive truncated'));
    const result = await applyLock({
      root,
      catalog: catalogOne,
      lock: lockOne,
      cacheDir,
      extract: extractSpy,
    });
    expect(result.applied).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/tar extract failed/);
    expect(result.errors[0]?.message).toMatch(/archive truncated/);
  });

  it('skips lock entries with no matching catalog entry', async () => {
    seedTarball('a'.repeat(64));
    const trimmedCatalog: CatalogConfig = {
      version: 1,
      entries: [],
    };
    const extractSpy = vi.fn().mockResolvedValue(undefined);
    const result = await applyLock({
      root,
      catalog: trimmedCatalog,
      lock: sampleLock,
      cacheDir,
      extract: extractSpy,
    });
    expect(result.applied).toEqual([]);
    expect(result.skipped.map((s) => s.id).sort()).toEqual(
      ['an-mcp', 'disabled-skill', 'sample-plugin'].sort(),
    );
    expect(extractSpy).not.toHaveBeenCalled();
  });
});

describe('mergeLockEntry', () => {
  it('replaces an existing entry by id', () => {
    const merged = mergeLockEntry(
      sampleLock,
      'an-mcp',
      {
        id: 'an-mcp',
        source: 'github:acme/an-mcp@v2',
        sha256: 'd'.repeat(64),
        resolvedRef: 'v2',
        bindings: [],
      },
      '2026-05-17T09:00:00Z',
    );
    expect(merged.resolvedAt).toBe('2026-05-17T09:00:00Z');
    expect(merged.entries).toHaveLength(3);
    const target = merged.entries.find((e) => e.id === 'an-mcp');
    expect(target?.sha256).toBe('d'.repeat(64));
    expect(target?.resolvedRef).toBe('v2');
  });

  it('appends a new entry when id is not in the existing lock', () => {
    const merged = mergeLockEntry(
      sampleLock,
      'fresh',
      {
        id: 'fresh',
        source: 'github:acme/fresh',
        sha256: 'e'.repeat(64),
        resolvedRef: 'HEAD',
        bindings: [],
      },
      '2026-05-17T09:00:00Z',
    );
    expect(merged.entries).toHaveLength(4);
    expect(merged.entries.at(-1)?.id).toBe('fresh');
  });

  it('removes an entry when newEntry is null', () => {
    const merged = mergeLockEntry(sampleLock, 'sample-plugin', null, '2026-05-17T09:00:00Z');
    expect(merged.entries.map((e) => e.id)).toEqual(['disabled-skill', 'an-mcp']);
  });
});
