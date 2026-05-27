/**
 * Memory page — Phase 2f MVP-GUI surface for the Memory MVP workflow.
 *
 * Sections:
 *   1. WorkspaceIndicator (top-right, also rendered on Dashboard for
 *      cross-page consistency).
 *   2. Search bar — `retrieval.search` over the active workspace.
 *   3. Results list — top-K hits with score, path, preview.
 *   4. "New note" button → SaveAsNoteModal for ad-hoc captures.
 *
 * The Memory page deliberately does NOT run the `ask` workflow —
 * delegation to claude.exe stays a CLI thing for v1 (interactive PTY
 * lives on the Chat page). MVP-DoD §4 "Speichern als Note" + §3
 * "Top-K-Retrieval" + §6 "Recall" are all covered here.
 */
import { useCallback, useState } from 'react';
import { SaveAsNoteModal } from '../components/save-as-note-modal';
import { WorkspaceIndicator } from '../components/workspace-indicator';
import {
  type CrossWorkspaceSearchResult,
  crossWorkspaceSearch,
  type RetrievalSearchResult,
  searchVault,
} from '../lib/rpc';

type AnySearchResult =
  | ({ kind: 'single' } & RetrievalSearchResult)
  | ({ kind: 'cross' } & CrossWorkspaceSearchResult);

interface SearchState {
  result: AnySearchResult | null;
  loading: boolean;
  error: string | null;
}

const INITIAL_SEARCH: SearchState = { result: null, loading: false, error: null };

export function MemoryPage() {
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState(10);
  const [includeEphemeral, setIncludeEphemeral] = useState(false);
  const [recursive, setRecursive] = useState(false);
  // Cross-workspace mode: 'off' (active only), 'scoped' (active + msp-internal),
  // 'cross-customer' (all customer workspaces). Codex Stage-2 hardening:
  // default is 'off' — the most restrictive, no implicit broad scope.
  const [scopeMode, setScopeMode] = useState<'off' | 'scoped' | 'cross-customer'>('off');
  const [search, setSearch] = useState<SearchState>(INITIAL_SEARCH);
  const [modalBody, setModalBody] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = query.trim();
      if (text.length === 0) return;
      setSearch({ result: null, loading: true, error: null });
      try {
        if (scopeMode === 'off') {
          const result = await searchVault({ text, topK, includeEphemeral, recursive });
          setSearch({ result: { kind: 'single', ...result }, loading: false, error: null });
        } else {
          const result = await crossWorkspaceSearch({
            text,
            topK,
            includeEphemeral,
            recursive,
            crossCustomer: scopeMode === 'cross-customer',
          });
          setSearch({ result: { kind: 'cross', ...result }, loading: false, error: null });
        }
      } catch (err) {
        setSearch({
          result: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [query, topK, includeEphemeral, recursive, scopeMode],
  );

  const handleNewNote = useCallback(() => {
    setModalBody('');
  }, []);

  return (
    <section className="page memory-page">
      <header className="memory-page__header">
        <h1>Memory</h1>
        <WorkspaceIndicator />
      </header>

      <form className="memory-search" onSubmit={(e) => void handleSubmit(e)}>
        <input
          type="search"
          value={query}
          placeholder="Frage stellen oder Schlagwort suchen…"
          onChange={(e) => setQuery(e.target.value)}
          // biome-ignore lint/a11y/noAutofocus: search is the primary action of this page
          autoFocus
        />
        <button type="submit" disabled={search.loading || query.trim().length === 0}>
          {search.loading ? 'Suche …' : 'Suchen'}
        </button>
        <button type="button" onClick={handleNewNote}>
          + Neue Notiz
        </button>
      </form>

      <div className="memory-options">
        <label>
          Top-K:{' '}
          <input
            type="number"
            min={1}
            max={50}
            value={topK}
            onChange={(e) => setTopK(Number.parseInt(e.target.value, 10) || 10)}
            style={{ width: '4rem' }}
          />
        </label>
        <label>
          Scope:{' '}
          <select
            value={scopeMode}
            onChange={(e) => setScopeMode(e.target.value as typeof scopeMode)}
            title={
              'off = nur aktiver Workspace · scoped = aktiv + msp-internal · ' +
              'cross-customer = alle Kunden-Workspaces (Audit-Log!)'
            }
          >
            <option value="off">Aktiver Workspace</option>
            <option value="scoped">+ msp-internal</option>
            <option value="cross-customer">⚠ Alle Kunden (audit-logged)</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={includeEphemeral}
            onChange={(e) => setIncludeEphemeral(e.target.checked)}
          />{' '}
          Include ephemeral
        </label>
        <label>
          <input
            type="checkbox"
            checked={recursive}
            onChange={(e) => setRecursive(e.target.checked)}
          />{' '}
          Recursive
        </label>
      </div>

      {scopeMode === 'cross-customer' && (
        <p className="banner banner-warning" role="status">
          ⚠ Cross-Customer-Suche aktiv — diese Abfrage wird im Audit-Log mit deinem Token-Tenant
          verzeichnet. Nutze dies nur wenn du eine Lösung aus einem anderen Customer-Workspace
          übernehmen willst.
        </p>
      )}

      {search.error !== null && (
        <p className="banner banner-error">Search failed: {search.error}</p>
      )}

      {search.result !== null && (
        <div className="memory-results">
          <p className="muted">
            {search.result.hits.length} hits aus {search.result.totalScanned} notes ·{' '}
            {search.result.durationMs} ms ·{' '}
            {search.result.kind === 'cross' ? (
              <>
                scope: <code>{search.result.scope.join(' + ')}</code>
              </>
            ) : (
              <>
                workspace: <code>{search.result.workspace}</code>
              </>
            )}
          </p>
          {search.result.hits.length === 0 ? (
            <p>Keine Treffer für „{search.result.query}".</p>
          ) : (
            <ol className="memory-hits">
              {search.result.hits.map((hit) => (
                <li key={hit.path} className="memory-hit">
                  <div className="memory-hit__head">
                    <span className="memory-hit__score">{hit.score.toFixed(3)}</span>
                    {'workspace' in hit && search.result?.kind === 'cross' && (
                      <span
                        className={`quick-capture-badge ${
                          hit.workspace.startsWith('msp-customers/')
                            ? 'badge-customer'
                            : 'badge-internal'
                        }`}
                        style={{ fontSize: '11px', padding: '2px 8px' }}
                      >
                        {hit.workspace}
                      </span>
                    )}
                    <code className="memory-hit__path">{hit.path}</code>
                    <span className="memory-hit__class">
                      [{String(hit.frontmatter.classification ?? 'unknown')}]
                    </span>
                  </div>
                  {hit.matchedTerms.length > 0 && (
                    <div className="memory-hit__terms">Matched: {hit.matchedTerms.join(', ')}</div>
                  )}
                  <pre className="memory-hit__preview">{hit.preview}</pre>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {modalBody !== null && (
        <SaveAsNoteModal
          initialBody={modalBody}
          onClose={() => setModalBody(null)}
          onSaved={(path) => {
            setModalBody(null);
            // Trigger a re-search so the new note appears if it matches.
            if (query.trim().length > 0) {
              void handleSubmit({ preventDefault: () => {} } as React.FormEvent);
            }
            void path;
          }}
        />
      )}
    </section>
  );
}
