/**
 * User-friendly error formatter for TypeBox/Ajv validation errors,
 * per ADR-0012 §3 ("User-Friendly-Errors").
 *
 * Converts TypeBox's JSON-Pointer-based `ValueError.path` into the
 * human-readable dotted-with-brackets notation:
 *
 *     /entries/2/source      → entries[2].source
 *     /vault/agent-runs/foo  → vault.agent-runs.foo
 *     (empty)                → <root>
 *
 * @module @core/validation/format
 */

import type { TSchema } from '@sinclair/typebox';
import { Value, type ValueError } from '@sinclair/typebox/value';

/**
 * Validate `value` against `schema`. Returns an empty array on success;
 * otherwise returns one human-readable string per error, ordered by
 * Ajv's traversal order.
 */
export function formatErrors(schema: TSchema, value: unknown): string[] {
  if (Value.Check(schema, value)) return [];
  return [...Value.Errors(schema, value)].map(formatSingle);
}

function formatSingle(err: ValueError): string {
  return `${formatPath(err.path)}: ${err.message}`;
}

/**
 * JSON Pointer → dotted+bracket notation.
 *
 * Numeric path segments become `[N]`; named segments are dot-separated.
 * Internal helper, exposed primarily for testing.
 */
export function formatPath(path: string): string {
  if (path === '') return '<root>';
  const segments = path.replace(/^\//, '').split('/');
  return segments.reduce<string>((acc, seg, i) => {
    if (/^\d+$/.test(seg)) return `${acc}[${seg}]`;
    return i === 0 ? seg : `${acc}.${seg}`;
  }, '');
}

/**
 * Throwing variant: validate and throw with formatted messages joined
 * by newlines. Useful for fail-fast contexts (boot, doctor checks).
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: readonly string[],
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function assertValid<T>(
  schema: TSchema,
  value: unknown,
  context = 'value',
): asserts value is T {
  const errors = formatErrors(schema, value);
  if (errors.length === 0) return;
  throw new ValidationError(`Invalid ${context}:\n  ${errors.join('\n  ')}`, errors);
}
