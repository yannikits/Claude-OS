import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanTarballCache,
  DEFAULT_TARBALL_RETENTION_MS,
} from '../../../src/domains/catalog/index.js';

describe('cleanTarballCache', () => {
  let tmpBase: string;
  let cacheDir: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-clean-'));
    cacheDir = join(tmpBase, 'cache');
    mkdirSync(cacheDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  function makeTarball(name: string, ageDays: number, sizeBytes = 128): string {
    const path = join(cacheDir, `${name}.tar.gz`);
    writeFileSync(path, Buffer.alloc(sizeBytes));
    const time = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    utimesSync(path, time, time);
    return path;
  }

  it('returns zeros when cache dir is missing', () => {
    const r = cleanTarballCache({
      cacheDir: join(tmpBase, 'missing'),
      maxAgeMs: DEFAULT_TARBALL_RETENTION_MS,
    });
    expect(r.removedCount).toBe(0);
    expect(r.remainingCount).toBe(0);
  });

  it('removes tarballs older than the retention window', () => {
    makeTarball('old1', 60);
    makeTarball('old2', 45);
    const r = cleanTarballCache({ cacheDir, maxAgeMs: DEFAULT_TARBALL_RETENTION_MS });
    expect(r.removedCount).toBe(2);
    expect(r.remainingCount).toBe(0);
    expect(r.removedBytes).toBe(256);
  });

  it('keeps tarballs newer than the retention window', () => {
    makeTarball('fresh', 1);
    const r = cleanTarballCache({ cacheDir, maxAgeMs: DEFAULT_TARBALL_RETENTION_MS });
    expect(r.removedCount).toBe(0);
    expect(r.remainingCount).toBe(1);
  });

  it('mixes old + new correctly', () => {
    makeTarball('old', 60);
    makeTarball('fresh', 1);
    const r = cleanTarballCache({ cacheDir, maxAgeMs: DEFAULT_TARBALL_RETENTION_MS });
    expect(r.removedCount).toBe(1);
    expect(r.remainingCount).toBe(1);
    expect(existsSync(join(cacheDir, 'fresh.tar.gz'))).toBe(true);
    expect(existsSync(join(cacheDir, 'old.tar.gz'))).toBe(false);
  });

  it('ignores non-tarball files', () => {
    makeTarball('a', 60);
    writeFileSync(join(cacheDir, 'notes.txt'), 'leave me');
    writeFileSync(join(cacheDir, 'partial.tmp-xyz'), 'leave me');
    cleanTarballCache({ cacheDir, maxAgeMs: DEFAULT_TARBALL_RETENTION_MS });
    expect(existsSync(join(cacheDir, 'notes.txt'))).toBe(true);
    expect(existsSync(join(cacheDir, 'partial.tmp-xyz'))).toBe(true);
  });

  it('honours injected now()', () => {
    const path = makeTarball('marker', 0);
    const fixed = new Date(Date.now() + 1_000_000_000);
    const r = cleanTarballCache({
      cacheDir,
      maxAgeMs: 1,
      now: () => fixed,
    });
    expect(r.removedCount).toBe(1);
    expect(existsSync(path)).toBe(false);
  });
});
