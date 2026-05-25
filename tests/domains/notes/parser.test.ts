import { describe, expect, it } from 'vitest';
import {
  extractFrontmatter,
  FrontmatterParseError,
  parseFrontmatter,
  serializeNote,
} from '../../../src/domains/notes/index.js';

describe('extractFrontmatter', () => {
  it('returns the body when no opening fence is present', () => {
    const r = extractFrontmatter('# Heading\n\nbody only');
    expect(r.hasFrontmatter).toBe(false);
    expect(r.rawFrontmatter).toBe('');
    expect(r.body).toBe('# Heading\n\nbody only');
  });

  it('splits standard frontmatter + body', () => {
    const r = extractFrontmatter('---\nkey: value\n---\nbody here\n');
    expect(r.hasFrontmatter).toBe(true);
    expect(r.rawFrontmatter).toBe('key: value');
    expect(r.body).toBe('body here\n');
  });

  it('handles CRLF line endings', () => {
    const r = extractFrontmatter('---\r\nk: v\r\n---\r\nbody\r\n');
    expect(r.hasFrontmatter).toBe(true);
    expect(r.rawFrontmatter).toBe('k: v');
    expect(r.body).toBe('body\n');
  });

  it('throws on missing closing fence', () => {
    expect(() => extractFrontmatter('---\nkey: value\nbody but no closing')).toThrow(
      FrontmatterParseError,
    );
  });

  it('returns empty rawFrontmatter for `---\\n---` (no content between fences)', () => {
    const r = extractFrontmatter('---\n---\nbody\n');
    expect(r.hasFrontmatter).toBe(true);
    expect(r.rawFrontmatter).toBe('');
    expect(r.body).toBe('body\n');
  });
});

describe('parseFrontmatter', () => {
  it('returns {} for empty input', () => {
    expect(parseFrontmatter('')).toEqual({});
    expect(parseFrontmatter('   ')).toEqual({});
  });

  it('parses a simple mapping', () => {
    expect(parseFrontmatter('foo: bar\nn: 42')).toEqual({ foo: 'bar', n: 42 });
  });

  it('parses arrays and nested objects', () => {
    const r = parseFrontmatter('tags:\n  - one\n  - two\nnested:\n  k: v');
    expect(r).toEqual({ tags: ['one', 'two'], nested: { k: 'v' } });
  });

  it('throws on syntactically broken YAML', () => {
    expect(() => parseFrontmatter('key: [unclosed')).toThrow(FrontmatterParseError);
  });

  it('refuses array root', () => {
    expect(() => parseFrontmatter('- item1\n- item2')).toThrow(FrontmatterParseError);
  });

  it('refuses scalar root', () => {
    expect(() => parseFrontmatter('just-a-string')).toThrow(FrontmatterParseError);
  });
});

describe('serializeNote', () => {
  it('round-trips frontmatter + body', () => {
    const fm = { workspace: 'personal', classification: 'personal', schema_version: 1 };
    const body = '# Title\n\nSome content.';
    const md = serializeNote(fm, body);
    const extracted = extractFrontmatter(md);
    expect(extracted.hasFrontmatter).toBe(true);
    expect(parseFrontmatter(extracted.rawFrontmatter)).toEqual(fm);
    expect(extracted.body).toContain('Some content.');
  });

  it('produces canonical --- fences', () => {
    const md = serializeNote({ k: 'v' }, '');
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('\n---\n');
  });

  it('ensures body ends with newline', () => {
    const md = serializeNote({ k: 'v' }, 'no-newline');
    expect(md.endsWith('\n')).toBe(true);
  });
});
