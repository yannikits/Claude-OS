import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CatalogConfig,
  LockBuilderError,
  lockCatalog,
} from '../../../src/domains/catalog/index.js';

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'claude-os-lock-builder-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

function tarballResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/gzip' } });
}

function notFoundResponse(): Response {
  return new Response('not found', { status: 404, statusText: 'Not Found' });
}

const githubCatalog: CatalogConfig = {
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

describe('lockCatalog — github sources', () => {
  it('builds a lock entry with sha256 + resolvedRef from the parsed source', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(tarballResponse('tarball-bytes-v1'));
    const result = await lockCatalog({
      catalog: githubCatalog,
      cacheDir,
      fetch: fetchSpy,
      nowIso: () => '2026-05-17T08:30:00Z',
    });
    expect(result.warnings).toEqual([]);
    expect(result.lock.version).toBe(1);
    expect(result.lock.resolvedAt).toBe('2026-05-17T08:30:00Z');
    expect(result.lock.entries).toHaveLength(1);
    const [entry] = result.lock.entries;
    expect(entry?.id).toBe('sample-plugin');
    expect(entry?.source).toBe('github:acme/sample-plugin@v1.0.0');
    expect(entry?.resolvedRef).toBe('v1.0.0');
    expect(entry?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(entry?.bindings).toEqual([]);
  });

  it('defaults resolvedRef to HEAD when the source has no @ref', async () => {
    const noRefCatalog: CatalogConfig = {
      version: 1,
      entries: [
        {
          id: 'head-plugin',
          kind: 'plugin',
          source: 'github:acme/head-plugin',
          enabled: true,
          scope: 'user',
        },
      ],
    };
    const fetchSpy = vi.fn().mockResolvedValueOnce(tarballResponse('head-bytes'));
    const result = await lockCatalog({
      catalog: noRefCatalog,
      cacheDir,
      fetch: fetchSpy,
      nowIso: () => '2026-05-17T08:30:00Z',
    });
    expect(result.lock.entries[0]?.resolvedRef).toBe('HEAD');
  });

  it('caches the tarball under <cacheDir>/<sha256>.tar.gz (atomic, no .tmp- leftovers)', async () => {
    const body = 'cache-me-please';
    const fetchSpy = vi.fn().mockResolvedValueOnce(tarballResponse(body));
    const result = await lockCatalog({
      catalog: githubCatalog,
      cacheDir,
      fetch: fetchSpy,
      nowIso: () => '2026-05-17T08:30:00Z',
    });
    const sha = result.lock.entries[0]?.sha256 as string;
    const cached = join(cacheDir, `${sha}.tar.gz`);
    expect(existsSync(cached)).toBe(true);
    expect(readFileSync(cached, 'utf8')).toBe(body);
    expect(readdirSync(cacheDir).some((f) => f.includes('.tmp-'))).toBe(false);
  });

  it('reuses the cached file on a second run with same bytes', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(tarballResponse('same-bytes'))
      .mockResolvedValueOnce(tarballResponse('same-bytes'));
    await lockCatalog({
      catalog: githubCatalog,
      cacheDir,
      fetch: fetchSpy,
      nowIso: () => '2026-05-17T08:30:00Z',
    });
    await lockCatalog({
      catalog: githubCatalog,
      cacheDir,
      fetch: fetchSpy,
      nowIso: () => '2026-05-17T08:30:01Z',
    });
    expect(readdirSync(cacheDir).filter((f) => f.endsWith('.tar.gz')).length).toBe(1);
  });
});

describe('lockCatalog — skipped sources', () => {
  it('emits a warning and skips marketplace: sources', async () => {
    const catalog: CatalogConfig = {
      version: 1,
      entries: [
        {
          id: 'mp-entry',
          kind: 'plugin',
          source: 'marketplace:acme:foo',
          enabled: true,
          scope: 'user',
        },
      ],
    };
    const fetchSpy = vi.fn();
    const result = await lockCatalog({
      catalog,
      cacheDir,
      fetch: fetchSpy,
      nowIso: () => '2026-05-17T08:30:00Z',
    });
    expect(result.lock.entries).toEqual([]);
    expect(result.warnings.some((w) => w.startsWith('mp-entry') && w.includes('marketplace'))).toBe(
      true,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('emits a warning and skips local: sources', async () => {
    const catalog: CatalogConfig = {
      version: 1,
      entries: [
        {
          id: 'local-entry',
          kind: 'skill',
          source: 'local:./skills/mine',
          enabled: true,
          scope: 'project',
        },
      ],
    };
    const fetchSpy = vi.fn();
    const result = await lockCatalog({
      catalog,
      cacheDir,
      fetch: fetchSpy,
      nowIso: () => '2026-05-17T08:30:00Z',
    });
    expect(result.lock.entries).toEqual([]);
    expect(result.warnings.some((w) => w.startsWith('local-entry') && w.includes('local:'))).toBe(
      true,
    );
  });
});

describe('lockCatalog — failure paths', () => {
  it('emits a warning per failing github tarball but keeps other entries', async () => {
    const catalog: CatalogConfig = {
      version: 1,
      entries: [
        ...githubCatalog.entries,
        {
          id: 'broken',
          kind: 'plugin',
          source: 'github:acme/missing@v9',
          enabled: true,
          scope: 'user',
        },
      ],
    };
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(tarballResponse('ok-bytes'))
      .mockResolvedValueOnce(notFoundResponse());
    const result = await lockCatalog({
      catalog,
      cacheDir,
      fetch: fetchSpy,
      nowIso: () => '2026-05-17T08:30:00Z',
    });
    expect(result.lock.entries.map((e) => e.id)).toEqual(['sample-plugin']);
    expect(result.warnings.some((w) => w.startsWith('broken') && w.includes('HTTP 404'))).toBe(
      true,
    );
  });

  it('emits a warning when fetch throws (network failure)', async () => {
    const fetchSpy = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET'));
    const result = await lockCatalog({
      catalog: githubCatalog,
      cacheDir,
      fetch: fetchSpy,
      nowIso: () => '2026-05-17T08:30:00Z',
    });
    expect(result.lock.entries).toEqual([]);
    expect(
      result.warnings.some(
        (w) => w.startsWith('sample-plugin') && w.includes('network fetch failed'),
      ),
    ).toBe(true);
  });

  it('throws LockBuilderError when no fetch is available on globalThis and none injected', async () => {
    const realFetch = globalThis.fetch;
    (globalThis as { fetch?: unknown }).fetch = undefined;
    try {
      await expect(lockCatalog({ catalog: githubCatalog, cacheDir })).rejects.toThrowError(
        LockBuilderError,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('lockCatalog — empty catalog', () => {
  it('returns an empty lock with the supplied resolvedAt', async () => {
    const result = await lockCatalog({
      catalog: { version: 1, entries: [] },
      cacheDir,
      fetch: vi.fn(),
      nowIso: () => '2026-05-17T08:30:00Z',
    });
    expect(result.lock).toEqual({ version: 1, resolvedAt: '2026-05-17T08:30:00Z', entries: [] });
    expect(result.warnings).toEqual([]);
  });
});
