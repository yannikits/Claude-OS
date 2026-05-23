import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyTree } from '../../../src/domains/migration/index.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'claude-os-migrate-copy-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('copyTree — happy path', () => {
  it('kopiert ein einfaches Verzeichnis rekursiv', async () => {
    const src = join(workDir, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'a.txt'), 'Hallo', 'utf8');
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, 'sub', 'b.txt'), 'Welt', 'utf8');

    const dst = join(workDir, 'dst');
    const stats = await copyTree({ source: src, destination: dst, exclude: [] });

    expect(stats.filesCopied).toBe(2);
    expect(readFileSync(join(dst, 'a.txt'), 'utf8')).toBe('Hallo');
    expect(readFileSync(join(dst, 'sub', 'b.txt'), 'utf8')).toBe('Welt');
    expect(stats.bytesCopied).toBeGreaterThan(0);
  });

  it('schließt einzelne Sub-Trees per exclude-Pattern aus', async () => {
    const src = join(workDir, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'keep.txt'), 'k', 'utf8');
    mkdirSync(join(src, 'cache'), { recursive: true });
    writeFileSync(join(src, 'cache', 'noisy.log'), 'big', 'utf8');

    const dst = join(workDir, 'dst');
    const stats = await copyTree({
      source: src,
      destination: dst,
      exclude: ['cache', 'cache/**'],
    });

    expect(existsSync(join(dst, 'keep.txt'))).toBe(true);
    expect(existsSync(join(dst, 'cache'))).toBe(false);
    expect(stats.excludedPaths.some((p) => p.startsWith('cache'))).toBe(true);
  });

  it('respektiert Glob-Patterns mit *', async () => {
    const src = join(workDir, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'a.json'), '{}', 'utf8');
    writeFileSync(join(src, 'a.log'), 'log', 'utf8');
    writeFileSync(join(src, 'a.txt'), 'txt', 'utf8');

    const dst = join(workDir, 'dst');
    await copyTree({ source: src, destination: dst, exclude: ['*.log'] });

    expect(existsSync(join(dst, 'a.json'))).toBe(true);
    expect(existsSync(join(dst, 'a.txt'))).toBe(true);
    expect(existsSync(join(dst, 'a.log'))).toBe(false);
  });

  it('n7: literal `{` und `}` in Filenames + Excludes funktionieren als plain chars', async () => {
    const src = join(workDir, 'src');
    mkdirSync(src, { recursive: true });
    // Filenames mit literalem `{`/`}` — vorher: globToRegex wuerde die als
    // Regex-Quantifier interpretieren und crash/falsch-matchen.
    writeFileSync(join(src, 'note{1}.md'), 'one', 'utf8');
    writeFileSync(join(src, 'note{1,2}.md'), 'multi', 'utf8');
    writeFileSync(join(src, 'plain.md'), 'plain', 'utf8');

    const dst = join(workDir, 'dst');
    // Exclude mit literalem `{}` — sollte als Plain-String matched werden,
    // NICHT als Regex-Quantifier (was syntax-errorn wuerde).
    await copyTree({ source: src, destination: dst, exclude: ['note{1,2}.md'] });

    expect(existsSync(join(dst, 'note{1}.md'))).toBe(true);
    expect(existsSync(join(dst, 'plain.md'))).toBe(true);
    expect(existsSync(join(dst, 'note{1,2}.md'))).toBe(false);
  });

  it('verweigert Default das Überschreiben einer bestehenden Ziel-Datei', async () => {
    const src = join(workDir, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'a.txt'), 'V2', 'utf8');
    const dst = join(workDir, 'dst');
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, 'a.txt'), 'EXISTING', 'utf8');
    await expect(copyTree({ source: src, destination: dst, exclude: [] })).rejects.toThrow();
    expect(readFileSync(join(dst, 'a.txt'), 'utf8')).toBe('EXISTING');
  });

  it('überschreibt mit overwrite:true und ist dann idempotent', async () => {
    const src = join(workDir, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'a.txt'), 'V1', 'utf8');
    const dst = join(workDir, 'dst');
    await copyTree({ source: src, destination: dst, exclude: [] });
    const stats2 = await copyTree({
      source: src,
      destination: dst,
      exclude: [],
      overwrite: true,
    });
    expect(stats2.filesCopied).toBe(1);
    expect(readFileSync(join(dst, 'a.txt'), 'utf8')).toBe('V1');
  });

  it('matcht Glob-Patterns auch case-insensitiv für Subtrees mit unterschiedlicher Case', async () => {
    const src = join(workDir, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'keep.txt'), 'k', 'utf8');
    mkdirSync(join(src, 'CACHE'), { recursive: true });
    writeFileSync(join(src, 'CACHE', 'noisy.log'), 'big', 'utf8');
    const dst = join(workDir, 'dst');
    // Exclude in lower case — sollte auf Windows die CACHE/ ebenfalls erwischen.
    await copyTree({ source: src, destination: dst, exclude: ['cache', 'cache/**'] });
    expect(existsSync(join(dst, 'keep.txt'))).toBe(true);
    if (process.platform === 'win32') {
      expect(existsSync(join(dst, 'CACHE'))).toBe(false);
    }
  });
});
