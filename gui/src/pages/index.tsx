import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type AgentListResult,
  addScheduleEntry,
  type CatalogInstallAutoDepsResult,
  type CatalogListResult,
  type ChatExitPayload,
  type ChatOutputPayload,
  chatKill,
  chatSpawn,
  chatWrite,
  deleteSecret,
  getSettings,
  getVaultStatus,
  installCatalogAutoDeps,
  listAgentRuns,
  listCatalog,
  listSchedules,
  listSecrets,
  onChatExit,
  onChatOutput,
  onSchedulerEvent,
  ping,
  removeScheduleEntry,
  type ScheduleListResult,
  type SchedulerEventPayload,
  type SecretsListResult,
  type SettingsReadResult,
  setScheduleEnabled,
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
  const sidecarOk = useSidecarOk();
  const [data, setData] = useState<CatalogListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showInstallForm, setShowInstallForm] = useState(false);
  const [formSource, setFormSource] = useState('');
  const [formRegistry, setFormRegistry] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<CatalogInstallAutoDepsResult | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listCatalog();
      setData(result);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleInstall = useCallback(
    async (evt: React.FormEvent) => {
      evt.preventDefault();
      if (formSource.length === 0 || formRegistry.length === 0) return;
      setInstalling(true);
      setInstallResult(null);
      try {
        const result = await installCatalogAutoDeps({
          source: formSource,
          registryPath: formRegistry,
        });
        setInstallResult(result);
        if (result.ok) {
          setFormSource('');
          setShowInstallForm(false);
          await reload();
        }
      } catch (e) {
        setInstallResult({
          ok: false,
          code: 'rpc-error',
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setInstalling(false);
      }
    },
    [formSource, formRegistry, reload],
  );

  return (
    <section className="page">
      <h1>Catalog</h1>
      <Status loading={loading} error={error} />
      {data && (
        <>
          <div className="row" style={{ alignItems: 'center', gap: '8px' }}>
            <p className="muted" style={{ flex: 1 }}>
              {data.catalogPath} · resolved {data.lockResolvedAt ?? '(nie gelockt)'}
            </p>
            <button
              type="button"
              disabled={!sidecarOk || installing}
              title={sidecarOk ? undefined : 'Read-Only-Modus — Sidecar nicht erreichbar'}
              onClick={() => setShowInstallForm((v) => !v)}
            >
              {showInstallForm ? 'Abbrechen' : '+ Install'}
            </button>
            <button type="button" disabled={loading || installing} onClick={reload}>
              {loading ? 'Lade …' : 'Refresh'}
            </button>
          </div>
          {showInstallForm && (
            <form className="schedule-add-form" onSubmit={handleInstall}>
              <label>
                source (github:owner/repo)
                <input
                  type="text"
                  value={formSource}
                  onChange={(e) => setFormSource(e.target.value)}
                  placeholder="github:acme/my-plugin"
                  required
                />
              </label>
              <label>
                registry path (marketplace-registry.json)
                <input
                  type="text"
                  value={formRegistry}
                  onChange={(e) => setFormRegistry(e.target.value)}
                  placeholder="C:\path\to\marketplace.json"
                  required
                />
              </label>
              <button type="submit" disabled={installing || !sidecarOk}>
                {installing ? 'Installiere …' : 'Install mit Auto-Deps'}
              </button>
            </form>
          )}
          {installResult && (
            <div
              className={installResult.ok ? 'banner banner-ok' : 'banner banner-error'}
              style={{ marginBottom: '12px' }}
            >
              {installResult.ok ? (
                <>
                  <strong>
                    [OK] {installResult.target.id}@{installResult.target.version} installiert
                  </strong>
                  <p style={{ margin: '4px 0 0' }}>
                    {installResult.iterations} Iteration{installResult.iterations === 1 ? '' : 'en'}{' '}
                    bis Fixpoint · {installResult.newEntries.length} neue Catalog-Eintrag(e) ·{' '}
                    {installResult.applied} extrahiert ({installResult.skipped} skipped,{' '}
                    {installResult.errors.length} fehlgeschlagen)
                  </p>
                  {installResult.lockWarnings.length > 0 && (
                    <ul style={{ margin: '4px 0 0', paddingLeft: '20px' }}>
                      {installResult.lockWarnings.map((w) => (
                        <li key={w} className="muted">
                          {w}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <>
                  <strong>[FAIL] {installResult.code}</strong>
                  <p style={{ margin: '4px 0 0' }}>{installResult.message}</p>
                </>
              )}
            </div>
          )}
          {data.entries.length === 0 ? (
            <p className="muted">
              Keine Einträge. Über <code>+ Install</code> oder via{' '}
              <code>claude-os catalog install</code> anlegen.
            </p>
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

interface ChatLogEntry {
  readonly id: number;
  readonly stream: 'stdout' | 'stderr' | 'meta';
  readonly text: string;
}

const MAX_LOG_LINES = 500;

export function ChatPage() {
  const sidecarOk = useSidecarOk();
  const [argsText, setArgsText] = useState('--help');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [log, setLog] = useState<ChatLogEntry[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idCounter = useRef(0);
  const logRef = useRef<HTMLDivElement | null>(null);

  const append = useCallback((stream: ChatLogEntry['stream'], text: string) => {
    idCounter.current += 1;
    const nextId = idCounter.current;
    setLog((prev) => {
      const next = [...prev, { id: nextId, stream, text }];
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
    });
  }, []);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    onChatOutput((p: ChatOutputPayload) => {
      if (p.sessionId !== sessionId) return;
      append(p.stream, p.chunk);
    }).then((u) => unsubs.push(u));
    onChatExit((p: ChatExitPayload) => {
      if (p.sessionId !== sessionId) return;
      append('meta', `[exited code=${p.exitCode ?? 'null'} signal=${p.signal ?? 'null'}]\n`);
      setRunning(false);
      setSessionId(null);
    }).then((u) => unsubs.push(u));
    return () => {
      for (const u of unsubs) u();
    };
  }, [sessionId, append]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const start = async () => {
    if (running) return;
    setError(null);
    const args = argsText.trim().length === 0 ? [] : argsText.trim().split(/\s+/);
    setLog([]);
    idCounter.current = 0;
    try {
      const result = await chatSpawn(args);
      setSessionId(result.sessionId);
      setRunning(true);
      append(
        'meta',
        `[spawned session ${result.sessionId.slice(0, 8)}… args=${JSON.stringify(args)}]\n`,
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const send = async () => {
    if (sessionId === null) return;
    const payload = `${input}\n`;
    try {
      await chatWrite(sessionId, payload);
      append('meta', `> ${input}\n`);
      setInput('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const stop = async () => {
    if (sessionId === null) return;
    try {
      await chatKill(sessionId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="page">
      <h1>Chat</h1>
      <p className="muted">
        Line-buffered claude-binary streaming. MVP — keine PTY, daher kein interaktiver
        Passwort-Prompt-Support. Für volle TTY-Features später node-pty + xterm.js (v1.x).
      </p>
      {error && <p className="banner banner-error">{error}</p>}
      <div className="chat-controls">
        <input
          type="text"
          className="chat-args"
          placeholder="claude args (z.B. --help)"
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          disabled={running}
        />
        {running ? (
          <button type="button" className="btn-danger" onClick={stop} disabled={!sidecarOk}>
            Stop
          </button>
        ) : (
          <button type="button" className="btn-primary" onClick={start} disabled={!sidecarOk}>
            Spawn
          </button>
        )}
      </div>
      <div className="chat-log" ref={logRef} data-testid="chat-log">
        {log.length === 0 ? (
          <p className="muted">Noch keine Ausgabe. Klick "Spawn" zum Starten.</p>
        ) : (
          log.map((entry) => (
            <pre key={entry.id} className={`chat-line chat-line-${entry.stream}`}>
              {entry.text}
            </pre>
          ))
        )}
      </div>
      {running && (
        <div className="chat-input-row">
          <input
            type="text"
            className="chat-input"
            placeholder="Eingabe zum stdin (Enter senden)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button type="button" className="btn-primary" onClick={send}>
            Senden
          </button>
        </div>
      )}
    </section>
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

// ============================================================================
// SchedulePage (v1.5 Phase 3) — Schedule-Liste + Live-Event-Stream
// ============================================================================

interface ScheduleLogEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly entryId: string;
  readonly kind: SchedulerEventPayload['type'];
  readonly summary: string;
}

const MAX_SCHEDULE_LOG = 300;

function formatScheduleEvent(e: SchedulerEventPayload): string {
  if (e.type === 'output') return `[${e.stream ?? '?'}] ${e.line ?? ''}`;
  if (e.type === 'fire') return 'fire';
  if (e.type === 'skip-overlap') return `skip-overlap: ${e.message ?? ''}`;
  if (e.type === 'exit') return `exit code=${e.exitCode ?? '?'} signal=${e.signal ?? '-'}`;
  return `parse-error: ${e.message ?? ''}`;
}

export function SchedulePage() {
  const sidecarOk = useSidecarOk();
  // Manueller Lade-State statt useRpc, weil wir nach Mutations re-fetchen wollen
  const [data, setData] = useState<ScheduleListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [formId, setFormId] = useState('');
  const [formCron, setFormCron] = useState('0 8 * * *');
  const [formCommand, setFormCommand] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [logs, setLogs] = useState<ScheduleLogEntry[]>([]);
  const logIdRef = useRef(0);

  const reload = useCallback(async () => {
    setLoading(true);
    setActionError(null);
    try {
      const result = await listSchedules();
      setData(result);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // initial load
  useEffect(() => {
    void reload();
  }, [reload]);

  const handleAdd = useCallback(
    async (evt: React.FormEvent) => {
      evt.preventDefault();
      if (formId.length === 0 || formCron.length === 0 || formCommand.length === 0) {
        setActionError('id, cron und command sind Pflicht.');
        return;
      }
      setActionPending(`add:${formId}`);
      setActionError(null);
      try {
        await addScheduleEntry({
          id: formId,
          cron: formCron,
          command: formCommand,
          ...(formDescription.length === 0 ? {} : { description: formDescription }),
        });
        setFormId('');
        setFormCron('0 8 * * *');
        setFormCommand('');
        setFormDescription('');
        setShowAddForm(false);
        await reload();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setActionPending(null);
      }
    },
    [formId, formCron, formCommand, formDescription, reload],
  );

  const handleRemove = useCallback(
    async (id: string) => {
      setActionPending(`remove:${id}`);
      setActionError(null);
      try {
        await removeScheduleEntry(id);
        await reload();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setActionPending(null);
      }
    },
    [reload],
  );

  const handleToggle = useCallback(
    async (id: string, nextEnabled: boolean) => {
      setActionPending(`toggle:${id}`);
      setActionError(null);
      try {
        await setScheduleEnabled(id, nextEnabled);
        await reload();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setActionPending(null);
      }
    },
    [reload],
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onSchedulerEvent((evt) => {
      logIdRef.current += 1;
      const entry: ScheduleLogEntry = {
        id: logIdRef.current,
        timestamp: evt.timestamp,
        entryId: evt.entryId,
        kind: evt.type,
        summary: formatScheduleEvent(evt),
      };
      setLogs((prev) => {
        const next = [...prev, entry];
        return next.length > MAX_SCHEDULE_LOG ? next.slice(-MAX_SCHEDULE_LOG) : next;
      });
    })
      .then((un) => {
        unlisten = un;
      })
      .catch(() => {
        // listen kann beim Cold-Start fehlschlagen wenn Tauri noch nicht ready ist —
        // der Status-Card zeigt das.
      });
    return () => {
      if (unlisten !== null) unlisten();
    };
  }, []);

  return (
    <section className="page">
      <h1>Schedule</h1>
      <Status loading={loading} error={error} />
      {actionError && <p className="banner banner-error">Aktion fehlgeschlagen: {actionError}</p>}
      {data && (
        <>
          <div className="row" style={{ alignItems: 'center', gap: '8px' }}>
            <p className="muted" style={{ flex: 1 }}>
              {data.count} Eintrag {data.count === 1 ? '' : 'e'} — Runner tickt alle 60s.
            </p>
            <button
              type="button"
              disabled={!sidecarOk || actionPending !== null}
              title={sidecarOk ? undefined : 'Read-Only-Modus — Sidecar nicht erreichbar'}
              onClick={() => setShowAddForm((v) => !v)}
            >
              {showAddForm ? 'Abbrechen' : '+ Neu'}
            </button>
            <button type="button" disabled={loading || actionPending !== null} onClick={reload}>
              {loading ? 'Lade …' : 'Refresh'}
            </button>
          </div>
          {showAddForm && (
            <form className="schedule-add-form" onSubmit={handleAdd}>
              <label>
                id
                <input
                  type="text"
                  value={formId}
                  onChange={(e) => setFormId(e.target.value)}
                  placeholder="morning-sync"
                  required
                />
              </label>
              <label>
                cron
                <input
                  type="text"
                  value={formCron}
                  onChange={(e) => setFormCron(e.target.value)}
                  placeholder="0 8 * * *"
                  required
                />
              </label>
              <label>
                command
                <input
                  type="text"
                  value={formCommand}
                  onChange={(e) => setFormCommand(e.target.value)}
                  placeholder="claude-os vault snapshot"
                  required
                />
              </label>
              <label>
                description (optional)
                <input
                  type="text"
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="Backup vor dem Start"
                />
              </label>
              <button
                type="submit"
                disabled={actionPending !== null || !sidecarOk}
                title={sidecarOk ? undefined : 'Read-Only-Modus'}
              >
                {actionPending?.startsWith('add:') ? 'Lege an …' : 'Hinzufuegen'}
              </button>
            </form>
          )}
          {data.entries.length === 0 ? (
            <p className="muted">
              Noch keine Schedule-Eintraege. Über <code>+ Neu</code> anlegen.
            </p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>id</th>
                  <th>cron</th>
                  <th>command</th>
                  <th>enabled</th>
                  <th>next</th>
                  <th>Aktionen</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((s) => (
                  <tr key={s.id}>
                    <td>{s.id}</td>
                    <td>
                      <code>{s.cron}</code>
                    </td>
                    <td className="ellipsis">{s.command}</td>
                    <td>{s.enabled ? 'on' : 'off'}</td>
                    <td>{s.next ?? '—'}</td>
                    <td className="row" style={{ gap: '4px' }}>
                      <button
                        type="button"
                        disabled={!sidecarOk || actionPending !== null}
                        title={sidecarOk ? undefined : 'Read-Only-Modus'}
                        onClick={() => handleToggle(s.id, !s.enabled)}
                      >
                        {actionPending === `toggle:${s.id}`
                          ? '...'
                          : s.enabled
                            ? 'Deaktivieren'
                            : 'Aktivieren'}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={!sidecarOk || actionPending !== null}
                        title={sidecarOk ? undefined : 'Read-Only-Modus'}
                        onClick={() => {
                          if (window.confirm(`Schedule "${s.id}" wirklich loeschen?`)) {
                            void handleRemove(s.id);
                          }
                        }}
                      >
                        {actionPending === `remove:${s.id}` ? '...' : 'Loeschen'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <h2 style={{ marginTop: '1.5rem' }}>Live-Events</h2>
      {logs.length === 0 ? (
        <p className="muted">
          (noch keine Events — der Runner emittiert <code>fire</code> / <code>output</code> /{' '}
          <code>exit</code> wenn Tasks feuern)
        </p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>timestamp</th>
              <th>entry</th>
              <th>type</th>
              <th>detail</th>
            </tr>
          </thead>
          <tbody>
            {[...logs].reverse().map((log) => (
              <tr key={log.id}>
                <td>{log.timestamp}</td>
                <td>{log.entryId}</td>
                <td>
                  <span className={`schedule-tag schedule-tag--${log.kind}`}>{log.kind}</span>
                </td>
                <td className="ellipsis">{log.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
