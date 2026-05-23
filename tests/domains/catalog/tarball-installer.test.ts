import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create as tarCreate } from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFromTarball, TarballInstallError } from '../../../src/domains/catalog/index.js';

/**
 * Builds a real .tar.gz fixture containing a tiny synthetic skill
 * package. Returns the bytes + sha256 so tests can drive
 * installFromTarball with a controlled archive.
 */
async function buildSyntheticTarball(tmpBase: string): Promise<{ bytes: Buffer; sha256: string }> {
  const stagingDir = join(tmpBase, 'staging');
  const skillDir = join(stagingDir, 'thinking-partner');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# Thinking Partner\n\nSynthetic skill body.\n');
  const archivePath = join(tmpBase, 'src.tar.gz');
  await tarCreate({ gzip: true, file: archivePath, cwd: stagingDir }, ['thinking-partner']);
  const bytes = readFileSync(archivePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex').toLowerCase();
  return { bytes, sha256 };
}

function makeFetch(
  payload: Buffer,
  status = 200,
): {
  fn: (url: string) => Promise<Response>;
  callCount: () => number;
} {
  let calls = 0;
  return {
    fn: (_url: string): Promise<Response> => {
      calls += 1;
      return Promise.resolve(
        new Response(payload, {
          status,
          headers: { 'content-type': 'application/gzip' },
        }),
      );
    },
    callCount: () => calls,
  };
}

describe('installFromTarball', () => {
  let tmpBase: string;
  let cacheDir: string;
  let destination: string;
  let bytes: Buffer;
  let sha256: string;

  beforeEach(async () => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-tar-'));
    cacheDir = join(tmpBase, 'cache');
    destination = join(tmpBase, 'dest');
    const fixture = await buildSyntheticTarball(tmpBase);
    bytes = fixture.bytes;
    sha256 = fixture.sha256;
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  it('downloads, caches by sha256, and extracts to destination', async () => {
    const { fn } = makeFetch(bytes);
    const result = await installFromTarball({
      url: 'https://example.test/archive.tar.gz',
      cacheDir,
      destination,
      fetchFn: fn,
    });
    expect(result.sha256).toBe(sha256);
    expect(result.alreadyCached).toBe(false);
    expect(result.bytesDownloaded).toBe(bytes.length);
    expect(result.cachedPath).toBe(join(cacheDir, `${sha256}.tar.gz`));
    expect(existsSync(result.cachedPath)).toBe(true);
    expect(existsSync(join(destination, 'thinking-partner', 'SKILL.md'))).toBe(true);
  });

  it('reuses the cache on a second install with the same expectedSha256 (no network)', async () => {
    const first = makeFetch(bytes);
    await installFromTarball({
      url: 'https://example.test/a.tar.gz',
      cacheDir,
      destination,
      expectedSha256: sha256,
      fetchFn: first.fn,
    });
    expect(first.callCount()).toBe(1);

    const second = makeFetch(bytes);
    const reused = await installFromTarball({
      url: 'https://example.test/a.tar.gz',
      cacheDir,
      destination: join(tmpBase, 'dest-2'),
      expectedSha256: sha256,
      fetchFn: second.fn,
    });
    expect(reused.alreadyCached).toBe(true);
    expect(reused.bytesDownloaded).toBe(0);
    expect(second.callCount()).toBe(0);
    expect(existsSync(join(tmpBase, 'dest-2', 'thinking-partner', 'SKILL.md'))).toBe(true);
  });

  it('throws on sha256 mismatch when expectedSha256 is supplied', async () => {
    const { fn } = makeFetch(bytes);
    await expect(
      installFromTarball({
        url: 'https://example.test/a.tar.gz',
        cacheDir,
        destination,
        expectedSha256: 'a'.repeat(64),
        fetchFn: fn,
      }),
    ).rejects.toThrow(TarballInstallError);
  });

  it('throws on HTTP error status', async () => {
    const { fn } = makeFetch(Buffer.from('not found'), 404);
    await expect(
      installFromTarball({
        url: 'https://example.test/missing.tar.gz',
        cacheDir,
        destination,
        fetchFn: fn,
      }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('throws on fetch rejection', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('socket reset'));
    await expect(
      installFromTarball({
        url: 'https://example.test/a.tar.gz',
        cacheDir,
        destination,
        fetchFn: fn as unknown as (url: string) => Promise<Response>,
      }),
    ).rejects.toThrow(/socket reset/);
  });

  it('detects and recovers from a corrupt cache entry', async () => {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, `${sha256}.tar.gz`), 'CORRUPT');
    const { fn, callCount } = makeFetch(bytes);
    const result = await installFromTarball({
      url: 'https://example.test/a.tar.gz',
      cacheDir,
      destination,
      expectedSha256: sha256,
      fetchFn: fn,
    });
    expect(callCount()).toBe(1);
    expect(result.alreadyCached).toBe(false);
    expect(readFileSync(result.cachedPath).equals(bytes)).toBe(true);
  });

  describe('M4 — Host-Allowlist (default fetch only)', () => {
    /**
     * Diese Tests benutzen explizit KEIN fetchFn-Injection — damit der
     * Production-Pfad mit dem URL-Allowlist-Check getroffen wird. Da
     * wir die default fetch nicht reichen lassen wollen (Netzwerk-
     * Aufruf), reicht der Check VOR der fetch und failt vorher.
     */
    it('refused non-allowlist https-host vor jedem network call', async () => {
      await expect(
        installFromTarball({
          url: 'https://attacker.example.com/tarball.tar.gz',
          cacheDir,
          destination,
          // KEIN fetchFn → triggert M4-Check
        }),
      ).rejects.toThrow(/refused tarball URL.*host "attacker.example.com" not in allowlist/);
    });

    it('refused http: scheme (downgrade-attacks)', async () => {
      await expect(
        installFromTarball({
          url: 'http://codeload.github.com/owner/repo/tar.gz/HEAD',
          cacheDir,
          destination,
        }),
      ).rejects.toThrow(/refused tarball URL.*protocol "http:" requires https: or file:/);
    });

    it('akzeptiert codeload.github.com per default', async () => {
      // URL ist valid, aber der echte fetch wuerde HTTP-404 retournen
      // (das ist OK — wir verifizieren nur dass der Allowlist-Check
      // PASSED, NICHT dass der fetch erfolgreich ist).
      // Default-fetch wird ausgeloest, der Test failt mit network-
      // bezogenem Error (NICHT mit "refused tarball URL").
      let err: unknown;
      try {
        await installFromTarball({
          url: 'https://codeload.github.com/nonexistent-org-12345/nonexistent-repo-xyz/tar.gz/HEAD',
          cacheDir,
          destination,
        });
      } catch (e) {
        err = e;
      }
      // Akzeptierter Error-Typ: irgendwas anderes als URL-rejection.
      expect(err).toBeInstanceOf(TarballInstallError);
      expect((err as Error).message).not.toMatch(/refused tarball URL/);
    }, 30_000);

    it('opts.allowedHosts override erlaubt self-hosted Mirror', async () => {
      // Url-DNS-resolve schlaegt fehl (Hostname existiert nicht) — wir
      // verifizieren nur dass der M4-Allowlist-Check passierte und der
      // network-fetch zur Stage kam.
      let err: unknown;
      try {
        await installFromTarball({
          url: 'https://my.mirror.org.nonexistent-tld-99/owner/repo.tar.gz',
          cacheDir,
          destination,
          allowedHosts: ['my.mirror.org.nonexistent-tld-99'],
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TarballInstallError);
      expect((err as Error).message).not.toMatch(/refused tarball URL/);
    }, 30_000);

    it('file:// schema ist immer erlaubt (ohne allowlist-check)', async () => {
      // file://-URL zu nicht-existierender Datei → network-fetch-error
      // aber NICHT URL-rejection.
      let err: unknown;
      try {
        await installFromTarball({
          url: 'file:///nonexistent/path/tarball.tar.gz',
          cacheDir,
          destination,
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TarballInstallError);
      expect((err as Error).message).not.toMatch(/refused tarball URL/);
    });

    it('opts.allowedHosts = [] deaktiviert den check (caller takes responsibility)', async () => {
      let err: unknown;
      try {
        await installFromTarball({
          url: 'https://any.host.example.test/tarball.tar.gz',
          cacheDir,
          destination,
          allowedHosts: [],
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TarballInstallError);
      expect((err as Error).message).not.toMatch(/refused tarball URL/);
    }, 30_000);
  });
});
