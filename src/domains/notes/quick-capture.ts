/**
 * Quick-Capture — schneller Note-Write für den MSP-Daily-Workflow.
 *
 * Use-Case: Anruf, Site-Visit, Kollegen-Anfrage. Yannik tippt 3 Zeilen
 * in der Web-UI (oder Tauri-App), drückt Enter — landet im aktiven
 * Customer-Workspace mit TANSS-kompatiblen Frontmatter-Defaults.
 *
 * Hardenings (Codex adversarial review 2026-05-27):
 *   1. Backend resolved den aktiven Workspace — Renderer-State wird
 *      NICHT als Wahrheit akzeptiert. Optionales `workspace`-Override im
 *      Payload muss zum gleichen aktiven Workspace passen, sonst Reject.
 *   2. Ambiguous-State → Throw. Synthetic `_unsorted` ist kein gültiges
 *      Quick-Capture-Ziel. Wer absichtlich in `_unsorted` schreiben
 *      will, nutzt `notes.save` direkt.
 *   3. `msp-customers/<id>`-Workspaces erzwingen `tenant` automatisch
 *      aus dem Workspace-Pfad (kein caller-supplied override).
 *   4. Filename ist deterministisch generiert (ISO + slug) — kein
 *      caller-controlled path. Verhindert traversal.
 *   5. Classification-Default greift Vault-Layer-Defense (ARCHITECTURE
 *      §5.2 fail-safe-rule): `customer-confidential` für Customer-
 *      Workspaces, `operational` für `msp-internal`, `personal` sonst.
 *   6. Audit-Log-Pflicht — jeder Quick-Capture-Write ist im
 *      audit-YYYY-MM-DD.jsonl mit kind=`note.write` action=`quick-capture`
 *      verzeichnet.
 *
 * @module @domains/notes/quick-capture
 */
import type { AuditLogger } from '../../core/audit/index.js';
import { readActiveWorkspace, UNSORTED_WORKSPACE, WorkspaceError } from '../workspace/index.js';
import { type NoteClassification, NotesError } from './types.js';
import { type WriteResult, writeNote } from './writer.js';

const MSP_CUSTOMER_PREFIX = 'msp-customers/';

/**
 * Erlaubte Quellen-Typen aus dem MSP-Daily-Workflow. Frei erweiterbar
 * über die offene Frontmatter — diese sind nur die kuratierten
 * Defaults für die GUI-Dropdown.
 */
export type QuickCaptureSource =
  | 'anruf'
  | 'vor-ort'
  | 'mail'
  | 'slack'
  | 'teams'
  | 'eigeninitiative'
  | 'sonstige';

export const QUICK_CAPTURE_SOURCES: readonly QuickCaptureSource[] = [
  'anruf',
  'vor-ort',
  'mail',
  'slack',
  'teams',
  'eigeninitiative',
  'sonstige',
] as const;

export type QuickCaptureCategory = 'incident' | 'anfrage' | 'doku' | 'change' | 'beobachtung';

export const QUICK_CAPTURE_CATEGORIES: readonly QuickCaptureCategory[] = [
  'incident',
  'anfrage',
  'doku',
  'change',
  'beobachtung',
] as const;

export type QuickCaptureStatus = 'offen' | 'in-bearbeitung' | 'wartet' | 'erledigt';

export const QUICK_CAPTURE_STATUSES: readonly QuickCaptureStatus[] = [
  'offen',
  'in-bearbeitung',
  'wartet',
  'erledigt',
] as const;

export interface QuickCaptureInput {
  readonly title: string;
  readonly body: string;
  readonly source: QuickCaptureSource;
  readonly category: QuickCaptureCategory;
  readonly status?: QuickCaptureStatus;
  readonly tags?: readonly string[];
  /**
   * Optional Workspace-Override. Wenn gesetzt MUSS er dem aktiven
   * Workspace entsprechen — sonst wirft die Funktion. Renderer kann
   * das mit-senden um Frontend↔Backend-Drift hart zu erkennen.
   */
  readonly workspace?: string;
  /**
   * Optionaler TANSS-Ticket-Link (Slot-Reserve für die spätere
   * claude-os-msp-Bridge — heute leer, später automatisch befüllt).
   */
  readonly tanssTicketId?: string;
}

export interface QuickCaptureOpts {
  /** Override für Tests. Default: `new Date()`. */
  readonly nowFactory?: () => Date;
  /** Override für Tests. Default: liest persistenten State von Disk. */
  readonly activeWorkspaceProvider?: () => string;
  /** Audit-Hook. Wenn `undefined`, wird kein Audit-Log geschrieben. */
  readonly auditLogger?: Pick<AuditLogger, 'append'>;
}

export interface QuickCaptureResult extends WriteResult {
  readonly workspace: string;
  readonly tenant: string | null;
  readonly source: QuickCaptureSource;
  readonly category: QuickCaptureCategory;
}

const ILLEGAL_FILENAME_CHARS = /[^a-z0-9-]+/g;

/**
 * Erzeugt einen Filename-Slug aus dem Titel.
 *
 * Schritte (alle deterministisch):
 *   1. Trim + lowercase
 *   2. Deutsche Umlaute → ASCII (ä→ae, ö→oe, ü→ue, ß→ss)
 *   3. Übriges Non-`[a-z0-9-]` durch `-` ersetzen
 *   4. Mehrfach-Bindestriche kollabieren, Trailing-Bindestriche weg
 *   5. Max 60 Zeichen
 *   6. Bei leerem Output: `note`
 */
export function slugifyTitle(title: string): string {
  const ascii = title
    .trim()
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
  const replaced = ascii.replace(ILLEGAL_FILENAME_CHARS, '-');
  const collapsed = replaced.replace(/-+/g, '-').replace(/^-|-$/g, '');
  const trimmed = collapsed.slice(0, 60).replace(/-$/g, '');
  return trimmed.length > 0 ? trimmed : 'note';
}

/**
 * Baut den deterministischen Quick-Capture-Filename.
 * Format: `YYYY-MM-DDTHH-MM-SSZ-<slug>.md` — sortierbar, kollisionsarm
 * pro Sekunde, ohne Pfad-Sonderzeichen (`:` durch `-` ersetzt).
 */
export function buildFilename(now: Date, title: string): string {
  const iso = now
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/-\d{3}Z$/, 'Z');
  return `${iso}-${slugifyTitle(title)}.md`;
}

/**
 * Default-Classification basierend auf der Workspace-Familie (per
 * ARCHITECTURE.md §5.2). Customer-Workspaces sind by-default
 * `customer-confidential`, `msp-internal` ist `operational`, alles
 * andere fällt zurück auf `personal`.
 */
export function defaultClassification(workspace: string): NoteClassification {
  if (workspace.startsWith(MSP_CUSTOMER_PREFIX)) return 'customer-confidential';
  if (workspace === 'msp-internal') return 'operational';
  return 'personal';
}

/**
 * Tenant-Resolution aus dem Workspace-Pfad. `msp-customers/<id>` →
 * `<id>`, sonst `null`. Diese Funktion dupliziert bewusst die Logik
 * aus `@domains/tenant/resolve.ts` — beide bleiben simpel und können
 * unabhängig getestet werden.
 */
function workspaceToTenant(workspace: string): string | null {
  if (workspace.startsWith(MSP_CUSTOMER_PREFIX)) {
    const tenant = workspace.slice(MSP_CUSTOMER_PREFIX.length);
    return tenant.length > 0 ? tenant : null;
  }
  return null;
}

/**
 * Quick-Capture-Hauptfunktion. Resolved active workspace, validiert,
 * baut Frontmatter, schreibt, audit-logged.
 */
export function quickCapture(
  vaultRoot: string,
  input: QuickCaptureInput,
  opts: QuickCaptureOpts = {},
): QuickCaptureResult {
  if (input.title.trim().length === 0) {
    throw new NotesError('quickCapture: title darf nicht leer sein');
  }
  if (input.body.trim().length === 0) {
    throw new NotesError('quickCapture: body darf nicht leer sein');
  }

  const provider = opts.activeWorkspaceProvider ?? (() => readActiveWorkspace().active);
  const active = provider();

  if (active === UNSORTED_WORKSPACE) {
    throw new WorkspaceError(
      `quickCapture: aktiver Workspace ist "${UNSORTED_WORKSPACE}" — wechsle ` +
        'zu einem konkreten Workspace (claude-os workspace use <id>) bevor du Quick-Capture nutzt.',
    );
  }

  if (input.workspace !== undefined && input.workspace !== active) {
    throw new WorkspaceError(
      `quickCapture: Drift zwischen Renderer-State (workspace="${input.workspace}") ` +
        `und Backend-State (active="${active}"). Re-load die Seite — der Backend-State ist autoritativ.`,
    );
  }

  const now = (opts.nowFactory ?? (() => new Date()))();
  const filename = buildFilename(now, input.title);
  const tenant = workspaceToTenant(active);

  // Frontmatter: minimal-required + Quick-Capture-Defaults + offene
  // Slots für die spätere TANSS-Bridge-Integration (claude-os-msp).
  const frontmatter = {
    workspace: active,
    classification: defaultClassification(active),
    schema_version: 1,
    type: 'session' as const,
    source: input.source,
    category: input.category,
    status: input.status ?? 'offen',
    title: input.title,
    ...(tenant !== null ? { tenant } : {}),
    ...(input.tags !== undefined && input.tags.length > 0 ? { tags: input.tags } : {}),
    // TANSS-Slot-Reservation (ADR-0030 — Bridge füllt das später)
    ...(input.tanssTicketId !== undefined ? { tanss_ticket_id: input.tanssTicketId } : {}),
    tanss_status: null,
  };

  const writeResult = writeNote(vaultRoot, active, filename, frontmatter, input.body, {
    nowIso: now.toISOString(),
  });

  if (opts.auditLogger !== undefined) {
    opts.auditLogger.append({
      kind: 'note.write',
      action: 'quick-capture',
      workspace: active,
      ...(tenant !== null ? { tenant } : {}),
      outcome: 'ok',
      details: {
        path: writeResult.path,
        source: input.source,
        category: input.category,
        status: input.status ?? 'offen',
        titleLength: input.title.length,
        bodyLength: input.body.length,
      },
    });
  }

  return {
    ...writeResult,
    workspace: active,
    tenant,
    source: input.source,
    category: input.category,
  };
}
