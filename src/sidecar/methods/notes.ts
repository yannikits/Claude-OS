/**
 * Notes-Namespace RPCs (Phase 2f): save, list.
 *
 * `notes.save` writes a frontmatter-validated markdown note via the
 * Phase-2b writer. `notes.list` returns the (parsed) notes in a
 * workspace for GUI listings.
 *
 * @module @sidecar/methods/notes
 */
import { AuditLogger } from '../../core/audit/index.js';
import {
  listNotes as listNotesDomain,
  type NoteFrontmatter,
  NotesError,
  QUICK_CAPTURE_CATEGORIES,
  QUICK_CAPTURE_SOURCES,
  QUICK_CAPTURE_STATUSES,
  type QuickCaptureCategory,
  type QuickCaptureSource,
  type QuickCaptureStatus,
  quickCapture,
  writeNote,
} from '../../domains/notes/index.js';
import {
  readActiveWorkspace,
  resolveVaultRoot,
  WorkspaceError,
} from '../../domains/workspace/index.js';
import type { RpcDispatcher } from '../rpc.js';
import { requireString } from './_shared.js';

// Singleton audit-logger — created lazily on first quick-capture call.
// Tests use a fresh logger per spec via the domain-level injection.
let sharedAuditLogger: AuditLogger | undefined;
function getAuditLogger(): AuditLogger {
  if (sharedAuditLogger === undefined) {
    sharedAuditLogger = new AuditLogger();
  }
  return sharedAuditLogger;
}

interface SaveParams {
  readonly filename: string;
  readonly body: string;
  readonly frontmatter: Record<string, unknown>;
  readonly workspace?: string;
  readonly overwrite?: boolean;
}

interface SaveResponse {
  readonly path: string;
  readonly created: boolean;
  readonly workspace: string;
}

interface QuickCaptureParams {
  readonly title: string;
  readonly body: string;
  readonly source: string;
  readonly category: string;
  readonly status?: string;
  readonly tags?: readonly string[];
  readonly workspace?: string;
  readonly tanssTicketId?: string;
}

interface QuickCaptureResponse {
  readonly path: string;
  readonly workspace: string;
  readonly tenant: string | null;
  readonly created: boolean;
  readonly filename: string;
  readonly source: string;
  readonly category: string;
}

interface QuickCaptureMetaResponse {
  readonly activeWorkspace: string;
  readonly sources: readonly string[];
  readonly categories: readonly string[];
  readonly statuses: readonly string[];
}

interface ListParams {
  readonly workspace?: string;
  readonly recursive?: boolean;
  readonly limit?: number;
}

interface ListItem {
  readonly path: string;
  readonly workspace: string;
  readonly frontmatter: NoteFrontmatter;
  /** First ~400 chars of body for preview. */
  readonly preview: string;
}

const DEFAULT_LIST_LIMIT = 200;
const PREVIEW_CHARS = 400;

function resolveVaultOrThrow(): string {
  try {
    return resolveVaultRoot();
  } catch (err) {
    if (err instanceof WorkspaceError) throw err;
    throw new WorkspaceError(`vault resolution failed: ${(err as Error).message}`);
  }
}

export function registerNotesMethods(dispatcher: RpcDispatcher): void {
  dispatcher.register('notes.save', (raw): SaveResponse => {
    const p = (raw ?? {}) as Partial<SaveParams>;
    const filename = requireString(p.filename, 'filename', 'notes.save');
    if (typeof p.body !== 'string') {
      throw new Error('notes.save: params.body muss ein string sein');
    }
    if (p.frontmatter === undefined || typeof p.frontmatter !== 'object') {
      throw new Error('notes.save: params.frontmatter muss ein Objekt sein');
    }
    const vault = resolveVaultOrThrow();
    const workspaceId = p.workspace ?? readActiveWorkspace().active;
    const fm = { ...p.frontmatter, workspace: workspaceId } as NoteFrontmatter;
    const res = writeNote(vault, workspaceId, filename, fm, p.body, {
      overwrite: p.overwrite === true,
    });
    return {
      path: res.path,
      created: res.created,
      workspace: workspaceId,
    };
  });

  dispatcher.register('notes.quickCapture', (raw): QuickCaptureResponse => {
    const p = (raw ?? {}) as Partial<QuickCaptureParams>;
    const title = requireString(p.title, 'title', 'notes.quickCapture');
    const body = requireString(p.body, 'body', 'notes.quickCapture');
    const source = requireString(p.source, 'source', 'notes.quickCapture');
    if (!QUICK_CAPTURE_SOURCES.includes(source as QuickCaptureSource)) {
      throw new Error(
        `notes.quickCapture: source="${source}" ungültig — erwartet eines von ${QUICK_CAPTURE_SOURCES.join('|')}`,
      );
    }
    const category = requireString(p.category, 'category', 'notes.quickCapture');
    if (!QUICK_CAPTURE_CATEGORIES.includes(category as QuickCaptureCategory)) {
      throw new Error(
        `notes.quickCapture: category="${category}" ungültig — erwartet eines von ${QUICK_CAPTURE_CATEGORIES.join('|')}`,
      );
    }
    if (
      p.status !== undefined &&
      !QUICK_CAPTURE_STATUSES.includes(p.status as QuickCaptureStatus)
    ) {
      throw new Error(
        `notes.quickCapture: status="${p.status}" ungültig — erwartet eines von ${QUICK_CAPTURE_STATUSES.join('|')}`,
      );
    }
    if (p.tags !== undefined) {
      if (!Array.isArray(p.tags) || !p.tags.every((t) => typeof t === 'string')) {
        throw new Error('notes.quickCapture: tags muss ein string[] sein');
      }
    }
    const vault = resolveVaultOrThrow();
    const res = quickCapture(
      vault,
      {
        title,
        body,
        source: source as QuickCaptureSource,
        category: category as QuickCaptureCategory,
        status: p.status as QuickCaptureStatus | undefined,
        tags: p.tags,
        workspace: p.workspace,
        tanssTicketId: p.tanssTicketId,
      },
      { auditLogger: getAuditLogger() },
    );
    return {
      path: res.path,
      workspace: res.workspace,
      tenant: res.tenant,
      created: res.created,
      filename: res.path.split(/[\\/]/).pop() ?? '',
      source: res.source,
      category: res.category,
    };
  });

  dispatcher.register('notes.captureMeta', (): QuickCaptureMetaResponse => {
    // Self-describing endpoint for the GUI dropdowns and active-workspace
    // badge. Single roundtrip on QuickCapture-modal open.
    const state = readActiveWorkspace();
    return {
      activeWorkspace: state.active,
      sources: QUICK_CAPTURE_SOURCES,
      categories: QUICK_CAPTURE_CATEGORIES,
      statuses: QUICK_CAPTURE_STATUSES,
    };
  });

  dispatcher.register('notes.list', (raw): readonly ListItem[] => {
    const p = (raw ?? {}) as Partial<ListParams>;
    const vault = resolveVaultOrThrow();
    const workspaceId = p.workspace ?? readActiveWorkspace().active;
    const limit =
      typeof p.limit === 'number' && Number.isInteger(p.limit) && p.limit > 0
        ? p.limit
        : DEFAULT_LIST_LIMIT;
    const notes = listNotesDomain(vault, workspaceId, {
      recursive: p.recursive === true,
    });
    return notes.slice(0, limit).map((n) => ({
      path: n.path,
      workspace: n.workspace,
      frontmatter: n.frontmatter,
      preview: n.body.slice(0, PREVIEW_CHARS),
    }));
  });
}

// Re-export so the orchestrator can import NotesError consistently.
export { NotesError };
