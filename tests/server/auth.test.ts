import { describe, expect, it } from 'vitest';
import { AuthError, extractBearer, verifyBearerToken } from '../../src/server/auth.js';

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
