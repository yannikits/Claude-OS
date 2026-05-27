/**
 * Approval-Token types — Public-Core-Foundation für ADR-0027 §Phase 7
 * (MSP-Write-Approval) und ADR-0026 §"Review-Gate" (Skill-Promote).
 *
 * Ein Approval-Token ist ein `SignedEnvelope` über einen spezifischen
 * Payload-Shape:
 *   - `kind` — welche Aktion freigegeben wird (msp.write / skill.promote)
 *   - `scope` — Bridge / Skill / Operation-Identifier
 *   - `subject` — Customer-ID / Skill-ID (workspace-context)
 *   - `nonce` — UUID, gegen Replay-Attacken
 *   - `issuedAt` / `expiresAt` — ISO-8601 timestamps
 *   - `details` — frei-form payload (diff-hash, before/after summary)
 *
 * @module @domains/approval-token/types
 */
import type { SignedEnvelope } from '../skill-lifecycle/signing/index.js';

/**
 * Discriminator-Union für die zwei Konsumenten dieser Foundation.
 * Erweiterbar via Folge-ADR ohne Schema-Bruch.
 */
export type ApprovalKind =
  | 'msp.write' // ADR-0027 §Phase 7 — Customer-API-Write
  | 'skill.promote' // ADR-0026 §"Review-Gate" — quarantined → reviewed
  | 'secret.rotate' // Future: signed secret-rotation events
  | 'workspace.create'; // Future: signed workspace-creation für MSP-Onboarding

export interface ApprovalTokenPayload {
  /** Token-Schema-Version, bumped wenn breaking. */
  readonly version: 1;
  readonly kind: ApprovalKind;
  /**
   * Was wird freigegeben — kind-spezifisch:
   *  - msp.write: "tanss.tickets.update", "ninja.devices.shutdown"
   *  - skill.promote: skill-id
   *  - secret.rotate: secret-key-name
   *  - workspace.create: workspace-id
   */
  readonly scope: string;
  /**
   * Subject of the action — kind-specific:
   *  - msp.write: customer-id (msp-customers/<id> mapping)
   *  - skill.promote: skill-id (same as scope; redundant ok)
   *  - secret.rotate: secret-key-name (same as scope)
   *  - workspace.create: workspace-id (same as scope)
   */
  readonly subject: string;
  /** Random UUID — verhindert Replay-Attacks. */
  readonly nonce: string;
  /** ISO-8601 issued-at. */
  readonly issuedAt: string;
  /**
   * ISO-8601 expires-at. Approval-Token sollten kurzlebig sein
   * (default 5min — wir geben dem User Zeit zum Confirmen, aber
   * nicht beliebig lange).
   */
  readonly expiresAt: string;
  /**
   * Freeform sanitised payload — diff-hash, before/after-summary,
   * MSP-API-call-params. Caller-Verantwortung: niemals Secrets.
   */
  readonly details?: Record<string, unknown>;
}

/**
 * Final-Token = signierter Envelope um den ApprovalTokenPayload.
 * Identisch zum signing-Wire-Format aus ADR-0035.
 */
export type ApprovalToken = SignedEnvelope<ApprovalTokenPayload>;

export class ApprovalTokenError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'invalid-payload'
      | 'verify-failed'
      | 'expired'
      | 'nonce-already-used'
      | 'wrong-kind'
      | 'wrong-scope'
      | 'wrong-subject',
  ) {
    super(message);
    this.name = 'ApprovalTokenError';
  }
}

/**
 * Default-TTL für Approval-Tokens. 5 Minuten — genug für menschliche
 * Confirm-Latency, kurz genug um stolen-token-Risk klein zu halten.
 */
export const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;

/**
 * Maximum acceptable clock-skew zwischen Issuer und Verifier.
 * Future-issuedAt-Tokens werden bis zu diesem Grenzwert toleriert.
 */
export const MAX_CLOCK_SKEW_MS = 30 * 1000;
