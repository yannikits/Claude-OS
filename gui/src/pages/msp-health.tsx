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
import { useCallback, useEffect, useState } from 'react';
import {
  type AggregateSnapshot,
  type BridgeCellResult,
  type BridgeKind,
  type CustomerHealthRow,
  type MspHealthConfig,
  mspHealthConfig,
  mspHealthRefresh,
  mspHealthRows,
  type TanssCellData,
  type VeeamCellData,
} from '../lib/rpc';

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
      {(['tanss', 'veeam'] as const).map((k) => {
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

export function MspHealthPage() {
  const [snap, setSnap] = useState<AggregateSnapshot | null>(null);
  const [cfg, setCfg] = useState<MspHealthConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

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

  const visibleBridges: BridgeKind[] = snap?.registeredBridges.length
    ? [...snap.registeredBridges]
    : [];

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
        <table className="data-table msp-health-table">
          <thead>
            <tr>
              <th>CUSTOMER</th>
              {visibleBridges.map((b) => (
                <th key={b}>{BRIDGE_LABEL[b]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {snap.rows.map((row) => (
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
            </td>
          );
        })}
      </tr>
      {expanded && (
        <tr className="msp-health-row-expanded">
          <td colSpan={1 + bridges.length}>
            <RowDetails row={row} />
          </td>
        </tr>
      )}
    </>
  );
}
