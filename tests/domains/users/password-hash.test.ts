import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  MalformedHashError,
  MIN_PASSWORD_LEN,
  verifyPassword,
  WeakPasswordError,
} from '../../../src/domains/users/index.js';

describe('hashPassword + verifyPassword', () => {
  it('round-trips a strong password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword('correct-horse-battery-staple', hash)).toBe(true);
  });

  it('returns false for the wrong password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword('wrong-horse-battery-staple', hash)).toBe(false);
  });

  it('returns false for a password of different length', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword('too-short-now', hash)).toBe(false);
    expect(await verifyPassword('correct-horse-battery-staple-extended', hash)).toBe(false);
  });

  it('returns false for empty password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('produces algorithm-tagged output with expected parameters', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(hash).toMatch(/^scrypt\$N=16384\$r=8\$p=1\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/);
  });

  it('produces a different hash on each invocation (random salt)', async () => {
    const a = await hashPassword('correct-horse-battery-staple');
    const b = await hashPassword('correct-horse-battery-staple');
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct-horse-battery-staple', a)).toBe(true);
    expect(await verifyPassword('correct-horse-battery-staple', b)).toBe(true);
  });

  it('handles unicode passwords', async () => {
    const pw = 'pässwôrd-üäö-ßünß';
    expect(pw.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LEN);
    const hash = await hashPassword(pw);
    expect(await verifyPassword(pw, hash)).toBe(true);
    expect(await verifyPassword('passwort-uao-suns', hash)).toBe(false);
  });
});

describe('hashPassword strength enforcement', () => {
  it(`rejects passwords below MIN_PASSWORD_LEN (${MIN_PASSWORD_LEN})`, async () => {
    const tooShort = 'a'.repeat(MIN_PASSWORD_LEN - 1);
    await expect(hashPassword(tooShort)).rejects.toBeInstanceOf(WeakPasswordError);
  });

  it('rejects empty password', async () => {
    await expect(hashPassword('')).rejects.toBeInstanceOf(WeakPasswordError);
  });

  it('rejects non-string password', async () => {
    await expect(hashPassword(undefined as unknown as string)).rejects.toBeInstanceOf(
      WeakPasswordError,
    );
    await expect(hashPassword(12345 as unknown as string)).rejects.toBeInstanceOf(
      WeakPasswordError,
    );
  });

  it('accepts exactly MIN_PASSWORD_LEN', async () => {
    const exact = 'a'.repeat(MIN_PASSWORD_LEN);
    const hash = await hashPassword(exact);
    expect(await verifyPassword(exact, hash)).toBe(true);
  });
});

describe('verifyPassword input validation', () => {
  it('throws MalformedHashError when encoded does not start with "scrypt$"', async () => {
    await expect(verifyPassword('any', 'bcrypt$N=16384$r=8$p=1$AAAA$BBBB')).rejects.toBeInstanceOf(
      MalformedHashError,
    );
  });

  it('throws MalformedHashError when segment count is wrong', async () => {
    await expect(verifyPassword('any', 'scrypt$N=16384$r=8$p=1$AAAA')).rejects.toBeInstanceOf(
      MalformedHashError,
    );
    await expect(
      verifyPassword('any', 'scrypt$N=16384$r=8$p=1$AAAA$BBBB$extra'),
    ).rejects.toBeInstanceOf(MalformedHashError);
  });

  it('throws MalformedHashError when integer segments are malformed', async () => {
    await expect(verifyPassword('any', 'scrypt$N=abc$r=8$p=1$AAAA$BBBB')).rejects.toBeInstanceOf(
      MalformedHashError,
    );
    await expect(verifyPassword('any', 'scrypt$N=0$r=8$p=1$AAAA$BBBB')).rejects.toBeInstanceOf(
      MalformedHashError,
    );
    await expect(verifyPassword('any', 'scrypt$N=16384$X=8$p=1$AAAA$BBBB')).rejects.toBeInstanceOf(
      MalformedHashError,
    );
  });

  it('throws MalformedHashError on empty input', async () => {
    await expect(verifyPassword('any', '')).rejects.toBeInstanceOf(MalformedHashError);
  });

  it('throws MalformedHashError when salt or hash is empty', async () => {
    await expect(verifyPassword('any', 'scrypt$N=16384$r=8$p=1$$BBBB')).rejects.toBeInstanceOf(
      MalformedHashError,
    );
    await expect(verifyPassword('any', 'scrypt$N=16384$r=8$p=1$AAAA$')).rejects.toBeInstanceOf(
      MalformedHashError,
    );
  });

  it('returns false (not throw) for a structurally-valid but tampered hash', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    // Flip a byte in the hash portion.
    const parts = hash.split('$');
    const hashB64 = parts[5] ?? '';
    const flipped = (hashB64[0] === 'A' ? 'B' : 'A') + hashB64.slice(1);
    parts[5] = flipped;
    const tampered = parts.join('$');
    expect(await verifyPassword('correct-horse-battery-staple', tampered)).toBe(false);
  });
});
