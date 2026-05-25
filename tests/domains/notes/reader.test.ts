import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listNotes,
  type NoteFrontmatter,
  readNote,
  writeNote,
} from '../../../src/domains/notes/index.js';

const baseFm = (): NoteFrontmatter => ({
  workspace: 'personal',
  classification: 'personal',
  schema_version: 1,
});

describe('readNote', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'notes-r-'));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('round-trips with writeNote', () => {
    const res = writeNote(vault, 'personal', 'r1.md', baseFm(), '# H\n\nbody');
    const note = readNote(res.path);
    expect(note.workspace).toBe('personal');
    expect(note.frontmatter.classification).toBe('personal');
    expect(note.body).toContain('body');
  });

  it('defaults missing classification to customer-confidential (fail-safe)', () => {
    const dir = join(vault, 'Claude-OS', 'workspaces', 'personal');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'no-class.md');
    writeFileSync(p, '---\nworkspace: personal\nschema_version: 1\n---\nbody\n');
    const note = readNote(p);
    expect(note.frontmatter.classification).toBe('customer-confidential');
  });

  it('routes notes lacking workspace into _unsorted', () => {
    const dir = join(vault, 'Claude-OS', 'workspaces', 'personal');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'no-ws.md');
    writeFileSync(p, '---\nclassification: personal\nschema_version: 1\n---\nbody\n');
    const note = readNote(p);
    expect(note.workspace).toBe('_unsorted');
  });

  it('defaults missing schema_version to 1', () => {
    const dir = join(vault, 'Claude-OS', 'workspaces', 'personal');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'no-sv.md');
    writeFileSync(p, '---\nworkspace: personal\nclassification: personal\n---\nbody\n');
    const note = readNote(p);
    expect(note.frontmatter.schema_version).toBe(1);
  });

  it('reads notes without any frontmatter (treats body as whole content)', () => {
    const dir = join(vault, 'Claude-OS', 'workspaces', 'personal');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'no-fm.md');
    writeFileSync(p, '# Just a heading\n\nNo frontmatter here.');
    const note = readNote(p);
    expect(note.workspace).toBe('_unsorted');
    expect(note.frontmatter.classification).toBe('customer-confidential');
    expect(note.body).toContain('# Just a heading');
  });
});

describe('listNotes', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'notes-l-'));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('returns empty array for a fresh workspace', () => {
    expect(listNotes(vault, 'personal')).toEqual([]);
  });

  it('lists .md notes in the workspace top-level', () => {
    writeNote(vault, 'personal', 'a.md', baseFm(), 'A');
    writeNote(vault, 'personal', 'b.md', baseFm(), 'B');
    const dir = join(vault, 'Claude-OS', 'workspaces', 'personal');
    writeFileSync(join(dir, 'not-a-note.txt'), 'plain text');
    const notes = listNotes(vault, 'personal');
    const names = notes.map((n) => n.path.split(/[\\/]/).pop()).sort();
    expect(names).toEqual(['a.md', 'b.md']);
  });

  it('skips sub-directories unless recursive', () => {
    writeNote(vault, 'personal', 'top.md', baseFm(), 'T');
    const sub = join(vault, 'Claude-OS', 'workspaces', 'personal', 'Sessions');
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, 'inner.md'),
      '---\nworkspace: personal\nclassification: personal\nschema_version: 1\n---\nx\n',
    );
    expect(listNotes(vault, 'personal').map((n) => n.path.split(/[\\/]/).pop())).toEqual([
      'top.md',
    ]);
    const recursive = listNotes(vault, 'personal', { recursive: true });
    expect(recursive.map((n) => n.path.split(/[\\/]/).pop()).sort()).toEqual([
      'inner.md',
      'top.md',
    ]);
  });

  it('silently skips malformed notes', () => {
    writeNote(vault, 'personal', 'ok.md', baseFm(), 'good');
    const dir = join(vault, 'Claude-OS', 'workspaces', 'personal');
    writeFileSync(join(dir, 'broken.md'), '---\nkey: [unclosed\n---\nbody\n');
    const notes = listNotes(vault, 'personal');
    const names = notes.map((n) => n.path.split(/[\\/]/).pop());
    expect(names).toContain('ok.md');
    expect(names).not.toContain('broken.md');
  });
});
