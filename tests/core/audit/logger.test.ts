import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditError, AuditLogger } from '../../../src/core/audit/index.js';

describe('AuditLogger', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends a JSONL entry to <auditDir>/audit-YYYY-MM-DD.jsonl', () => {
    const now = new Date('2026-05-25T10:00:00.000Z');
    const logger = new AuditLogger({
      auditDir: dir,
      now: () => now,
      hostname: 'fixture-host',
    });
    const entry = logger.append({
      kind: 'workspace.switch',
      action: 'workspace.use',
      workspace: 'personal',
      outcome: 'ok',
      details: { from: 'msp-internal', to: 'personal' },
    });
    expect(entry.at).toBe('2026-05-25T10:00:00.000Z');
    expect(entry.hostname).toBe('fixture-host');

    const filePath = join(dir, 'audit-2026-05-25.jsonl');
    expect(existsSync(filePath)).toBe(true);
    const raw = readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0] ?? '{}');
    expect(parsed.kind).toBe('workspace.switch');
    expect(parsed.outcome).toBe('ok');
    expect(parsed.details).toEqual({ from: 'msp-internal', to: 'personal' });
  });

  it('appends multiple entries as separate JSONL rows', () => {
    const logger = new AuditLogger({
      auditDir: dir,
      now: () => new Date('2026-05-25T10:00:00.000Z'),
    });
    logger.append({
      kind: 'bridge.read',
      action: 'tanss.list',
      workspace: 'msp-customers/acme',
      tenant: 'acme',
      outcome: 'ok',
    });
    logger.append({
      kind: 'bridge.read',
      action: 'ninja.list',
      workspace: 'msp-customers/acme',
      tenant: 'acme',
      outcome: 'ok',
    });
    const raw = readFileSync(join(dir, 'audit-2026-05-25.jsonl'), 'utf8');
    expect(raw.split('\n').filter((l) => l.length > 0).length).toBe(2);
  });

  it('uses a different file per UTC day', () => {
    const logger1 = new AuditLogger({
      auditDir: dir,
      now: () => new Date('2026-05-25T23:59:59.000Z'),
    });
    logger1.append({
      kind: 'secret.read',
      action: 'tanss-token',
      workspace: 'personal',
      outcome: 'ok',
    });
    const logger2 = new AuditLogger({
      auditDir: dir,
      now: () => new Date('2026-05-26T00:00:01.000Z'),
    });
    logger2.append({
      kind: 'secret.read',
      action: 'tanss-token',
      workspace: 'personal',
      outcome: 'ok',
    });
    expect(existsSync(join(dir, 'audit-2026-05-25.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'audit-2026-05-26.jsonl'))).toBe(true);
  });

  it('emits tenant when provided, omits when absent', () => {
    const logger = new AuditLogger({
      auditDir: dir,
      now: () => new Date('2026-05-25T10:00:00.000Z'),
    });
    logger.append({
      kind: 'bridge.read',
      action: 'a',
      workspace: 'msp-customers/foo',
      tenant: 'foo',
      outcome: 'ok',
    });
    logger.append({ kind: 'workspace.switch', action: 'b', workspace: 'personal', outcome: 'ok' });
    const raw = readFileSync(join(dir, 'audit-2026-05-25.jsonl'), 'utf8');
    const lines = raw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    expect(lines[0].tenant).toBe('foo');
    expect(lines[1]).not.toHaveProperty('tenant');
  });

  it('uses injected sink instead of touching FS when provided', () => {
    const captured: { path: string; jsonl: string }[] = [];
    const logger = new AuditLogger({
      auditDir: dir,
      now: () => new Date('2026-05-25T10:00:00.000Z'),
      sink: (path, jsonl) => captured.push({ path, jsonl }),
    });
    logger.append({ kind: 'skill.invoke', action: 'foo', workspace: 'personal', outcome: 'ok' });
    expect(captured.length).toBe(1);
    expect(captured[0]?.path).toContain('audit-2026-05-25.jsonl');
    expect(JSON.parse(captured[0]?.jsonl.trim() ?? '{}').kind).toBe('skill.invoke');
    // FS was NOT touched.
    expect(existsSync(join(dir, 'audit-2026-05-25.jsonl'))).toBe(false);
  });

  it('wraps non-JSON-safe payloads in AuditError', () => {
    const logger = new AuditLogger({
      auditDir: dir,
      now: () => new Date('2026-05-25T10:00:00.000Z'),
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      logger.append({
        kind: 'bridge.read',
        action: 'foo',
        workspace: 'personal',
        outcome: 'ok',
        details: circular,
      }),
    ).toThrow(AuditError);
  });
});
