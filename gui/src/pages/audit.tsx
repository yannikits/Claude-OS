/**
 * Audit-Trail-Dashboard — Read-only Web-UI über die audit-JSONL-Logs.
 *
 * Admin-only (gating geschieht serverseitig via routes-audit.ts).
 * Drei Sektionen: Stats-Strip (Counts pro Kind) → Filter-Bar →
 * Events-Table. Plus zwei Export-Buttons (JSONL / CSV).
 *
 * Operator-Console-Treatment via globale `.data-table`, Display-Font
 * caps + tabular-nums. Newest-first sort default — Operator schaut
 * meistens auf "was passierte zuletzt".
 *
 * @module gui/pages/audit
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { WorkspaceIndicator } from '../components/workspace-indicator';
import {
  type AuditEntry,
  type AuditPage as AuditPagePayload,
  type AuditQuery,
  type AuditStats,
  auditExport,
  auditList,
  auditStats as fetchAuditStats,
} from '../lib/rpc';

const ALL_KINDS: readonly string[] = [
  'auth.login.success',
  'auth.login.failed',
  'auth.logout',
  'auth.register',
  'auth.password.change',
  'admin.user.create',
  'admin.user.disable',
  'admin.user.enable',
  'admin.user.reset-password',
  'workspace.switch',
  'secret.read',
  'secret.write',
  'skill.promote',
  'skill.invoke',
  'note.write',
  'bridge.read',
  'bridge.write',
];

type RangePreset = 'today' | '7d' | '30d' | 'custom';

function rangeFor(preset: RangePreset): { from: string; to: string } {
  const now = new Date();
  const to = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59),
  );
  const fromDate = new Date(to.getTime());
  if (preset === 'today') {
    fromDate.setUTCHours(0, 0, 0, 0);
  } else if (preset === '7d') {
    fromDate.setUTCDate(fromDate.getUTCDate() - 6);
    fromDate.setUTCHours(0, 0, 0, 0);
  } else {
    fromDate.setUTCDate(fromDate.getUTCDate() - 29);
    fromDate.setUTCHours(0, 0, 0, 0);
  }
  return { from: fromDate.toISOString(), to: to.toISOString() };
}

export function AuditPage() {
  const [preset, setPreset] = useState<RangePreset>('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [selectedKinds, setSelectedKinds] = useState<readonly string[]>([]);
  const [workspace, setWorkspace] = useState('');
  const [tenant, setTenant] = useState('');
  const [outcome, setOutcome] = useState<'' | 'ok' | 'denied' | 'error'>('');
  const [actionContains, setActionContains] = useState('');
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  const [page, setPage] = useState<AuditPagePayload | null>(null);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const query = useMemo<AuditQuery>(() => {
    const range =
      preset === 'custom'
        ? { from: customFrom || undefined, to: customTo || undefined }
        : rangeFor(preset);
    return {
      from: range.from,
      to: range.to,
      kinds: selectedKinds.length > 0 ? selectedKinds : undefined,
      workspace: workspace || undefined,
      tenant: tenant || undefined,
      outcome: outcome || undefined,
      actionContains: actionContains || undefined,
      offset,
      limit: pageSize,
    } as AuditQuery;
  }, [
    preset,
    customFrom,
    customTo,
    selectedKinds,
    workspace,
    tenant,
    outcome,
    actionContains,
    offset,
    pageSize,
  ]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pageData, statsData] = await Promise.all([auditList(query), fetchAuditStats(query)]);
      setPage(pageData);
      setStats(statsData);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [query]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleExport = useCallback(
    async (format: 'jsonl' | 'csv') => {
      try {
        const result = await auditExport(query, format);
        // Trigger browser download via Blob + anchor click
        const blob = new Blob([result.content], {
          type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/x-ndjson',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = result.suggestedFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [query],
  );

  const toggleKind = (k: string) => {
    setSelectedKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
    setOffset(0);
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section className="page audit-page">
      <header className="page-header">
        <h1>Audit-Log</h1>
        <WorkspaceIndicator />
      </header>

      {error !== null && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      {stats !== null && stats.totalEvents > 0 && (
        <div className="audit-stats-strip">
          {Object.entries(stats.counts)
            .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
            .map(([kind, count]) => (
              <span key={kind} className="audit-stats-pill">
                <span className="audit-stats-pill__count">{count}</span>
                <span className="audit-stats-pill__kind">{kind}</span>
              </span>
            ))}
          <span className="audit-stats-total">Total · {stats.totalEvents}</span>
        </div>
      )}

      <div className="audit-filter-bar">
        <div className="audit-filter-group">
          <span className="audit-filter-label">Range</span>
          <select
            value={preset}
            onChange={(e) => {
              setPreset(e.target.value as RangePreset);
              setOffset(0);
            }}
          >
            <option value="today">Heute</option>
            <option value="7d">7 Tage</option>
            <option value="30d">30 Tage</option>
            <option value="custom">Custom</option>
          </select>
          {preset === 'custom' && (
            <>
              <input
                type="datetime-local"
                value={customFrom}
                onChange={(e) => {
                  setCustomFrom(e.target.value ? `${e.target.value}:00Z` : '');
                  setOffset(0);
                }}
                placeholder="from"
              />
              <input
                type="datetime-local"
                value={customTo}
                onChange={(e) => {
                  setCustomTo(e.target.value ? `${e.target.value}:00Z` : '');
                  setOffset(0);
                }}
                placeholder="to"
              />
            </>
          )}
        </div>

        <div className="audit-filter-group">
          <span className="audit-filter-label">Workspace</span>
          <input
            type="text"
            value={workspace}
            onChange={(e) => {
              setWorkspace(e.target.value);
              setOffset(0);
            }}
            placeholder="e.g. personal"
          />
        </div>

        <div className="audit-filter-group">
          <span className="audit-filter-label">Tenant</span>
          <input
            type="text"
            value={tenant}
            onChange={(e) => {
              setTenant(e.target.value);
              setOffset(0);
            }}
            placeholder="e.g. mueller"
          />
        </div>

        <div className="audit-filter-group">
          <span className="audit-filter-label">Outcome</span>
          <select
            value={outcome}
            onChange={(e) => {
              setOutcome(e.target.value as typeof outcome);
              setOffset(0);
            }}
          >
            <option value="">alle</option>
            <option value="ok">ok</option>
            <option value="denied">denied</option>
            <option value="error">error</option>
          </select>
        </div>

        <div className="audit-filter-group audit-filter-group--wide">
          <span className="audit-filter-label">Action ⊆</span>
          <input
            type="text"
            value={actionContains}
            onChange={(e) => {
              setActionContains(e.target.value);
              setOffset(0);
            }}
            placeholder="e.g. tanss.tickets"
          />
        </div>

        <div className="audit-filter-group">
          <button
            type="button"
            className="btn-primary"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? 'Lade …' : 'Refresh'}
          </button>
          <button type="button" onClick={() => void handleExport('csv')}>
            CSV
          </button>
          <button type="button" onClick={() => void handleExport('jsonl')}>
            JSONL
          </button>
        </div>
      </div>

      <details className="audit-kinds-picker">
        <summary>
          Kinds ({selectedKinds.length === 0 ? 'alle' : `${selectedKinds.length} gewählt`})
        </summary>
        <div className="audit-kinds-grid">
          {ALL_KINDS.map((k) => (
            <label key={k} className="audit-kind-checkbox">
              <input
                type="checkbox"
                checked={selectedKinds.includes(k)}
                onChange={() => toggleKind(k)}
              />
              <span>{k}</span>
            </label>
          ))}
        </div>
      </details>

      {page !== null && (
        <>
          <table className="data-table audit-table">
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Kind</th>
                <th>Action</th>
                <th>Workspace</th>
                <th>Tenant</th>
                <th>Outcome</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {page.entries.map((e) => {
                const id = `${e.at}|${e.action}|${e.pid}`;
                const isExpanded = expanded.has(id);
                return (
                  <tr key={id} className={`audit-row audit-row--${e.outcome}`}>
                    <td>{e.at}</td>
                    <td>{e.kind}</td>
                    <td>{e.action}</td>
                    <td>{e.workspace}</td>
                    <td>{e.tenant ?? '—'}</td>
                    <td>{e.outcome}</td>
                    <td>
                      {e.details !== undefined && (
                        <>
                          <button
                            type="button"
                            className="audit-row__expand"
                            onClick={() => toggleExpand(id)}
                            aria-expanded={isExpanded}
                          >
                            {isExpanded ? '▾' : '▸'}
                          </button>
                          {isExpanded && (
                            <pre className="audit-row__details">
                              {JSON.stringify(e.details, null, 2)}
                            </pre>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {page.entries.length === 0 && (
            <p className="muted">Keine Events im gewählten Zeitfenster und Filter.</p>
          )}

          <div className="audit-pagination">
            <span className="muted">
              {page.total === 0
                ? '0'
                : `${offset + 1}–${Math.min(offset + page.entries.length, page.total)} von ${page.total}`}
            </span>
            <button
              type="button"
              onClick={() => setOffset(Math.max(0, offset - pageSize))}
              disabled={offset === 0}
            >
              ← Prev
            </button>
            <button
              type="button"
              onClick={() => setOffset(offset + pageSize)}
              disabled={offset + page.entries.length >= page.total}
            >
              Next →
            </button>
            <label>
              Pro Seite{' '}
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number.parseInt(e.target.value, 10));
                  setOffset(0);
                }}
              >
                <option value="25">25</option>
                <option value="50">50</option>
                <option value="100">100</option>
                <option value="250">250</option>
                <option value="500">500</option>
              </select>
            </label>
          </div>
        </>
      )}
    </section>
  );
}

interface AuditEntryRowProps {
  readonly entry: AuditEntry;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}

// Keep export so consumers can use the row independently in tests.
// biome-ignore lint/correctness/noUnusedVariables: exported for tests
export type _UnusedAuditEntryRowProps = AuditEntryRowProps;
