import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type NoteFrontmatter, writeNote } from '../../../src/domains/notes/index.js';
import { searchWorkspace } from '../../../src/domains/retrieval/index.js';

const fm = (overrides: Partial<NoteFrontmatter> = {}): NoteFrontmatter => ({
  workspace: 'personal',
  classification: 'personal',
  schema_version: 1,
  ...overrides,
});

describe('searchWorkspace', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'ret-'));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('returns no hits for a fresh workspace', () => {
    const r = searchWorkspace(vault, 'personal', { text: 'anything' });
    expect(r.hits).toEqual([]);
    expect(r.totalScanned).toBe(0);
  });

  it('returns no hits when query tokenises to nothing', () => {
    writeNote(vault, 'personal', 'n.md', fm(), 'body');
    const r = searchWorkspace(vault, 'personal', { text: '?' });
    expect(r.hits).toEqual([]);
    expect(r.tokens).toEqual([]);
  });

  it('ranks the matching note higher than non-matching ones', () => {
    writeNote(vault, 'personal', 'a.md', fm(), 'Discussion about authentication patterns.');
    writeNote(vault, 'personal', 'b.md', fm(), 'Unrelated cooking recipe with onions.');
    writeNote(vault, 'personal', 'c.md', fm(), 'More cooking with garlic and salt.');
    const r = searchWorkspace(vault, 'personal', { text: 'authentication' });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]?.note.path.endsWith('a.md')).toBe(true);
    expect(r.hits[0]?.matchedTerms).toContain('authentication');
    expect(r.hits[0]?.score).toBeGreaterThan(0);
  });

  it('respects topK cut-off', () => {
    for (let i = 0; i < 5; i++) {
      writeNote(vault, 'personal', `n${i}.md`, fm(), `authentication note ${i}`);
    }
    const r = searchWorkspace(vault, 'personal', { text: 'authentication', topK: 3 });
    expect(r.hits.length).toBe(3);
    expect(r.totalScanned).toBe(5);
  });

  it('excludes ephemeral by default', () => {
    writeNote(vault, 'personal', 'keep.md', fm(), 'project deadline next week');
    writeNote(
      vault,
      'personal',
      'eph.md',
      fm({ classification: 'ephemeral' }),
      'project deadline next week',
    );
    const r = searchWorkspace(vault, 'personal', { text: 'deadline' });
    const paths = r.hits.map((h) => h.note.path);
    expect(paths.some((p) => p.endsWith('keep.md'))).toBe(true);
    expect(paths.some((p) => p.endsWith('eph.md'))).toBe(false);
  });

  it('allows including ephemeral when explicitly requested', () => {
    writeNote(vault, 'personal', 'keep.md', fm(), 'deadline');
    writeNote(vault, 'personal', 'eph.md', fm({ classification: 'ephemeral' }), 'deadline');
    const r = searchWorkspace(vault, 'personal', {
      text: 'deadline',
      excludeClassifications: [],
    });
    expect(r.hits.length).toBe(2);
  });

  it('indexes frontmatter.tags + frontmatter.type', () => {
    writeNote(vault, 'personal', 'tagged.md', fm({ tags: ['kubernetes', 'docker'] }), 'body');
    writeNote(vault, 'personal', 'typed.md', fm({ type: 'project' }), 'body');
    writeNote(vault, 'personal', 'plain.md', fm(), 'body');
    const t = searchWorkspace(vault, 'personal', { text: 'kubernetes' });
    expect(t.hits.length).toBe(1);
    expect(t.hits[0]?.note.path.endsWith('tagged.md')).toBe(true);

    const ty = searchWorkspace(vault, 'personal', { text: 'project' });
    expect(ty.hits.length).toBe(1);
    expect(ty.hits[0]?.note.path.endsWith('typed.md')).toBe(true);
  });

  it('returns durationMs + tokens for diagnostics', () => {
    writeNote(vault, 'personal', 'a.md', fm(), 'hello world');
    const r = searchWorkspace(vault, 'personal', { text: 'Hello WORLD' });
    expect(r.tokens).toEqual(['hello', 'world']);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.query).toBe('Hello WORLD');
  });

  it('handles German tokens (umlauts preserved)', () => {
    writeNote(vault, 'personal', 'de.md', fm(), 'Über die Mitarbeiter müssen größere Räume haben.');
    writeNote(vault, 'personal', 'en.md', fm(), 'About employees needing larger rooms.');
    const r = searchWorkspace(vault, 'personal', { text: 'mitarbeiter' });
    expect(r.hits.length).toBe(1);
    expect(r.hits[0]?.note.path.endsWith('de.md')).toBe(true);
  });
});
