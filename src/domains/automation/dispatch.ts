/**
 * Route a FiredAction to the correct sink. The engine stays transport-
 * agnostic; this is the one place that knows v1 action types map to:
 *   - dashboard-alert / notify → the SSE notification bus (`alert`)
 *   - audit-log                → the audit trail (`audit`)
 *
 * @module @domains/automation/dispatch
 */
import type { FiredAction } from './evaluator.js';

export interface ActionSink {
  readonly alert: (fired: FiredAction) => void;
  readonly audit: (fired: FiredAction) => void;
}

export function dispatchFiredAction(fired: FiredAction, sink: ActionSink): void {
  switch (fired.action.type) {
    case 'dashboard-alert':
    case 'notify':
      sink.alert(fired);
      return;
    case 'audit-log':
      sink.audit(fired);
      return;
  }
}
