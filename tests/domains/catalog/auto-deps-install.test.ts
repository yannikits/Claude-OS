/**
 * v1.5+ marketplace-initial-source extension: tests fuer
 * `installFromGithubWithAutoDeps`.
 *
 * Die volle Happy-Path-Pipeline (Marketplace -> Github -> Tarball ->
 * Manifest-Peek -> Resolution -> applyLock) braucht echte Netzwerk-Calls
 * und wird auf RPC-Layer-Ebene in `tests/sidecar/methods-installAutoDeps`
 * abgedeckt. Hier fokussieren wir die zwei neuen v1.5+ Aspekte:
 *
 *  1. `parsedGithubToSourceString` (pure helper, round-trip property).
 *  2. Marketplace:Initial-Source-Resolution error-paths — die brauchen
 *     keinen echten Netzwerk-Call, weil sie *vor* dem Tarball-Fetch
 *     throwen sollen.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AutoDepsInstallError,
  installFromGithubWithAutoDeps,
  type MarketplaceRegistryFile,
  type ParsedGithubSource,
  parsedGithubToSourceString,
} from '../../../src/domains/catalog/index.js';

describe('parsedGithubToSourceString', () => {
  it('rendert github:owner/repo ohne ref oder subPath', () => {
    const parsed: ParsedGithubSource = {
      kind: 'github',
      raw: 'github:foo/bar',
      owner: 'foo',
      repo: 'bar',
    };
    expect(parsedGithubToSourceString(parsed)).toBe('github:foo/bar');
  });

  it('haengt @ref an wenn vorhanden', () => {
    const parsed: ParsedGithubSource = {
      kind: 'github',
      raw: 'marketplace:mp:plugin',
      owner: 'foo',
      repo: 'bar',
      ref: 'main',
    };
    expect(parsedGithubToSourceString(parsed)).toBe('github:foo/bar@main');
  });

  it('haengt :subPath an wenn vorhanden', () => {
    const parsed: ParsedGithubSource = {
      kind: 'github',
      raw: 'marketplace:mp:plugin',
      owner: 'foo',
      repo: 'bar',
      subPath: 'sub/dir',
    };
    expect(parsedGithubToSourceString(parsed)).toBe('github:foo/bar:sub/dir');
  });

  it('haengt @ref UND :subPath in dieser Reihenfolge an', () => {
    const parsed: ParsedGithubSource = {
      kind: 'github',
      raw: 'marketplace:mp:plugin',
      owner: 'foo',
      repo: 'bar',
      ref: 'v1.2.3',
      subPath: 'pkg',
    };
    // Order matches source-resolver.parseSource — ref before subPath.
    expect(parsedGithubToSourceString(parsed)).toBe('github:foo/bar@v1.2.3:pkg');
  });
});

describe('installFromGithubWithAutoDeps — marketplace: initial source', () => {
  let tmpBase: string;
  let tmpRoot: string;
  let cacheDir: string;
  let registryPath: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-adi-'));
    tmpRoot = join(tmpBase, 'root');
    cacheDir = join(tmpBase, 'cache');
    registryPath = join(tmpBase, 'registry.json');
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(join(tmpRoot, 'config'), { recursive: true });
    writeFileSync(join(tmpRoot, '.claude-os-root'), '');
    mkdirSync(cacheDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  function writeRegistry(payload: MarketplaceRegistryFile | unknown): void {
    writeFileSync(registryPath, JSON.stringify(payload));
  }

  it('throws marketplace-resolution wenn Registry-Datei nicht existiert', async () => {
    const missingRegistry = join(tmpBase, 'does-not-exist.json');
    await expect(
      installFromGithubWithAutoDeps({
        source: 'marketplace:foo:bar',
        registryPath: missingRegistry,
        root: tmpRoot,
        cacheDir,
        dryRun: true,
      }),
    ).rejects.toMatchObject({
      name: 'AutoDepsInstallError',
      code: 'marketplace-resolution',
    });
  });

  it('throws marketplace-resolution wenn marketplace unbekannt', async () => {
    writeRegistry({
      version: 1,
      marketplaces: {
        'known-mp': {
          source: 'github:foo/bar',
          plugins: { p1: {} },
        },
      },
    });
    await expect(
      installFromGithubWithAutoDeps({
        source: 'marketplace:unknown-mp:p1',
        registryPath,
        root: tmpRoot,
        cacheDir,
        dryRun: true,
      }),
    ).rejects.toMatchObject({
      name: 'AutoDepsInstallError',
      code: 'marketplace-resolution',
    });
  });

  it('throws marketplace-resolution wenn plugin im Marketplace unbekannt', async () => {
    writeRegistry({
      version: 1,
      marketplaces: {
        mymp: {
          source: 'github:foo/bar',
          plugins: { 'real-plugin': {} },
        },
      },
    });
    let err: unknown;
    try {
      await installFromGithubWithAutoDeps({
        source: 'marketplace:mymp:ghost-plugin',
        registryPath,
        root: tmpRoot,
        cacheDir,
        dryRun: true,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AutoDepsInstallError);
    expect((err as AutoDepsInstallError).code).toBe('marketplace-resolution');
    expect((err as AutoDepsInstallError).message).toMatch(/marketplace:mymp:ghost-plugin/);
  });

  it('marketplace:initial source kommt am marketplace-Schritt vorbei (failt erst beim target-fetch)', async () => {
    // Registry resolved zu github:owner/nonexistent-repo-xyz — der
    // tatsaechliche Tarball-Fetch wird HTTP-404 zurueckkriegen. Wir
    // verifizieren nur dass der marketplace-resolution-Schritt OK ist
    // (Fehler-Code ist NICHT marketplace-resolution).
    writeRegistry({
      version: 1,
      marketplaces: {
        mp1: {
          source: 'github:nonexistent-org-12345/nonexistent-repo-67890',
          plugins: { p1: {} },
        },
      },
    });
    let err: unknown;
    try {
      await installFromGithubWithAutoDeps({
        source: 'marketplace:mp1:p1',
        registryPath,
        root: tmpRoot,
        cacheDir,
        dryRun: true,
      });
    } catch (e) {
      err = e;
    }
    // Wir erwarten einen Fehler — aber NICHT marketplace-resolution.
    // target-fetch (HTTP-404) ODER target-manifest (Tarball-leer/
    // malformed) sind beide akzeptabel.
    expect(err).toBeInstanceOf(AutoDepsInstallError);
    expect((err as AutoDepsInstallError).code).not.toBe('marketplace-resolution');
    expect((err as AutoDepsInstallError).code).not.toBe('unsupported-source');
  }, 30_000); // network-roundtrip — generous timeout
});
