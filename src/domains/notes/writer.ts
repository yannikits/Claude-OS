/**
 * Note writing with atomic tempfile+rename + strict frontmatter
 * validation.
 *
 * The writer:
 *   1. Validates filename (no traversal, no reserved Win names)
 *   2. Fills `created` (if absent) and `updated` (always) with ISO-8601
 *   3. Validates frontmatter against the strict TypeBox schema
 *   4. Ensures the workspace dir exists
 *   5. Serializes to markdown
 *   6. Writes via tempfile + rename for atomicity
 *
 * `overwrite: false` (default) refuses to clobber an existing file.
 *
 * @module @domains/notes/writer
 */
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import type { WorkspaceId } from '../workspace/index.js';
import { validateWriteFrontmatter } from './frontmatter-schema.js';
import { serializeNote } from './parser.js';
import { ensureWorkspaceDir, noteFilePath } from './paths.js';
import { type NoteFrontmatter, NotesError } from './types.js';

export interface WriteNoteOpts {
  /** Default `false`. Set `true` to allow updating an existing file. */
  readonly overwrite?: boolean;
  /** Override `created` (tests). Defaults to `new Date().toISOString()`. */
  readonly nowIso?: string;
}

export interface WriteResult {
  readonly path: string;
  readonly created: boolean;
  readonly frontmatter: NoteFrontmatter;
}

/**
 * Writes a note to `<vaultRoot>/Claude-OS/workspaces/<workspaceId>/<filename>`.
 */
export function writeNote(
  vaultRoot: string,
  workspaceId: WorkspaceId,
  filename: string,
  frontmatter: NoteFrontmatter,
  body: string,
  opts: WriteNoteOpts = {},
): WriteResult {
  const target = noteFilePath(vaultRoot, workspaceId, filename);
  const alreadyExists = existsSync(target);

  if (alreadyExists && opts.overwrite !== true) {
    throw new NotesError(
      `Note already exists at "${target}". Pass {overwrite: true} to replace it.`,
    );
  }

  const now = opts.nowIso ?? new Date().toISOString();
  // Stamp created on first write, refresh updated on every write.
  // The caller's frontmatter overrides created if explicitly set.
  const stamped: NoteFrontmatter = {
    ...frontmatter,
    workspace: workspaceId,
    created: frontmatter.created ?? now,
    updated: now,
  };

  validateWriteFrontmatter(stamped);

  ensureWorkspaceDir(vaultRoot, workspaceId);

  const markdown = serializeNote(stamped as unknown as Record<string, unknown>, body);

  // Atomic write: tempfile + rename. rename() is atomic on the same
  // filesystem volume (POSIX guarantee, NTFS treats it as a transaction).
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, markdown, { encoding: 'utf8' });
  renameSync(tmp, target);

  return {
    path: target,
    created: !alreadyExists,
    frontmatter: stamped,
  };
}
