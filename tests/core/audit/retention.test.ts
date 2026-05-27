import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditError,
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  pruneAuditFiles,
} from '../../../src/core/audit/index.js';

describe('pruneAuditFiles', () => {
  let dir: string;
  const fixedNow = new Date('2026-05-27T12:00:00Z');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-prune-'));
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  const seed = (filename: string, contents = '{}\n') => {
    writeFileSync(join(dir, filename), contents, 'utf8');
  };

  it('keeps files within retention window', () => {
    seed('audit-2026-05-20.jsonl'); // 7 days ago
    seed('audit-2026-05-25.jsonl'); // 2 days ago
    const result = pruneAuditFiles({
      auditDir: dir,
      retentionDays: 30,
      now: () => fixedNow,
    });
    expect(result.deleted).toEqual([]);
    expect(result.scanned).toBe(2);
    expect(existsSync(join(dir, 'audit-2026-05-20.jsonl'))).toBe(true);
  });

  it('deletes files older than retention window', () => {
    seed('audit-2026-01-01.jsonl'); // > 90 days
    seed('audit-2026-05-20.jsonl'); // within
    const result = pruneAuditFiles({
      auditDir: dir,
      retentionDays: 90,
      now: () => fixedNow,
    });
    expect(result.deleted).toContain('audit-2026-01-01.jsonl');
    expect(result.deleted).not.toContain('audit-2026-05-20.jsonl');
    expect(existsSync(join(dir, 'audit-2026-01-01.jsonl'))).toBe(false);
    expect(existsSync(join(dir, 'audit-2026-05-20.jsonl'))).toBe(true);
  });

  it('respects dry-run flag (reports but does not delete)', () => {
    seed('audit-2026-01-01.jsonl');
    const result = pruneAuditFiles({
      auditDir: dir,
      retentionDays: 90,
      now: () => fixedNow,
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.deleted).toEqual(['audit-2026-01-01.jsonl']);
    expect(existsSync(join(dir, 'audit-2026-01-01.jsonl'))).toBe(true);
  });

  it('skips non-audit files silently', () => {
    seed('audit-2026-01-01.jsonl');
    seed('audit-2026-01-01.jsonl.gz'); // archived
    seed('random.txt');
    seed('audit-2026-01-01.tmp');
    const result = pruneAuditFiles({
      auditDir: dir,
      retentionDays: 90,
      now: () => fixedNow,
    });
    expect(result.deleted).toEqual(['audit-2026-01-01.jsonl']);
    expect(result.skippedNonAudit).toBe(3);
    expect(existsSync(join(dir, 'random.txt'))).toBe(true);
    expect(existsSync(join(dir, 'audit-2026-01-01.jsonl.gz'))).toBe(true);
  });

  it('handles non-existent audit-dir gracefully', () => {
    const result = pruneAuditFiles({
      auditDir: join(dir, 'does-not-exist'),
      retentionDays: 90,
      now: () => fixedNow,
    });
    expect(result.scanned).toBe(0);
    expect(result.deleted).toEqual([]);
  });

  it('reads CLAUDE_OS_AUDIT_RETENTION_DAYS env-var when retentionDays unset', () => {
    seed('audit-2026-05-25.jsonl');
    const result = pruneAuditFiles({
      auditDir: dir,
      env: { CLAUDE_OS_AUDIT_RETENTION_DAYS: '1' } as NodeJS.ProcessEnv,
      now: () => fixedNow,
    });
    expect(result.retentionDays).toBe(1);
    expect(result.deleted).toContain('audit-2026-05-25.jsonl');
  });

  it('falls back to DEFAULT_RETENTION_DAYS when env-var malformed', () => {
    const result = pruneAuditFiles({
      auditDir: dir,
      env: { CLAUDE_OS_AUDIT_RETENTION_DAYS: 'banana' } as NodeJS.ProcessEnv,
      now: () => fixedNow,
    });
    expect(result.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('clamps retentionDays to MIN_RETENTION_DAYS', () => {
    const result = pruneAuditFiles({
      auditDir: dir,
      retentionDays: 0,
      now: () => fixedNow,
    });
    expect(result.retentionDays).toBe(MIN_RETENTION_DAYS);
  });

  it('clamps retentionDays to MAX_RETENTION_DAYS', () => {
    const result = pruneAuditFiles({
      auditDir: dir,
      retentionDays: 99999,
      now: () => fixedNow,
    });
    expect(result.retentionDays).toBe(MAX_RETENTION_DAYS);
  });

  it('cutoffIso is the retention boundary', () => {
    const result = pruneAuditFiles({
      auditDir: dir,
      retentionDays: 7,
      now: () => fixedNow,
    });
    // 7 days before fixedNow
    expect(result.cutoffIso.slice(0, 10)).toBe('2026-05-20');
  });

  it('throws AuditError when audit-dir is unreadable', () => {
    // simulate by passing a path that exists but is a file (not dir)
    const fakePath = join(dir, 'not-a-dir');
    writeFileSync(fakePath, 'x', 'utf8');
    expect(() =>
      pruneAuditFiles({
        auditDir: fakePath,
        now: () => fixedNow,
      }),
    ).toThrow(AuditError);
  });
});
