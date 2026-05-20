import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create as tarCreate } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NO_MANIFEST,
  readPluginManifestFromTarball,
} from '../../../src/domains/catalog/tarball-manifest-reader.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'claude-os-tarball-reader-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Build a real gzipped tar containing the given files (key = path
 * inside the wrapper dir, value = file contents). The wrapper dir
 * mimics the GitHub tarball layout (`<repo>-<sha>/...`), so reading
 * with the default `stripComponents: 1` lands on the inner path.
 */
async function buildTarball(wrapperDir: string, files: Record<string, string>): Promise<string> {
  const stage = mkdtempSync(join(tmpdir(), 'claude-os-tarball-stage-'));
  try {
    const root = join(stage, wrapperDir);
    mkdirSync(root, { recursive: true });
    for (const [relPath, contents] of Object.entries(files)) {
      const abs = join(root, relPath);
      const dir = abs.substring(
        0,
        abs.lastIndexOf('/') === -1 ? abs.lastIndexOf('\\') : abs.lastIndexOf('/'),
      );
      if (dir && dir !== root) mkdirSync(dir, { recursive: true });
      writeFileSync(abs, contents, 'utf8');
    }
    const archive = join(workDir, `${wrapperDir}.tar.gz`);
    await tarCreate(
      {
        file: archive,
        gzip: true,
        cwd: stage,
      },
      [wrapperDir],
    );
    return archive;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

describe('readPluginManifestFromTarball — happy path', () => {
  it('parses a well-formed plugin.json under the github wrapper directory', async () => {
    const archive = await buildTarball('acme-sample-1234567', {
      'plugin.json': JSON.stringify({
        id: 'acme-sample',
        version: '1.2.3',
        requires: ['mcp:redis>=2.0.0'],
        provides: ['skill:acme-sample=1.2.3'],
      }),
      'README.md': '# acme-sample',
    });
    const result = await readPluginManifestFromTarball(archive);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest).toEqual({
        id: 'acme-sample',
        version: '1.2.3',
        requires: ['mcp:redis>=2.0.0'],
        provides: ['skill:acme-sample=1.2.3'],
      });
    }
  });

  it('accepts manifests that omit requires/provides (leaf plugins)', async () => {
    const archive = await buildTarball('leaf-plugin-0', {
      'plugin.json': JSON.stringify({ id: 'leaf', version: '0.1.0' }),
    });
    const result = await readPluginManifestFromTarball(archive);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe('leaf');
      expect(result.manifest.version).toBe('0.1.0');
      expect(result.manifest.requires).toBeUndefined();
      expect(result.manifest.provides).toBeUndefined();
    }
  });

  it('honours a custom stripComponents value of 0 (no wrapper)', async () => {
    const stage = mkdtempSync(join(tmpdir(), 'claude-os-no-wrapper-'));
    try {
      writeFileSync(
        join(stage, 'plugin.json'),
        JSON.stringify({ id: 'no-wrap', version: '1.0.0' }),
        'utf8',
      );
      const archive = join(workDir, 'no-wrapper.tar.gz');
      await tarCreate({ file: archive, gzip: true, cwd: stage }, ['plugin.json']);
      const result = await readPluginManifestFromTarball(archive, { stripComponents: 0 });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.manifest.id).toBe('no-wrap');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
});

describe('readPluginManifestFromTarball — degraded paths', () => {
  it('returns NO_MANIFEST when the archive does not contain a plugin.json', async () => {
    const archive = await buildTarball('no-manifest-here', {
      'README.md': '# nothing to see',
    });
    const result = await readPluginManifestFromTarball(archive);
    expect(result).toEqual(NO_MANIFEST);
  });

  it('reports JSON parse failures via the result.reason channel', async () => {
    const archive = await buildTarball('bad-json', {
      'plugin.json': '{ not real json',
    });
    const result = await readPluginManifestFromTarball(archive);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/parse/i);
  });

  it('reports schema violations via the result.reason channel', async () => {
    const archive = await buildTarball('schema-bad', {
      'plugin.json': JSON.stringify({ id: 'x', version: 'not-a-version' }),
    });
    const result = await readPluginManifestFromTarball(archive);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/schema/i);
  });

  it('ignores plugin.json in nested subdirectories (only top-level wins)', async () => {
    const archive = await buildTarball('nested-only', {
      'docs/plugin.json': JSON.stringify({ id: 'nested', version: '1.0.0' }),
      'README.md': '# wrong location',
    });
    const result = await readPluginManifestFromTarball(archive);
    expect(result).toEqual(NO_MANIFEST);
  });
});

describe('readPluginManifestFromTarball — IO errors', () => {
  it('rejects when the tarball path does not exist', async () => {
    const missing = join(workDir, 'does-not-exist.tar.gz');
    await expect(readPluginManifestFromTarball(missing)).rejects.toThrow();
  });
});
