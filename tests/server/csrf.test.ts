import { describe, expect, it } from 'vitest';
import { csrfEquals, newCsrfToken } from '../../src/server/csrf.js';

describe('csrf', () => {
  it('newCsrfToken returns a 64-char hex string', () => {
    const t = newCsrfToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces unique tokens', () => {
    const a = newCsrfToken();
    const b = newCsrfToken();
    expect(a).not.toBe(b);
  });

  it('csrfEquals returns true for identical tokens', () => {
    const t = newCsrfToken();
    expect(csrfEquals(t, t)).toBe(true);
  });

  it('csrfEquals returns false for different tokens', () => {
    expect(csrfEquals(newCsrfToken(), newCsrfToken())).toBe(false);
  });

  it('csrfEquals returns false for length-mismatch', () => {
    expect(csrfEquals('short', 'much-longer-token-here')).toBe(false);
  });

  it('csrfEquals returns false for non-string inputs', () => {
    expect(csrfEquals('any', undefined as unknown as string)).toBe(false);
    expect(csrfEquals(123 as unknown as string, 'any')).toBe(false);
  });
});
