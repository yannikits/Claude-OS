/**
 * Approval-Token Builder — komponiert + signiert einen ApprovalToken.
 *
 * @module @domains/approval-token/builder
 */
import { randomUUID } from 'node:crypto';
import { signPayload } from '../skill-lifecycle/signing/index.js';
import { assertValidPayload } from './schema.js';
import {
  type ApprovalKind,
  type ApprovalToken,
  type ApprovalTokenPayload,
  DEFAULT_APPROVAL_TTL_MS,
} from './types.js';

export interface CreateApprovalTokenInput {
  readonly kind: ApprovalKind;
  readonly scope: string;
  readonly subject: string;
  readonly details?: Record<string, unknown>;
}

export interface CreateApprovalTokenOpts {
  /** Yannik's private key — base64-url 32B. */
  readonly privateKeyB64: string;
  /** Yannik's public key — base64-url 32B. */
  readonly publicKeyB64: string;
  /** Override default TTL (5 min). */
  readonly ttlMs?: number;
  /** Override now-factory (tests). */
  readonly now?: () => Date;
  /** Override nonce-factory (tests). Default `randomUUID()`. */
  readonly nonceFactory?: () => string;
}

/**
 * Composes an ApprovalToken with nonce + timestamps + signs it.
 *
 * Throws `ApprovalTokenError('invalid-payload')` if the input fails
 * TypeBox-validation (scope/subject zu kurz, kind unbekannt, etc.).
 */
export function createApprovalToken(
  input: CreateApprovalTokenInput,
  opts: CreateApprovalTokenOpts,
): ApprovalToken {
  const ttlMs = opts.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const nowFn = opts.now ?? (() => new Date());
  const nonceFn = opts.nonceFactory ?? (() => randomUUID());

  const issuedAt = nowFn();
  const expiresAt = new Date(issuedAt.getTime() + ttlMs);

  const payload: ApprovalTokenPayload = {
    version: 1,
    kind: input.kind,
    scope: input.scope,
    subject: input.subject,
    nonce: nonceFn(),
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ...(input.details === undefined ? {} : { details: input.details }),
  };

  assertValidPayload(payload);

  return signPayload(payload, opts.privateKeyB64, opts.publicKeyB64, { now: () => issuedAt });
}
