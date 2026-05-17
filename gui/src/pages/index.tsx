import { useEffect, useState } from 'react';
import {
  type AgentListResult,
  type CatalogListResult,
  getVaultStatus,
  listAgentRuns,
  listCatalog,
  ping,
  type VaultStatusResult,
} from '../lib/rpc';

function useRpc<T>(fetcher: () => Promise<T>): {
  data: T | null;
  error: string | null;
  loading: boolean;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fetcher identity is stable per page mount; deps array intentionally empty so the fetch fires exactly once per mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetcher()
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, error, loading };
}

function Status({ error, loading }: { error: string | null; loading: boolean }) {
  if (loading) return <p className="muted">Lade …</p>;
  if (error) return <p className="banner banner-error">RPC-Fehler: {error}</p>;
  return null;
}

export function Dashboard() {
  const pingResult = useRpc(() => ping());
  const catalog = useRpc(() => listCatalog());
  const vault = useRpc(() => getVaultStatus());
  const agents = useRpc(() => listAgentRuns({ limit: 1 }));

  return (
    <section className="page">
      <h1>Dashboard</h1>
      <div className="cards">
        <div className="card">
          <h3>Sidecar</h3>
          <Status loading={pingResult.loading} error={pingResult.error} />
          {pingResult.data && <p>OK — ts {pingResult.data.ts}</p>}
        </div>
        <div className="card">
          <h3>Catalog</h3>
          <Status loading={catalog.loading} error={catalog.error} />
          {catalog.data && <p>{catalog.data.entries.length} Einträge</p>}
        </div>
        <div className="card">
          <h3>Vault</h3>
          <Status loading={vault.loading} error={vault.error} />
          {vault.data && (
            <p>
              {vault.data.config.conflictMode} · busy={vault.data.busy === null ? 'no' : 'yes'}
            </p>
          )}
        </div>
        <div className="card">
          <h3>Agent Runs</h3>
          <Status loading={agents.loading} error={agents.error} />
          {agents.data && <p>{agents.data.count} aufgezeichnet</p>}
        </div>
      </div>
    </section>
  );
}

export function CatalogPage() {
  const { data, error, loading } = useRpc<CatalogListResult>(() => listCatalog());
  return (
    <section className="page">
      <h1>Catalog</h1>
      <Status loading={loading} error={error} />
      {data && (
        <>
          <p className="muted">
            {data.catalogPath} · resolved {data.lockResolvedAt ?? '(nie gelockt)'}
          </p>
          {data.entries.length === 0 ? (
            <p className="muted">Keine Einträge.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>id</th>
                  <th>kind</th>
                  <th>scope</th>
                  <th>enabled</th>
                  <th>source</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={`${e.scope}:${e.id}`}>
                    <td>{e.id}</td>
                    <td>{e.kind}</td>
                    <td>{e.scope}</td>
                    <td>{e.enabled ? 'yes' : 'no'}</td>
                    <td className="ellipsis">{e.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

export function VaultPage() {
  const { data, error, loading } = useRpc<VaultStatusResult>(() => getVaultStatus());
  return (
    <section className="page">
      <h1>Vault</h1>
      <Status loading={loading} error={error} />
      {data && (
        <dl className="kv">
          <dt>Pfad</dt>
          <dd>
            <code>{data.vaultPath}</code>
          </dd>
          <dt>Conflict mode</dt>
          <dd>{data.config.conflictMode}</dd>
          <dt>Schedule</dt>
          <dd>
            {data.config.scheduleEnabled ? 'aktiv' : 'aus'} (idle {data.config.idleSeconds}s)
          </dd>
          <dt>Busy</dt>
          <dd>
            {data.busy === null
              ? 'frei'
              : `${data.busy.reason} (host=${data.busy.hostname}, pid=${data.busy.pid}, seit ${data.busy.acquiredAt})`}
          </dd>
        </dl>
      )}
    </section>
  );
}

export function AgentRunsPage() {
  const { data, error, loading } = useRpc<AgentListResult>(() => listAgentRuns({ limit: 50 }));
  return (
    <section className="page">
      <h1>Agent Runs</h1>
      <Status loading={loading} error={error} />
      {data && (
        <>
          <p className="muted">{data.count} Einträge (letzte 50)</p>
          {data.items.length === 0 ? (
            <p className="muted">Noch keine Runs aufgezeichnet.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>timestamp</th>
                  <th>project</th>
                  <th>machine</th>
                  <th>prompt</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.runId}>
                    <td>{r.timestamp}</td>
                    <td>{r.project}</td>
                    <td>{r.machineId}</td>
                    <td className="ellipsis">{r.prompt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

function Stub({ title, hint }: { title: string; hint: string }) {
  return (
    <section className="page">
      <h1>{title}</h1>
      <p className="muted">{hint}</p>
    </section>
  );
}

export function ChatPage() {
  return (
    <Stub
      title="Chat"
      hint="claude.exe-Wrapper kommt in einer 6f-tail Iteration — der Chat braucht PTY-Streaming (claude-bridge spawn → renderer xterm.js)."
    />
  );
}

export function SettingsPage() {
  return (
    <Stub
      title="Settings"
      hint="settings.local.json + Anthropic-config-dir surface wired in der 6f-tail. Aktuell nur Anzeige geplant — Mutation per CLI."
    />
  );
}

export function SecretsPage() {
  return (
    <Stub
      title="Secrets"
      hint="secrets.list RPC kommt in 6f-tail. Values bleiben out-of-band — UI listet nur Namen."
    />
  );
}
