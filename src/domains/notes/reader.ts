/**
 * Note reading + listing.
 *
 * Lenient on read (per ARCHITECTURE.md §5.2 fail-safe rule):
 *   - missing `classification` → `customer-confidential`
 *   - missing `workspace` → routed to `_unsorted`
 *   - missing `schema_version` → 1
 *   - malformed YAML throws (data is corrupt — refuse silent recovery)
 *
 * @module @domains/notes/reader
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveWorkspacePath, UNSORTED_WORKSPACE, type WorkspaceId } from '../workspace/index.js';
import { extractFrontmatter, parseFrontmatter } from './parser.js';
import { type Note, type NoteClassification, type NoteFrontmatter, NotesError } from './types.js';

interface ListOpts {
  /** Recurse into sub-directories. Default false (top-level only). */
  readonly recursive?: boolean;
}

/**
 * Reads a note from an absolute path. Throws on FS errors or malformed
 * YAML; defaults missing frontmatter fields per the fail-safe policy.
 */
export function readNote(absolutePath: string): Note {
  let raw: string;
  try {
    raw = readFileSync(absolutePath, 'utf8');
  } catch (err) {
    throw new NotesError(`Failed to read note at "${absolutePath}": ${(err as Error).message}`);
  }
  const extracted = extractFrontmatter(raw);
  const parsed = extracted.hasFrontmatter ? parseFrontmatter(extracted.rawFrontmatter) : {};
  const frontmatter = applyReadDefaults(parsed);
  const workspace =
    typeof frontmatter.workspace === 'string' && frontmatter.workspace.length > 0
      ? frontmatter.workspace
      : UNSORTED_WORKSPACE;
  return {
    path: absolutePath,
    workspace,
    frontmatter,
    body: extracted.body,
    rawFrontmatter: extracted.rawFrontmatter,
  };
}

function applyReadDefaults(raw: Record<string, unknown>): NoteFrontmatter {
  const classification: NoteClassification =
    typeof raw.classification === 'string' && isClassification(raw.classification)
      ? raw.classification
      : 'customer-confidential';
  const schemaVersion =
    typeof raw.schema_version === 'number' && Number.isInteger(raw.schema_version)
      ? raw.schema_version
      : 1;
  const workspace =
    typeof raw.workspace === 'string' && raw.workspace.length > 0
      ? raw.workspace
      : UNSORTED_WORKSPACE;
  // Keep all other keys (open frontmatter), but pin the strict types
  // on the well-known ones.
  return {
    ...raw,
    workspace,
    classification,
    schema_version: schemaVersion,
  } as NoteFrontmatter;
}

function isClassification(s: string): s is NoteClassification {
  return (
    s === 'personal' ||
    s === 'operational' ||
    s === 'customer-confidential' ||
    s === 'secret' ||
    s === 'ephemeral'
  );
}

/**
 * Lists notes within a workspace directory. Returns parsed `Note`
 * objects (lenient frontmatter defaults applied).
 *
 * Non-`.md` files are skipped silently. Sub-directories are skipped
 * by default (`recursive: false`).
 *
 * Returns `[]` if the workspace directory doesn't exist yet (fresh
 * workspace, before any writes).
 */
export function listNotes(
  vaultRoot: string,
  workspaceId: WorkspaceId,
  opts: ListOpts = {},
): Note[] {
  const dir = resolveWorkspacePath(vaultRoot, workspaceId);
  return walkMd(dir, opts.recursive === true);
}

function walkMd(dir: string, recursive: boolean): Note[] {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(dir);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];
  const out: Note[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) out.push(...walkMd(full, true));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    try {
      out.push(readNote(full));
    } catch {
      // Skip malformed notes silently — they're surfaced when the user
      // tries to open them individually. Don't kill a whole list-call
      // because of one bad file.
    }
  }
  return out;
}
