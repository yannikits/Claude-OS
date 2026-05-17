import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceRegistryError, urlLoader } from '../../../src/domains/catalog/index.js';

const REGISTRY_URL = 'https://example.test/marketplace.json';

const validRegistryJson = JSON.stringify({
  version: 1,
  marketplaces: {
    'acme-skills': {
      source: 'github:acme/skills',
      plugins: {
        'pragmatic-review': { path: 'plugins/pragmatic-review' },
      },
    },
  },
});

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'claude-os-marketplace-url-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

function mockResponse(opts: {
  status: number;
  body?: string;
  etag?: string;
  statusText?: string;
}): Response {
  const headers = new Headers();
  if (opts.etag !== undefined) headers.set('etag', opts.etag);
  // 304 is a "null body status" per the WHATWG Fetch spec, so the
  // Response constructor refuses any body for it. We hand-roll a
  // duck-typed object instead — urlLoader only reads `.status` +
  // `.headers` in the 304 branch.
  if (opts.status === 304) {
    return {
      status: 304,
      ok: false,
      headers,
      statusText: opts.statusText ?? 'Not Modified',
    } as unknown as Response;
  }
  return new Response(opts.body ?? '', {
    status: opts.status,
    statusText: opts.statusText ?? '',
    headers,
  });
}

describe('urlLoader — first fetch', () => {
  it('fetches, validates, and caches body + ETag', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({ status: 200, body: validRegistryJson, etag: 'W/"v1"' }),
      );
    const loader = urlLoader({ url: REGISTRY_URL, cacheDir, fetch: fetchSpy });
    const registry = await loader();
    expect(registry.version).toBe(1);
    expect(Object.keys(registry.marketplaces)).toEqual(['acme-skills']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(calledUrl).toBe(REGISTRY_URL);
    expect(init.headers['If-None-Match']).toBeUndefined();
    expect(init.headers.Accept).toBe('application/json');
    const files = readdirSync(cacheDir);
    expect(files.some((f) => f.startsWith('marketplace-') && f.endsWith('.json'))).toBe(true);
    expect(files.some((f) => f.startsWith('marketplace-') && f.endsWith('.etag'))).toBe(true);
  });

  it('does not write .etag when server omits the header', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 200, body: validRegistryJson }));
    const loader = urlLoader({ url: REGISTRY_URL, cacheDir, fetch: fetchSpy });
    await loader();
    const files = readdirSync(cacheDir);
    expect(files.some((f) => f.endsWith('.json'))).toBe(true);
    expect(files.some((f) => f.endsWith('.etag'))).toBe(false);
  });
});

describe('urlLoader — conditional refetch', () => {
  it('sends If-None-Match with cached etag and reuses body on 304', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 200, body: validRegistryJson, etag: 'W/"v1"' }))
      .mockResolvedValueOnce(mockResponse({ status: 304 }));
    const loader = urlLoader({ url: REGISTRY_URL, cacheDir, fetch: fetchSpy });

    await loader();
    const secondCall = await loader();
    expect(secondCall.version).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const [, secondInit] = fetchSpy.mock.calls[1] as [string, { headers: Record<string, string> }];
    expect(secondInit.headers['If-None-Match']).toBe('W/"v1"');
  });

  it('replaces cached body and etag on a fresh 200', async () => {
    const updatedJson = JSON.stringify({
      version: 1,
      marketplaces: {
        'acme-skills': {
          source: 'github:acme/skills',
          plugins: { 'pragmatic-review': {}, 'team-onboarding': {} },
        },
      },
    });
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 200, body: validRegistryJson, etag: 'W/"v1"' }))
      .mockResolvedValueOnce(mockResponse({ status: 200, body: updatedJson, etag: 'W/"v2"' }));
    const loader = urlLoader({ url: REGISTRY_URL, cacheDir, fetch: fetchSpy });

    await loader();
    const refreshed = await loader();
    expect(Object.keys(refreshed.marketplaces['acme-skills']?.plugins ?? {})).toEqual(
      expect.arrayContaining(['pragmatic-review', 'team-onboarding']),
    );
    const etagFile = readdirSync(cacheDir).find((f) => f.endsWith('.etag')) as string;
    expect(readFileSync(join(cacheDir, etagFile), 'utf8')).toBe('W/"v2"');
  });
});

describe('urlLoader — error paths', () => {
  it('throws MarketplaceRegistryError on non-200/304 status', async () => {
    const fetchSpy = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(mockResponse({ status: 404, statusText: 'Not Found' })),
      );
    const loader = urlLoader({ url: REGISTRY_URL, cacheDir, fetch: fetchSpy });
    await expect(loader()).rejects.toBeInstanceOf(MarketplaceRegistryError);
    await expect(loader()).rejects.toThrow(/HTTP 404/);
  });

  it('wraps fetch network failures in MarketplaceRegistryError', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const loader = urlLoader({ url: REGISTRY_URL, cacheDir, fetch: fetchSpy });
    await expect(loader()).rejects.toThrow(/fetch .* failed: ECONNRESET/);
  });

  it('rejects malformed JSON from the server', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 200, body: '{not json', etag: 'W/"v1"' }));
    const loader = urlLoader({ url: REGISTRY_URL, cacheDir, fetch: fetchSpy });
    await expect(loader()).rejects.toThrow(/not valid JSON/);
  });

  it('rejects valid JSON with wrong shape', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 200, body: '{"version":2}' }));
    const loader = urlLoader({ url: REGISTRY_URL, cacheDir, fetch: fetchSpy });
    await expect(loader()).rejects.toThrow(/invalid shape/);
  });

  it('throws when 304 arrives but no cached body is present', async () => {
    const sha16 = createHash('sha256').update(REGISTRY_URL).digest('hex').slice(0, 16);
    writeFileSync(join(cacheDir, `marketplace-${sha16}.etag`), 'W/"v1"', 'utf8');
    const fetchSpy = vi.fn().mockResolvedValueOnce(mockResponse({ status: 304 }));
    const loader = urlLoader({ url: REGISTRY_URL, cacheDir, fetch: fetchSpy });
    await expect(loader()).rejects.toThrow(/304 but no cached body/);
  });

  it('throws when no fetch is available on globalThis and none injected', () => {
    const realFetch = globalThis.fetch;
    (globalThis as { fetch?: unknown }).fetch = undefined;
    try {
      expect(() => urlLoader({ url: REGISTRY_URL, cacheDir })).toThrow(
        /requires a fetch implementation/,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('urlLoader — cache key', () => {
  it('routes distinct URLs to distinct cache files', async () => {
    const fetchSpy = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(mockResponse({ status: 200, body: validRegistryJson, etag: 'W/"x"' })),
      );
    const a = urlLoader({ url: 'https://example.test/a.json', cacheDir, fetch: fetchSpy });
    const b = urlLoader({ url: 'https://example.test/b.json', cacheDir, fetch: fetchSpy });
    await a();
    await b();
    const files = readdirSync(cacheDir);
    expect(files.filter((f) => f.endsWith('.json')).length).toBe(2);
    expect(files.filter((f) => f.endsWith('.etag')).length).toBe(2);
  });

  it('reuses the same cache key for the same URL across invocations', async () => {
    const fetchSpy = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(mockResponse({ status: 200, body: validRegistryJson, etag: 'W/"v1"' })),
      );
    await urlLoader({ url: REGISTRY_URL, cacheDir, fetch: fetchSpy })();
    await urlLoader({ url: REGISTRY_URL, cacheDir, fetch: fetchSpy })();
    const files = readdirSync(cacheDir);
    expect(files.filter((f) => f.endsWith('.json')).length).toBe(1);
    expect(files.filter((f) => f.endsWith('.etag')).length).toBe(1);
  });
});

describe('urlLoader — atomic-write smoke', () => {
  it('leaves no stray .tmp- files behind', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({ status: 200, body: validRegistryJson, etag: 'W/"v1"' }),
      );
    await urlLoader({ url: REGISTRY_URL, cacheDir, fetch: fetchSpy })();
    const files = readdirSync(cacheDir);
    expect(files.some((f) => f.includes('.tmp-'))).toBe(false);
    const jsonFile = files.find((f) => f.endsWith('.json')) as string;
    expect(existsSync(join(cacheDir, jsonFile))).toBe(true);
    expect(JSON.parse(readFileSync(join(cacheDir, jsonFile), 'utf8'))).toEqual(
      JSON.parse(validRegistryJson),
    );
  });
});
