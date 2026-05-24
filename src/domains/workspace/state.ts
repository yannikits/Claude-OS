/**
 * Active-workspace state persistence (per ADR-0031 §"Aktiver Workspace
 * als Session-State").
 *
 * Stores the active workspace id + last switch timestamp as JSON under
 * `<dataDir>/workspace-state.json`. Atomic tempfile+rename writes,
 * mode 0o600 so the file isn't world-readable in shared installs.
 *
 * No locking — single-user single-machine model. Concurrent writes
 * race-of-last-write-wins; the audit-log captures the full sequence
 * for forensic purposes.
 *
 * @module @domains/workspace/state
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveMachinePaths } from '../../core/paths/index.js';
import { assertValidWorkspaceId } from './paths.js';
import {
  type ActiveWorkspaceState,
  DEFAULT_WORKSPACE,
  WorkspaceError,
  type WorkspaceId,
} from './types.js';

const STATE_FILENAME = 'workspace-state.json';

interface StateOpts {
  /** Override dataDir (tests). Defaults to `resolveMachinePaths().dataDir`. */
  readonly dataDir?: string;
  /** Env-var source for `resolveMachinePaths` (tests). */
  readonly env?: NodeJS.ProcessEnv;
}

function resolveStatePath(opts: StateOpts): string {
  if (opts.dataDir !== undefined) {
    return join(opts.dataDir, STATE_FILENAME);
  }
  const paths = resolveMachinePaths(opts.env === undefined ? {} : { env: opts.env });
  return join(paths.dataDir, STATE_FILENAME);
}

/**
 * Reads the active workspace state. Returns a default
 * `{active: 'personal', switchedAt: <now>}` if the file doesn't exist
 * or is unreadable — the caller doesn't need to handle the missing
 * file case explicitly.
 *
 * Corrupt JSON does throw, on the principle of "fail loud for
 * unexpected data states" (carry-over from busy-flag Lesson 2026-05-22).
 */
export function readActiveWorkspace(opts: StateOpts = {}): ActiveWorkspaceState {
  const path = resolveStatePath(opts);
  if (!existsSync(path)) {
    return { active: DEFAULT_WORKSPACE, switchedAt: new Date(0).toISOString() };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new WorkspaceError(
      `Failed to read workspace state at "${path}": ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new WorkspaceError(
      `Corrupt workspace state at "${path}": ${(err as Error).message}. ` +
        `Delete the file to reset to default (personal).`,
    );
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>).active !== 'string' ||
    typeof (parsed as Record<string, unknown>).switchedAt !== 'string'
  ) {
    throw new WorkspaceError(
      `Workspace state at "${path}" missing required fields {active, switchedAt}.`,
    );
  }
  const active = (parsed as { active: string }).active;
  const switchedAt = (parsed as { switchedAt: string }).switchedAt;
  // Don't crash on a legacy/stale id — keep it as the active value
  // until the user explicitly switches. assertValidWorkspaceId is run
  // on write, not on read, so the read path is lenient.
  return { active, switchedAt };
}

/**
 * Writes the active workspace state atomically. Validates the id
 * before persisting — rejects traversal sequences and unknown formats.
 */
export function writeActiveWorkspace(id: WorkspaceId, opts: StateOpts = {}): ActiveWorkspaceState {
  assertValidWorkspaceId(id);
  const state: ActiveWorkspaceState = {
    active: id,
    switchedAt: new Date().toISOString(),
  };
  const path = resolveStatePath(opts);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(tmp, path);
  return state;
}
