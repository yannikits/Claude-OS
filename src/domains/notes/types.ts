/**
 * Notes-domain types (ADR-0031 + ARCHITECTURE.md §5.2).
 *
 * Frontmatter union of both spec sources, in addition to write-time
 * required fields. Optional fields default to safe values on read
 * (fail-safe `classification: customer-confidential` per
 * `ARCHITECTURE.md §5.2`).
 *
 * @module @domains/notes/types
 */

export type NoteClassification =
  | 'personal'
  | 'operational'
  | 'customer-confidential'
  | 'secret'
  | 'ephemeral';

export const NOTE_CLASSIFICATIONS: readonly NoteClassification[] = [
  'personal',
  'operational',
  'customer-confidential',
  'secret',
  'ephemeral',
] as const;

export type NoteType = 'session' | 'skill-memory' | 'person' | 'project';

export const NOTE_TYPES: readonly NoteType[] = [
  'session',
  'skill-memory',
  'person',
  'project',
] as const;

/**
 * Frontmatter schema (write-time view — full constraints).
 *
 * Reading is lenient: missing `classification` defaults to
 * `customer-confidential` per ARCHITECTURE.md §5.2 fail-safe-rule,
 * missing `workspace` routes the note into the synthetic `_unsorted`
 * bucket.
 */
export interface NoteFrontmatter {
  readonly workspace: string;
  readonly classification: NoteClassification;
  readonly schema_version: number;
  /** Pflicht nur bei workspace startsWith 'msp-customers/' (ADR-0031). */
  readonly tenant?: string;
  /** ISO-8601. Optional; writer fills with now() if absent on create. */
  readonly created?: string;
  /** ISO-8601. Writer updates on every write. */
  readonly updated?: string;
  readonly tags?: readonly string[];
  readonly type?: NoteType;
  /** Allow arbitrary extra-keys for forward-compat (frontmatter is open). */
  readonly [key: string]: unknown;
}

export interface Note {
  /** Absolute filesystem path. */
  readonly path: string;
  /** Workspace id derived from frontmatter (or `_unsorted`). */
  readonly workspace: string;
  /** Parsed frontmatter (or defaulted on read). */
  readonly frontmatter: NoteFrontmatter;
  /** Markdown body — everything after the closing `---`. */
  readonly body: string;
  /** Raw frontmatter YAML text (for re-serialization round-trips). */
  readonly rawFrontmatter: string;
}

export class NotesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotesError';
  }
}

export class FrontmatterParseError extends NotesError {
  constructor(message: string) {
    super(message);
    this.name = 'FrontmatterParseError';
  }
}

export class FrontmatterValidationError extends NotesError {
  constructor(
    message: string,
    public readonly errors: readonly string[],
  ) {
    super(message);
    this.name = 'FrontmatterValidationError';
  }
}

export class InvalidNoteFilenameError extends NotesError {
  constructor(filename: string, reason: string) {
    super(`Invalid note filename "${filename}": ${reason}`);
    this.name = 'InvalidNoteFilenameError';
  }
}
