import { describe, expect, it } from 'vitest';
import {
  ApprovalExpiredError,
  type ApprovalRequest,
  ApprovalSignatureError,
  fingerprintOf,
  generateApprovalKeyPair,
  signApprovalToken,
  verifyApprovalToken,
} from '../../../src/core/approval/index.js';

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    action: 'tanss.ticket.close',
    target: 'ticket-4711',
    workspace: 'msp-customers/acme',
    tenant: 'acme',
    payload: { reason: 'resolved-by-auto-restart' },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: 'deadbeef-cafe-1234',
    ...overrides,
  };
}

describe('generateApprovalKeyPair', () => {
  it('returns base64-encoded raw keys + fingerprint', () => {
    const kp = generateApprovalKeyPair();
    expect(typeof kp.publicKey).toBe('string');
    expect(typeof kp.privateKey).toBe('string');
    expect(kp.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(kp.fingerprint).toBe(fingerprintOf(kp.publicKey));
  });

  it('generates different keys each call', () => {
    const a = generateApprovalKeyPair();
    const b = generateApprovalKeyPair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe('signApprovalToken / verifyApprovalToken — happy path', () => {
  it('signs + verifies a fresh token', () => {
    const kp = generateApprovalKeyPair();
    const r = request();
    const token = signApprovalToken(r, kp.privateKey, kp.publicKey);
    expect(token.publicKeyFingerprint).toBe(kp.fingerprint);
    expect(token.signature.length).toBeGreaterThan(20);
    expect(() => verifyApprovalToken(token, kp.publicKey)).not.toThrow();
  });

  it('canonical-JSON guarantees signing is order-independent', () => {
    const kp = generateApprovalKeyPair();
    const a = signApprovalToken(
      {
        action: 'x',
        target: 't',
        workspace: 'personal',
        payload: { b: 2, a: 1 },
        expiresAt: '2030-01-01T00:00:00.000Z',
        nonce: 'n1',
      },
      kp.privateKey,
      kp.publicKey,
    );
    const b = signApprovalToken(
      {
        action: 'x',
        target: 't',
        workspace: 'personal',
        payload: { a: 1, b: 2 },
        expiresAt: '2030-01-01T00:00:00.000Z',
        nonce: 'n1',
      },
      kp.privateKey,
      kp.publicKey,
    );
    expect(a.signature).toBe(b.signature);
  });
});

describe('verifyApprovalToken — refuses tampering', () => {
  it('throws when public key has different fingerprint than token claims', () => {
    const kp1 = generateApprovalKeyPair();
    const kp2 = generateApprovalKeyPair();
    const token = signApprovalToken(request(), kp1.privateKey, kp1.publicKey);
    expect(() => verifyApprovalToken(token, kp2.publicKey)).toThrow(ApprovalSignatureError);
  });

  it('throws when the signature is mutated', () => {
    const kp = generateApprovalKeyPair();
    const token = signApprovalToken(request(), kp.privateKey, kp.publicKey);
    const tampered = { ...token, signature: token.signature.replace(/./, 'A') };
    expect(() => verifyApprovalToken(tampered, kp.publicKey)).toThrow(ApprovalSignatureError);
  });

  it('throws when the request payload is mutated post-signing', () => {
    const kp = generateApprovalKeyPair();
    const token = signApprovalToken(request(), kp.privateKey, kp.publicKey);
    const tampered = {
      ...token,
      request: { ...token.request, payload: { reason: 'changed-after-signing' } },
    };
    expect(() => verifyApprovalToken(tampered, kp.publicKey)).toThrow(ApprovalSignatureError);
  });

  it('throws when the nonce changes', () => {
    const kp = generateApprovalKeyPair();
    const token = signApprovalToken(request(), kp.privateKey, kp.publicKey);
    const tampered = {
      ...token,
      request: { ...token.request, nonce: 'different-nonce' },
    };
    expect(() => verifyApprovalToken(tampered, kp.publicKey)).toThrow(ApprovalSignatureError);
  });
});

describe('verifyApprovalToken — expiration', () => {
  it('throws ApprovalExpiredError when expiresAt < now', () => {
    const kp = generateApprovalKeyPair();
    const expired = request({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const token = signApprovalToken(expired, kp.privateKey, kp.publicKey);
    expect(() => verifyApprovalToken(token, kp.publicKey)).toThrow(ApprovalExpiredError);
  });

  it('honours the now() override for time-travel tests', () => {
    const kp = generateApprovalKeyPair();
    const r = request({ expiresAt: '2026-01-01T00:00:00.000Z' });
    const token = signApprovalToken(r, kp.privateKey, kp.publicKey);
    // "now" is BEFORE expiresAt → should succeed
    expect(() =>
      verifyApprovalToken(token, kp.publicKey, { now: new Date('2025-12-01T00:00:00.000Z') }),
    ).not.toThrow();
    // "now" is AFTER expiresAt → should throw
    expect(() =>
      verifyApprovalToken(token, kp.publicKey, { now: new Date('2026-02-01T00:00:00.000Z') }),
    ).toThrow(ApprovalExpiredError);
  });

  it('skipExpirationCheck:true bypasses time-check (debug-only)', () => {
    const kp = generateApprovalKeyPair();
    const expired = request({ expiresAt: '1999-01-01T00:00:00.000Z' });
    const token = signApprovalToken(expired, kp.privateKey, kp.publicKey);
    expect(() =>
      verifyApprovalToken(token, kp.publicKey, { skipExpirationCheck: true }),
    ).not.toThrow();
  });
});
