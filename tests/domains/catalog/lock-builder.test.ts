import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CatalogConfig,
  LockBuilderError,
  lockCatalog,
  type ManifestReadResult,
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

describe('lockCatalog — plugin binding resolution (Phase 5o)', () => {
  const dependentCatalog: CatalogConfig = {
    version: 1,
    entries: [
      {
        id: 'mcp-foo',
        kind: 'plugin',
        source: 'github:acme/mcp-foo@v1.0.0',
        enabled: true,
        scope: 'user',
      },
      {
        id: 'skill-user',
        kind: 'plugin',
        source: 'github:acme/skill-user@v2.1.0',
        enabled: true,
        scope: 'user',
      },
    ],
  };

  it('populates bindings for plugins whose requires are satisfied by sibling plugins', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(tarballResponse('mcp-foo-bytes-v1'))
      .mockResolvedValueOnce(tarballResponse('skill-user-bytes-v2'));

    // Manifest reader is injected — first call returns mcp-foo manifest,
    // second returns skill-user manifest. The order matches fetch order
    // because the lock builder reads manifests in the same loop order.
    const readerCalls: string[] = [];
    const readManifest = vi.fn(async (tarballPath: string): Promise<ManifestReadResult> => {
      readerCalls.push(tarballPath);
      if (readerCalls.length === 1) {
        return {
          ok: true,
          manifest: {
            id: 'mcp-foo',
            version: '1.0.0',
            provides: ['mcp:foo>=1.0.0'],
          },
        };
      }
      return {
        ok: true,
        manifest: {
          id: 'skill-user',
          version: '2.1.0',
          requires: ['mcp:foo>=1.0.0'],
        },
      };
    });

    const result = await lockCatalog({
      catalog: dependentCatalog,
      cacheDir,
      fetch: fetchSpy,
      readManifest,
      nowIso: () => '2026-05-17T08:30:00Z',
    });

    expect(result.warnings).toEqual([]);
    expect(readManifest).toHaveBeenCalledTimes(2);

    const skillUser = result.lock.entries.find((e) => e.id === 'skill-user');
    expect(skillUser?.bindings).toEqual([{ capability: 'mcp:foo>=1.0.0', providedBy: 'mcp-foo' }]);
    const mcpFoo = result.lock.entries.find((e) => e.id === 'mcp-foo');
    expect(mcpFoo?.bindings).toEqual([]);
  });

  it('keeps the lock entry with bindings:[] and stays silent when the manifest is simply missing', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(tarballResponse('opaque-tarball'));
    const readManifest = vi.fn(
      async (): Promise<ManifestReadResult> => ({
        ok: false,
        reason: 'tarball does not contain a plugin.json entry',
      }),
    );
    const catalog: CatalogConfig = {
      version: 1,
      entries: [
        {
          id: 'no-manifest-plugin',
          kind: 'plugin',
          source: 'github:acme/no-manifest@v1',
          enabled: true,
          scope: 'user',
        },
      ],
    };
    const result = await lockCatalog({
      catalog,
      cacheDir,
      fetch: fetchSpy,
      readManifest,
      nowIso: () => '2026-05-17T08:30:00Z',
    });
    expect(result.lock.entries.map((e) => e.id)).toEqual(['no-manifest-plugin']);
    expect(result.lock.entries[0]?.bindings).toEqual([]);
    // NO_MANIFEST is silent — pre-ADR-0010 plugins are still legal in v1.
    expect(result.warnings).toEqual([]);
  });

  it('surfaces a warning when the plugin.json is present but malformed', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(tarballResponse('opaque-tarball'));
    const readManifest = vi.fn(
      async (): Promise<ManifestReadResult> => ({
        ok: false,
        reason: 'plugin.json failed to parse: Unexpected token',
      }),
    );
    const catalog: CatalogConfig = {
      version: 1,
      entries: [
        {
          id: 'bad-manifest',
          kind: 'plugin',
          source: 'github:acme/bad-manifest@v1',
          enabled: true,
          scope: 'user',
        },
      ],
    };
    const result = await lockCatalog({
      catalog,
      cacheDir,
      fetch: fetchSpy,
      readManifest,
      nowIso: () => '2026-05-17T08:30:00Z',
    });
    expect(result.lock.entries[0]?.bindings).toEqual([]);
    expect(
      result.warnings.some((w) => w.includes('bad-manifest') && w.includes('plugin.json')),
    ).toBe(true);
  });

  it('emits a binding-resolution warning when a require cannot be satisfied', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(tarballResponse('lonely'));
    const readManifest = vi.fn(
      async (): Promise<ManifestReadResult> => ({
        ok: true,
        manifest: {
          id: 'lonely',
          version: '1.0.0',
          requires: ['mcp:does-not-exist>=1.0.0'],
        },
      }),
    );
    const catalog: CatalogConfig = {
      version: 1,
      entries: [
        {
          id: 'lonely',
          kind: 'plugin',
          source: 'github:acme/lonely@v1',
          enabled: true,
          scope: 'user',
        },
      ],
    };
    const result = await lockCatalog({
      catalog,
      cacheDir,
      fetch: fetchSpy,
      readManifest,
      nowIso: () => '2026-05-17T08:30:00Z',
    });
    expect(result.lock.entries).toHaveLength(1);
    expect(result.lock.entries[0]?.bindings).toEqual([]);
    expect(
      result.warnings.some((w) => w.includes('lonely') && w.includes('binding resolution failed')),
    ).toBe(true);
  });

  it('does not invoke the manifest reader for skill / mcp entries (leaves)', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(tarballResponse('skill-bytes'))
      .mockResolvedValueOnce(tarballResponse('mcp-bytes'));
    const readManifest = vi.fn();
    const catalog: CatalogConfig = {
      version: 1,
      entries: [
        {
          id: 'just-a-skill',
          kind: 'skill',
          source: 'github:acme/just-a-skill@v1',
          enabled: true,
          scope: 'user',
        },
        {
          id: 'just-an-mcp',
          kind: 'mcp',
          source: 'github:acme/just-an-mcp@v1',
          enabled: true,
          scope: 'user',
        },
      ],
    };
    const result = await lockCatalog({
      catalog,
      cacheDir,
      fetch: fetchSpy,
      readManifest,
      nowIso: () => '2026-05-17T08:30:00Z',
    });
    expect(readManifest).not.toHaveBeenCalled();
    expect(result.lock.entries).toHaveLength(2);
    for (const entry of result.lock.entries) expect(entry.bindings).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});
