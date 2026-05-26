import { describe, expect, it } from 'vitest';
import {
  AuthError,
  extractBearer,
  matchBearerToken,
  parseTokenList,
  tokenToTenantId,
  verifyBearerToken,
} from '../../src/server/auth.js';

describe('verifyBearerToken', () => {
  it('matches identical strings', () => {
    expect(verifyBearerToken('abc123', 'abc123')).toBe(true);
  });
  it('rejects different strings of same length', () => {
    expect(verifyBearerToken('abc123', 'xyz789')).toBe(false);
  });
  it('rejects length-mismatch without throwing', () => {
    expect(verifyBearerToken('short', 'much-longer-token-here')).toBe(false);
  });
  it('rejects empty against non-empty', () => {
    expect(verifyBearerToken('', 'token')).toBe(false);
  });
});

describe('parseTokenList', () => {
  it('returns single-element list from a single token (backwards-compat)', () => {
    expect(parseTokenList('abc123')).toEqual(['abc123']);
  });
  it('splits CSV into trimmed entries', () => {
    expect(parseTokenList('a, b ,c')).toEqual(['a', 'b', 'c']);
  });
  it('drops empty entries from trailing commas', () => {
    expect(parseTokenList('a,b,,')).toEqual(['a', 'b']);
  });
  it('returns empty list from empty string', () => {
    expect(parseTokenList('')).toEqual([]);
  });
});

describe('matchBearerToken', () => {
  it('matches one token from a list', () => {
    expect(matchBearerToken('b', ['a', 'b', 'c'])).toBe('b');
  });
  it('returns null when none match', () => {
    expect(matchBearerToken('x', ['a', 'b', 'c'])).toBeNull();
  });
  it('returns null for empty list', () => {
    expect(matchBearerToken('a', [])).toBeNull();
  });
  it('returns the actually-matched string (callers compute tenant from it)', () => {
    const result = matchBearerToken('alice-token', ['alice-token', 'bob-token']);
    expect(result).toBe('alice-token');
  });
});

describe('tokenToTenantId', () => {
  it('is deterministic across calls', () => {
    expect(tokenToTenantId('hello')).toBe(tokenToTenantId('hello'));
  });
  it('produces a 12-char hex string', () => {
    const id = tokenToTenantId('token');
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });
  it('produces different ids for different tokens', () => {
    expect(tokenToTenantId('a')).not.toBe(tokenToTenantId('b'));
  });
});

describe('extractBearer', () => {
  it('extracts token from valid header', () => {
    expect(extractBearer('Bearer abc123')).toBe('abc123');
  });
  it('throws missing on undefined', () => {
    expect(() => extractBearer(undefined)).toThrow(AuthError);
    try {
      extractBearer(undefined);
    } catch (e) {
      expect((e as AuthError).reason).toBe('missing');
      expect((e as AuthError).statusCode).toBe(401);
    }
  });
  it('throws missing on empty string', () => {
    try {
      extractBearer('');
    } catch (e) {
      expect((e as AuthError).reason).toBe('missing');
    }
  });
  it('throws malformed (400) when prefix is wrong', () => {
    try {
      extractBearer('Basic abc:xyz');
    } catch (e) {
      expect((e as AuthError).reason).toBe('malformed');
      expect((e as AuthError).statusCode).toBe(400);
    }
  });
  it('throws malformed when token after prefix is empty', () => {
    try {
      extractBearer('Bearer ');
    } catch (e) {
      expect((e as AuthError).reason).toBe('malformed');
    }
  });
});
