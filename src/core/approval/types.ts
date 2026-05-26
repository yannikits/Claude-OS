/**
 * Approval-token types (Phase 7 foundation per ADR-0027 §Phase-7).
 *
 * MSP-Bridge **write**-operations require a Yannik-signed approval-token
 * before the actual API call. The signing-flow is:
 *
 *   1. Caller builds an `ApprovalRequest { action, target, payload }`.
 *   2. GUI shows the request + a diff/dry-run preview to Yannik
 *      (analog ADR-0023 Native-Password-Pattern — sensitive UX never
 *      passes through React-state).
 *   3. Yannik approves; the Ed25519 private key (out of the OS keyring,
 *      ADR-0004) signs the canonical-JSON form of the request.
 *   4. The resulting `ApprovalToken` is attached to the bridge-call.
 *   5. Bridge re-verifies the token before executing.
 *   6. The full request + token gets appended to the audit-log
 *      (Phase 6 `AuditLogger`, kind `bridge.write`).
 *
 * Public-core ships the **types + signing primitives**. Out of scope:
 *   - GUI approval-flow (Tauri-side, Phase 8+)
 *   - Bridge-specific dry-run code (private `claude-os-msp` per ADR-0030)
 *   - Keyring integration of the Ed25519 keypair (separate PR after
 *     ADR-0026 signature-flow lands)
 *
 * @module @core/approval/types
 */

/**
 * What the user is being asked to approve. Caller serialises this via
 * `canonicalJsonStringify` to a stable byte-form, which is then signed.
 */
export interface ApprovalRequest {
  /** Short action label ("tanss.ticket.close", "veeam.job.start"). */
  readonly action: string;
  /** Free-form target identifier ("ticket-4711", "job-uuid-..."). */
  readonly target: string;
  /** Workspace this action runs in (tenant-isolation hook per ADR-0031). */
  readonly workspace: string;
  /** Customer-id when relevant (extracted from msp-customers/<id> workspace). */
  readonly tenant?: string;
  /** Action payload (request-body for the API call). Caller sanitises. */
  readonly payload: Record<string, unknown>;
  /** ISO-8601 expiration timestamp — refused after this point. */
  readonly expiresAt: string;
  /** Random nonce so replay-of-same-payload is detectable in audit-log. */
  readonly nonce: string;
}

/**
 * Signed approval. Bridge attaches this to the API call; bridge-side
 * `verifyApprovalToken(token, publicKey)` MUST return true before any
 * write happens.
 */
export interface ApprovalToken {
  readonly request: ApprovalRequest;
  /** Base64-encoded Ed25519 signature over canonical-JSON of `request`. */
  readonly signature: string;
  /** First 16 hex chars of SHA-256(publicKey) — forensic correlation. */
  readonly publicKeyFingerprint: string;
  /** ISO-8601 when the user approved. */
  readonly signedAt: string;
}

export interface ApprovalKeyPair {
  /** Base64-encoded raw Ed25519 public key (32 bytes). */
  readonly publicKey: string;
  /** Base64-encoded raw Ed25519 private key (32 bytes). */
  readonly privateKey: string;
  /** First 16 hex chars of SHA-256(publicKey). Stable identifier. */
  readonly fingerprint: string;
}

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalError';
  }
}

export class ApprovalSignatureError extends ApprovalError {
  constructor(reason: string) {
    super(`Approval-token signature invalid: ${reason}`);
    this.name = 'ApprovalSignatureError';
  }
}

export class ApprovalExpiredError extends ApprovalError {
  constructor(expiresAt: string) {
    super(`Approval-token expired at ${expiresAt} (now > expiresAt)`);
    this.name = 'ApprovalExpiredError';
  }
}

export class ApprovalKeyFormatError extends ApprovalError {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalKeyFormatError';
  }
}
