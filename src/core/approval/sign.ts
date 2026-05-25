/**
 * Ed25519 sign + verify for approval-tokens.
 *
 * Node's `crypto.sign(null, data, privKey)` does the Ed25519 thing when
 * the key is an Ed25519 KeyObject — `null` algorithm is mandatory (Ed25519
 * is deterministic, no pre-hash needed).
 *
 * Keys are exchanged as base64 of the RAW 32-byte forms (PEM/DER overhead
 * not needed). The fingerprint is the first 16 hex chars of SHA-256(public
 * key bytes) — short enough for UI surfaces, long enough to discriminate.
 *
 * Signing is done over the canonical-JSON form of the `ApprovalRequest`
 * (see canonical-json.ts) so re-signing the same request yields the same
 * signature byte-for-byte.
 *
 * @module @core/approval/sign
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { canonicalJsonStringify } from './canonical-json.js';
import {
  ApprovalExpiredError,
  ApprovalKeyFormatError,
  type ApprovalKeyPair,
  type ApprovalRequest,
  ApprovalSignatureError,
  type ApprovalToken,
} from './types.js';

/**
 * Generates a fresh Ed25519 keypair. Returns base64-encoded raw forms
 * (no PEM headers) so the keys can be stored in the OS-Keychain as
 * simple strings.
 */
export function generateApprovalKeyPair(): ApprovalKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ format: 'jwk' }).x as string; // JWK 'x' = base64url public-key bytes
  const privRaw = (privateKey.export({ format: 'jwk' }) as { d?: string }).d ?? '';
  if (privRaw.length === 0) {
    throw new ApprovalKeyFormatError('generateKeyPair: JWK export missing private "d"');
  }
  const pubB64 = base64urlToBase64(pubRaw);
  const privB64 = base64urlToBase64(privRaw);
  return {
    publicKey: pubB64,
    privateKey: privB64,
    fingerprint: fingerprintOf(pubB64),
  };
}

/**
 * Returns the fingerprint of a base64-encoded raw public-key.
 * First 16 hex chars of SHA-256(decoded bytes).
 */
export function fingerprintOf(publicKeyBase64: string): string {
  const bytes = Buffer.from(publicKeyBase64, 'base64');
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/**
 * Signs an `ApprovalRequest` with a base64-encoded raw Ed25519 private
 * key. Returns an `ApprovalToken` ready for transport.
 */
export function signApprovalToken(
  request: ApprovalRequest,
  privateKeyBase64: string,
  publicKeyBase64: string,
  now: Date = new Date(),
): ApprovalToken {
  let privKey: ReturnType<typeof createPrivateKey>;
  try {
    privKey = createPrivateKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        d: base64ToBase64Url(privateKeyBase64),
        x: base64ToBase64Url(publicKeyBase64),
      },
      format: 'jwk',
    });
  } catch (err) {
    throw new ApprovalKeyFormatError(
      `signApprovalToken: invalid private key (${(err as Error).message})`,
    );
  }
  const canonical = canonicalJsonStringify(request);
  const signature = sign(null, Buffer.from(canonical, 'utf8'), privKey);
  return {
    request,
    signature: signature.toString('base64'),
    publicKeyFingerprint: fingerprintOf(publicKeyBase64),
    signedAt: now.toISOString(),
  };
}

export interface VerifyOpts {
  /** Override `now()` for tests / replay-window check. */
  readonly now?: Date;
  /** Skip the expiration check (debug only). Default false. */
  readonly skipExpirationCheck?: boolean;
}

/**
 * Verifies an `ApprovalToken` against a base64-encoded raw public key.
 *
 * Throws:
 *   - `ApprovalSignatureError` if the signature doesn't verify
 *   - `ApprovalSignatureError` if the fingerprint in the token doesn't
 *     match the supplied public key (caller is checking the wrong key)
 *   - `ApprovalExpiredError` if `expiresAt < now`
 */
export function verifyApprovalToken(
  token: ApprovalToken,
  publicKeyBase64: string,
  opts: VerifyOpts = {},
): void {
  const expectedFp = fingerprintOf(publicKeyBase64);
  if (token.publicKeyFingerprint !== expectedFp) {
    throw new ApprovalSignatureError(
      `fingerprint mismatch: token=${token.publicKeyFingerprint}, supplied-key=${expectedFp}`,
    );
  }

  if (opts.skipExpirationCheck !== true) {
    const now = opts.now ?? new Date();
    const expiresAtMs = Date.parse(token.request.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      throw new ApprovalSignatureError(
        `expiresAt is not a parseable ISO-8601 string: "${token.request.expiresAt}"`,
      );
    }
    if (now.getTime() > expiresAtMs) {
      throw new ApprovalExpiredError(token.request.expiresAt);
    }
  }

  let pubKey: ReturnType<typeof createPublicKey>;
  try {
    pubKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: base64ToBase64Url(publicKeyBase64) },
      format: 'jwk',
    });
  } catch (err) {
    throw new ApprovalKeyFormatError(
      `verifyApprovalToken: invalid public key (${(err as Error).message})`,
    );
  }
  const canonical = canonicalJsonStringify(token.request);
  const sigBytes = Buffer.from(token.signature, 'base64');
  const ok = verify(null, Buffer.from(canonical, 'utf8'), pubKey, sigBytes);
  if (!ok) {
    throw new ApprovalSignatureError('Ed25519 verify returned false');
  }
}

function base64urlToBase64(b64url: string): string {
  return b64url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(b64url.length / 4) * 4, '=');
}

function base64ToBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
