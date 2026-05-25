import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertValidNoteFilename,
  ensureWorkspaceDir,
  InvalidNoteFilenameError,
  noteFilePath,
} from '../../../src/domains/notes/index.js';

describe('assertValidNoteFilename', () => {
  it.each([
    'note.md',
    'note-2026-05-25.md',
    'a_b_c.md',
    'with.multiple.dots.md',
    'NoExtensionStillOK',
  ])('accepts %s', (n) => {
    expect(() => assertValidNoteFilename(n)).not.toThrow();
  });

  it.each([
    ['', 'empty'],
    ['has/slash.md', 'separator'],
    ['has\\back.md', 'separator'],
    ['has:colon.md', 'separator'],
    ['has space.md', 'separator'],
    ['.', 'dot'],
    ['..', 'dot-dot'],
    ['.hidden.md', 'dotfile'],
    ['con.md', 'reserved-windows-stem'],
    ['CON', 'reserved-windows'],
    ['lpt1.md', 'reserved-lpt'],
  ])('rejects %s (%s)', (n) => {
    expect(() => assertValidNoteFilename(n)).toThrow(InvalidNoteFilenameError);
  });

  it('refuses names over 255 chars', () => {
    expect(() => assertValidNoteFilename(`${'x'.repeat(256)}.md`)).toThrow(
      InvalidNoteFilenameError,
    );
  });
});

describe('noteFilePath + ensureWorkspaceDir', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'notes-paths-'));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('builds the ADR-0031 layout path', () => {
    const p = noteFilePath(vault, 'personal', 'note.md').replace(/\\/g, '/');
    expect(p.endsWith('/Claude-OS/workspaces/personal/note.md')).toBe(true);
  });

  it('refuses traversal in filename', () => {
    expect(() => noteFilePath(vault, 'personal', '../escape.md')).toThrow(InvalidNoteFilenameError);
  });

  it('ensureWorkspaceDir is idempotent', () => {
    const dir1 = ensureWorkspaceDir(vault, 'personal');
    const dir2 = ensureWorkspaceDir(vault, 'personal');
    expect(dir1).toBe(dir2);
    expect(existsSync(dir1)).toBe(true);
    expect(statSync(dir1).isDirectory()).toBe(true);
  });

  it('ensureWorkspaceDir creates customer workspaces nested', () => {
    const dir = ensureWorkspaceDir(vault, 'msp-customers/acme');
    expect(dir.replace(/\\/g, '/').endsWith('/msp-customers/acme')).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});
