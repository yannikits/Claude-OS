import { describe, expect, it } from 'vitest';
import { ApprovalError, canonicalJsonStringify } from '../../../src/core/approval/index.js';

describe('canonicalJsonStringify', () => {
  it('produces stable output for primitive values', () => {
    expect(canonicalJsonStringify(null)).toBe('null');
    expect(canonicalJsonStringify(true)).toBe('true');
    expect(canonicalJsonStringify(false)).toBe('false');
    expect(canonicalJsonStringify(42)).toBe('42');
    expect(canonicalJsonStringify('hi')).toBe('"hi"');
  });

  it('sorts object keys lexicographically', () => {
    const out = canonicalJsonStringify({ b: 1, a: 2, c: 3 });
    expect(out).toBe('{"a":2,"b":1,"c":3}');
  });

  it('sorts recursively in nested objects', () => {
    const out = canonicalJsonStringify({ outer: { z: 1, a: 2 }, alpha: 3 });
    expect(out).toBe('{"alpha":3,"outer":{"a":2,"z":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('produces the same byte-stream for differently-ordered inputs', () => {
    const a = { b: 1, a: 2, nested: { y: 1, x: 2 } };
    const b = { nested: { x: 2, y: 1 }, a: 2, b: 1 };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
  });

  it('rejects undefined values (would silently drop in JSON.stringify)', () => {
    expect(() => canonicalJsonStringify({ a: undefined })).toThrow(ApprovalError);
  });

  it('rejects functions', () => {
    expect(() => canonicalJsonStringify({ a: () => 1 })).toThrow(ApprovalError);
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJsonStringify(Number.NaN)).toThrow(ApprovalError);
    expect(() => canonicalJsonStringify(Number.POSITIVE_INFINITY)).toThrow(ApprovalError);
  });
});
