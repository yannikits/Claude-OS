/**
 * MSP-Health Dashboard — admin-only aggregate view of all configured
 * Read-Bridges across all customer-workspaces.
 *
 * Per-cell rendering chooses a compact "what does an operator need to
 * know at a glance" summary:
 *   - tanss-ok: `N open / M total`
 *   - veeam-ok: `X ok · Y warn · Z failed · W running` (plus `missingJobs` flag)
 *   - error kinds: tinted background + short message
 *
 * Click a row to expand inline details. Manual refresh; no polling.
 *
 * @module gui/pages/msp-health
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type AggregateSnapshot,
  type BridgeCellResult,
  type BridgeKind,
  type CustomerHealthRow,
  type MspHealthConfig,
  mspHealthConfig,
  mspHealthRefresh,
  mspHealthRows,
  type SecurepointCellData,
  type SophosCellData,
  type TanssCellData,
  type VeeamCellData,
} from '../lib/rpc';
import { useAutoRefresh } from '../lib/use-msp-auto-refresh';

const BRIDGE_LABEL: Record<BridgeKind, string> = {
  tanss: 'TANSS',
  veeam: 'VEEAM',
  sophos: 'SOPHOS',
  securepoint: 'SECUREPOINT',
  m365: 'M365',
};

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return '—';
  const s = Math.round(ageMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

function cellTone(c: BridgeCellResult<unknown> | undefined): string {
  if (c === undefined) return 'tone-empty';
  switch (c.kind) {
    case 'ok':
      return 'tone-ok';
    case 'rate-limited':
    case 'misconfigured':
      return 'tone-warn';
    case 'auth-failed':
    case 'unreachable':
    case 'timeout':
    case 'error':
      return 'tone-error';
  }
}

function TanssCell({ cell }: { cell: BridgeCellResult<TanssCellData> | undefined }) {
  if (cell === undefined) return <span className="cell-dim">—</span>;
  if (cell.kind !== 'ok') {
    return (
      <span className="cell-status">
        <strong>{cell.kind}</strong>
        {'message' in cell && cell.message !== undefined && (
          <span className="cell-msg"> · {cell.message}</span>
        )}
      </span>
    );
  }
  const d = cell.data;
  return (
    <span className="cell-status">
      <strong>{d.openCount}</strong> open / {d.totalCount} total
      {d.newestUpdateAt !== null && (
        <span className="cell-msg"> · last {fmtDate(d.newestUpdateAt)}</span>
      )}
    </span>
  );
}

function SecurepointCell({ cell }: { cell: BridgeCellResult<SecurepointCellData> | undefined }) {
  if (cell === undefined) return <span className="cell-dim">—</span>;
  if (cell.kind !== 'ok') {
    return (
      <span className="cell-status">
        <strong>{cell.kind}</strong>
        {'message' in cell && cell.message !== undefined && (
          <span className="cell-msg"> · {cell.message}</span>
        )}
      </span>
    );
  }
  const d = cell.data;
  const licClass =
    d.licenseStatus === 'valid' ? '' : d.licenseStatus === 'expiring-soon' ? ' cell-msg-warn' : '';
  return (
    <span className="cell-status">
      <strong>{d.online ? 'ONLINE' : 'OFFLINE'}</strong>
      <span className={`cell-msg${licClass}`}>
        {' '}
        · license {d.licenseStatus}
        {d.licenseDaysRemaining !== null ? ` (${d.licenseDaysRemaining}d)` : ''}
      </span>
    </span>
  );
}

function SophosCell({ cell }: { cell: BridgeCellResult<SophosCellData> | undefined }) {
  if (cell === undefined) return <span className="cell-dim">—</span>;
  if (cell.kind !== 'ok') {
    return (
      <span className="cell-status">
        <strong>{cell.kind}</strong>
        {'message' in cell && cell.message !== undefined && (
          <span className="cell-msg"> · {cell.message}</span>
        )}
      </span>
    );
  }
  const d = cell.data;
  const licClass =
    d.licenseSummary === 'active'
      ? ''
      : d.licenseSummary === 'expiring-soon' || d.licenseSummary === 'mixed'
        ? ' cell-msg-warn'
        : '';
  return (
    <span className="cell-status">
      <strong>{d.firmwareVersion || '—'}</strong>
      <span className={`cell-msg${licClass}`}>
        {' '}
        · {d.licenseSummary}
        {d.daysToEarliestExpiry !== null ? ` (${d.daysToEarliestExpiry}d)` : ''}
      </span>
    </span>
  );
}

function VeeamCell({ cell }: { cell: BridgeCellResult<VeeamCellData> | undefined }) {
  if (cell === undefined) return <span className="cell-dim">—</span>;
  if (cell.kind !== 'ok') {
    return (
      <span className="cell-status">
        <strong>{cell.kind}</strong>
        {'message' in cell && cell.message !== undefined && (
          <span className="cell-msg"> · {cell.message}</span>
        )}
      </span>
    );
  }
  const d = cell.data;
  return (
    <span className="cell-status">
      <strong>{d.okCount}</strong> ok · {d.warningCount} warn · {d.failedCount} failed ·{' '}
      {d.runningCount} running
      {d.missingJobs.length > 0 && (
        <span className="cell-msg cell-msg-warn"> · {d.missingJobs.length} missing</span>
      )}
    </span>
  );
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function RowDetails({ row }: { row: CustomerHealthRow }) {
  return (
    <div className="msp-health-details">
      {(['tanss', 'veeam', 'sophos', 'securepoint'] as const).map((k) => {
        const cell = row.cells[k] as BridgeCellResult<unknown> | undefined;
        if (cell === undefined) return null;
        return (
          <div key={k} className="msp-health-detail-block">
            <div className="msp-health-detail-head">{BRIDGE_LABEL[k]}</div>
            <pre>{JSON.stringify(cell, null, 2)}</pre>
          </div>
        );
      })}
    </div>
  );
}

const AUTO_REFRESH_OPTIONS: { readonly label: string; readonly seconds: number | null }[] = [
  { label: 'off', seconds: null },
  { label: '1m', seconds: 60 },
  { label: '5m', seconds: 300 },
  { label: '15m', seconds: 900 },
];

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

export function MspHealthPage() {
  const [snap, setSnap] = useState<AggregateSnapshot | null>(null);
  const [cfg, setCfg] = useState<MspHealthConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [autoRefreshSec, setAutoRefreshSec] = useState<number | null>(null);
  const [pageSize, setPageSize] = useState<number>(50);
  const [page, setPage] = useState<number>(0);

  const load = useCallback(async (force: boolean): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const fresh = force ? await mspHealthRefresh() : await mspHealthRows();
      setSnap(fresh);
      setCfg(await mspHealthConfig());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  // Auto-refresh: silent reload (no force), driven by user-selected interval.
  useAutoRefresh(() => void load(false), autoRefreshSec);

  const visibleBridges: BridgeKind[] = snap?.registeredBridges.length
    ? [...snap.registeredBridges]
    : [];

  // Pagination math.
  const rows = snap?.rows ?? [];
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = useMemo(
    () => rows.slice(safePage * pageSize, safePage * pageSize + pageSize),
    [rows, safePage, pageSize],
  );

  return (
    <div className="msp-health-page">
      <header className="msp-health-header">
        <h1>MSP HEALTH</h1>
        <div className="msp-health-meta">
          {snap !== null && (
            <span>
              {snap.rows.length} customers · {snap.registeredBridges.length} bridges (
              {snap.registeredBridges.join(' · ') || '—'})
            </span>
          )}
          {cfg !== null && cfg.cacheAgeMs !== null && (
            <span className="msp-health-age">cache age: {formatAge(cfg.cacheAgeMs)}</span>
          )}
        </div>
        <div className="msp-health-actions">
          <div className="msp-health-control">
            <span className="msp-health-control-label">auto:</span>
            {AUTO_REFRESH_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                type="button"
                className={`msp-health-segment${autoRefreshSec === opt.seconds ? ' active' : ''}`}
                onClick={() => setAutoRefreshSec(opt.seconds)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => void load(true)} disabled={loading}>
            {loading ? '…' : '↻ Refresh'}
          </button>
        </div>
      </header>

      {error !== null && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      {snap === null && !loading && error === null && (
        <p className="msp-health-empty">Lade Snapshot …</p>
      )}

      {snap !== null && snap.rows.length === 0 && (
        <p className="msp-health-empty">
          Keine Customer-Workspaces gefunden. Lege einen unter{' '}
          <code>vault/workspaces/msp-customers/&lt;slug&gt;/customer.yaml</code> an.
        </p>
      )}

      {snap !== null && snap.rows.length > 0 && (
        <>
          <table className="data-table msp-health-table">
            <thead>
              <tr>
                <th>CUSTOMER</th>
                {visibleBridges.map((b) => (
                  <th key={b}>{BRIDGE_LABEL[b]}</th>
                ))}
                <th className="msp-health-th-audit">AUDIT</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => (
                <RowGroup
                  key={row.slug}
                  row={row}
                  bridges={visibleBridges}
                  expanded={expanded === row.slug}
                  onToggle={() => setExpanded((cur) => (cur === row.slug ? null : row.slug))}
                />
              ))}
            </tbody>
          </table>
          <div className="msp-health-pagination">
            <span className="msp-health-control-label">rows:</span>
            {PAGE_SIZE_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                className={`msp-health-segment${pageSize === n ? ' active' : ''}`}
                onClick={() => {
                  setPageSize(n);
                  setPage(0);
                }}
              >
                {n}
              </button>
            ))}
            <span className="msp-health-pagination-info">
              page {safePage + 1} / {totalPages} ({rows.length} total)
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
            >
              ‹ prev
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
            >
              next ›
            </button>
          </div>
        </>
      )}
    </div>
  );
}

interface RowGroupProps {
  readonly row: CustomerHealthRow;
  readonly bridges: readonly BridgeKind[];
  readonly expanded: boolean;
  readonly onToggle: () => void;
}

function RowGroup({ row, bridges, expanded, onToggle }: RowGroupProps) {
  const auditUrl = `/audit?tenant=${encodeURIComponent(row.slug)}&kinds=bridge.read`;
  return (
    <>
      <tr className="msp-health-row" onClick={onToggle}>
        <td>
          <strong>{row.displayName}</strong>
          <span className="cell-slug">{row.slug}</span>
        </td>
        {bridges.map((b) => {
          // CustomerHealthCells is typed (tanss?, veeam?, …); future bridges
          // not yet defined render as null.
          const cells = row.cells as Record<BridgeKind, BridgeCellResult<unknown> | undefined>;
          const cell = cells[b];
          return (
            <td key={b} className={`msp-health-cell ${cellTone(cell)}`}>
              {b === 'tanss' && (
                <TanssCell cell={cell as BridgeCellResult<TanssCellData> | undefined} />
              )}
              {b === 'veeam' && (
                <VeeamCell cell={cell as BridgeCellResult<VeeamCellData> | undefined} />
              )}
              {b === 'sophos' && (
                <SophosCell cell={cell as BridgeCellResult<SophosCellData> | undefined} />
              )}
              {b === 'securepoint' && (
                <SecurepointCell cell={cell as BridgeCellResult<SecurepointCellData> | undefined} />
              )}
            </td>
          );
        })}
        <td className="msp-health-cell-audit">
          <a className="msp-health-drill-link" href={auditUrl} onClick={(e) => e.stopPropagation()}>
            audit
          </a>
        </td>
      </tr>
      {expanded && (
        <tr className="msp-health-row-expanded">
          <td colSpan={2 + bridges.length}>
            <RowDetails row={row} />
          </td>
        </tr>
      )}
    </>
  );
}
