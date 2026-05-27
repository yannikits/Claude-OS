/**
 * @module @core/audit
 */

export { type AppendInput, AuditLogger, type AuditLoggerOpts } from './logger.js';
export { auditDir, auditFileForDate } from './paths.js';
export {
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  pruneAuditFiles,
  type RetentionOpts,
  type RetentionResult,
} from './retention.js';
export {
  AUDIT_SCHEMA_VERSION,
  type AuditEntry,
  AuditError,
  type AuditEventKind,
  type AuditSchemaVersion,
} from './types.js';
