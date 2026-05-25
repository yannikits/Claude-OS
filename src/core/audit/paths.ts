/**
 * Audit-log on-disk paths.
 *
 * Per ADR-0027 + SECURITY.md §4: audit lives under the per-machine
 * `dataDir` (NOT the vault — audit-logs are per-machine forensic
 * records, not synced via the cloud-mount). One file per UTC-day so
 * grep/tail-by-date stays trivial.
 *
 * @module @core/audit/paths
 */
import { join } from 'node:path';
import { resolveMachinePaths } from '../paths/index.js';

const AUDIT_SUBDIR = 'audit';

/** Returns `<dataDir>/audit/`. */
export function auditDir(opts: { env?: NodeJS.ProcessEnv } = {}): string {
  const paths = resolveMachinePaths(opts.env === undefined ? {} : { env: opts.env });
  return join(paths.dataDir, AUDIT_SUBDIR);
}

/**
 * Returns `<dataDir>/audit/audit-YYYY-MM-DD.jsonl` for the given date
 * (or today in UTC by default).
 */
export function auditFileForDate(
  date: Date = new Date(),
  opts: { env?: NodeJS.ProcessEnv; dir?: string } = {},
): string {
  const day = date.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const dir = opts.dir ?? auditDir(opts.env === undefined ? {} : { env: opts.env });
  return join(dir, `audit-${day}.jsonl`);
}
