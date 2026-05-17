/**
 * DiffEngine — unified-diff rendering for file-pair comparisons during
 * Selective-Merge updates (ADR-0005 §48).
 *
 * Uses the `diff` npm package for line-level diffing and patch
 * generation. Binary files (detected via NUL byte in the first 8 KB)
 * are classified `binary` and not diffed.
 *
 * Pure function — no FS writes, no prompts. Phase 4f's CLI layer
 * wraps the output for terminal display.
 *
 * @module @domains/update-orchestrator/diff-engine
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { createPatch, diffLines } from 'diff';

export type DiffStatus =
  | 'unchanged' // upstream and local are byte-identical
  | 'modified' // both present, content differs
  | 'added' // upstream exists, local missing
  | 'removed' // local exists, upstream missing
  | 'binary'; // either side is binary — diff skipped

export interface DiffSummary {
  readonly status: DiffStatus;
  readonly addedLines: number;
  readonly removedLines: number;
  /** Unified-diff text; empty for `unchanged`, `added`-only, `removed`-only and `binary`. */
  readonly unifiedDiff: string;
  /** Human-readable single-line summary for presenter use. */
  readonly summary: string;
}

interface DiffOpts {
  /** Override the display name in patch headers (default: basename(localPath)). */
  readonly displayName?: string;
  /** Bytes to scan for binary detection. Default 8 KB. */
  readonly binaryScanBytes?: number;
}

function readIfFile(p: string): Buffer | null {
  if (!existsSync(p)) return null;
  try {
    if (!statSync(p).isFile()) return null;
    return readFileSync(p);
  } catch {
    return null;
  }
}

function isBinaryBuffer(buf: Buffer, scanBytes: number): boolean {
  const end = Math.min(scanBytes, buf.length);
  for (let i = 0; i < end; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function diffFiles(
  upstreamPath: string,
  localPath: string,
  opts: DiffOpts = {},
): DiffSummary {
  const scanBytes = opts.binaryScanBytes ?? 8192;
  const upstreamBuf = readIfFile(upstreamPath);
  const localBuf = readIfFile(localPath);
  const name = opts.displayName ?? basename(localPath);

  if (upstreamBuf === null && localBuf === null) {
    return {
      status: 'unchanged',
      addedLines: 0,
      removedLines: 0,
      unifiedDiff: '',
      summary: `${name}: absent both sides`,
    };
  }

  if (upstreamBuf === null) {
    const lc = localBuf as Buffer;
    return {
      status: 'removed',
      addedLines: 0,
      removedLines: lc.toString('utf8').split(/\r?\n/).length,
      unifiedDiff: '',
      summary: `${name}: removed upstream (local-only)`,
    };
  }
  if (localBuf === null) {
    const uc = upstreamBuf;
    return {
      status: 'added',
      addedLines: uc.toString('utf8').split(/\r?\n/).length,
      removedLines: 0,
      unifiedDiff: '',
      summary: `${name}: new upstream file`,
    };
  }

  if (isBinaryBuffer(upstreamBuf, scanBytes) || isBinaryBuffer(localBuf, scanBytes)) {
    const sameSize = upstreamBuf.length === localBuf.length;
    const bytewiseSame = sameSize && upstreamBuf.equals(localBuf);
    if (bytewiseSame) {
      return {
        status: 'unchanged',
        addedLines: 0,
        removedLines: 0,
        unifiedDiff: '',
        summary: `${name}: binary, identical`,
      };
    }
    return {
      status: 'binary',
      addedLines: 0,
      removedLines: 0,
      unifiedDiff: '',
      summary: `${name}: binary, differs (no text diff)`,
    };
  }

  const upstreamText = upstreamBuf.toString('utf8');
  const localText = localBuf.toString('utf8');

  if (upstreamText === localText) {
    return {
      status: 'unchanged',
      addedLines: 0,
      removedLines: 0,
      unifiedDiff: '',
      summary: `${name}: identical`,
    };
  }

  const chunks = diffLines(upstreamText, localText);
  let addedLines = 0;
  let removedLines = 0;
  for (const chunk of chunks) {
    if (chunk.added === true) addedLines += chunk.count ?? chunk.value.split('\n').length - 1;
    else if (chunk.removed === true) {
      removedLines += chunk.count ?? chunk.value.split('\n').length - 1;
    }
  }
  const patch = createPatch(name, upstreamText, localText, 'upstream', 'local');
  return {
    status: 'modified',
    addedLines,
    removedLines,
    unifiedDiff: patch,
    summary: `${name}: +${addedLines} / -${removedLines}`,
  };
}
