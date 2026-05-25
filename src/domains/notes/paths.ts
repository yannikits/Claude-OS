/**
 * Note-file path helpers within a workspace tree.
 *
 * @module @domains/notes/paths
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveWorkspacePath } from '../workspace/index.js';
import { InvalidNoteFilenameError } from './types.js';

/**
 * Validates a note filename. Refuses path-separators, whitespace, NUL,
 * drive-letter colons and Windows-reserved names. Accepts the bare
 * basename only — caller is responsible for adding the `.md` extension
 * if missing.
 *
 * Allowed: any sequence not containing `/`, `\\`, `:`, whitespace, NUL,
 * with length 1..255. Reserved Windows names (CON, PRN, NUL, AUX,
 * COM1-9, LPT1-9) are refused even when followed by an extension.
 */
const RESERVED_WIN_NAMES = new Set([
  'con',
  'prn',
  'nul',
  'aux',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

// Reject path-separators (\\ /), colon, all whitespace (incl. space/tab),
// and NUL. \s + \x00 are explicit codepoint references to avoid the
// silent-NUL-substitution issue we hit when using a literal " " inside
// the char-class on this writer pipeline (lesson 2026-05-25).
// biome-ignore lint/suspicious/noControlCharactersInRegex: \x00 is intentional path-injection defense
const ILLEGAL_FILENAME_CHARS = /[\\/:\s\x00]/;

export function assertValidNoteFilename(filename: string): void {
  if (filename.length === 0) {
    throw new InvalidNoteFilenameError(filename, 'empty');
  }
  if (filename.length > 255) {
    throw new InvalidNoteFilenameError(filename, 'over 255 chars');
  }
  if (ILLEGAL_FILENAME_CHARS.test(filename)) {
    throw new InvalidNoteFilenameError(filename, 'contains path-separator, whitespace or NUL');
  }
  if (filename === '.' || filename === '..') {
    throw new InvalidNoteFilenameError(filename, 'reserved');
  }
  if (filename.startsWith('.')) {
    throw new InvalidNoteFilenameError(filename, 'dotfile (leading dot) not allowed');
  }
  const stem = filename.replace(/\.[^.]+$/, '').toLowerCase();
  if (RESERVED_WIN_NAMES.has(stem)) {
    throw new InvalidNoteFilenameError(filename, `reserved name on Windows ("${stem}")`);
  }
}

/**
 * Ensures the on-disk workspace directory exists (lazy bootstrap on
 * first write). Idempotent — `recursive: true` and no error on EEXIST.
 */
export function ensureWorkspaceDir(vaultRoot: string, workspaceId: string): string {
  const dir = resolveWorkspacePath(vaultRoot, workspaceId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Returns the absolute path of a note file within a workspace.
 * Validates id + filename to refuse traversal.
 */
export function noteFilePath(vaultRoot: string, workspaceId: string, filename: string): string {
  assertValidNoteFilename(filename);
  return join(resolveWorkspacePath(vaultRoot, workspaceId), filename);
}
