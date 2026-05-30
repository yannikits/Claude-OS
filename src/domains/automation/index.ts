export { type ActionSink, dispatchFiredAction } from './dispatch.js';
export { type AutomationEngineOpts, startAutomationEngine } from './engine.js';
export { evaluateRules, type FiredAction } from './evaluator.js';
export {
  createFiredActionLog,
  type FiredActionLog,
  type FiredActionLogOpts,
  type LoggedFiring,
} from './fired-log.js';
export { loadRules, type RuleLoadIssue, type RuleLoadResult } from './rule-loader.js';
export { type Rule, type RuleAction, RuleSchema } from './rule-schema.js';
export { diffSnapshots, type StateChange } from './state-diff.js';
