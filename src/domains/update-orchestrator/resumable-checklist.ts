/**
 * ResumableChecklist — atomically-persisted progress log for selective-
 * merge updates per ADR-0005 §62.
 *
 * File format (markdown so it's human-inspectable):
 *
 *   # claude-os update checklist
 *   - timestamp: 2026-05-17T08-00-00-000Z
 *   - scope: skills
 *   - status: in-progress
 *   - total: 42
 *
 *   ## Files
 *   - [x] thinking-partner/SKILL.md → upgrade
 *   - [x] daily-review/SKILL.md → keep
 *   - [ ] de-ai-ify/SKILL.md
 *
 * On every `markDone()` the full file is rewritten atomically
 * (tempfile + rename) so a crash mid-update never produces a torn
 * checklist. `loadLatest(dir, scope)` discovers an in-progress run
 * for `claude-os update --resume`.
 *
 * @module @domains/update-orchestrator/resumable-checklist
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReviewDecision } from './review-loop.js';
import type { UpdateScope } from './types.js';

export type ChecklistStatus = 'in-progress' | 'complete';

export interface ChecklistSnapshot {
  readonly timestamp: string;
  readonly scope: UpdateScope;
  readonly status: ChecklistStatus;
  readonly total: number;
  readonly done: ReadonlyMap<string, ReviewDecision>;
  readonly filePath: string;
}

interface ChecklistInitOpts {
  /** Directory where the checklist file lives. */
  readonly dir: string;
  readonly scope: UpdateScope;
  readonly total: number;
  /** Override clock (tests). */
  readonly now?: () => Date;
  /** Override the prefix segment of the file basename. */
  readonly basenamePrefix?: string;
}

const DEFAULT_PREFIX = 'upgrade-checklist-';
const DECISION_VALUES: readonly ReviewDecision[] = ['keep', 'upgrade', 'skip'];

function refSafeIso(d: Date): string {
  return d.toISOString().replaceAll(':', '-').replace('.', '-');
}

function escapeRelPath(p: string): string {
  return p.replaceAll('\r', '').replaceAll('\n', ' ');
}

function isDecision(v: string): v is ReviewDecision {
  return (DECISION_VALUES as readonly string[]).includes(v);
}

function serialise(snapshot: ChecklistSnapshot): string {
  const lines: string[] = [
    '# claude-os update checklist',
    `- timestamp: ${snapshot.timestamp}`,
    `- scope: ${snapshot.scope}`,
    `- status: ${snapshot.status}`,
    `- total: ${snapshot.total}`,
    '',
    '## Files',
  ];
  for (const [relPath, decision] of snapshot.done) {
    lines.push(`- [x] ${escapeRelPath(relPath)} → ${decision}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseHeader(raw: string): {
  timestamp?: string;
  scope?: UpdateScope;
  status?: ChecklistStatus;
  total?: number;
} {
  const header: ReturnType<typeof parseHeader> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^-\s+(timestamp|scope|status|total):\s+(.+)$/i.exec(line);
    if (match === null) continue;
    const key = match[1]?.toLowerCase() ?? '';
    const value = match[2]?.trim() ?? '';
    if (key === 'timestamp') header.timestamp = value;
    else if (key === 'scope' && (value === 'env' || value === 'skills' || value === 'plugins')) {
      header.scope = value;
    } else if (key === 'status' && (value === 'in-progress' || value === 'complete')) {
      header.status = value;
    } else if (key === 'total') {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) header.total = n;
    }
  }
  return header;
}

function parseDoneEntries(raw: string): Map<string, ReviewDecision> {
  const done = new Map<string, ReviewDecision>();
  const lineRegex = /^-\s+\[x\]\s+(.+?)\s+→\s+(\S+)\s*$/i;
  for (const line of raw.split(/\r?\n/)) {
    const match = lineRegex.exec(line);
    if (match === null) continue;
    const relPath = match[1]?.trim();
    const decision = match[2]?.trim();
    if (relPath === undefined || decision === undefined) continue;
    if (!isDecision(decision)) continue;
    done.set(relPath, decision);
  }
  return done;
}

function parseSnapshot(filePath: string, raw: string): ChecklistSnapshot | null {
  const header = parseHeader(raw);
  if (
    header.timestamp === undefined ||
    header.scope === undefined ||
    header.status === undefined ||
    header.total === undefined
  ) {
    return null;
  }
  const done = parseDoneEntries(raw);
  return {
    timestamp: header.timestamp,
    scope: header.scope,
    status: header.status,
    total: header.total,
    done,
    filePath,
  };
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, filePath);
}

export class ResumableChecklist {
  readonly filePath: string;
  private timestamp: string;
  private readonly scope: UpdateScope;
  private status: ChecklistStatus;
  private readonly total: number;
  private readonly done: Map<string, ReviewDecision>;

  private constructor(
    filePath: string,
    timestamp: string,
    scope: UpdateScope,
    status: ChecklistStatus,
    total: number,
    done: Map<string, ReviewDecision>,
  ) {
    this.filePath = filePath;
    this.timestamp = timestamp;
    this.scope = scope;
    this.status = status;
    this.total = total;
    this.done = done;
  }

  /** Creates a fresh checklist and persists the initial state. */
  static create(opts: ChecklistInitOpts): ResumableChecklist {
    const timestamp = refSafeIso((opts.now ?? (() => new Date()))());
    const prefix = opts.basenamePrefix ?? DEFAULT_PREFIX;
    const filePath = join(opts.dir, `${prefix}${timestamp}.md`);
    const instance = new ResumableChecklist(
      filePath,
      timestamp,
      opts.scope,
      'in-progress',
      opts.total,
      new Map(),
    );
    atomicWrite(filePath, serialise(instance.snapshot()));
    return instance;
  }

  /** Loads an existing checklist file. Returns null if absent or malformed. */
  static load(filePath: string): ResumableChecklist | null {
    if (!existsSync(filePath)) return null;
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
    const snapshot = parseSnapshot(filePath, raw);
    if (snapshot === null) return null;
    return new ResumableChecklist(
      filePath,
      snapshot.timestamp,
      snapshot.scope,
      snapshot.status,
      snapshot.total,
      new Map(snapshot.done),
    );
  }

  /**
   * Finds the most recent in-progress checklist for `scope` in `dir`.
   * Returns null when none exist. Already-`complete` checklists are
   * ignored so a finished run is never accidentally resumed.
   */
  static loadLatest(
    dir: string,
    scope: UpdateScope,
    opts: { prefix?: string; includeComplete?: boolean } = {},
  ): ResumableChecklist | null {
    if (!existsSync(dir)) return null;
    const prefix = opts.prefix ?? DEFAULT_PREFIX;
    const candidates: { ts: string; path: string }[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith('.md')) continue;
      const ts = entry.name.slice(prefix.length, -3);
      candidates.push({ ts, path: join(dir, entry.name) });
    }
    candidates.sort((a, b) => (a.ts > b.ts ? -1 : a.ts < b.ts ? 1 : 0));
    for (const c of candidates) {
      const list = ResumableChecklist.load(c.path);
      if (list === null) continue;
      if (list.scope !== scope) continue;
      if (list.status === 'complete' && opts.includeComplete !== true) continue;
      return list;
    }
    return null;
  }

  /** Records a per-file decision and persists. */
  markDone(relPath: string, decision: ReviewDecision): void {
    this.done.set(relPath, decision);
    atomicWrite(this.filePath, serialise(this.snapshot()));
  }

  /** True iff `relPath` has been processed previously. */
  isDone(relPath: string): boolean {
    return this.done.has(relPath);
  }

  /** Returns the subset of `allFiles` not yet processed. */
  pendingFiles(allFiles: readonly string[]): readonly string[] {
    return allFiles.filter((p) => !this.done.has(p));
  }

  /** Marks the run as complete and persists. The file stays on disk. */
  complete(): void {
    this.status = 'complete';
    atomicWrite(this.filePath, serialise(this.snapshot()));
  }

  /** Removes the checklist file from disk. Idempotent. */
  abandon(): void {
    if (existsSync(this.filePath)) {
      try {
        unlinkSync(this.filePath);
      } catch {
        /* best-effort */
      }
    }
  }

  /** Returns a read-only snapshot for inspection / serialisation tests. */
  snapshot(): ChecklistSnapshot {
    return {
      timestamp: this.timestamp,
      scope: this.scope,
      status: this.status,
      total: this.total,
      done: new Map(this.done),
      filePath: this.filePath,
    };
  }
}
