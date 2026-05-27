/**
 * TypeBox-Schema für ApprovalTokenPayload — strict-validate vor Sign + Verify.
 *
 * @module @domains/approval-token/schema
 */
import { type Static, Type } from '@sinclair/typebox';
import { formatErrors } from '../../core/validation/format.js';
import { ApprovalTokenError } from './types.js';

const ApprovalKindSchema = Type.Union([
  Type.Literal('msp.write'),
  Type.Literal('skill.promote'),
  Type.Literal('secret.rotate'),
  Type.Literal('workspace.create'),
]);

/**
 * Strict schema. `additionalProperties: false` für payload-shape —
 * keine surprise-fields. `details` darf arbitrary keys haben (it's
 * the freeform-slot).
 */
export const ApprovalTokenPayloadSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: ApprovalKindSchema,
    scope: Type.String({ minLength: 1, maxLength: 256 }),
    subject: Type.String({ minLength: 1, maxLength: 256 }),
    nonce: Type.String({ minLength: 8, maxLength: 64 }),
    issuedAt: Type.String({ minLength: 20 }), // ISO-8601 mind. "2026-05-27T10:00:00Z"
    expiresAt: Type.String({ minLength: 20 }),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export type ApprovalTokenPayloadStatic = Static<typeof ApprovalTokenPayloadSchema>;

/**
 * Validates a payload-shape. Throws ApprovalTokenError on failure.
 * Used vor Sign (caller-input-check) und nach Verify (defense-in-
 * depth gegen manipulated envelope.payload).
 */
export function assertValidPayload(
  payload: unknown,
): asserts payload is ApprovalTokenPayloadStatic {
  const errors = formatErrors(ApprovalTokenPayloadSchema, payload);
  if (errors.length > 0) {
    throw new ApprovalTokenError(
      `invalid approval-token payload:\n  ${errors.join('\n  ')}`,
      'invalid-payload',
    );
  }
}
