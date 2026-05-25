/**
 * Deterministic canonical-JSON serialisation for approval-tokens.
 *
 * Two JSON-serialisations of the same object MUST produce the same byte
 * sequence — otherwise signing the same request twice could yield two
 * different signatures and verification would fail spuriously.
 *
 * Rules (subset of RFC 8785):
 *   - Object-keys sorted lexicographically (Unicode code-point order via
 *     `localeCompare(undefined, { sensitivity: 'variant' })`-equivalent
 *     — we use the JS `<`/`>` operator which compares code-points)
 *   - No whitespace between tokens
 *   - Strings escape `"` and `\` only (no extra escaping of `/` etc.)
 *   - Numbers serialise via `Number.prototype.toString()` — caller must
 *     not put NaN/Infinity in the payload (throws)
 *   - Arrays preserve insertion order (they're ordered by nature)
 *   - `undefined` and functions are rejected (would silently drop in
 *     `JSON.stringify`)
 *
 * @module @core/approval/canonical-json
 */
import { ApprovalError } from './types.js';

export function canonicalJsonStringify(value: unknown): string {
  return serialise(value);
}

function serialise(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new ApprovalError(`canonicalJsonStringify: non-finite number not serialisable (${v})`);
    }
    return JSON.stringify(v);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) {
    return `[${v.map(serialise).join(',')}]`;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    // Reject keys whose value is undefined or a function (JSON.stringify
    // silently drops them — that would make canonical-form non-bijective).
    for (const [k, val] of entries) {
      if (val === undefined) {
        throw new ApprovalError(
          `canonicalJsonStringify: key "${k}" has undefined value (would silently drop)`,
        );
      }
      if (typeof val === 'function') {
        throw new ApprovalError(
          `canonicalJsonStringify: key "${k}" is a function (not JSON-serialisable)`,
        );
      }
    }
    const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${sorted.map(([k, val]) => `${JSON.stringify(k)}:${serialise(val)}`).join(',')}}`;
  }
  throw new ApprovalError(`canonicalJsonStringify: unsupported value type (${typeof v})`);
}
