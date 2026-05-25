import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type OpenedIndex,
  openIndex,
  rebuildAll,
  searchIndex,
} from '../../../src/domains/memory-index/index.js';
import { type NoteFrontmatter, writeNote } from '../../../src/domains/notes/index.js';

const fm = (overrides: Partial<NoteFrontmatter> = {}): NoteFrontmatter => ({
  workspace: 'personal',
  classification: 'personal',
  schema_version: 1,
  ...overrides,
});

describe('searchIndex', () => {
  let vault: string;
  let opened: OpenedIndex;

  beforeEach(async () => {
    vault = mkdtempSync(join(tmpdir(), 'mi-search-'));
    opened = await openIndex({ vaultRoot: vault });
  });

  afterEach(() => {
    opened.db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it('returns no hits when query tokenises to nothing', () => {
    const r = searchIndex(opened.db, 'personal', { text: '?!' });
    expect(r.hits).toEqual([]);
    expect(r.tokens).toEqual([]);
  });

  it('returns no hits when index is empty', () => {
    const r = searchIndex(opened.db, 'personal', { text: 'anything' });
    expect(r.hits).toEqual([]);
    expect(r.totalScanned).toBe(0);
  });

  it('ranks the FTS-matching note and isolates by workspace', () => {
    writeNote(vault, 'personal', 'auth.md', fm(), 'Discussion about authentication patterns.');
    writeNote(vault, 'personal', 'cook.md', fm(), 'Cooking recipe with garlic.');
    writeNote(
      vault,
      'msp-internal',
      'auth-internal.md',
      fm({ workspace: 'msp-internal' }),
      'Internal authentication runbook.',
    );
    rebuildAll(opened.db, vault);

    const personal = searchIndex(opened.db, 'personal', { text: 'authentication' });
    expect(personal.hits.length).toBe(1);
    expect(personal.hits[0]?.note.path.endsWith('auth.md')).toBe(true);
    expect(personal.hits[0]?.score).toBeGreaterThan(0);

    // Same query against msp-internal workspace returns the other doc.
    const internal = searchIndex(opened.db, 'msp-internal', { text: 'authentication' });
    expect(internal.hits.length).toBe(1);
    expect(internal.hits[0]?.note.path.endsWith('auth-internal.md')).toBe(true);
  });

  it('respects topK cut-off', () => {
    for (let i = 0; i < 6; i++) {
      writeNote(vault, 'personal', `n${i}.md`, fm(), `kubernetes deployment ${i}`);
    }
    rebuildAll(opened.db, vault);
    const r = searchIndex(opened.db, 'personal', { text: 'kubernetes', topK: 3 });
    expect(r.hits.length).toBe(3);
    expect(r.totalScanned).toBe(6);
  });

  it('excludes ephemeral by default, includes when overridden', () => {
    writeNote(vault, 'personal', 'keep.md', fm(), 'deadline next week');
    writeNote(
      vault,
      'personal',
      'eph.md',
      fm({ classification: 'ephemeral' }),
      'deadline next week',
    );
    rebuildAll(opened.db, vault);

    const def = searchIndex(opened.db, 'personal', { text: 'deadline' });
    expect(def.hits.map((h) => h.note.path.split(/[\\/]/).pop())).toEqual(['keep.md']);

    const incl = searchIndex(opened.db, 'personal', {
      text: 'deadline',
      excludeClassifications: [],
    });
    expect(incl.hits.length).toBe(2);
  });

  it('returns hits as RetrievalResult-compatible shape (frontmatter parsed from json)', () => {
    writeNote(
      vault,
      'personal',
      'tag.md',
      fm({ tags: ['cluster', 'ops'], type: 'session' }),
      'cluster ops body',
    );
    rebuildAll(opened.db, vault);

    const r = searchIndex(opened.db, 'personal', { text: 'cluster' });
    expect(r.hits.length).toBe(1);
    const hit = r.hits[0];
    expect(hit?.note.workspace).toBe('personal');
    expect(hit?.note.frontmatter.classification).toBe('personal');
    expect(hit?.note.frontmatter.tags).toEqual(['cluster', 'ops']);
    expect(hit?.note.frontmatter.type).toBe('session');
  });

  it('escapes FTS-operator characters from query to avoid injection', () => {
    writeNote(vault, 'personal', 'minus.md', fm(), 'the minus operator should not blow up');
    rebuildAll(opened.db, vault);
    // `-` is FTS4 NOT-operator if unquoted. We escape it; the literal
    // term has no token (tokeniser would also drop bare `-`), so the
    // call must not throw and just returns empty hits.
    expect(() => searchIndex(opened.db, 'personal', { text: '- AND OR NEAR' })).not.toThrow();
  });
});
