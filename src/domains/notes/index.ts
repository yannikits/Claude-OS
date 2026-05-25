/**
 * Notes domain — markdown notes with frontmatter (ADR-0031 +
 * ARCHITECTURE.md §5.2).
 *
 * @module @domains/notes
 */

export { validateWriteFrontmatter, WriteFrontmatterSchema } from './frontmatter-schema.js';
export {
  type ExtractedFrontmatter,
  extractFrontmatter,
  parseFrontmatter,
  serializeNote,
} from './parser.js';
export { assertValidNoteFilename, ensureWorkspaceDir, noteFilePath } from './paths.js';
export { listNotes, readNote } from './reader.js';
export {
  FrontmatterParseError,
  FrontmatterValidationError,
  InvalidNoteFilenameError,
  NOTE_CLASSIFICATIONS,
  NOTE_TYPES,
  type Note,
  type NoteClassification,
  type NoteFrontmatter,
  NotesError,
  type NoteType,
} from './types.js';
export { type WriteNoteOpts, type WriteResult, writeNote } from './writer.js';
