import { describe, expect, it, vi } from 'vitest';
import {
  ApprovalTokenError,
  createApprovalToken,
  DEFAULT_APPROVAL_TTL_MS,
  verifyApprovalToken,
} from '../../../src/domains/approval-token/index.js';
import { generateEd25519Keypair } from '../../../src/domains/skill-lifecycle/signing/index.js';

const fixedNonce =
  (n = 'nonce-fixed-12345678') =>
  () =>
    n;

describe('createApprovalToken', () => {
  it('composes payload + signs with current time', () => {
    const kp = generateEd25519Keypair();
    const now = new Date('2026-05-27T10:00:00Z');
    const token = createApprovalToken(
      {
        kind: 'msp.write',
        scope: 'tanss.tickets.update',
        subject: 'acme-customer-id',
        details: { ticketId: 'T-12345', diff: 'status: open → closed' },
      },
      {
        privateKeyB64: kp.privateKeyB64,
        publicKeyB64: kp.publicKeyB64,
        now: () => now,
        nonceFactory: fixedNonce(),
      },
    );

    expect(token.algorithm).toBe('ed25519-sha256-canonjson');
    expect(token.payload.kind).toBe('msp.write');
    expect(token.payload.scope).toBe('tanss.tickets.update');
    expect(token.payload.subject).toBe('acme-customer-id');
    expect(token.payload.nonce).toBe('nonce-fixed-12345678');
    expect(token.payload.issuedAt).toBe('2026-05-27T10:00:00.000Z');
    expect(token.payload.expiresAt).toBe(
      new Date(now.getTime() + DEFAULT_APPROVAL_TTL_MS).toISOString(),
    );
    expect(token.payload.version).toBe(1);
  });

  it('respects custom TTL', () => {
    const kp = generateEd25519Keypair();
    const now = new Date('2026-05-27T10:00:00Z');
    const token = createApprovalToken(
      {
        kind: 'skill.promote',
        scope: 'vpn-mtu-fix',
        subject: 'vpn-mtu-fix',
      },
      {
        privateKeyB64: kp.privateKeyB64,
        publicKeyB64: kp.publicKeyB64,
        ttlMs: 1000,
        now: () => now,
        nonceFactory: fixedNonce(),
      },
    );
    expect(token.payload.expiresAt).toBe('2026-05-27T10:00:01.000Z');
  });

  it('rejects empty scope (TypeBox schema)', () => {
    const kp = generateEd25519Keypair();
    expect(() =>
      createApprovalToken(
        { kind: 'msp.write', scope: '', subject: 'acme' },
        { privateKeyB64: kp.privateKeyB64, publicKeyB64: kp.publicKeyB64 },
      ),
    ).toThrow(ApprovalTokenError);
  });
});

describe('verifyApprovalToken', () => {
  const issueAt = new Date('2026-05-27T10:00:00Z');
  const within = new Date('2026-05-27T10:02:00Z'); // 2 min later — within 5min default

  const makeToken = (kp = generateEd25519Keypair(), overrides: Record<string, unknown> = {}) => {
    return {
      kp,
      token: createApprovalToken(
        {
          kind: 'msp.write',
          scope: 'tanss.tickets.update',
          subject: 'acme',
          ...overrides,
        },
        {
          privateKeyB64: kp.privateKeyB64,
          publicKeyB64: kp.publicKeyB64,
          now: () => issueAt,
          nonceFactory: fixedNonce(),
        },
      ),
    };
  };

  it('verifies a freshly-issued token successfully', async () => {
    const { kp, token } = makeToken();
    const payload = await verifyApprovalToken(token, {
      expectedPublicKeyB64: kp.publicKeyB64,
      now: () => within,
    });
    expect(payload.kind).toBe('msp.write');
    expect(payload.scope).toBe('tanss.tickets.update');
  });

  it('rejects expired tokens', async () => {
    const { kp, token } = makeToken();
    const expired = new Date('2026-05-27T11:00:00Z'); // 1h later
    await expect(
      verifyApprovalToken(token, {
        expectedPublicKeyB64: kp.publicKeyB64,
        now: () => expired,
      }),
    ).rejects.toThrow(/expired/);
  });

  it('rejects tokens from a different key (attacker swap)', async () => {
    const { token } = makeToken();
    const other = generateEd25519Keypair();
    await expect(
      verifyApprovalToken(token, {
        expectedPublicKeyB64: other.publicKeyB64,
        now: () => within,
      }),
    ).rejects.toThrow(/verification failed/);
  });

  it('rejects wrong-kind tokens', async () => {
    const { kp, token } = makeToken();
    await expect(
      verifyApprovalToken(token, {
        expectedPublicKeyB64: kp.publicKeyB64,
        expectedKind: 'skill.promote',
        now: () => within,
      }),
    ).rejects.toThrow(/wrong kind/);
  });

  it('rejects wrong-scope tokens', async () => {
    const { kp, token } = makeToken();
    await expect(
      verifyApprovalToken(token, {
        expectedPublicKeyB64: kp.publicKeyB64,
        expectedScope: 'tanss.tickets.create',
        now: () => within,
      }),
    ).rejects.toThrow(/wrong scope/);
  });

  it('rejects wrong-subject tokens', async () => {
    const { kp, token } = makeToken();
    await expect(
      verifyApprovalToken(token, {
        expectedPublicKeyB64: kp.publicKeyB64,
        expectedSubject: 'other-customer',
        now: () => within,
      }),
    ).rejects.toThrow(/wrong subject/);
  });

  it('rejects tokens whose nonce has been seen (replay-attack defense)', async () => {
    const { kp, token } = makeToken();
    const nonceSeen = vi.fn().mockResolvedValue(true);
    await expect(
      verifyApprovalToken(token, {
        expectedPublicKeyB64: kp.publicKeyB64,
        now: () => within,
        nonceSeen,
      }),
    ).rejects.toThrow(/already-used/);
    expect(nonceSeen).toHaveBeenCalledWith('nonce-fixed-12345678');
  });

  it('passes when nonce is fresh (replay-hook returns false)', async () => {
    const { kp, token } = makeToken();
    const nonceSeen = vi.fn().mockResolvedValue(false);
    const payload = await verifyApprovalToken(token, {
      expectedPublicKeyB64: kp.publicKeyB64,
      now: () => within,
      nonceSeen,
    });
    expect(payload.nonce).toBe('nonce-fixed-12345678');
  });

  it('rejects tampered payload (signature mismatch)', async () => {
    const { kp, token } = makeToken();
    const tampered = {
      ...token,
      payload: { ...token.payload, subject: 'evil-customer' },
    };
    await expect(
      verifyApprovalToken(tampered, {
        expectedPublicKeyB64: kp.publicKeyB64,
        now: () => within,
      }),
    ).rejects.toThrow(/verification failed/);
  });

  it('tolerates clock-skew within ±30s default', async () => {
    const { kp, token } = makeToken();
    // 5min + 20s after issue — within MAX_CLOCK_SKEW_MS default
    const slightlyAfter = new Date(issueAt.getTime() + DEFAULT_APPROVAL_TTL_MS + 20_000);
    const payload = await verifyApprovalToken(token, {
      expectedPublicKeyB64: kp.publicKeyB64,
      now: () => slightlyAfter,
    });
    expect(payload.kind).toBe('msp.write');
  });

  it('respects custom clockSkewMs=0 (strict expiry)', async () => {
    const { kp, token } = makeToken();
    // 1 ms past expiry — strict mode rejects
    const strictPastExpiry = new Date(issueAt.getTime() + DEFAULT_APPROVAL_TTL_MS + 1);
    await expect(
      verifyApprovalToken(token, {
        expectedPublicKeyB64: kp.publicKeyB64,
        now: () => strictPastExpiry,
        clockSkewMs: 0,
      }),
    ).rejects.toThrow(/expired/);
  });
});
