/**
 * Audit-log retention — deletes audit files older than the configured
 * retention window (per SECURITY.md §4.3).
 *
 * Default retention: **90 days** (per SECURITY.md §4.3 baseline). Can
 * be lifted up to 7 years for DSGVO MSP-contexts — Yannik configures
 * via `$CLAUDE_OS_AUDIT_RETENTION_DAYS` env-var or explicit opts.
 *
 * The implementation is filename-driven: audit files are
 * `audit-YYYY-MM-DD.jsonl`. The date prefix is parsed and compared
 * against (`now - retentionDays`). Files outside the cutoff are
 * deleted. Append-only invariant is preserved — never edit, only
 * delete whole-day files past the cutoff.
 *
 * Idempotent: safe to call as often as needed (e.g. once per sidecar
 * boot, or via a daily scheduled job).
 *
 * @module @core/audit/retention
 */
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { auditDir } from './paths.js';
import { AuditError } from './types.js';

export const DEFAULT_RETENTION_DAYS = 90;
export const MIN_RETENTION_DAYS = 1;
/**
 * Maximum retention window. 10 Jahre — deutsche Tax-Authorities-
 * Aufbewahrungsfrist (`§147 AO`) für Buchführungsunterlagen, dominiert
 * die kürzere 7y-DSGVO-Frist. Höher würde keinen MSP-Use-Case treffen.
 * Yannik-Entscheidung 2026-05-27 (vorher 7y, jetzt 10y).
 */
export const MAX_RETENTION_DAYS = 10 * 365;

const AUDIT_FILE_PATTERN = /^audit-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

export interface RetentionOpts {
  /** Retention window in days. Default 90 (per SECURITY.md §4.3). */
  readonly retentionDays?: number;
  /** Override audit-dir for tests. */
  readonly auditDir?: string;
  /** Env-source for `resolveMachinePaths` when auditDir is unset. */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam — override `Date.now()`. */
  readonly now?: () => Date;
  /** Dry-run: scan + report, but don't delete. */
  readonly dryRun?: boolean;
}

export interface RetentionResult {
  readonly retentionDays: number;
  readonly cutoffIso: string;
  readonly scanned: number;
  readonly deleted: readonly string[];
  readonly skippedNonAudit: number;
  readonly dryRun: boolean;
}

function resolveRetentionDays(opts: RetentionOpts): number {
  if (typeof opts.retentionDays === 'number') {
    return clampRetention(opts.retentionDays);
  }
  const env = opts.env ?? process.env;
  const raw = env.CLAUDE_OS_AUDIT_RETENTION_DAYS;
  if (raw !== undefined && raw.length > 0) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return clampRetention(parsed);
    }
  }
  return DEFAULT_RETENTION_DAYS;
}

function clampRetention(days: number): number {
  if (!Number.isFinite(days) || days < MIN_RETENTION_DAYS) return MIN_RETENTION_DAYS;
  if (days > MAX_RETENTION_DAYS) return MAX_RETENTION_DAYS;
  return Math.floor(days);
}

function resolveDir(opts: RetentionOpts): string {
  if (opts.auditDir !== undefined) return opts.auditDir;
  return auditDir(opts.env === undefined ? {} : { env: opts.env });
}

/**
 * Deletes audit files older than `retentionDays`. Returns a summary
 * for logging / surface-up to a doctor-check.
 *
 * Files that don't match the `audit-YYYY-MM-DD.jsonl` pattern (e.g.
 * gzipped archives `.jsonl.gz`, or stray files) are LEFT ALONE —
 * retention only operates on the canonical filename format.
 *
 * Errors during individual `unlinkSync` are swallowed into the result
 * (file might be open on Windows, FS race) — the caller decides what
 * to do. This keeps retention non-fatal for the boot-time hook.
 */
export function pruneAuditFiles(opts: RetentionOpts = {}): RetentionResult {
  const retentionDays = resolveRetentionDays(opts);
  const now = (opts.now ?? (() => new Date()))();
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const dryRun = opts.dryRun === true;
  const dir = resolveDir(opts);

  if (!existsSync(dir)) {
    return {
      retentionDays,
      cutoffIso,
      scanned: 0,
      deleted: [],
      skippedNonAudit: 0,
      dryRun,
    };
  }

  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    throw new AuditError(
      `pruneAuditFiles: failed to read audit-dir "${dir}": ${(err as Error).message}`,
    );
  }

  let scanned = 0;
  let skippedNonAudit = 0;
  const deleted: string[] = [];

  for (const entry of entries) {
    const match = AUDIT_FILE_PATTERN.exec(entry);
    if (match === null) {
      skippedNonAudit += 1;
      continue;
    }
    scanned += 1;
    const year = Number.parseInt(match[1] ?? '0', 10);
    const month = Number.parseInt(match[2] ?? '0', 10);
    const day = Number.parseInt(match[3] ?? '0', 10);
    // Use noon UTC to avoid timezone-boundary off-by-one
    const fileMs = Date.UTC(year, month - 1, day, 12, 0, 0);
    if (fileMs >= cutoffMs) continue;
    const fullPath = join(dir, entry);
    if (!dryRun) {
      try {
        // Verify it's actually a file (defense against symlink-shenanigans)
        const st = statSync(fullPath);
        if (!st.isFile()) continue;
        unlinkSync(fullPath);
      } catch {
        // Non-fatal — log silently. File might be locked on Windows.
        continue;
      }
    }
    deleted.push(entry);
  }

  return {
    retentionDays,
    cutoffIso,
    scanned,
    deleted,
    skippedNonAudit,
    dryRun,
  };
}
