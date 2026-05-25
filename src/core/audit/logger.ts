/**
 * AuditLogger — append-only JSONL writer.
 *
 * Behaviour:
 *   - one row per `append()`, terminated with `\n`
 *   - file rotates by UTC-day automatically (each `append` resolves
 *     the day-file fresh, so a process running across midnight writes
 *     to the right file)
 *   - missing audit dir is auto-created on first write
 *   - file mode 0o600 (per machine, not world-readable)
 *   - `auditFn` injectable so tests can intercept without touching FS
 *
 * **Do not log secrets.** Callers MUST sanitise `details` payloads
 * before passing them in (per SECURITY.md §4). The logger does not
 * scan for secret-shaped fields.
 *
 * @module @core/audit/logger
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { auditFileForDate } from './paths.js';
import { type AuditEntry, AuditError, type AuditEventKind } from './types.js';

export interface AuditLoggerOpts {
  /** Override audit-dir (tests). */
  readonly auditDir?: string;
  /** Env-vars for `resolveMachinePaths` (tests). */
  readonly env?: NodeJS.ProcessEnv;
  /** Override `now()` (tests — fixed timestamp). */
  readonly now?: () => Date;
  /** Inject a sink for the JSONL line (tests — bypass FS). */
  readonly sink?: (filePath: string, jsonl: string) => void;
  /** Inject hostname (tests). */
  readonly hostname?: string;
}

export interface AppendInput {
  readonly kind: AuditEventKind;
  readonly action: string;
  readonly workspace: string;
  readonly tenant?: string;
  readonly outcome: AuditEntry['outcome'];
  readonly details?: Record<string, unknown>;
}

export class AuditLogger {
  private readonly now: () => Date;
  private readonly host: string;
  private readonly sink: (filePath: string, jsonl: string) => void;

  constructor(private readonly opts: AuditLoggerOpts = {}) {
    this.now = opts.now ?? (() => new Date());
    this.host = opts.hostname ?? hostname();
    this.sink = opts.sink ?? AuditLogger.defaultSink;
  }

  append(input: AppendInput): AuditEntry {
    const at = this.now();
    const entry: AuditEntry = {
      at: at.toISOString(),
      kind: input.kind,
      action: input.action,
      workspace: input.workspace,
      ...(input.tenant === undefined ? {} : { tenant: input.tenant }),
      outcome: input.outcome,
      ...(input.details === undefined ? {} : { details: input.details }),
      pid: process.pid,
      hostname: this.host,
    };
    const filePath =
      this.opts.auditDir !== undefined
        ? `${this.opts.auditDir.replace(/[\\/]+$/, '')}/audit-${at.toISOString().slice(0, 10)}.jsonl`
        : auditFileForDate(at, this.opts.env === undefined ? {} : { env: this.opts.env });
    let jsonl: string;
    try {
      jsonl = `${JSON.stringify(entry)}\n`;
    } catch (err) {
      throw new AuditError(
        `failed to serialise audit-entry (likely non-JSON-safe value in details): ${(err as Error).message}`,
      );
    }
    try {
      this.sink(filePath, jsonl);
    } catch (err) {
      throw new AuditError(
        `failed to write audit-entry to "${filePath}": ${(err as Error).message}`,
      );
    }
    return entry;
  }

  private static defaultSink(filePath: string, jsonl: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(filePath, jsonl, { encoding: 'utf8', mode: 0o600 });
  }
}
