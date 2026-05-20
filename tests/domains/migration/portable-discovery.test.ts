import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverPortable, MigrationError } from '../../../src/domains/migration/index.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'claude-os-migrate-discovery-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function makePortableLayout(opts: {
  withVault?: boolean;
  withConfig?: boolean;
  withStart?: boolean;
  withEnv?: boolean;
  withPackage?: boolean;
}): string {
  const root = mkdtempSync(join(workDir, 'portable-'));
  if (opts.withVault === true) {
    mkdirSync(join(root, 'vault'), { recursive: true });
    writeFileSync(join(root, 'vault', 'notes.md'), '# notes', 'utf8');
  }
  if (opts.withConfig === true) {
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'catalog.json'), '{}', 'utf8');
  }
  if (opts.withStart === true) {
    writeFileSync(join(root, 'start.bat'), '@echo off\nrem launcher', 'utf8');
  }
  if (opts.withEnv === true) {
    writeFileSync(
      join(root, '.env'),
      'OPENAI_API_KEY=sk-redacted\nGITHUB_TOKEN=ghp-redacted',
      'utf8',
    );
  }
  if (opts.withPackage === true) {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'claude-portable', version: '0.9.3' }),
      'utf8',
    );
  }
  return root;
}

describe('discoverPortable — happy path', () => {
  it('erkennt ein vollständiges v0.x-Layout', () => {
    const root = makePortableLayout({
      withVault: true,
      withConfig: true,
      withStart: true,
      withEnv: true,
      withPackage: true,
    });
    const result = discoverPortable(root);
    expect(result.vaultDir).toBe(join(root, 'vault'));
    expect(result.configDir).toBe(join(root, 'config'));
    expect(result.envFiles).toContain('.env');
    expect(result.detectedVersion).toBe('0.9.3');
    expect(result.warnings).toEqual([]);
  });

  it('liefert detectedVersion="unknown" wenn package.json fehlt', () => {
    const root = makePortableLayout({ withVault: true, withConfig: true, withStart: true });
    const result = discoverPortable(root);
    expect(result.detectedVersion).toBe('unknown');
  });

  it('toleriert vault/ ohne config/ und produziert Warning', () => {
    const root = makePortableLayout({ withVault: true, withStart: true });
    const result = discoverPortable(root);
    expect(result.vaultDir).not.toBeNull();
    expect(result.configDir).toBeNull();
    expect(result.warnings.some((w) => w.includes('config/'))).toBe(true);
  });

  it('toleriert config/ ohne vault/ und produziert Warning', () => {
    const root = makePortableLayout({ withConfig: true, withStart: true });
    const result = discoverPortable(root);
    expect(result.vaultDir).toBeNull();
    expect(result.configDir).not.toBeNull();
    expect(result.warnings.some((w) => w.includes('vault/'))).toBe(true);
  });
});

describe('discoverPortable — Fehlerpfade', () => {
  it('wirft MigrationError wenn Pfad nicht existiert', () => {
    expect(() => discoverPortable(join(workDir, 'nope'))).toThrow(MigrationError);
  });

  it('wirft MigrationError wenn weder vault noch config noch Launcher da ist', () => {
    const root = mkdtempSync(join(workDir, 'empty-'));
    writeFileSync(join(root, 'README.md'), '# unrelated', 'utf8');
    expect(() => discoverPortable(root)).toThrow(/v0\.x-Layout/);
  });
});

describe('discoverPortable — .env-Discovery', () => {
  it('findet mehrere .env-Files in Subdirs', () => {
    const root = makePortableLayout({ withVault: true, withStart: true });
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, '.env'), 'A=1', 'utf8');
    writeFileSync(join(root, 'sub', '.env.local'), 'B=2', 'utf8');
    const result = discoverPortable(root);
    expect(result.envFiles).toContain('.env');
    expect(result.envFiles.some((f) => f.endsWith('.env.local'))).toBe(true);
  });

  it('überspringt vault/, node_modules/, .git/, bin/ bei der Suche', () => {
    const root = makePortableLayout({ withVault: true, withStart: true });
    mkdirSync(join(root, 'vault'), { recursive: true });
    writeFileSync(join(root, 'vault', '.env'), 'NEVER=1', 'utf8');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.env'), 'NEVER=1', 'utf8');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(join(root, 'bin', '.env'), 'NEVER=1', 'utf8');
    const result = discoverPortable(root);
    expect(result.envFiles.some((f) => f.includes('node_modules'))).toBe(false);
    expect(result.envFiles.some((f) => f.startsWith('vault'))).toBe(false);
    expect(result.envFiles.some((f) => f.startsWith('bin'))).toBe(false);
  });
});
