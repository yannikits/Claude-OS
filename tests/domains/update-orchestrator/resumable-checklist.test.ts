import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResumableChecklist } from '../../../src/domains/update-orchestrator/index.js';

describe('ResumableChecklist', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-os-chk-'));
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('create writes the initial markdown header', () => {
    const fixed = new Date('2026-05-17T08:00:00.123Z');
    const chk = ResumableChecklist.create({
      dir,
      scope: 'skills',
      total: 3,
      now: () => fixed,
    });
    const raw = readFileSync(chk.filePath, 'utf8');
    expect(raw).toContain('# claude-os update checklist');
    expect(raw).toContain('- timestamp: 2026-05-17T08-00-00-123Z');
    expect(raw).toContain('- scope: skills');
    expect(raw).toContain('- status: in-progress');
    expect(raw).toContain('- total: 3');
    expect(chk.filePath).toMatch(/upgrade-checklist-2026-05-17T08-00-00-123Z\.md$/);
  });

  it('markDone appends an [x] line and persists atomically', () => {
    const chk = ResumableChecklist.create({ dir, scope: 'skills', total: 2 });
    chk.markDone('a/SKILL.md', 'upgrade');
    chk.markDone('b/SKILL.md', 'keep');
    const raw = readFileSync(chk.filePath, 'utf8');
    expect(raw).toContain('- [x] a/SKILL.md → upgrade');
    expect(raw).toContain('- [x] b/SKILL.md → keep');
    expect(chk.isDone('a/SKILL.md')).toBe(true);
    expect(chk.isDone('b/SKILL.md')).toBe(true);
    expect(chk.isDone('c/SKILL.md')).toBe(false);
  });

  it('load round-trips a persisted file', () => {
    const original = ResumableChecklist.create({
      dir,
      scope: 'skills',
      total: 5,
      now: () => new Date('2026-05-17T08:00:00.000Z'),
    });
    original.markDone('a/SKILL.md', 'upgrade');
    original.markDone('b/SKILL.md', 'skip');

    const reloaded = ResumableChecklist.load(original.filePath);
    expect(reloaded).not.toBeNull();
    const snap = reloaded?.snapshot();
    expect(snap?.scope).toBe('skills');
    expect(snap?.total).toBe(5);
    expect(snap?.status).toBe('in-progress');
    expect(snap?.done.get('a/SKILL.md')).toBe('upgrade');
    expect(snap?.done.get('b/SKILL.md')).toBe('skip');
  });

  it('load returns null on missing file', () => {
    expect(ResumableChecklist.load(join(dir, 'no-such.md'))).toBeNull();
  });

  it('load returns null on malformed content', () => {
    const path = join(dir, 'upgrade-checklist-bad.md');
    writeFileSync(path, '# just a title\nno header lines\n');
    expect(ResumableChecklist.load(path)).toBeNull();
  });

  it('pendingFiles excludes done entries', () => {
    const chk = ResumableChecklist.create({ dir, scope: 'skills', total: 3 });
    chk.markDone('a.md', 'upgrade');
    expect(chk.pendingFiles(['a.md', 'b.md', 'c.md'])).toEqual(['b.md', 'c.md']);
  });

  it('complete switches status to complete and persists', () => {
    const chk = ResumableChecklist.create({ dir, scope: 'skills', total: 1 });
    chk.complete();
    const raw = readFileSync(chk.filePath, 'utf8');
    expect(raw).toContain('- status: complete');
  });

  it('loadLatest skips complete checklists by default', () => {
    const old = ResumableChecklist.create({
      dir,
      scope: 'skills',
      total: 1,
      now: () => new Date('2026-05-17T08:00:00.000Z'),
    });
    old.complete();
    expect(ResumableChecklist.loadLatest(dir, 'skills')).toBeNull();
    expect(ResumableChecklist.loadLatest(dir, 'skills', { includeComplete: true })).not.toBeNull();
  });

  it('loadLatest picks the most recent in-progress checklist for scope', () => {
    const a = ResumableChecklist.create({
      dir,
      scope: 'skills',
      total: 1,
      now: () => new Date('2026-05-17T08:00:00.000Z'),
    });
    const b = ResumableChecklist.create({
      dir,
      scope: 'skills',
      total: 1,
      now: () => new Date('2026-05-17T09:00:00.000Z'),
    });
    ResumableChecklist.create({
      dir,
      scope: 'plugins',
      total: 1,
      now: () => new Date('2026-05-17T10:00:00.000Z'),
    });
    const latest = ResumableChecklist.loadLatest(dir, 'skills');
    expect(latest?.filePath).toBe(b.filePath);
    expect(latest?.filePath).not.toBe(a.filePath);
  });

  it('loadLatest returns null when dir does not exist', () => {
    expect(ResumableChecklist.loadLatest(join(dir, 'nope'), 'skills')).toBeNull();
  });

  it('abandon removes the file', () => {
    const chk = ResumableChecklist.create({ dir, scope: 'skills', total: 1 });
    expect(existsSync(chk.filePath)).toBe(true);
    chk.abandon();
    expect(existsSync(chk.filePath)).toBe(false);
  });

  it('abandon is idempotent', () => {
    const chk = ResumableChecklist.create({ dir, scope: 'skills', total: 1 });
    chk.abandon();
    expect(() => chk.abandon()).not.toThrow();
  });
});
