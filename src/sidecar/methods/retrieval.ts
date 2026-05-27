/**
 * Retrieval-Namespace RPCs (Phase 2f): search.
 *
 * Linear-scan BM25 retrieval (Phase 2c) exposed to the GUI. Workspace-
 * scoped by default (active workspace or `--workspace`); cross-workspace
 * search remains an explicit caller-iteration (ADR-0031).
 *
 * @module @sidecar/methods/retrieval
 */
import { AuditLogger } from '../../core/audit/index.js';
import type { Note } from '../../domains/notes/index.js';
import { crossWorkspaceSearch, searchWorkspace } from '../../domains/retrieval/index.js';
import {
  readActiveWorkspace,
  resolveVaultRoot,
  WorkspaceError,
} from '../../domains/workspace/index.js';
import type { RpcDispatcher } from '../rpc.js';
import { requireString } from './_shared.js';

let sharedAuditLogger: AuditLogger | undefined;
function getAuditLogger(): AuditLogger {
  if (sharedAuditLogger === undefined) {
    sharedAuditLogger = new AuditLogger();
  }
  return sharedAuditLogger;
}

interface SearchParams {
  readonly text: string;
  readonly workspace?: string;
  readonly topK?: number;
  readonly includeEphemeral?: boolean;
  readonly recursive?: boolean;
}

interface SearchHitDto {
  readonly path: string;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly preview: string;
  readonly frontmatter: Note['frontmatter'];
}

interface SearchResponse {
  readonly query: string;
  readonly tokens: readonly string[];
  readonly hits: readonly SearchHitDto[];
  readonly totalScanned: number;
  readonly durationMs: number;
  readonly workspace: string;
}

const HIT_PREVIEW_CHARS = 320;

function resolveVaultOrThrow(): string {
  try {
    return resolveVaultRoot();
  } catch (err) {
    if (err instanceof WorkspaceError) throw err;
    throw new WorkspaceError(`vault resolution failed: ${(err as Error).message}`);
  }
}

interface CrossWorkspaceSearchParams {
  readonly text: string;
  readonly crossCustomer?: boolean;
  readonly topK?: number;
  readonly includeEphemeral?: boolean;
  readonly recursive?: boolean;
}

interface CrossWorkspaceHitDto extends SearchHitDto {
  /** Workspace this hit originated from — surfaced explicitly per
   *  Codex Stage-2 hardening (caller MUST be able to render source). */
  readonly workspace: string;
}

interface CrossWorkspaceSearchResponse {
  readonly query: string;
  readonly tokens: readonly string[];
  readonly hits: readonly CrossWorkspaceHitDto[];
  readonly totalScanned: number;
  readonly durationMs: number;
  readonly activeWorkspace: string;
  readonly scope: readonly string[];
  readonly crossCustomer: boolean;
}

export function registerRetrievalMethods(dispatcher: RpcDispatcher): void {
  dispatcher.register('retrieval.search', (raw): SearchResponse => {
    const p = (raw ?? {}) as Partial<SearchParams>;
    const text = requireString(p.text, 'text', 'retrieval.search');
    const vault = resolveVaultOrThrow();
    const workspaceId = p.workspace ?? readActiveWorkspace().active;
    const result = searchWorkspace(vault, workspaceId, {
      text,
      topK: typeof p.topK === 'number' && p.topK > 0 ? p.topK : 10,
      excludeClassifications: p.includeEphemeral === true ? [] : undefined,
      recursive: p.recursive === true,
    });
    return {
      query: result.query,
      tokens: result.tokens,
      hits: result.hits.map((h) => ({
        path: h.note.path,
        score: h.score,
        matchedTerms: h.matchedTerms,
        preview: h.note.body.slice(0, HIT_PREVIEW_CHARS),
        frontmatter: h.note.frontmatter,
      })),
      totalScanned: result.totalScanned,
      durationMs: result.durationMs,
      workspace: workspaceId,
    };
  });

  dispatcher.register('retrieval.crossWorkspaceSearch', (raw): CrossWorkspaceSearchResponse => {
    const p = (raw ?? {}) as Partial<CrossWorkspaceSearchParams>;
    const text = requireString(p.text, 'text', 'retrieval.crossWorkspaceSearch');
    const vault = resolveVaultOrThrow();
    const activeWorkspace = readActiveWorkspace().active;
    const topK = typeof p.topK === 'number' && p.topK > 0 ? p.topK : 10;
    const result = crossWorkspaceSearch(
      vault,
      {
        query: {
          text,
          topK,
          excludeClassifications: p.includeEphemeral === true ? [] : undefined,
          recursive: p.recursive === true,
        },
        activeWorkspace,
        crossCustomer: p.crossCustomer === true,
      },
      // Audit-logger only matters for crossCustomer=true (per
      // domain-layer policy) — we still inject it so the flag
      // toggles work correctly.
      { auditLogger: getAuditLogger() },
    );
    return {
      query: result.query,
      tokens: result.tokens,
      hits: result.hits.map((h) => ({
        path: h.note.path,
        score: h.score,
        matchedTerms: h.matchedTerms,
        preview: h.note.body.slice(0, HIT_PREVIEW_CHARS),
        frontmatter: h.note.frontmatter,
        workspace: h.note.workspace,
      })),
      totalScanned: result.totalScanned,
      durationMs: result.durationMs,
      activeWorkspace,
      scope: result.scope,
      crossCustomer: result.crossCustomer,
    };
  });
}
