import { describe, expect, it } from 'vitest';
import { composePrompt } from '../../../src/domains/ask/index.js';
import type { Note } from '../../../src/domains/notes/index.js';
import type { RetrievalHit } from '../../../src/domains/retrieval/index.js';

function makeNote(path: string, body: string): Note {
  return {
    path,
    workspace: 'personal',
    frontmatter: {
      workspace: 'personal',
      classification: 'personal',
      schema_version: 1,
    },
    body,
    rawFrontmatter: '',
  };
}

function makeHit(path: string, body: string, score = 1): RetrievalHit {
  return {
    note: makeNote(path, body),
    score,
    matchedTerms: [],
  };
}

describe('composePrompt', () => {
  it('returns question-only when hits is empty', () => {
    const c = composePrompt('what is X?', [], { workspaceId: 'personal' });
    expect(c.contextHits).toEqual([]);
    expect(c.text).toContain('# User question');
    expect(c.text).toContain('what is X?');
    expect(c.text).not.toContain('# Context');
  });

  it('produces context block + question for a single hit', () => {
    const hits = [makeHit('/v/personal/n1.md', 'body of note 1')];
    const c = composePrompt('explain', hits, { workspaceId: 'personal' });
    expect(c.contextHits).toHaveLength(1);
    expect(c.text).toContain('# Context (from workspace: personal)');
    expect(c.text).toContain('## Note: /v/personal/n1.md');
    expect(c.text).toContain('body of note 1');
    expect(c.text).toContain('# User question\n\nexplain');
  });

  it('renders all hits in order', () => {
    const hits = [makeHit('/v/a.md', 'aaa'), makeHit('/v/b.md', 'bbb'), makeHit('/v/c.md', 'ccc')];
    const c = composePrompt('q', hits, { workspaceId: 'personal' });
    expect(c.contextHits).toHaveLength(3);
    const aPos = c.text.indexOf('aaa');
    const bPos = c.text.indexOf('bbb');
    const cPos = c.text.indexOf('ccc');
    expect(aPos).toBeLessThan(bPos);
    expect(bPos).toBeLessThan(cPos);
  });

  it('normalises Windows path-separators to forward-slashes', () => {
    const hits = [makeHit('C:\\vault\\personal\\note.md', 'x')];
    const c = composePrompt('q', hits, { workspaceId: 'personal' });
    expect(c.text).toContain('C:/vault/personal/note.md');
    expect(c.text).not.toContain('C:\\vault');
  });

  it('truncates body when per-note limit is exceeded', () => {
    const longBody = 'a'.repeat(1_000);
    const hits = [makeHit('/v/n.md', longBody)];
    const c = composePrompt('q', hits, { workspaceId: 'personal', perNoteCharLimit: 100 });
    expect(c.text).toContain('[... note truncated]');
    // overall length should be much less than 1000 chars of body
    expect(c.text.length).toBeLessThan(500);
  });

  it('drops hits from the tail to honour totalCharLimit', () => {
    const hits = [makeHit('/v/keep.md', 'short'), makeHit('/v/drop.md', 'b'.repeat(10_000))];
    const c = composePrompt('q', hits, {
      workspaceId: 'personal',
      perNoteCharLimit: 10_000,
      totalCharLimit: 800,
    });
    expect(c.contextHits).toHaveLength(1);
    expect(c.contextHits[0]?.note.path).toBe('/v/keep.md');
    expect(c.text).not.toContain('drop.md');
  });

  it('falls back to question-only when even the first hit blows the budget', () => {
    const hits = [makeHit('/v/big.md', 'b'.repeat(5_000))];
    const c = composePrompt('q', hits, {
      workspaceId: 'personal',
      perNoteCharLimit: 5_000,
      totalCharLimit: 200,
    });
    expect(c.contextHits).toEqual([]);
    expect(c.text).toContain('# User question');
    expect(c.text).not.toContain('# Context');
  });

  it('uses workspaceId in the header', () => {
    const hits = [makeHit('/v/n.md', 'x')];
    const c = composePrompt('q', hits, { workspaceId: 'msp-customers/acme' });
    expect(c.text).toContain('workspace: msp-customers/acme');
  });

  it('reports chars approximating text length', () => {
    const c = composePrompt('q', [makeHit('/v/n.md', 'short body')], {
      workspaceId: 'personal',
    });
    expect(c.chars).toBe(c.text.length);
  });
});
