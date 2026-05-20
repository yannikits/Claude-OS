import * as fsModule from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildMigrationPlan,
  executePlan,
  MigrationError,
} from '../../../src/domains/migration/index.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'claude-os-migrate-runner-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function makePortable(opts: { withGit?: boolean; withCache?: boolean; withEnv?: boolean }): string {
  const root = mkdtempSync(join(workDir, 'portable-'));
  mkdirSync(join(root, 'vault'), { recursive: true });
  writeFileSync(join(root, 'vault', 'note.md'), '# note', 'utf8');
  if (opts.withGit === true) {
    mkdirSync(join(root, 'vault', '.git'), { recursive: true });
    writeFileSync(join(root, 'vault', '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8');
  }
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'catalog.json'), '{}', 'utf8');
  if (opts.withCache === true) {
    mkdirSync(join(root, 'config', 'cache'), { recursive: true });
    writeFileSync(join(root, 'config', 'cache', 'noisy.bin'), 'big', 'utf8');
  }
  writeFileSync(join(root, 'start.bat'), '@echo off', 'utf8');
  if (opts.withEnv === true) {
    writeFileSync(join(root, '.env'), 'OPENAI_API_KEY=sk-x', 'utf8');
  }
  return root;
}

describe('buildMigrationPlan', () => {
  it('erstellt Plan-Steps für vault + config + git-metadata + secrets', () => {
    const source = makePortable({ withGit: true, withCache: true, withEnv: true });
    const target = mkdtempSync(join(workDir, 'target-'));
    const plan = buildMigrationPlan({ sourceRoot: source, targetRoot: target });

    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds).toContain('copy-tree');
    expect(kinds).toContain('migrate-git-metadata');
    expect(kinds).toContain('collect-secrets');
    expect(plan.targetAlreadyMigrated).toBe(false);
  });

  it('erkennt vorhandenen .claude-os-root-Marker am Ziel', () => {
    const source = makePortable({});
    const target = mkdtempSync(join(workDir, 'target-'));
    writeFileSync(join(target, '.claude-os-root'), '{}', 'utf8');
    const plan = buildMigrationPlan({ sourceRoot: source, targetRoot: target });
    expect(plan.targetAlreadyMigrated).toBe(true);
    expect(plan.notes.some((n) => n.includes('.claude-os-root-Marker'))).toBe(true);
  });
});

describe('executePlan — dryRun', () => {
  it('führt keine FS-Mutationen aus', async () => {
    const source = makePortable({ withEnv: true });
    const target = mkdtempSync(join(workDir, 'target-'));
    const plan = buildMigrationPlan({ sourceRoot: source, targetRoot: target });
    const result = await executePlan({ plan, dryRun: true });
    expect(result.success).toBe(true);
    expect(result.results.every((r) => r.status === 'skipped')).toBe(true);
    expect(existsSync(join(target, 'vault'))).toBe(false);
    expect(existsSync(join(target, 'config'))).toBe(false);
  });
});

describe('executePlan — execute', () => {
  it('kopiert vault + config und respektiert excludes (.git, cache/)', async () => {
    const source = makePortable({ withGit: true, withCache: true });
    const target = mkdtempSync(join(workDir, 'target-'));
    const plan = buildMigrationPlan({ sourceRoot: source, targetRoot: target });
    const result = await executePlan({ plan });
    expect(result.success).toBe(true);
    expect(existsSync(join(target, 'vault', 'note.md'))).toBe(true);
    expect(readFileSync(join(target, 'vault', 'note.md'), 'utf8')).toBe('# note');
    expect(existsSync(join(target, 'vault', '.git'))).toBe(false);
    expect(existsSync(join(target, 'config', 'catalog.json'))).toBe(true);
    expect(existsSync(join(target, 'config', 'cache'))).toBe(false);
  });

  it('bricht ab wenn Target bereits migriert ist und --force fehlt', async () => {
    const source = makePortable({});
    const target = mkdtempSync(join(workDir, 'target-'));
    writeFileSync(join(target, '.claude-os-root'), '{}', 'utf8');
    const plan = buildMigrationPlan({ sourceRoot: source, targetRoot: target });
    await expect(executePlan({ plan })).rejects.toThrow(MigrationError);
  });

  it('läuft mit --force durch obwohl Target bereits migriert ist', async () => {
    const source = makePortable({});
    const target = mkdtempSync(join(workDir, 'target-'));
    writeFileSync(join(target, '.claude-os-root'), '{}', 'utf8');
    const plan = buildMigrationPlan({ sourceRoot: source, targetRoot: target });
    const result = await executePlan({ plan, force: true });
    expect(result.success).toBe(true);
  });

  it('verbietet Source == Target (Selbst-Migration)', () => {
    const source = makePortable({});
    expect(() => buildMigrationPlan({ sourceRoot: source, targetRoot: source })).toThrow(
      MigrationError,
    );
  });

  it('verbietet Target innerhalb von Source', () => {
    const source = makePortable({});
    const target = join(source, 'nested');
    expect(() => buildMigrationPlan({ sourceRoot: source, targetRoot: target })).toThrow(
      /innerhalb der Quelle/,
    );
  });

  it('verbietet Source innerhalb von Target', () => {
    const target = mkdtempSync(join(workDir, 'target-outer-'));
    const innerSource = join(target, 'inner');
    // Source-Layout in innerSource erstellen (innerSource liegt INNERHALB target).
    const fs = fsModule;
    fs.mkdirSync(join(innerSource, 'vault'), { recursive: true });
    fs.writeFileSync(join(innerSource, 'vault', 'note.md'), '# n', 'utf8');
    fs.mkdirSync(join(innerSource, 'config'), { recursive: true });
    fs.writeFileSync(join(innerSource, 'start.bat'), '@echo off', 'utf8');
    expect(() => buildMigrationPlan({ sourceRoot: innerSource, targetRoot: target })).toThrow(
      /innerhalb des Ziels/,
    );
  });

  it('TOCTOU-Schutz: re-check Marker zum Execute-Zeitpunkt', async () => {
    const source = makePortable({});
    const target = mkdtempSync(join(workDir, 'target-'));
    const plan = buildMigrationPlan({ sourceRoot: source, targetRoot: target });
    // Nach Plan-Bau ist der Marker NICHT da. Jetzt landet er drin.
    writeFileSync(join(target, '.claude-os-root'), '{}', 'utf8');
    await expect(executePlan({ plan })).rejects.toThrow(MigrationError);
  });

  it('default verlustfrei — verweigert Überschreiben existierender Ziel-Dateien', async () => {
    const source = makePortable({});
    const target = mkdtempSync(join(workDir, 'target-'));
    const existing = join(target, 'vault');
    // Existierendes Vault-File am Ziel mit anderem Inhalt
    const fs = fsModule;
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(join(existing, 'note.md'), 'PRE-EXISTING', 'utf8');
    const plan = buildMigrationPlan({ sourceRoot: source, targetRoot: target });
    const result = await executePlan({ plan });
    // Erwartung: vault-copy schlägt fehl, success=false
    expect(result.success).toBe(false);
    expect(fs.readFileSync(join(existing, 'note.md'), 'utf8')).toBe('PRE-EXISTING');
  });

  it('--overwrite überschreibt explizit', async () => {
    const source = makePortable({});
    const target = mkdtempSync(join(workDir, 'target-'));
    const existing = join(target, 'vault');
    const fs = fsModule;
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(join(existing, 'note.md'), 'OLD', 'utf8');
    const plan = buildMigrationPlan({ sourceRoot: source, targetRoot: target });
    const result = await executePlan({ plan, overwrite: true });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(join(existing, 'note.md'), 'utf8')).toBe('# note');
  });

  it('produziert Hinweis-Result für migrate-git-metadata (nicht automatisch ausgeführt)', async () => {
    const source = makePortable({ withGit: true });
    const target = mkdtempSync(join(workDir, 'target-'));
    const plan = buildMigrationPlan({ sourceRoot: source, targetRoot: target });
    const result = await executePlan({ plan });
    const gitStep = result.results.find((r) => r.step.kind === 'migrate-git-metadata');
    expect(gitStep?.status).toBe('skipped');
    expect(gitStep?.message).toContain('doctor --migrate-git-metadata');
  });

  it('produziert Hinweis-Result für collect-secrets (mit Key-Liste, ohne Values)', async () => {
    const source = makePortable({ withEnv: true });
    const target = mkdtempSync(join(workDir, 'target-'));
    const plan = buildMigrationPlan({ sourceRoot: source, targetRoot: target });
    const result = await executePlan({ plan });
    const secretStep = result.results.find((r) => r.step.kind === 'collect-secrets');
    expect(secretStep?.status).toBe('skipped');
    expect(secretStep?.message).toContain('OPENAI_API_KEY');
    expect(secretStep?.message).not.toContain('sk-x');
  });
});
