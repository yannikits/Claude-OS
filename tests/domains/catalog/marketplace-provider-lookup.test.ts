import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMarketplaceProviderLookup,
  fileLoader,
  type ManifestReadResult,
  MarketplaceRegistry,
  parseCapability,
} from '../../../src/domains/catalog/index.js';

let cacheDir: string;
let registryDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'claude-os-mp-lookup-cache-'));
  registryDir = mkdtempSync(join(tmpdir(), 'claude-os-mp-lookup-reg-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
});

function makeRegistry(): MarketplaceRegistry {
  // Marketplace mit zwei Plugins die unterschiedliche capabilities provided
  const file = join(registryDir, 'registry.json');
  require('node:fs').writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      marketplaces: {
        acme: {
          source: 'github:acme/marketplace',
          plugins: {
            'mcp-foo': { path: 'mcp-foo' },
            'mcp-bar': { path: 'mcp-bar' },
          },
        },
      },
    }),
    'utf8',
  );
  return new MarketplaceRegistry({ load: fileLoader(file) });
}

describe('createMarketplaceProviderLookup', () => {
  it('iteriert Marketplaces + Plugins und liefert Provider fuer eine Capability', async () => {
    const registry = makeRegistry();
    const fetchImpl = vi.fn(
      async () =>
        new Response(Buffer.from('fake-tar'), {
          status: 200,
          headers: { 'content-type': 'application/gzip' },
        }),
    );
    const readManifest = vi.fn(async (tarballPath: string): Promise<ManifestReadResult> => {
      // Wir wissen nicht welcher Tarball-Pfad welchem Plugin entspricht,
      // weil beide identische bytes haben → gleicher sha256 → gleicher
      // Cache-Pfad. Fuer realistische Tests muesste pro Plugin ein
      // unterschiedlicher fake-body geliefert werden. Hier liefern wir
      // einfach ein einziges Manifest zurueck.
      void tarballPath;
      return {
        ok: true,
        manifest: {
          id: 'mcp-foo',
          version: '1.0.0',
          provides: ['mcp:foo'],
        },
      };
    });
    const lookup = createMarketplaceProviderLookup({
      registry,
      cacheDir,
      fetch: fetchImpl,
      readManifest,
    });
    const matches = await lookup(parseCapability('mcp:foo'));
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.manifest.id).toBe('mcp-foo');
    expect(matches[0]?.source).toMatch(/^marketplace:acme:/);
  });

  it('liefert leeres Array wenn keine Manifeste matchen', async () => {
    const registry = makeRegistry();
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('fake-tar'), { status: 200 }));
    const readManifest = vi.fn(
      async (): Promise<ManifestReadResult> => ({
        ok: true,
        manifest: { id: 'unrelated', version: '1.0.0', provides: ['mcp:something-else'] },
      }),
    );
    const lookup = createMarketplaceProviderLookup({
      registry,
      cacheDir,
      fetch: fetchImpl,
      readManifest,
    });
    const matches = await lookup(parseCapability('mcp:nonexistent'));
    expect(matches).toEqual([]);
  });

  it('toleriert Tarball-Fetch-Fehler pro Plugin ohne Gesamt-Crash', async () => {
    const registry = makeRegistry();
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
    const readManifest = vi.fn();
    const lookup = createMarketplaceProviderLookup({
      registry,
      cacheDir,
      fetch: fetchImpl,
      readManifest,
    });
    const matches = await lookup(parseCapability('mcp:foo'));
    expect(matches).toEqual([]);
    // readManifest sollte nie aufgerufen werden weil fetch fehlschlug
    expect(readManifest).not.toHaveBeenCalled();
  });

  it('toleriert Manifest-Parse-Fehler pro Plugin ohne Gesamt-Crash', async () => {
    const registry = makeRegistry();
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('fake-tar'), { status: 200 }));
    const readManifest = vi.fn(
      async (): Promise<ManifestReadResult> => ({
        ok: false,
        reason: 'plugin.json failed to parse: simulated',
      }),
    );
    const lookup = createMarketplaceProviderLookup({
      registry,
      cacheDir,
      fetch: fetchImpl,
      readManifest,
    });
    const matches = await lookup(parseCapability('mcp:foo'));
    expect(matches).toEqual([]);
  });

  it('cached Index-Build — zweiter Call laeuft ohne erneutes Fetch', async () => {
    const registry = makeRegistry();
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('fake-tar'), { status: 200 }));
    const readManifest = vi.fn(
      async (): Promise<ManifestReadResult> => ({
        ok: true,
        manifest: { id: 'mcp-foo', version: '1.0.0', provides: ['mcp:foo'] },
      }),
    );
    const lookup = createMarketplaceProviderLookup({
      registry,
      cacheDir,
      fetch: fetchImpl,
      readManifest,
    });
    await lookup(parseCapability('mcp:foo'));
    const fetchCallsAfterFirstCall = fetchImpl.mock.calls.length;
    await lookup(parseCapability('mcp:bar'));
    expect(fetchImpl.mock.calls.length).toBe(fetchCallsAfterFirstCall);
  });

  it('throws wenn keine fetch-Implementation verfuegbar', () => {
    const registry = makeRegistry();
    const realFetch = globalThis.fetch;
    (globalThis as { fetch?: unknown }).fetch = undefined;
    try {
      expect(() =>
        createMarketplaceProviderLookup({
          registry,
          cacheDir,
        }),
      ).toThrow(/fetch implementation/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
