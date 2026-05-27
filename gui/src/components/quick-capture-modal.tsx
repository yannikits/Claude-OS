/**
 * Quick-Capture-Modal — MSP-Daily-Workflow Schnellnotiz.
 *
 * Hotkey "n" auf jeder Page öffnet das Modal. Yannik tippt Title +
 * 3 Zeilen, wählt Source + Category, drückt Ctrl+Enter (oder Submit) —
 * landet im aktiven Customer-Workspace mit TANSS-Slots als Stub.
 *
 * Backend-Validation (siehe `src/domains/notes/quick-capture.ts`):
 *   - Aktiver Workspace ist autoritativ (Backend resolved, nicht
 *     Renderer-State)
 *   - Workspace-Drift zwischen Renderer und Backend → hartes Reject
 *   - `_unsorted` als aktiver Workspace → Reject
 *   - Audit-Log-Pflicht
 *
 * Renderer-Side zeigt den aufgelösten Workspace als grosse Badge VOR
 * dem Submit — damit Yannik sicher ist welcher Kunde gerade aktiv ist.
 *
 * @module gui/components/quick-capture-modal
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type CrossWorkspaceHitDto,
  crossWorkspaceSearch,
  getQuickCaptureMeta,
  type QuickCaptureMeta,
  quickCaptureNote,
} from '../lib/rpc';

interface Props {
  onClose: () => void;
  onCaptured?: (path: string) => void;
}

const DEFAULT_SOURCE = 'anruf';
const DEFAULT_CATEGORY = 'incident';
const DEFAULT_STATUS = 'offen';

export function QuickCaptureModal({ onClose, onCaptured }: Props) {
  const [meta, setMeta] = useState<QuickCaptureMeta | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [source, setSource] = useState(DEFAULT_SOURCE);
  const [category, setCategory] = useState(DEFAULT_CATEGORY);
  const [status, setStatus] = useState(DEFAULT_STATUS);
  const [tags, setTags] = useState('');
  const [tanssTicketId, setTanssTicketId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<CrossWorkspaceHitDto[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);

  const titleInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getQuickCaptureMeta()
      .then((m) => {
        if (cancelled) return;
        setMeta(m);
        if (!m.sources.includes(source)) {
          setSource(m.sources[0] ?? DEFAULT_SOURCE);
        }
        if (!m.categories.includes(category)) {
          setCategory(m.categories[0] ?? DEFAULT_CATEGORY);
        }
        if (!m.statuses.includes(status)) {
          setStatus(m.statuses[0] ?? DEFAULT_STATUS);
        }
        // Auto-focus title once meta loaded (delay until field is enabled).
        setTimeout(() => titleInputRef.current?.focus(), 0);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMetaError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: meta-fetch must run once on mount; source/category/status are derived from meta and would re-fetch on every keystroke
  }, []);

  const workspace = meta?.activeWorkspace ?? '…';
  const isUnsorted = workspace === '_unsorted';
  const isCustomer = workspace.startsWith('msp-customers/');

  const customerBadgeLabel = useMemo(() => {
    if (isUnsorted) return 'Kein konkreter Workspace aktiv — Quick-Capture deaktiviert';
    if (isCustomer) return workspace.slice('msp-customers/'.length);
    if (workspace === 'msp-internal') return 'MSP-Intern';
    if (workspace === 'personal') return 'Persönlich';
    return workspace;
  }, [isUnsorted, isCustomer, workspace]);

  // MSP-C — Live-Suggestions: debounce 500ms gegen `title + body`, scope =
  // default (active + msp-internal, KEIN cross-customer hier — wir wollen
  // keine Audit-Log-Floods bei jedem Tastenanschlag). Bei <15 Zeichen keine
  // Suche (zu noisy).
  useEffect(() => {
    if (isUnsorted || meta === null) {
      setSuggestions([]);
      return;
    }
    const combined = `${title} ${body}`.trim();
    if (combined.length < 15) {
      setSuggestions([]);
      setSuggestionsLoading(false);
      return;
    }
    let cancelled = false;
    setSuggestionsLoading(true);
    const timer = setTimeout(() => {
      void crossWorkspaceSearch({
        text: combined,
        topK: 3,
        crossCustomer: false, // never cross-customer in suggestion mode
      })
        .then((res) => {
          if (cancelled) return;
          setSuggestions(res.hits);
          setSuggestionsLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setSuggestions([]);
          setSuggestionsLoading(false);
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [title, body, isUnsorted, meta]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (saving) return;
      if (title.trim().length === 0 || body.trim().length === 0) return;
      if (meta === null || isUnsorted) return;
      setSaving(true);
      setError(null);
      try {
        const tagList = tags
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
        const res = await quickCaptureNote({
          title: title.trim(),
          body,
          source,
          category,
          status,
          tags: tagList.length > 0 ? tagList : undefined,
          workspace: meta.activeWorkspace,
          tanssTicketId: tanssTicketId.trim().length > 0 ? tanssTicketId.trim() : undefined,
        });
        onCaptured?.(res.path);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [
      saving,
      title,
      body,
      meta,
      isUnsorted,
      source,
      category,
      status,
      tags,
      tanssTicketId,
      onCaptured,
      onClose,
    ],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void handleSubmit(e as never);
    },
    [onClose, handleSubmit],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dialog-backdrop pattern; modal itself has role=dialog
    <div className="modal-backdrop" onClick={onClose} onKeyDown={handleKeyDown} role="presentation">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation only — dialog itself receives focus */}
      <div
        className="modal quick-capture-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Quick-Capture"
      >
        <header className="quick-capture-header">
          <h2>Quick-Capture</h2>
          <div
            className={`quick-capture-badge ${isUnsorted ? 'badge-warning' : isCustomer ? 'badge-customer' : 'badge-internal'}`}
            aria-live="polite"
            title={`Aktiver Workspace: ${workspace}`}
          >
            {meta === null ? 'Lade…' : customerBadgeLabel}
          </div>
        </header>

        {metaError !== null && (
          <p className="error-banner">Fehler beim Laden der Workspace-Info: {metaError}</p>
        )}

        {isUnsorted && (
          <p className="error-banner">
            Der aktive Workspace ist <code>_unsorted</code>. Wechsle zu einem konkreten Workspace
            (Settings → Workspace) bevor du Quick-Capture nutzt.
          </p>
        )}

        <form onSubmit={(e) => void handleSubmit(e)}>
          <label>
            Titel:
            <input
              ref={titleInputRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              disabled={saving || meta === null || isUnsorted}
              placeholder="VPN MTU bei Acme — User reported drops"
              maxLength={120}
            />
          </label>

          <label>
            Inhalt (Markdown OK, Ctrl+Enter zum Speichern):
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              required
              disabled={saving || meta === null || isUnsorted}
              placeholder={'## Symptom\n\n## Bisherige Schritte\n'}
            />
          </label>

          <div className="form-row">
            <label>
              Quelle:
              <select
                value={source}
                onChange={(e) => setSource(e.target.value)}
                disabled={saving || meta === null || isUnsorted}
              >
                {(meta?.sources ?? []).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Kategorie:
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                disabled={saving || meta === null || isUnsorted}
              >
                {(meta?.categories ?? []).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Status:
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                disabled={saving || meta === null || isUnsorted}
              >
                {(meta?.statuses ?? []).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label>
            Tags (komma-getrennt, optional):
            <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              disabled={saving || meta === null || isUnsorted}
              placeholder="vpn, securepoint, urgent"
            />
          </label>

          <label>
            TANSS-Ticket (optional, Slot-Reserve):
            <input
              type="text"
              value={tanssTicketId}
              onChange={(e) => setTanssTicketId(e.target.value)}
              disabled={saving || meta === null || isUnsorted}
              placeholder="T-12345"
            />
          </label>

          {(suggestions.length > 0 || suggestionsLoading) && !isUnsorted && (
            <div className="quick-capture-suggestions">
              <div className="quick-capture-suggestions__header">
                {suggestionsLoading
                  ? 'Suche ähnliche Notizen …'
                  : `Ähnliche Notizen (${suggestions.length})`}
              </div>
              {suggestions.length > 0 && (
                <ul>
                  {suggestions.map((hit) => {
                    const filename =
                      hit.path.split(/[\\/]/).pop()?.replace(/\.md$/, '') ?? hit.path;
                    const wsLabel = hit.workspace.startsWith('msp-customers/')
                      ? hit.workspace.slice('msp-customers/'.length)
                      : hit.workspace === 'msp-internal'
                        ? 'MSP-Intern'
                        : hit.workspace;
                    return (
                      <li key={hit.path} title={hit.path}>
                        <span
                          className={`quick-capture-badge ${
                            hit.workspace.startsWith('msp-customers/')
                              ? 'badge-customer'
                              : 'badge-internal'
                          }`}
                          style={{ fontSize: '10px', padding: '1px 6px' }}
                        >
                          {wsLabel}
                        </span>
                        <span className="quick-capture-suggestion__title">{filename}</span>
                        <span className="quick-capture-suggestion__score">
                          {hit.score.toFixed(2)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="quick-capture-suggestions__hint">
                Wenn das Problem schon gelöst ist: Note öffnen statt neu schreiben (Memory-Page).
              </p>
            </div>
          )}

          {error !== null && <p className="error-banner">Fehler: {error}</p>}

          <div className="modal-buttons">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
              Abbrechen (Esc)
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={
                saving ||
                meta === null ||
                isUnsorted ||
                title.trim().length === 0 ||
                body.trim().length === 0
              }
            >
              {saving ? 'Speichere…' : 'Speichern (Ctrl+Enter)'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
