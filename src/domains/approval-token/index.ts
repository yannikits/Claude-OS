/**
 * Approval-Token domain — Public-Core-Foundation für ADR-0027 §Phase 7
 * (MSP-Write) und ADR-0026 §"Review-Gate" (Skill-Promote).
 *
 * Wrappt das ADR-0035-`SignedEnvelope` mit ApprovalTokenPayload-Schema +
 * Expiry + Nonce + Scope/Kind/Subject-Check + Replay-Protection-Hook.
 *
 * @module @domains/approval-token
 */

export {
  type CreateApprovalTokenInput,
  type CreateApprovalTokenOpts,
  createApprovalToken,
} from './builder.js';
export { ApprovalTokenPayloadSchema, assertValidPayload } from './schema.js';
export {
  type ApprovalKind,
  type ApprovalToken,
  ApprovalTokenError,
  type ApprovalTokenPayload,
  DEFAULT_APPROVAL_TTL_MS,
  MAX_CLOCK_SKEW_MS,
} from './types.js';
export { type VerifyApprovalTokenOpts, verifyApprovalToken } from './verifier.js';
