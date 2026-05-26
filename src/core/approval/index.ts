/**
 * Approval-token public-core foundation for Phase 7 MSP-Write per ADR-0027.
 *
 * @module @core/approval
 */

export { canonicalJsonStringify } from './canonical-json.js';
export {
  fingerprintOf,
  generateApprovalKeyPair,
  signApprovalToken,
  type VerifyOpts,
  verifyApprovalToken,
} from './sign.js';
export {
  ApprovalError,
  ApprovalExpiredError,
  ApprovalKeyFormatError,
  type ApprovalKeyPair,
  type ApprovalRequest,
  ApprovalSignatureError,
  type ApprovalToken,
} from './types.js';
