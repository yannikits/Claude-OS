/**
 * Approval-Token Verifier — signature + expiry + scope/subject-match
 * + replay-protection.
 *
 * Defense-Layer:
 *   1. SignedEnvelope-Verify (ADR-0035 — signature + algorithm)
 *   2. Payload-Schema-Validate (TypeBox — kein malformed payload)
 *   3. Expiry-Check (`now <= expiresAt + clockSkew`)
 *   4. NotBefore-Check (`now >= issuedAt - clockSkew`)
 *   5. Scope/Kind/Subject-Match — caller specifies expected values
 *   6. Replay-Protection — caller injects a `nonceSeen()` check
 *
 * Returns the decoded payload on success. Throws ApprovalTokenError
 * on any failure (signature mismatch is a structural failure, not a
 * normal control-flow case — Caller branches on the kind).
 *
 * @module @domains/approval-token/verifier
 */
import { verifyEnvelope } from '../skill-lifecycle/signing/index.js';
import { assertValidPayload } from './schema.js';
import {
  type ApprovalKind,
  type ApprovalToken,
  ApprovalTokenError,
  type ApprovalTokenPayload,
  MAX_CLOCK_SKEW_MS,
} from './types.js';

export interface VerifyApprovalTokenOpts {
  /** Trust-anchored public-key — Token-publicKey muss matchen. */
  readonly expectedPublicKeyB64: string;
  /** Erwartetes `kind`. Wenn unset, jeder kind erlaubt (caller branches). */
  readonly expectedKind?: ApprovalKind;
  /** Erwarteter `scope`. Wenn unset, jeder scope erlaubt. */
  readonly expectedScope?: string;
  /** Erwarteter `subject`. Wenn unset, jeder subject erlaubt. */
  readonly expectedSubject?: string;
  /**
   * Replay-Schutz-Hook. Wenn der Caller schon einen nonce-store hat
   * (z.B. SQLite-set + retention-prune), prüft er hier ob die nonce
   * schon-mal-gesehen wurde. Bei `true` → ApprovalTokenError('nonce-
   * already-used').
   *
   * Wenn `nonceSeen` unset → kein Replay-Schutz (caller-Verantwortung
   * den nonce extern zu tracken). Foundation lässt diese Politik
   * dem Caller-Layer (claude-os-msp speichert nonces in customer-
   * isolated tables).
   */
  readonly nonceSeen?: (nonce: string) => boolean | Promise<boolean>;
  /** Override now-factory (tests). */
  readonly now?: () => Date;
  /** Override clock-skew tolerance. Default 30s. */
  readonly clockSkewMs?: number;
}

/**
 * Verifies a token end-to-end. Returns the decoded payload on success.
 */
export async function verifyApprovalToken(
  token: ApprovalToken,
  opts: VerifyApprovalTokenOpts,
): Promise<ApprovalTokenPayload> {
  const nowFn = opts.now ?? (() => new Date());
  const clockSkewMs = opts.clockSkewMs ?? MAX_CLOCK_SKEW_MS;

  // 1. Signature-Verify (ADR-0035).
  let signatureValid: boolean;
  try {
    signatureValid = verifyEnvelope(token, { expectedPublicKeyB64: opts.expectedPublicKeyB64 });
  } catch (err) {
    throw new ApprovalTokenError(
      `envelope-verify threw: ${(err as Error).message}`,
      'verify-failed',
    );
  }
  if (!signatureValid) {
    throw new ApprovalTokenError(
      'envelope signature verification failed (wrong key, tampered payload, or wrong algorithm)',
      'verify-failed',
    );
  }

  // 2. Payload-Schema-Validate (defense-in-depth gegen manipulated
  //    envelope.payload).
  assertValidPayload(token.payload);

  // 3. Expiry + 4. NotBefore.
  const now = nowFn();
  const issuedAt = new Date(token.payload.issuedAt);
  const expiresAt = new Date(token.payload.expiresAt);
  if (Number.isNaN(issuedAt.getTime()) || Number.isNaN(expiresAt.getTime())) {
    throw new ApprovalTokenError(
      'issuedAt or expiresAt are not valid ISO-8601 timestamps',
      'invalid-payload',
    );
  }
  if (now.getTime() > expiresAt.getTime() + clockSkewMs) {
    throw new ApprovalTokenError(
      `token expired (expiresAt=${token.payload.expiresAt}, now=${now.toISOString()})`,
      'expired',
    );
  }
  if (now.getTime() + clockSkewMs < issuedAt.getTime()) {
    throw new ApprovalTokenError(
      `token issued in the future (issuedAt=${token.payload.issuedAt}, now=${now.toISOString()})`,
      'invalid-payload',
    );
  }

  // 5. Scope/Kind/Subject-Match.
  if (opts.expectedKind !== undefined && token.payload.kind !== opts.expectedKind) {
    throw new ApprovalTokenError(
      `wrong kind: expected "${opts.expectedKind}", got "${token.payload.kind}"`,
      'wrong-kind',
    );
  }
  if (opts.expectedScope !== undefined && token.payload.scope !== opts.expectedScope) {
    throw new ApprovalTokenError(
      `wrong scope: expected "${opts.expectedScope}", got "${token.payload.scope}"`,
      'wrong-scope',
    );
  }
  if (opts.expectedSubject !== undefined && token.payload.subject !== opts.expectedSubject) {
    throw new ApprovalTokenError(
      `wrong subject: expected "${opts.expectedSubject}", got "${token.payload.subject}"`,
      'wrong-subject',
    );
  }

  // 6. Replay-Protection.
  if (opts.nonceSeen !== undefined) {
    const seen = await opts.nonceSeen(token.payload.nonce);
    if (seen) {
      throw new ApprovalTokenError(
        `nonce "${token.payload.nonce}" already-used (replay-attack defense)`,
        'nonce-already-used',
      );
    }
  }

  return token.payload;
}
