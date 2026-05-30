import { type Static, Type } from '@sinclair/typebox';

const OBJECT_OPTS = { additionalProperties: false } as const;

/** Bridge identifier — mirrors `BridgeKind` in src/domains/msp-bridges/types.ts. */
export const RuleBridgeSchema = Type.Union([
  Type.Literal('tanss'),
  Type.Literal('veeam'),
  Type.Literal('sophos'),
  Type.Literal('securepoint'),
  Type.Literal('m365'),
]);

/**
 * Status a condition can match — covers the FULL `kind` discriminant of
 * BridgeCellResult in src/domains/msp-aggregate/types.ts (what the poll-diff
 * detector compares across ticks). Must stay in sync with that union — all 7
 * kinds, incl. `rate-limited` and `error`, so a customer system erroring out
 * or getting rate-limited can be alerted on.
 */
export const RuleStatusSchema = Type.Union([
  Type.Literal('ok'),
  Type.Literal('misconfigured'),
  Type.Literal('auth-failed'),
  Type.Literal('unreachable'),
  Type.Literal('rate-limited'),
  Type.Literal('timeout'),
  Type.Literal('error'),
]);

export const RuleTriggerSchema = Type.Object(
  {
    bridge: RuleBridgeSchema,
    customers: Type.Union([
      Type.Literal('all'),
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    ]),
  },
  OBJECT_OPTS,
);

export const RuleConditionSchema = Type.Object(
  {
    statusIn: Type.Array(RuleStatusSchema, { minItems: 1 }),
  },
  OBJECT_OPTS,
);

/**
 * v1 actions are non-write only (Phase MC-B). Write actions (TANSS comment,
 * Ninja script) arrive in later phases behind the approval gate.
 */
export const RuleActionSchema = Type.Union([
  Type.Object(
    { type: Type.Literal('dashboard-alert'), message: Type.String({ minLength: 1 }) },
    OBJECT_OPTS,
  ),
  Type.Object(
    { type: Type.Literal('notify'), message: Type.String({ minLength: 1 }) },
    OBJECT_OPTS,
  ),
  Type.Object(
    { type: Type.Literal('audit-log'), message: Type.String({ minLength: 1 }) },
    OBJECT_OPTS,
  ),
]);

export type RuleAction = Static<typeof RuleActionSchema>;

export const RuleSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z0-9][a-z0-9_-]*$' }),
    description: Type.Optional(Type.String()),
    // `enabled: false` is enforced (evaluator skips the rule). Default = enabled.
    enabled: Type.Optional(Type.Boolean()),
    // FORWARD-DECLARATION, currently a NO-OP: `armed` is the future auto-execute
    // gate (Phase MC-E) — it will decide whether a WRITE action skips the
    // approval queue. In the current phase ALL actions are non-write, so the
    // evaluator does not read `armed` yet. It does NOT gate firing; use
    // `enabled` for that. See tasks/phase-msp-cockpit.md (MC-E).
    armed: Type.Optional(Type.Boolean()),
    trigger: RuleTriggerSchema,
    condition: RuleConditionSchema,
    actions: Type.Array(RuleActionSchema, { minItems: 1 }),
  },
  OBJECT_OPTS,
);

export type Rule = Static<typeof RuleSchema>;
