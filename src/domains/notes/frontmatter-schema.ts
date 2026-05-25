/**
 * TypeBox schema for note frontmatter (ADR-0031 + ARCHITECTURE.md §5.2).
 *
 * Two views:
 *   - `WriteFrontmatterSchema` — strict, used by `writeNote` before
 *     persistence. Requires workspace + classification + schema_version,
 *     plus tenant when workspace starts with `msp-customers/`.
 *   - Read-side has no schema — reader is lenient (defaults on miss).
 *
 * @module @domains/notes/frontmatter-schema
 */
import { type Static, Type } from '@sinclair/typebox';
import { formatErrors } from '../../core/validation/format.js';
import {
  FrontmatterValidationError,
  NOTE_CLASSIFICATIONS,
  NOTE_TYPES,
  type NoteFrontmatter,
} from './types.js';

const ClassificationSchema = Type.Union(NOTE_CLASSIFICATIONS.map((c) => Type.Literal(c)));

const NoteTypeSchema = Type.Union(NOTE_TYPES.map((t) => Type.Literal(t)));

/**
 * Strict schema. `additionalProperties: true` — frontmatter remains an
 * open type so users can add fields without an immediate schema bump.
 */
export const WriteFrontmatterSchema = Type.Object(
  {
    workspace: Type.String({ minLength: 1 }),
    classification: ClassificationSchema,
    schema_version: Type.Integer({ minimum: 1 }),
    tenant: Type.Optional(Type.String({ minLength: 1 })),
    created: Type.Optional(Type.String({ minLength: 1 })),
    updated: Type.Optional(Type.String({ minLength: 1 })),
    tags: Type.Optional(Type.Array(Type.String())),
    type: Type.Optional(NoteTypeSchema),
  },
  { additionalProperties: true },
);

export type WriteFrontmatter = Static<typeof WriteFrontmatterSchema>;

/**
 * Validates frontmatter against the strict write-time schema. Adds a
 * conditional `tenant` requirement for `msp-customers/<id>` workspaces.
 *
 * Throws `FrontmatterValidationError` on failure with one message per
 * validation issue.
 */
export function validateWriteFrontmatter(fm: unknown): asserts fm is NoteFrontmatter {
  const errors = formatErrors(WriteFrontmatterSchema, fm);
  if (errors.length > 0) {
    throw new FrontmatterValidationError(`Invalid frontmatter:\n  ${errors.join('\n  ')}`, errors);
  }
  const checked = fm as NoteFrontmatter;
  if (checked.workspace.startsWith('msp-customers/')) {
    if (typeof checked.tenant !== 'string' || checked.tenant.length === 0) {
      const msg = `tenant: required when workspace starts with "msp-customers/" (per ADR-0031)`;
      throw new FrontmatterValidationError(`Invalid frontmatter:\n  ${msg}`, [msg]);
    }
  }
}
