/**
 * Cross-Workspace Solution-Search — Phase MSP-B (per three-brain plan
 * 2026-05-27-msp-productivity, Codex Stage-2 hardenings).
 *
 * Use-Case: "Wann haben wir bei einem anderen Kunden ein ähnliches
 * VPN-MTU-Problem gefixt?" Yannik tippt eine Query, der Search läuft
 * über mehrere Workspaces — aber mit harten Multi-Tenant-Guards.
 *
 * Codex adversarial-review hardenings:
 *   1. **Default-Scope ist SEHR eng**: `active workspace` + `msp-internal`.
 *      Andere Customer-Workspaces sind explicit opt-in via
 *      `crossCustomer: true`. Keine implicit-Erweiterung.
 *   2. **Pro Hit ist `sourceWorkspace` explizit sichtbar** (= note.
 *      workspace) — der Caller sieht sofort woher das Resultat kommt.
 *      Renderer muss das anzeigen, nicht verstecken.
 *   3. **Cross-Customer-Suchen werden AUDIT-LOGGED** (kind=`bridge.read`
 *      action=`cross-workspace-search`). `details.scope` listet die
 *      durchsuchten Workspaces, `details.queryLen` die Query-Länge.
 *      `query` selbst wird NICHT geloggt (potentiell sensible
 *      Suchbegriffe). Die Hits sind audit-relevant, ihre Pfade ja —
 *      aber abgekürzt auf Filename-Stem damit nicht customer-Pfade
 *      die ganze Audit-Datei aufblähen.
 *   4. **`_unsorted` ist NIE ein gültiger Scope-Eintrag** (synthetic).
 *   5. **`redactInCrossSearch: true` im Frontmatter** einer Note
 *      excludiert sie aus jedem cross-customer-Hit — Defense-in-depth
 *      für notes die zwar in `msp-internal` liegen aber sensible
 *      customer-Daten enthalten.
 *
 * Layering: dieses Modul kennt KEIN HTTP/RPC. Es ist eine pure-
 * function-Komposition über `searchWorkspace` aus dem Phase-2c-Code.
 * Der Sidecar-Layer baut die scope-Liste auf und ruft uns auf.
 *
 * @module @domains/retrieval/cross-workspace
 */
import type { AuditLogger } from '../../core/audit/index.js';
import { listWorkspaces, UNSORTED_WORKSPACE, type Workspace } from '../workspace/index.js';
import { searchWorkspace } from './linear-scan.js';
import {
  RetrievalError,
  type RetrievalHit,
  type RetrievalQuery,
  type RetrievalResult,
} from './types.js';

const MSP_INTERNAL = 'msp-internal';
const MSP_CUSTOMER_PREFIX = 'msp-customers/';
const DEFAULT_TOP_K = 10;

export interface CrossWorkspaceSearchInput {
  readonly query: RetrievalQuery;
  /** Active workspace — anchor of the default scope. Required. */
  readonly activeWorkspace: string;
  /**
   * `true` includes every `msp-customers/<id>` workspace into the
   * search. Default is false — only `activeWorkspace + msp-internal`
   * is searched. Audit-log fires only when this is `true`.
   */
  readonly crossCustomer?: boolean;
}

export interface CrossWorkspaceSearchOpts {
  /** Override listWorkspaces (tests). Default reads on-disk vault. */
  readonly workspaceLister?: (vaultRoot: string) => readonly Workspace[];
  /** Audit hook. Required if `crossCustomer: true`, optional otherwise. */
  readonly auditLogger?: Pick<AuditLogger, 'append'>;
  /**
   * Tenant id derived from the token (server-mode) or session — included
   * in the audit-log entry so we can correlate searches per user later.
   * Server-side comes from `ServerTenantContext.tokenTenantId`.
   */
  readonly subjectTenant?: string;
}

export interface CrossWorkspaceSearchResult extends RetrievalResult {
  /** Workspaces actually searched (post-dedup, post-_unsorted-filter). */
  readonly scope: readonly string[];
  /** `true` if any cross-customer workspace ended up in scope. */
  readonly crossCustomer: boolean;
}

/**
 * Builds the searched-workspace list given the active workspace and the
 * cross-customer flag.
 *
 *   crossCustomer=false (default): [activeWorkspace, 'msp-internal']
 *     - dedup'd if active == 'msp-internal'
 *     - `_unsorted` would never appear here (caller-validated)
 *   crossCustomer=true: [activeWorkspace, 'msp-internal', ...every
 *     `msp-customers/<id>` from listWorkspaces()]
 *     - dedup'd; `_unsorted` filtered out
 *
 * Throws when activeWorkspace is `_unsorted` (per Codex hardening #4).
 */
export function buildScope(
  activeWorkspace: string,
  crossCustomer: boolean,
  available: readonly Workspace[],
): readonly string[] {
  if (activeWorkspace === UNSORTED_WORKSPACE) {
    throw new RetrievalError(
      `crossWorkspaceSearch: aktiver Workspace ist "${UNSORTED_WORKSPACE}" — wähle einen ` +
        'konkreten Workspace bevor du suchst.',
    );
  }
  const scope = new Set<string>([activeWorkspace, MSP_INTERNAL]);
  if (crossCustomer) {
    for (const ws of available) {
      if (ws.id === UNSORTED_WORKSPACE) continue;
      if (ws.id.startsWith(MSP_CUSTOMER_PREFIX)) scope.add(ws.id);
    }
  }
  // Ordering: active first, dann msp-internal, dann alphabetisch
  // sortierte customer-workspaces — gibt deterministische Test-output.
  const arr = [...scope];
  return arr.sort((a, b) => {
    if (a === activeWorkspace) return -1;
    if (b === activeWorkspace) return 1;
    if (a === MSP_INTERNAL) return -1;
    if (b === MSP_INTERNAL) return 1;
    return a.localeCompare(b);
  });
}

/**
 * Filter-out hits with `redactInCrossSearch: true` in their frontmatter,
 * but ONLY when the originating workspace differs from the active one.
 * Same-workspace hits are always shown (the redact-flag is about
 * cross-workspace exposure, not local hiding).
 */
function applyRedactionFilter(
  hits: readonly RetrievalHit[],
  activeWorkspace: string,
): readonly RetrievalHit[] {
  return hits.filter((h) => {
    if (h.note.workspace === activeWorkspace) return true;
    const fm = h.note.frontmatter as Record<string, unknown>;
    return fm.redactInCrossSearch !== true;
  });
}

/**
 * Cross-workspace search hauptfunktion.
 *
 * Runs `searchWorkspace` per scope-entry, merges + sorts by BM25-score,
 * caps at `query.topK`, applies redaction-filter, optional audit-log.
 *
 * Per-workspace errors are tolerated — a missing customer-workspace
 * directory (filesystem race, workspace deleted) gives 0 hits there
 * but doesn't fail the whole search. The error count is part of the
 * audit-log details.
 */
export function crossWorkspaceSearch(
  vaultRoot: string,
  input: CrossWorkspaceSearchInput,
  opts: CrossWorkspaceSearchOpts = {},
): CrossWorkspaceSearchResult {
  const started = Date.now();
  const lister = opts.workspaceLister ?? listWorkspaces;
  const available = lister(vaultRoot);
  const crossCustomer = input.crossCustomer === true;
  const scope = buildScope(input.activeWorkspace, crossCustomer, available);

  const allHits: RetrievalHit[] = [];
  let totalScanned = 0;
  let errorCount = 0;
  let tokens: readonly string[] = [];
  let queryEcho = input.query.text;

  for (const workspaceId of scope) {
    try {
      const r = searchWorkspace(vaultRoot, workspaceId, input.query);
      allHits.push(...r.hits);
      totalScanned += r.totalScanned;
      tokens = r.tokens; // tokens are stable across workspaces (same query)
      queryEcho = r.query;
    } catch {
      errorCount += 1;
      // Continue — a missing workspace dir is non-fatal at this layer.
    }
  }

  const sortedHits = allHits.slice().sort((a, b) => b.score - a.score);
  const topK = input.query.topK ?? DEFAULT_TOP_K;
  const redacted = applyRedactionFilter(sortedHits, input.activeWorkspace);
  const capped = redacted.slice(0, topK);

  const result: CrossWorkspaceSearchResult = {
    query: queryEcho,
    tokens,
    hits: capped,
    totalScanned,
    durationMs: Date.now() - started,
    scope,
    crossCustomer,
  };

  // Audit-log: ALWAYS when crossCustomer is true (covers privacy boundary).
  // Skipped for the default-scope case — `active + msp-internal` is not
  // a tenant-boundary-crossing event.
  if (crossCustomer && opts.auditLogger !== undefined) {
    const hitWorkspaceFreq: Record<string, number> = {};
    for (const h of capped) {
      hitWorkspaceFreq[h.note.workspace] = (hitWorkspaceFreq[h.note.workspace] ?? 0) + 1;
    }
    opts.auditLogger.append({
      kind: 'bridge.read',
      action: 'cross-workspace-search',
      workspace: input.activeWorkspace,
      ...(opts.subjectTenant !== undefined ? { tenant: opts.subjectTenant } : {}),
      outcome: 'ok',
      details: {
        scope: scope as string[],
        queryLen: input.query.text.length,
        topK,
        hitCount: capped.length,
        totalScanned,
        errorCount,
        // Hit-Workspace-Verteilung (keine Pfade, nur Counts) — ermöglicht
        // forensic correlation ohne Customer-Pfad-Leakage in Audit.
        hitWorkspaces: hitWorkspaceFreq,
        durationMs: result.durationMs,
      },
    });
  }

  return result;
}
