/**
 * Workspace-aware path resolution within the Obsidian vault (ADR-0031).
 *
 * Layout:
 *   <vault-root>/
 *   └── Claude-OS/
 *       └── workspaces/
 *           ├── personal/
 *           ├── msp-internal/
 *           └── msp-customers/
 *               └── <customer-id>/
 *
 * @module @domains/workspace/paths
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_WORKSPACE,
  InvalidWorkspaceIdError,
  WORKSPACE_LAYOUT_DIR,
  WORKSPACES_SUBDIR,
  type Workspace,
  type WorkspaceId,
  type WorkspaceKind,
} from './types.js';

/**
 * Validates a workspace id against the ADR-0031 shape. Rejects
 * traversal sequences and unsupported customer-id characters.
 *
 * Allowed:
 *   personal
 *   msp-internal
 *   msp-customers/<id>          where <id> matches /^[a-z0-9][a-z0-9_-]*$/
 */
export function assertValidWorkspaceId(id: string): void {
  if (id.length === 0) {
    throw new InvalidWorkspaceIdError(id, 'empty');
  }
  if (id === 'personal' || id === 'msp-internal') return;
  if (id.startsWith('msp-customers/')) {
    const sub = id.slice('msp-customers/'.length);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(sub)) {
      throw new InvalidWorkspaceIdError(id, 'customer-id must match /^[a-z0-9][a-z0-9_-]*$/');
    }
    return;
  }
  throw new InvalidWorkspaceIdError(
    id,
    'allowed: personal | msp-internal | msp-customers/<customer-id>',
  );
}

/**
 * Classifies a workspace id into its top-level kind.
 */
export function classifyWorkspace(id: WorkspaceId): WorkspaceKind {
  if (id === 'personal') return 'personal';
  if (id === 'msp-internal') return 'msp-internal';
  if (id.startsWith('msp-customers/')) return 'msp-customers';
  return 'unsorted';
}

/**
 * Returns `<vault-root>/Claude-OS/workspaces/`.
 */
export function workspacesDir(vaultRoot: string): string {
  return join(vaultRoot, WORKSPACE_LAYOUT_DIR, WORKSPACES_SUBDIR);
}

/**
 * Returns the absolute path of a workspace's on-disk directory.
 * Validates the id before constructing the path (no traversal).
 */
export function resolveWorkspacePath(vaultRoot: string, id: WorkspaceId): string {
  assertValidWorkspaceId(id);
  return join(workspacesDir(vaultRoot), id);
}

/**
 * Returns `true` if a workspace's on-disk directory exists.
 */
export function workspaceExists(vaultRoot: string, id: WorkspaceId): boolean {
  try {
    assertValidWorkspaceId(id);
  } catch {
    return false;
  }
  const path = resolveWorkspacePath(vaultRoot, id);
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Lists workspaces on disk. Auto-creates the layout directory the first
 * time it's called against a fresh vault (no-op if already present).
 *
 * `personal` is always returned, even if its directory doesn't exist
 * yet — it's the ADR-0031 default and bootstrapping it on first
 * `workspace use personal` is intended.
 */
export function listWorkspaces(vaultRoot: string): Workspace[] {
  const root = workspacesDir(vaultRoot);
  const out: Workspace[] = [];

  if (!existsSync(root)) {
    // Fresh vault — return just the default as a virtual entry.
    out.push({ id: DEFAULT_WORKSPACE, kind: 'personal', path: null });
    return out;
  }

  const entries = readdirSync(root, { withFileTypes: true });
  let sawPersonal = false;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name === 'personal') {
      sawPersonal = true;
      out.push({ id: 'personal', kind: 'personal', path: join(root, name) });
    } else if (name === 'msp-internal') {
      out.push({ id: 'msp-internal', kind: 'msp-internal', path: join(root, name) });
    } else if (name === 'msp-customers') {
      const custRoot = join(root, name);
      const customers = readdirSync(custRoot, { withFileTypes: true });
      for (const cust of customers) {
        if (!cust.isDirectory()) continue;
        const id = `msp-customers/${cust.name}`;
        try {
          assertValidWorkspaceId(id);
        } catch {
          // skip invalid customer ids silently — they're surfaced via the
          // `_unsorted` bucket in higher layers.
          continue;
        }
        out.push({ id, kind: 'msp-customers', path: join(custRoot, cust.name) });
      }
    }
    // Other top-level dirs are ignored — ADR-0031 reserves the layout.
  }

  if (!sawPersonal) {
    out.unshift({ id: DEFAULT_WORKSPACE, kind: 'personal', path: null });
  }

  return out;
}
