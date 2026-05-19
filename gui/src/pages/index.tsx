import { useCallback, useEffect, useState } from 'react';
import {
  type AgentListResult,
  type CatalogListResult,
  deleteSecret,
  getSettings,
  getVaultStatus,
  listAgentRuns,
  listCatalog,
  listSecrets,
  ping,
  type SecretsListResult,
  type SettingsReadResult,
  type VaultStatusResult,
} from '../lib/rpc';
import { useSidecarOk } from '../lib/sidecar-status';

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

function YesNo({ value }: { value: boolean }) {
  return (
    <span className={value ? 'badge badge-ok' : 'badge badge-muted'}>{value ? 'ja' : 'nein'}</span>
  );
}

export function SettingsPage() {
  const { data, error, loading } = useRpc<SettingsReadResult>(() => getSettings());
  return (
    <section className="page">
      <h1>Settings</h1>
      <p className="muted">
        Read-only Anzeige. Änderungen aktuell nur per CLI (<code>claude-os auth …</code>,{' '}
        <code>claude-os secrets …</code>).
      </p>
      <Status loading={loading} error={error} />
      {data && (
        <>
          <h2>Anthropic Setup</h2>
          <dl className="kv">
            <dt>Config-Verzeichnis</dt>
            <dd>
              <code>{data.anthropic.resolvedConfigDir}</code>
            </dd>
            <dt>$ANTHROPIC_CONFIG_DIR</dt>
            <dd>{data.anthropic.envOverride ?? <span className="muted">(unset)</span>}</dd>
            <dt>Aktives Profil</dt>
            <dd>{data.anthropic.activeProfile ?? <span className="muted">(default)</span>}</dd>
            <dt>Verfügbare Profile</dt>
            <dd>
              {data.anthropic.availableProfiles.length === 0 ? (
                <span className="muted">keine</span>
              ) : (
                data.anthropic.availableProfiles.map((p) => (
                  <span key={p.name} className={p.active ? 'badge badge-ok' : 'badge badge-muted'}>
                    {p.name}
                  </span>
                ))
              )}
            </dd>
            <dt>.credentials.json vorhanden</dt>
            <dd>
              <YesNo value={data.anthropic.credentialsFileExists} />{' '}
              <code className="muted">{data.anthropic.credentialsFile}</code>
            </dd>
          </dl>

          <h2>Secrets-Backend</h2>
          <dl className="kv">
            <dt>Aktives Backend</dt>
            <dd>
              <code>{data.secrets.backend}</code>
            </dd>
            <dt>$CLAUDE_OS_SECRETS_BACKEND</dt>
            <dd>{data.secrets.envOverride ?? <span className="muted">(unset)</span>}</dd>
          </dl>

          <h2>Claude-Code-Settings</h2>
          <p className="muted">
            Informationell — diese Dateien gehören zu Claude-Code, nicht zu claude-os. Wird nur die
            Existenz angezeigt, keine Inhalte.
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>scope</th>
                <th>name</th>
                <th>vorhanden</th>
                <th>Größe</th>
                <th>geändert</th>
                <th>Pfad</th>
              </tr>
            </thead>
            <tbody>
              {data.claudeCodeSettings.map((f) => (
                <tr key={`${f.scope}:${f.name}`}>
                  <td>{f.scope}</td>
                  <td>{f.name}</td>
                  <td>
                    <YesNo value={f.exists} />
                  </td>
                  <td>{f.size === null ? '—' : `${f.size} B`}</td>
                  <td>{f.mtime ?? '—'}</td>
                  <td className="ellipsis">{f.path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

export function SecretsPage() {
  const [data, setData] = useState<SecretsListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const sidecarOk = useSidecarOk();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listSecrets();
      setData(result);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleDelete(key: string) {
    if (!window.confirm(`Secret "${key}" wirklich löschen?`)) return;
    setPendingDelete(key);
    setActionError(null);
    try {
      const result = await deleteSecret(key);
      if (!result.deleted) {
        setActionError(`Secret "${key}" wurde nicht gefunden (möglicherweise bereits gelöscht).`);
      }
      await refresh();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingDelete(null);
    }
  }

  return (
    <section className="page">
      <h1>Secrets</h1>
      <p className="muted">
        Nur Namen — Values bleiben out-of-band. <code>set</code> / <code>get</code> nur per CLI (
        <code>claude-os secrets set &lt;key&gt;</code>).
      </p>
      <Status loading={loading} error={error} />
      {actionError && <p className="banner banner-error">{actionError}</p>}
      {data && (
        <>
          <p className="muted">
            Backend: <code>{data.backend}</code> · {data.count} Einträge
          </p>
          {data.locked ? (
            <p className="banner banner-error">
              Backend gesperrt — Master-Key fehlt. Setze die Env-Var{' '}
              <code>CLAUDE_OS_SECRETS_KEY</code> bevor du die App startest, oder verwalte Secrets
              per CLI (<code>claude-os secrets set/get/list</code>).
              {data.lockedReason && (
                <>
                  <br />
                  <span className="muted">Details: {data.lockedReason}</span>
                </>
              )}
            </p>
          ) : data.entries.length === 0 ? (
            <p className="muted">Keine Secrets gespeichert.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>key</th>
                  <th>backend</th>
                  <th>Aktion</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((s) => (
                  <tr key={s.key}>
                    <td>
                      <code>{s.key}</code>
                    </td>
                    <td>{s.backend}</td>
                    <td>
                      <button
                        type="button"
                        className="btn-danger"
                        disabled={pendingDelete === s.key || !sidecarOk}
                        title={sidecarOk ? undefined : 'Read-Only-Modus — Sidecar nicht erreichbar'}
                        onClick={() => handleDelete(s.key)}
                      >
                        {pendingDelete === s.key ? 'Lösche …' : 'Löschen'}
                      </button>
                    </td>
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
