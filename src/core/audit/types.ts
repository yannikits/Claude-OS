/**
 * Audit-log types (Phase 6 foundation per ADR-0027 + SECURITY.md §4).
 *
 * Append-only structured event log for security-relevant actions:
 *   - MSP-Bridge API calls (read in Phase 6, write in Phase 7)
 *   - Workspace switches (Phase 2a — currently uses pino directly; can
 *     migrate to this audit-log in a follow-up)
 *   - Secret reads / writes (Phase 3d secrets domain)
 *   - Skill lifecycle transitions (Phase 5 sandbox/promote events)
 *
 * The full SECURITY.md §4 audit-store spec covers retention, rotation,
 * forwarding, and signature requirements. This module provides the
 * **wire format** + **append API** that all those concerns build on.
 *
 * Bridge implementations live in `claude-os-msp` (per ADR-0030) and
 * import this types/logger surface from the public-core (Claude-portable).
 *
 * @module @core/audit/types
 */

/**
 * Discriminator for the major event-categories the audit-log tracks.
 * Bridge-specific subtypes go in the `details` payload — the kind
 * stays coarse so the log file can be filtered with simple grep.
 */
export type AuditEventKind =
  | 'bridge.read'
  | 'bridge.write'
  | 'workspace.switch'
  | 'secret.read'
  | 'secret.write'
  | 'skill.promote'
  | 'skill.invoke'
  | 'note.write'
  | 'auth.login.success'
  | 'auth.login.failed'
  | 'auth.logout'
  | 'auth.register'
  | 'auth.password.change';

/**
 * Audit-log schema version. Bumped only when a backwards-incompatible
 * field change happens. Forward-compat: readers tolerate higher versions
 * by stripping unknown fields rather than rejecting the entry.
 *
 * History:
 *   v1 (2026-05-27) — initial finalized schema per SECURITY.md §4:
 *                     at, kind, action, workspace, tenant?, outcome,
 *                     details?, pid, hostname, schema_version
 */
export const AUDIT_SCHEMA_VERSION = 1 as const;
export type AuditSchemaVersion = typeof AUDIT_SCHEMA_VERSION;

/**
 * Single append-only audit entry. Written as one JSONL row per
 * `auditLogger.append()`. The shape is fixed-key + open-ended
 * `details` to keep grep-friendly.
 *
 * Schema is finalized per SECURITY.md §4 (Phase 5 completion 2026-05-27).
 */
export interface AuditEntry {
  /** Schema version — see `AUDIT_SCHEMA_VERSION`. */
  readonly schema_version: AuditSchemaVersion;
  /** ISO-8601 timestamp at write time. */
  readonly at: string;
  readonly kind: AuditEventKind;
  /** Free-form short label for the action ("tanss.tickets.list", "tenant-switch"). */
  readonly action: string;
  /** Workspace active at the time of the event (per ADR-0031). */
  readonly workspace: string;
  /** Customer-id when relevant (resolved from `msp-customers/<id>`). */
  readonly tenant?: string;
  /** Outcome — `ok` for success, `denied` for policy-block, `error` for unexpected. */
  readonly outcome: 'ok' | 'denied' | 'error';
  /** Free-form payload (sanitised). Caller's responsibility to not log secrets. */
  readonly details?: Record<string, unknown>;
  /** Process id for forensic correlation. */
  readonly pid: number;
  /** Hostname for cross-machine forensic correlation. */
  readonly hostname: string;
}

export class AuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditError';
  }
}
