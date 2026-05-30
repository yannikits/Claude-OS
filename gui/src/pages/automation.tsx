import { useCallback, useEffect, useState } from 'react';
import {
  type AutomationFiring,
  type AutomationRule,
  type AutomationRuleIssue,
  automationFirings,
  automationRules,
} from '../lib/rpc';
import { useAutoRefresh } from '../lib/use-msp-auto-refresh';

function customersLabel(customers: 'all' | readonly string[]): string {
  return customers === 'all' ? 'alle Kunden' : customers.join(', ');
}

/**
 * Read-only Automation view (Phase MC-B): the currently-loaded rules plus
 * the most recent rule firings. No editing — rules are authored as YAML in
 * the vault; the UI-builder is a later phase.
 */
export function AutomationPage() {
  const [rules, setRules] = useState<readonly AutomationRule[]>([]);
  const [issues, setIssues] = useState<readonly AutomationRuleIssue[]>([]);
  const [firings, setFirings] = useState<readonly AutomationFiring[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rulesRes, firingsRes] = await Promise.all([automationRules(), automationFirings()]);
      setRules(rulesRes.rules);
      setIssues(rulesRes.errors);
      setFirings(firingsRes.firings);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useAutoRefresh(() => void load(), 30);

  return (
    <div className="msp-health-page">
      <header className="msp-health-header">
        <h1>Automation</h1>
        <button
          type="button"
          className="msp-health-control"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? 'Lädt …' : 'Aktualisieren'}
        </button>
      </header>

      {error !== null && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      {issues.length > 0 && (
        <div className="banner banner-error" role="alert">
          {issues.length} Regel-Datei(en) mit Fehlern:{' '}
          {issues.map((i) => `${i.file} (${i.message})`).join('; ')}
        </div>
      )}

      <section>
        <h2>Aktive Regeln ({rules.length})</h2>
        {rules.length === 0 ? (
          <p className="cell-dim">
            Keine Regeln geladen. Lege YAML-Dateien unter <code>Claude-OS/automation/rules/</code>{' '}
            im Vault an.
          </p>
        ) : (
          <table className="msp-health-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Bridge</th>
                <th>Kunden</th>
                <th>Status-Trigger</th>
                <th>Aktionen</th>
                <th>Modus</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.id}
                    {r.enabled === false && <span className="cell-dim"> (deaktiviert)</span>}
                  </td>
                  <td>{r.trigger.bridge}</td>
                  <td>{customersLabel(r.trigger.customers)}</td>
                  <td>{r.condition.statusIn.join(', ')}</td>
                  <td>{r.actions.map((a) => a.type).join(', ')}</td>
                  <td>{r.armed === true ? 'auto' : 'Freigabe'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Letzte Auslösungen ({firings.length})</h2>
        {firings.length === 0 ? (
          <p className="cell-dim">Noch keine Auslösungen seit Server-Start.</p>
        ) : (
          <table className="msp-health-table">
            <thead>
              <tr>
                <th>Zeit</th>
                <th>Regel</th>
                <th>Kunde</th>
                <th>Bridge</th>
                <th>Aktion</th>
              </tr>
            </thead>
            <tbody>
              {firings.map((f) => (
                <tr key={`${f.firedAt}-${f.ruleId}-${f.slug}-${f.action.type}`}>
                  <td>{new Date(f.firedAt).toLocaleString()}</td>
                  <td>{f.ruleId}</td>
                  <td>{f.slug}</td>
                  <td>{f.bridge}</td>
                  <td>
                    {f.action.type}: {f.action.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
