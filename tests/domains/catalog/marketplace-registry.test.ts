import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fileLoader,
  MarketplaceRegistry,
  MarketplaceRegistryError,
  type MarketplaceRegistryFile,
} from '../../../src/domains/catalog/index.js';

describe('MarketplaceRegistry + fileLoader', () => {
  let tmpBase: string;
  let registryPath: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-mreg-'));
    registryPath = join(tmpBase, 'registry.json');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  function writeRegistry(payload: MarketplaceRegistryFile | unknown): void {
    writeFileSync(registryPath, JSON.stringify(payload));
  }

  function exampleRegistry(): MarketplaceRegistryFile {
    return {
      version: 1,
      marketplaces: {
        claudesidian: {
          source: 'github:heyitsnoah/claudesidian',
          plugins: {
            'claudesidian-pack': { path: 'skills' },
            'minimal-pack': {},
          },
        },
        custom: {
          source: 'github:owner/repo',
          ref: 'feature',
          plugins: { 'plugin-A': {} },
        },
      },
    };
  }

  it('marketplaces() returns the sorted list of names', async () => {
    writeRegistry(exampleRegistry());
    const reg = new MarketplaceRegistry({ load: fileLoader(registryPath) });
    expect(await reg.marketplaces()).toEqual(['claudesidian', 'custom']);
  });

  it('plugins(name) returns the sorted list', async () => {
    writeRegistry(exampleRegistry());
    const reg = new MarketplaceRegistry({ load: fileLoader(registryPath) });
    expect(await reg.plugins('claudesidian')).toEqual(['claudesidian-pack', 'minimal-pack']);
  });

  it('resolve() returns a github source with subPath from plugin.path', async () => {
    writeRegistry(exampleRegistry());
    const reg = new MarketplaceRegistry({ load: fileLoader(registryPath) });
    const parsed = await reg.resolve('claudesidian', 'claudesidian-pack');
    expect(parsed.kind).toBe('github');
    expect(parsed.owner).toBe('heyitsnoah');
    expect(parsed.repo).toBe('claudesidian');
    expect(parsed.subPath).toBe('skills');
  });

  it('resolve() honours marketplace-level ref', async () => {
    writeRegistry(exampleRegistry());
    const reg = new MarketplaceRegistry({ load: fileLoader(registryPath) });
    const parsed = await reg.resolve('custom', 'plugin-A');
    expect(parsed.ref).toBe('feature');
  });

  it('resolve() works for a plugin without explicit path', async () => {
    writeRegistry(exampleRegistry());
    const reg = new MarketplaceRegistry({ load: fileLoader(registryPath) });
    const parsed = await reg.resolve('claudesidian', 'minimal-pack');
    expect(parsed.subPath).toBeUndefined();
  });

  it('throws for unknown marketplace', async () => {
    writeRegistry(exampleRegistry());
    const reg = new MarketplaceRegistry({ load: fileLoader(registryPath) });
    await expect(reg.resolve('ghost', 'p')).rejects.toThrow(MarketplaceRegistryError);
  });

  it('throws for unknown plugin', async () => {
    writeRegistry(exampleRegistry());
    const reg = new MarketplaceRegistry({ load: fileLoader(registryPath) });
    await expect(reg.resolve('claudesidian', 'ghost')).rejects.toThrow(MarketplaceRegistryError);
  });

  it('throws for non-github marketplace source', async () => {
    writeRegistry({
      version: 1,
      marketplaces: {
        bad: { source: 'local:/tmp/foo', plugins: { p: {} } },
      },
    });
    const reg = new MarketplaceRegistry({ load: fileLoader(registryPath) });
    await expect(reg.resolve('bad', 'p')).rejects.toThrow(/must be github/);
  });

  it('fileLoader throws on missing file', () => {
    const reg = new MarketplaceRegistry({ load: fileLoader(join(tmpBase, 'nope.json')) });
    return expect(reg.marketplaces()).rejects.toThrow(MarketplaceRegistryError);
  });

  it('fileLoader throws on malformed JSON', () => {
    writeFileSync(registryPath, '{not json');
    const reg = new MarketplaceRegistry({ load: fileLoader(registryPath) });
    return expect(reg.marketplaces()).rejects.toThrow(/not valid JSON/);
  });

  it('fileLoader throws on invalid shape', () => {
    writeRegistry({ version: 2, marketplaces: {} });
    const reg = new MarketplaceRegistry({ load: fileLoader(registryPath) });
    return expect(reg.marketplaces()).rejects.toThrow(/invalid shape/);
  });

  it('caches the loaded registry until invalidate()', async () => {
    let loads = 0;
    const reg = new MarketplaceRegistry({
      load: () => {
        loads += 1;
        return exampleRegistry();
      },
    });
    await reg.marketplaces();
    await reg.plugins('claudesidian');
    await reg.resolve('claudesidian', 'minimal-pack');
    expect(loads).toBe(1);
    reg.invalidate();
    await reg.marketplaces();
    expect(loads).toBe(2);
  });
});
