/**
 * Modal fuer MCP-Server-Trust-Acknowledgement (M3, v1.x).
 *
 * Wenn der live-probe-Watcher einen `trust-required`-Status fuer einen
 * MCP-Server liefert, oeffnet die `McpClientsPage` dieses Modal. Wir
 * zeigen die `command` + `args` aus `mcp.json` damit der User informiert
 * entscheiden kann ob er das 3rd-party-Binary spawnen lassen will.
 *
 * Bei Bestätigung ruft das Modal `mcp.trust.acknowledge` ueber die RPC
 * und triggert dann ein `reprobe` damit der Watcher den Server sofort
 * neu laeuft (statt 60s auf den naechsten Tick zu warten).
 *
 * Trust ist persistent in `<dataDir>/mcp-trust.json` (per-Maschine,
 * nicht im Vault — Trust ist Maschine-spezifisch). Revoke geht ueber
 * `mcp.trust.revoke` (z. B. in einer kuenftigen "Trusted Servers"-Liste
 * unter Settings).
 *
 * @module gui/components/mcp-trust-modal
 */
import { useCallback, useState } from 'react';
import { acknowledgeMcpTrust, type McpServerEntry, reprobeMcpClient } from '../lib/rpc';
import { useSidecarOk } from '../lib/sidecar-status';

export interface McpTrustModalProps {
  /** Stable identifier — typically `<host>:<entry.name>` */
  readonly serverKey: string;
  readonly entry: McpServerEntry;
  readonly message: string;
  readonly onClose: () => void;
  /** Called after acknowledge+reprobe succeeded (caller refreshes list). */
  readonly onAcknowledged: () => void;
}

export function McpTrustModal({
  serverKey,
  entry,
  message,
  onClose,
  onAcknowledged,
}: McpTrustModalProps) {
  const sidecarOk = useSidecarOk();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleTrust = useCallback(async () => {
    if (!sidecarOk || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await acknowledgeMcpTrust(serverKey);
      // Best-effort reprobe — wenn das fehlschlaegt ist die Trust-Entry
      // trotzdem persisitiert, der naechste Watcher-Tick (max 60s) holt
      // den Status nach. Wir geben dem Caller `onAcknowledged` damit er
      // sein UI refreshen kann.
      try {
        await reprobeMcpClient(serverKey);
      } catch {
        // ignore — Tick-Loop wird das in <60s einholen
      }
      onAcknowledged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [sidecarOk, submitting, serverKey, onAcknowledged, onClose]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-target for close
    // biome-ignore lint/a11y/useKeyWithClickEvents: ESC handled on inner panel
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onClose();
        }}
        role="dialog"
        aria-label="MCP-Server vertrauen?"
      >
        <header className="modal-header">
          <h2>MCP-Server vertrauen?</h2>
          <button type="button" className="modal-close" onClick={onClose} title="Schliessen">
            ×
          </button>
        </header>

        <p className="banner banner-warn" role="alert">
          <strong>Sicherheits-Hinweis:</strong> claude-os hat den MCP-Server{' '}
          <code data-testid="mcp-trust-server-key">{serverKey}</code> in deiner Konfiguration
          gefunden, aber noch nicht ausgefuehrt. Erst nach deinem Vertrauen-OK wird das Binary
          gestartet (analog zum Claude-Desktop-Pattern).
        </p>

        <dl className="kv" data-testid="mcp-trust-details">
          <dt>Name</dt>
          <dd>{entry.name}</dd>
          <dt>Host</dt>
          <dd className="muted">{entry.host}</dd>
          <dt>Quelle</dt>
          <dd className="muted ellipsis" title={entry.sourcePath}>
            {entry.sourcePath}
          </dd>
          <dt>Command</dt>
          <dd>
            <code>{entry.command}</code>
          </dd>
          <dt>Args</dt>
          <dd>
            <code>{entry.args.length === 0 ? '(keine)' : entry.args.join(' ')}</code>
          </dd>
        </dl>

        <p className="muted" style={{ fontSize: '11px' }}>
          {message}
        </p>

        {error !== null && (
          <p className="banner banner-error" role="alert">
            {error}
          </p>
        )}

        <footer className="modal-footer">
          <button type="button" onClick={onClose} disabled={submitting}>
            Abbrechen (nicht jetzt)
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!sidecarOk || submitting}
            onClick={handleTrust}
            data-testid="mcp-trust-acknowledge"
          >
            {submitting ? 'Vertraue …' : 'Vertrauen'}
          </button>
        </footer>
      </div>
    </div>
  );
}
