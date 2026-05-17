import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BackupManager,
  backupPathFor,
  backupsDirFor,
} from '../../../src/domains/update-orchestrator/index.js';

describe('BackupManager', () => {
  let tmpBase: string;
  let backupsDir: string;
  let sourceDir: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-backup-'));
    backupsDir = join(tmpBase, 'backups');
    sourceDir = join(tmpBase, 'source-skills');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(join(sourceDir, 'thinking-partner'), { recursive: true });
    writeFileSync(join(sourceDir, 'thinking-partner', 'SKILL.md'), '# Thinking\n');
    mkdirSync(join(sourceDir, 'daily-review'), { recursive: true });
    writeFileSync(join(sourceDir, 'daily-review', 'SKILL.md'), '# Daily\n');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  function makeManager(now?: () => Date): BackupManager {
    return new BackupManager({
      backupsDir,
      ...(now === undefined ? {} : { now }),
    });
  }

  it('snapshot creates a timestamped backup with recursive copy', () => {
    const fixed = new Date('2026-05-17T08:00:00.123Z');
    const mgr = makeManager(() => fixed);
    const entry = mgr.snapshot('skills', sourceDir);
    expect(entry.timestamp).toBe('2026-05-17T08-00-00-123Z');
    expect(entry.scope).toBe('skills');
    expect(entry.sourceDir).toBe(sourceDir);
    expect(entry.fileCount).toBe(2);
    expect(entry.totalBytes).toBeGreaterThan(0);
    expect(existsSync(join(entry.path, 'skills', 'thinking-partner', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(entry.path, 'skills', 'daily-review', 'SKILL.md'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(entry.path, 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest.timestamp).toBe('2026-05-17T08-00-00-123Z');
    expect(manifest.scope).toBe('skills');
  });

  it('snapshot handles a missing source dir gracefully', () => {
    const mgr = makeManager();
    const entry = mgr.snapshot('skills', join(tmpBase, 'does-not-exist'));
    expect(entry.fileCount).toBe(0);
    expect(entry.totalBytes).toBe(0);
    expect(existsSync(join(entry.path, 'skills'))).toBe(true);
  });

  it('list returns entries sorted oldest-first', () => {
    const a = makeManager(() => new Date('2026-05-17T01:00:00.000Z')).snapshot('skills', sourceDir);
    const b = makeManager(() => new Date('2026-05-17T02:00:00.000Z')).snapshot('skills', sourceDir);
    const c = makeManager(() => new Date('2026-05-17T03:00:00.000Z')).snapshot('skills', sourceDir);
    const list = makeManager().list();
    expect(list.map((e) => e.timestamp)).toEqual([a.timestamp, b.timestamp, c.timestamp]);
  });

  it('list skips entries without a manifest', () => {
    makeManager(() => new Date('2026-05-17T01:00:00.000Z')).snapshot('skills', sourceDir);
    mkdirSync(join(backupsDir, 'update-bogus'), { recursive: true });
    const list = makeManager().list();
    expect(list.length).toBe(1);
  });

  it('restore "latest" copies the newest backup into destination', () => {
    makeManager(() => new Date('2026-05-17T01:00:00.000Z')).snapshot('skills', sourceDir);
    const second = makeManager(() => new Date('2026-05-17T02:00:00.000Z')).snapshot(
      'skills',
      sourceDir,
    );
    const dest = join(tmpBase, 'restored');
    const entry = makeManager().restore('latest', dest);
    expect(entry?.timestamp).toBe(second.timestamp);
    expect(existsSync(join(dest, 'thinking-partner', 'SKILL.md'))).toBe(true);
  });

  it('restore by explicit timestamp', () => {
    const first = makeManager(() => new Date('2026-05-17T01:00:00.000Z')).snapshot(
      'skills',
      sourceDir,
    );
    makeManager(() => new Date('2026-05-17T02:00:00.000Z')).snapshot('skills', sourceDir);
    const dest = join(tmpBase, 'restored');
    const entry = makeManager().restore(first.timestamp, dest);
    expect(entry?.timestamp).toBe(first.timestamp);
  });

  it('restore returns null when no backups exist', () => {
    const mgr = makeManager();
    expect(mgr.restore('latest', join(tmpBase, 'dest'))).toBeNull();
  });

  it('restore returns null for an unknown timestamp', () => {
    makeManager(() => new Date('2026-05-17T01:00:00.000Z')).snapshot('skills', sourceDir);
    const mgr = makeManager();
    expect(mgr.restore('2099-01-01T00-00-00-000Z', join(tmpBase, 'dest'))).toBeNull();
  });

  it('prune removes older backups beyond retention', () => {
    const timestamps: string[] = [];
    for (let i = 1; i <= 7; i += 1) {
      const entry = makeManager(() => new Date(`2026-05-17T0${i}:00:00.000Z`)).snapshot(
        'skills',
        sourceDir,
      );
      timestamps.push(entry.timestamp);
    }
    const removed = makeManager().prune(5);
    expect(removed.length).toBe(2);
    expect([...removed].sort()).toEqual([timestamps[0], timestamps[1]].sort());
    const remaining = makeManager().list();
    expect(remaining.length).toBe(5);
  });

  it('prune is a no-op when below retention', () => {
    makeManager(() => new Date('2026-05-17T01:00:00.000Z')).snapshot('skills', sourceDir);
    makeManager(() => new Date('2026-05-17T02:00:00.000Z')).snapshot('skills', sourceDir);
    expect(makeManager().prune(5)).toEqual([]);
  });

  it('prune throws on negative retention', () => {
    expect(() => makeManager().prune(-1)).toThrow();
  });
});

describe('backupsDirFor / backupPathFor', () => {
  it('returns the conventional <dataRoot>/backups/ path', () => {
    expect(backupsDirFor('/data')).toBe(join('/data', 'backups'));
    expect(backupPathFor('/data/backups', '2026-05-17T08-00-00-000Z')).toBe(
      join('/data/backups', 'update-2026-05-17T08-00-00-000Z'),
    );
  });
});
