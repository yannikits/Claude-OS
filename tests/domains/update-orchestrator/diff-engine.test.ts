import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffFiles } from '../../../src/domains/update-orchestrator/index.js';

describe('diffFiles', () => {
  let tmpBase: string;
  let upstream: string;
  let local: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-diff-'));
    upstream = join(tmpBase, 'upstream.md');
    local = join(tmpBase, 'local.md');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  it('returns unchanged for identical content', () => {
    writeFileSync(upstream, '# Hello\nworld\n');
    writeFileSync(local, '# Hello\nworld\n');
    const result = diffFiles(upstream, local);
    expect(result.status).toBe('unchanged');
    expect(result.unifiedDiff).toBe('');
    expect(result.addedLines).toBe(0);
    expect(result.removedLines).toBe(0);
  });

  it('returns added when local missing', () => {
    writeFileSync(upstream, '# New\nupstream-only\n');
    const result = diffFiles(upstream, local);
    expect(result.status).toBe('added');
    expect(result.summary).toMatch(/new upstream file/);
  });

  it('returns removed when upstream missing', () => {
    writeFileSync(local, '# Local\nlocal-only\n');
    const result = diffFiles(upstream, local);
    expect(result.status).toBe('removed');
    expect(result.summary).toMatch(/removed upstream/);
  });

  it('returns modified with line counts and unified diff', () => {
    writeFileSync(upstream, '# Title\nline 1\nline 2\nline 3\n');
    writeFileSync(local, '# Title\nline 1\nLINE 2 MODIFIED\nline 3\nline 4 ADDED\n');
    const result = diffFiles(upstream, local);
    expect(result.status).toBe('modified');
    expect(result.addedLines).toBeGreaterThan(0);
    expect(result.removedLines).toBeGreaterThan(0);
    expect(result.unifiedDiff).toMatch(/^---/m);
    expect(result.unifiedDiff).toMatch(/^\+\+\+/m);
    expect(result.summary).toMatch(/\+\d+ \/ -\d+/);
  });

  it('detects binary files by NUL byte', () => {
    writeFileSync(upstream, Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x00, 0x01]));
    writeFileSync(local, Buffer.from([0x89, 0x50, 0x4e, 0x00, 0xff, 0xfe]));
    const result = diffFiles(upstream, local);
    expect(result.status).toBe('binary');
    expect(result.unifiedDiff).toBe('');
    expect(result.summary).toMatch(/binary/);
  });

  it('treats identical binaries as unchanged', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);
    writeFileSync(upstream, buf);
    writeFileSync(local, buf);
    const result = diffFiles(upstream, local);
    expect(result.status).toBe('unchanged');
    expect(result.summary).toMatch(/binary, identical/);
  });

  it('honours custom displayName in patch headers', () => {
    writeFileSync(upstream, 'a\n');
    writeFileSync(local, 'b\n');
    const result = diffFiles(upstream, local, { displayName: 'skills/thinking-partner/SKILL.md' });
    expect(result.unifiedDiff).toMatch(/skills\/thinking-partner\/SKILL\.md/);
  });

  it('returns unchanged when both absent', () => {
    const result = diffFiles(upstream, local);
    expect(result.status).toBe('unchanged');
    expect(result.summary).toMatch(/absent both sides/);
  });
});
