/**
 * Workspace-switch audit log (per ADR-0031 + SECURITY.md §4).
 *
 * Minimal v1 implementation: structured pino-events with a stable
 * `event` field. The full SECURITY.md §4 audit-store is Phase 6+
 * material; this module only emits the event so audit-trail-completeness
 * can be back-filled later by tailing the log files.
 *
 * @module @domains/workspace/audit-log
 */
import { createLogger } from '../../core/logging/index.js';
import type { WorkspaceId } from './types.js';

const logger = createLogger().child({ component: 'workspace-audit' });

export interface WorkspaceSwitchEvent {
  readonly from: WorkspaceId | null;
  readonly to: WorkspaceId;
  readonly source: 'cli' | 'gui' | 'sidecar' | 'env-default';
  readonly at: string;
}

/**
 * Emits a structured `workspace.switch` audit event. Side-effect-only.
 * Caller is responsible for invoking after a successful state write.
 */
export function logWorkspaceSwitch(event: Omit<WorkspaceSwitchEvent, 'at'>): void {
  const payload: WorkspaceSwitchEvent = {
    ...event,
    at: new Date().toISOString(),
  };
  logger.info(payload, 'workspace.switch');
}
