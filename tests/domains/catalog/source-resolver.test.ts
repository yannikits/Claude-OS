import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  githubTarballUrl,
  type ParsedGithubSource,
  parseSource,
  SourceParseError,
} from '../../../src/domains/catalog/index.js';

describe('parseSource', () => {
  it('parses marketplace:<name>:<plugin>', () => {
    const r = parseSource('marketplace:claudesidian:claudesidian-pack');
    expect(r.kind).toBe('marketplace');
    if (r.kind === 'marketplace') {
      expect(r.marketplace).toBe('claudesidian');
      expect(r.plugin).toBe('claudesidian-pack');
    }
  });

  it('parses github:<owner>/<repo>', () => {
    const r = parseSource('github:iteenschmiede/claude-config');
    expect(r.kind).toBe('github');
    if (r.kind === 'github') {
      expect(r.owner).toBe('iteenschmiede');
      expect(r.repo).toBe('claude-config');
      expect(r.ref).toBeUndefined();
      expect(r.subPath).toBeUndefined();
    }
  });

  it('parses github with @ref', () => {
    const r = parseSource('github:owner/repo@v1.2.3');
    if (r.kind !== 'github') throw new Error('expected github');
    expect(r.ref).toBe('v1.2.3');
  });

  it('parses github with subPath', () => {
    const r = parseSource('github:owner/repo:skills/thinking-partner');
    if (r.kind !== 'github') throw new Error('expected github');
    expect(r.subPath).toBe('skills/thinking-partner');
  });

  it('parses github with ref and subPath', () => {
    const r = parseSource('github:owner/repo@main:skills/foo');
    if (r.kind !== 'github') throw new Error('expected github');
    expect(r.ref).toBe('main');
    expect(r.subPath).toBe('skills/foo');
  });

  it('parses local with absolute path', () => {
    const r = parseSource('local:/tmp/skill-pack');
    expect(r.kind).toBe('local');
    if (r.kind === 'local') expect(isAbsolute(r.path)).toBe(true);
  });

  it('parses local with relative path resolved against cwd', () => {
    const r = parseSource('local:./skill-pack', { cwd: '/home/me' });
    if (r.kind !== 'local') throw new Error('expected local');
    expect(r.path.includes('skill-pack')).toBe(true);
    expect(isAbsolute(r.path)).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    const r = parseSource('  github:owner/repo  ');
    expect(r.kind).toBe('github');
  });

  it('rejects unknown scheme', () => {
    expect(() => parseSource('npm:foo')).toThrow(SourceParseError);
  });

  it('rejects empty input', () => {
    expect(() => parseSource('')).toThrow(SourceParseError);
    expect(() => parseSource('   ')).toThrow(SourceParseError);
  });

  it('rejects scheme without colon', () => {
    expect(() => parseSource('github-without-colon')).toThrow(SourceParseError);
  });

  it('rejects marketplace without plugin', () => {
    expect(() => parseSource('marketplace:claudesidian')).toThrow(SourceParseError);
  });

  it('rejects marketplace with empty plugin name', () => {
    expect(() => parseSource('marketplace:claudesidian:')).toThrow(SourceParseError);
  });

  it('rejects marketplace name with invalid chars', () => {
    expect(() => parseSource('marketplace:claud sidian:pack')).toThrow(SourceParseError);
  });

  it('rejects github with bad owner/repo shape', () => {
    expect(() => parseSource('github:owner')).toThrow(SourceParseError);
    expect(() => parseSource('github:owner/repo/extra')).toThrow(SourceParseError);
  });

  it('rejects github with empty ref', () => {
    expect(() => parseSource('github:owner/repo@')).toThrow(SourceParseError);
  });

  it('rejects github with empty subPath', () => {
    expect(() => parseSource('github:owner/repo:')).toThrow(SourceParseError);
  });

  it('rejects local with empty path', () => {
    expect(() => parseSource('local:')).toThrow(SourceParseError);
  });
});

describe('githubTarballUrl', () => {
  it('uses codeload host with HEAD when no ref', () => {
    const parsed: ParsedGithubSource = {
      kind: 'github',
      raw: 'github:owner/repo',
      owner: 'owner',
      repo: 'repo',
    };
    expect(githubTarballUrl(parsed)).toBe('https://codeload.github.com/owner/repo/tar.gz/HEAD');
  });

  it('uses the supplied ref', () => {
    const parsed: ParsedGithubSource = {
      kind: 'github',
      raw: 'github:owner/repo@v1',
      owner: 'owner',
      repo: 'repo',
      ref: 'v1',
    };
    expect(githubTarballUrl(parsed)).toBe('https://codeload.github.com/owner/repo/tar.gz/v1');
  });
});
