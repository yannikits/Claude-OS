import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanEnvFiles } from '../../../src/domains/migration/index.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'claude-os-migrate-secrets-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('scanEnvFiles', () => {
  it('extrahiert nur Keys, niemals Values', () => {
    writeFileSync(
      join(workDir, '.env'),
      'OPENAI_API_KEY=sk-deadbeef\nGITHUB_TOKEN=ghp-secret',
      'utf8',
    );
    const out = scanEnvFiles(workDir, ['.env']);
    expect(out.keys).toEqual(['GITHUB_TOKEN', 'OPENAI_API_KEY']);
    // Values dürfen NICHT im Output sein
    expect(JSON.stringify(out)).not.toContain('sk-deadbeef');
    expect(JSON.stringify(out)).not.toContain('ghp-secret');
  });

  it('ignoriert leere Zeilen und Kommentare', () => {
    writeFileSync(
      join(workDir, '.env'),
      ['# header', '', 'A=1', '   ', '# another', 'B=2'].join('\n'),
      'utf8',
    );
    const out = scanEnvFiles(workDir, ['.env']);
    expect(out.keys).toEqual(['A', 'B']);
  });

  it('akzeptiert shell-style "export KEY=value"', () => {
    writeFileSync(join(workDir, '.env'), 'export FOO=bar', 'utf8');
    const out = scanEnvFiles(workDir, ['.env']);
    expect(out.keys).toEqual(['FOO']);
  });

  it('protokolliert unparseable Zeilen statt sie zu verwerfen', () => {
    writeFileSync(
      join(workDir, '.env'),
      ['VALID=1', 'lower_case=nope', 'no equal sign here'].join('\n'),
      'utf8',
    );
    const out = scanEnvFiles(workDir, ['.env']);
    expect(out.keys).toEqual(['VALID']);
    expect(out.unknownLines).toHaveLength(2);
    expect(out.unknownLines[0]?.source).toBe('.env');
  });

  it('dedupliziert Keys über mehrere Dateien', () => {
    writeFileSync(join(workDir, '.env'), 'SHARED=a', 'utf8');
    writeFileSync(join(workDir, '.env.local'), 'SHARED=b\nLOCAL_ONLY=c', 'utf8');
    const out = scanEnvFiles(workDir, ['.env', '.env.local']);
    expect(out.keys).toEqual(['LOCAL_ONLY', 'SHARED']);
  });

  it('toleriert fehlende Files und meldet sie als unknownLine', () => {
    const out = scanEnvFiles(workDir, ['missing.env']);
    expect(out.keys).toEqual([]);
    expect(out.unknownLines).toHaveLength(1);
    expect(out.unknownLines[0]?.line).toContain('could not read');
  });
});
