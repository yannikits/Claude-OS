/**
 * Rule evaluator: pure function mapping (rules × state-changes) to the actions
 * that should fire. It performs NO dispatch — emitting alerts, queueing
 * approvals or calling vendor APIs happens downstream. Keeping evaluation pure
 * makes the matching logic trivially testable and side-effect free.
 *
 * A rule fires for a change when ALL hold:
 *  - the rule is enabled (default true),
 *  - `trigger.bridge` equals the change's bridge,
 *  - `trigger.customers` is `'all'` or includes the change's customer slug,
 *  - `condition.statusIn` includes the change's NEW status (`to`).
 *
 * @module @domains/automation/evaluator
 */
import type { Rule, RuleAction } from './rule-schema.js';
import type { StateChange } from './state-diff.js';

export interface FiredAction {
  readonly ruleId: string;
  readonly slug: string;
  readonly bridge: string;
  readonly action: RuleAction;
}

export function evaluateRules(
  rules: readonly Rule[],
  changes: readonly StateChange[],
): FiredAction[] {
  const fired: FiredAction[] = [];

  for (const change of changes) {
    for (const rule of rules) {
      if (rule.enabled === false) {
        continue;
      }
      if (rule.trigger.bridge !== change.bridge) {
        continue;
      }
      const { customers } = rule.trigger;
      if (customers !== 'all' && !customers.includes(change.slug)) {
        continue;
      }
      if (!(rule.condition.statusIn as readonly string[]).includes(change.to)) {
        continue;
      }
      for (const action of rule.actions) {
        fired.push({ ruleId: rule.id, slug: change.slug, bridge: change.bridge, action });
      }
    }
  }

  return fired;
}
