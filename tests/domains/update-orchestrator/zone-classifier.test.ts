import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZoneClassifier } from '../../../src/domains/update-orchestrator/index.js';

describe('ZoneClassifier', () => {
  let tmpBase: string;
  let upstreamRoot: string;
  let localRoot: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-zone-'));
    upstreamRoot = join(tmpBase, 'upstream');
    localRoot = join(tmpBase, 'local');
    mkdirSync(upstreamRoot, { recursive: true });
    mkdirSync(localRoot, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  function writeUpstream(rel: string, content: string): void {
    const full = join(upstreamRoot, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }

  function writeLocal(rel: string, content: string): void {
    const full = join(localRoot, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }

  it('classifies a file present in both as system', () => {
    writeUpstream('thinking-partner/SKILL.md', 'u\n');
    writeLocal('thinking-partner/SKILL.md', 'l\n');
    const c = new ZoneClassifier({ upstreamRoot, localRoot });
    expect(c.classify('thinking-partner/SKILL.md').zone).toBe('system');
  });

  it('classifies a new upstream-only file as system (new file)', () => {
    writeUpstream('brand-new/SKILL.md', 'u\n');
    const c = new ZoneClassifier({ upstreamRoot, localRoot });
    const result = c.classify('brand-new/SKILL.md');
    expect(result.zone).toBe('system');
    expect(result.reason).toMatch(/missing locally/);
  });

  it('classifies a local-only file as personal', () => {
    writeLocal('my-private/SKILL.md', 'private\n');
    const c = new ZoneClassifier({ upstreamRoot, localRoot });
    expect(c.classify('my-private/SKILL.md').zone).toBe('personal');
  });

  it('honours .skill-lock.json — locked skills override system zone', () => {
    writeUpstream('thinking-partner/SKILL.md', 'u\n');
    writeLocal('thinking-partner/SKILL.md', 'l\n');
    writeLocal('.skill-lock.json', JSON.stringify({ locked: ['thinking-partner'] }));
    const c = new ZoneClassifier({ upstreamRoot, localRoot });
    const result = c.classify('thinking-partner/SKILL.md');
    expect(result.zone).toBe('locked');
    expect(result.reason).toMatch(/\.skill-lock\.json/);
  });

  it('honours frontmatter claudeos: locked', () => {
    writeUpstream('daily-review/SKILL.md', 'u\n');
    writeLocal('daily-review/SKILL.md', '---\nclaudeos: locked\nother: foo\n---\n# body\n');
    const c = new ZoneClassifier({ upstreamRoot, localRoot });
    const result = c.classify('daily-review/SKILL.md');
    expect(result.zone).toBe('locked');
    expect(result.reason).toMatch(/frontmatter/);
  });

  it('treats quoted frontmatter value as locked', () => {
    writeUpstream('x/SKILL.md', 'u\n');
    writeLocal('x/SKILL.md', '---\nclaudeos: "locked"\n---\n# body\n');
    const c = new ZoneClassifier({ upstreamRoot, localRoot });
    expect(c.classify('x/SKILL.md').zone).toBe('locked');
  });

  it('does not treat unrelated frontmatter values as locked', () => {
    writeUpstream('x/SKILL.md', 'u\n');
    writeLocal('x/SKILL.md', '---\nclaudeos: free\n---\n# body\n');
    const c = new ZoneClassifier({ upstreamRoot, localRoot });
    expect(c.classify('x/SKILL.md').zone).toBe('system');
  });

  it('ignores malformed .skill-lock.json gracefully', () => {
    writeUpstream('x/SKILL.md', 'u\n');
    writeLocal('x/SKILL.md', 'l\n');
    writeLocal('.skill-lock.json', '{not valid json');
    const c = new ZoneClassifier({ upstreamRoot, localRoot });
    expect(c.classify('x/SKILL.md').zone).toBe('system');
    expect(c.locked).toEqual([]);
  });

  it('ignores non-string entries in .skill-lock.json', () => {
    writeLocal('.skill-lock.json', JSON.stringify({ locked: ['ok-name', 42, null, ''] }));
    const c = new ZoneClassifier({ upstreamRoot, localRoot });
    expect(c.locked).toEqual(['ok-name']);
  });

  it('classifies a file absent in both as personal (absent)', () => {
    const c = new ZoneClassifier({ upstreamRoot, localRoot });
    expect(c.classify('nope/SKILL.md').zone).toBe('personal');
  });

  it('uses the first path segment as the skill name for lock matching', () => {
    writeUpstream('thinking-partner/nested/dir/extra.md', 'u\n');
    writeLocal('thinking-partner/nested/dir/extra.md', 'l\n');
    writeLocal('.skill-lock.json', JSON.stringify({ locked: ['thinking-partner'] }));
    const c = new ZoneClassifier({ upstreamRoot, localRoot });
    expect(c.classify('thinking-partner/nested/dir/extra.md').zone).toBe('locked');
  });

  it('uses backslash-normalised paths', () => {
    writeUpstream('thinking-partner/SKILL.md', 'u\n');
    writeLocal('thinking-partner/SKILL.md', 'l\n');
    writeLocal('.skill-lock.json', JSON.stringify({ locked: ['thinking-partner'] }));
    const c = new ZoneClassifier({ upstreamRoot, localRoot });
    expect(c.classify('thinking-partner\\SKILL.md').zone).toBe('locked');
  });
});
