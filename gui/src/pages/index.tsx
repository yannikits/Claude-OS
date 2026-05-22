import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { AuthLoginModal } from '../components/auth-login-modal';
import { SecretAddModal } from '../components/secret-add-modal';
import {
  type AgentListResult,
  activateProfile,
  addScheduleEntry,
  type CatalogInstallAutoDepsResult,
  type CatalogListResult,
  deleteSecret,
  getMcpClientsStatus,
  getSettings,
  getVaultStatus,
  installCatalogAutoDeps,
  listAgentRuns,
  listCatalog,
  listSchedules,
  listSecrets,
  type McpClientsStatusResult,
  onMcpClientEvent,
  onPtyData,
  onPtyExit,
  onSchedulerEvent,
  type PtyDataPayload,
  type PtyExitPayload,
  ping,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
  removeCatalogEntry,
  removeScheduleEntry,
  reprobeMcpClient,
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
  const schedules = useRpc(() => listSchedules());
  const mcpClients = useRpc(() => getMcpClientsStatus());

  // Schedule-Aggregat: enabled vs disabled + nächster Fire
  const scheduleSummary = schedules.data
    ? (() => {
        const enabled = schedules.data.entries.filter((s) => s.enabled).length;
        const disabled = schedules.data.entries.length - enabled;
        // nächste Fire-Zeit aus allen enabled entries (ISO-strings sortierbar)
        const nextFires = schedules.data.entries
          .filter((s) => s.enabled && s.next !== null && s.next !== undefined)
          .map((s) => s.next as string)
          .sort();
        return { enabled, disabled, nextFire: nextFires[0] ?? null };
      })()
    : null;

  // MCP-Health-Aggregat: count pro kind
  const mcpSummary = mcpClients.data
    ? (() => {
        const total = mcpClients.data.entries.length;
        const alive = mcpClients.data.entries.filter((e) => e.result.kind === 'alive').length;
        const issues = total - alive;
        return { total, alive, issues };
      })()
    : null;

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
        <div className="card">
          <h3>Schedule</h3>
          <Status loading={schedules.loading} error={schedules.error} />
          {scheduleSummary && (
            <>
              <p>
                {scheduleSummary.enabled} aktiv · {scheduleSummary.disabled} aus
              </p>
              <p className="muted" style={{ fontSize: '11px' }}>
                {scheduleSummary.nextFire
                  ? `nächste: ${scheduleSummary.nextFire}`
                  : '(keine fällige)'}
              </p>
            </>
          )}
        </div>
        <div className="card">
          <h3>MCP-Clients</h3>
          <Status loading={mcpClients.loading} error={mcpClients.error} />
          {mcpSummary && (
            <p>
              <span className="mcp-status mcp-status--alive">{mcpSummary.alive} alive</span>
              {mcpSummary.issues > 0 && (
                <>
                  {' · '}
                  <span className="mcp-status mcp-status--crashed">
                    {mcpSummary.issues} Problem{mcpSummary.issues === 1 ? '' : 'e'}
                  </span>
                </>
              )}
              {' · '}
              {mcpSummary.total} total
            </p>
          )}
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
  const [removingId, setRemovingId] = useState<string | null>(null);

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

  const handleRemove = useCallback(
    async (id: string) => {
      setRemovingId(id);
      try {
        const result = await removeCatalogEntry(id);
        if (!result.ok) {
          setError(`catalog.removeEntry: ${result.message}`);
        }
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRemovingId(null);
      }
    },
    [reload],
  );

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
                  <th>Aktion</th>
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
                    <td>
                      <button
                        type="button"
                        className="danger"
                        disabled={!sidecarOk || removingId !== null || installing}
                        title={
                          sidecarOk
                            ? 'Entry aus catalog.json entfernen (FS-Files bleiben)'
                            : 'Read-Only-Modus'
                        }
                        onClick={() => {
                          if (window.confirm(`Catalog-Entry "${e.id}" wirklich entfernen?`)) {
                            void handleRemove(e.id);
                          }
                        }}
                      >
                        {removingId === e.id ? '...' : 'Loeschen'}
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

export function ChatPage() {
  const sidecarOk = useSidecarOk();
  const [argsText, setArgsText] = useState('--help');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // xterm.js terminal state — lives in refs so we can re-attach across
  // session lifecycles without remounting the host div.
  const termHostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termWriteHandlerRef = useRef<{ dispose: () => void } | null>(null);

  // Race-Fix carry-over aus v1.2 (PR #55, ChatPage): wir muessen die
  // Tauri-listen()-Promises kennen damit start() vor dem spawn awaitet,
  // sonst koennen pty.exit-Events fuer sehr kurze Spawns verloren gehen.
  const activeSessionIdRef = useRef<string | null>(null);
  const listenersReadyRef = useRef<Promise<unknown> | null>(null);
  // Synchrone Spawn-Guard — verhindert Double-Spawn bei Doppelklick
  // (Codex-Review MEDIUM #4 carry-over).
  const startInFlightRef = useRef(false);

  // Mount xterm.js terminal once. We don't tear it down between sessions
  // (the user can run claude --help, see output, then claude /login in the
  // same terminal — like a real shell experience). The session-specific
  // bindings (onData) are wired/unwired in start()/onExit().
  useEffect(() => {
    if (termHostRef.current === null) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: 13,
      theme: {
        background: '#161618',
        foreground: '#e5e5e5',
        cursor: '#8aa8ff',
      },
      scrollback: 5000,
      convertEol: true,
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(termHostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // ResizeObserver: when the container width/height changes, refit and
    // forward new dimensions to any active PTY session.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // happens during teardown — ignore
      }
      const id = activeSessionIdRef.current;
      if (id !== null) {
        void ptyResize(id, term.cols, term.rows).catch(() => {
          // session already dead — exit handler will fire
        });
      }
    });
    ro.observe(termHostRef.current);

    return () => {
      ro.disconnect();
      termWriteHandlerRef.current?.dispose();
      termWriteHandlerRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Subscribe to pty.data / pty.exit events once. Filter by ref so the
  // listener closure always sees the LATEST session id (avoids re-mounting
  // and the race the v1.2 ChatPage had).
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let cancelled = false;
    const ready = Promise.all([
      onPtyData((p: PtyDataPayload) => {
        if (p.sessionId !== activeSessionIdRef.current) return;
        termRef.current?.write(p.data);
      }),
      onPtyExit((p: PtyExitPayload) => {
        if (p.sessionId !== activeSessionIdRef.current) return;
        // Visual marker in the terminal stream.
        termRef.current?.write(
          `\r\n\x1b[33m[exited code=${p.exitCode ?? 'null'} signal=${p.signal ?? 'null'}]\x1b[0m\r\n`,
        );
        // Tear down the onData -> ptyWrite binding so any stray keystrokes
        // don't try to write into a dead session.
        termWriteHandlerRef.current?.dispose();
        termWriteHandlerRef.current = null;
        setRunning(false);
        setSessionId(null);
        activeSessionIdRef.current = null;
      }),
    ]).then((subs) => {
      if (cancelled) {
        for (const u of subs) u();
        return;
      }
      unsubs.push(...subs);
    });
    listenersReadyRef.current = ready;
    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, []);

  const start = useCallback(async () => {
    if (running || startInFlightRef.current) return;
    startInFlightRef.current = true;
    setStarting(true);
    setError(null);

    const args = argsText.trim().length === 0 ? [] : argsText.trim().split(/\s+/);
    const term = termRef.current;
    if (term === null) {
      startInFlightRef.current = false;
      setStarting(false);
      setError('Terminal noch nicht bereit');
      return;
    }
    // Clear screen + scroll buffer so each spawn starts fresh. xterm's
    // \x1bc is the full-reset ESC sequence.
    term.reset();

    try {
      if (listenersReadyRef.current !== null) {
        await listenersReadyRef.current;
      }
      const { sessionId: newId } = await ptySpawn(args, {
        cols: term.cols,
        rows: term.rows,
      });
      activeSessionIdRef.current = newId;
      setSessionId(newId);
      setRunning(true);
      // Wire xterm keystrokes -> pty.write. Keep the dispose handle so we
      // can clean it up on exit.
      termWriteHandlerRef.current?.dispose();
      termWriteHandlerRef.current = term.onData((data) => {
        // Fire-and-forget; if the session died mid-write, the catch is a
        // no-op (the exit handler already cleaned up).
        void ptyWrite(newId, data).catch(() => {});
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      startInFlightRef.current = false;
      setStarting(false);
    }
  }, [argsText, running]);

  const stop = useCallback(async () => {
    if (sessionId === null) return;
    try {
      await ptyKill(sessionId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      if (/unknown sessionId/i.test(msg)) {
        setSessionId(null);
        setRunning(false);
        activeSessionIdRef.current = null;
      }
    }
  }, [sessionId]);

  /**
   * Reset-Button: clearet LOKAL den GUI-State + Terminal-Screen ohne RPC.
   * Escape-Hatch falls eine Sidecar-Notification verloren ging und die UI
   * im running=true haengt. Carry-over aus v1.2 ChatPage.
   */
  const reset = useCallback(() => {
    termWriteHandlerRef.current?.dispose();
    termWriteHandlerRef.current = null;
    activeSessionIdRef.current = null;
    setSessionId(null);
    setRunning(false);
    setError(null);
    termRef.current?.reset();
    termRef.current?.writeln('\x1b[2m[lokal: state geclearet via Reset]\x1b[0m');
  }, []);

  return (
    <section className="page">
      <h1>Chat</h1>
      <p className="muted">
        Vollwertiges TTY via node-pty + xterm.js. Interaktive Prompts (Login, Passwort, readline)
        funktionieren echt. Window-Resize wird auto-an die PTY-Session propagiert.
      </p>
      {error && <p className="banner banner-error">{error}</p>}
      <div className="chat-controls">
        <input
          type="text"
          className="chat-args"
          placeholder="claude args (z.B. --help oder /login)"
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          disabled={running}
        />
        {running ? (
          <button type="button" className="btn-danger" onClick={stop} disabled={!sidecarOk}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn-primary"
            onClick={start}
            disabled={!sidecarOk || starting}
          >
            {starting ? 'Spawne …' : 'Spawn'}
          </button>
        )}
        <button
          type="button"
          onClick={reset}
          title="Lokal: GUI-State + Terminal clearen ohne RPC (Escape-Hatch wenn die UI haengt)"
        >
          Reset
        </button>
      </div>
      <div className="terminal-host" ref={termHostRef} data-testid="terminal-host" />
    </section>
  );
}

function YesNo({ value }: { value: boolean }) {
  return (
    <span className={value ? 'badge badge-ok' : 'badge badge-muted'}>{value ? 'ja' : 'nein'}</span>
  );
}

export function SettingsPage() {
  const sidecarOk = useSidecarOk();
  const [data, setData] = useState<SettingsReadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [switchingProfile, setSwitchingProfile] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getSettings();
      setData(result);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleProfileSwitch = useCallback(
    async (name: string) => {
      if (data === null || name === data.anthropic.activeProfile) return;
      setSwitchingProfile(true);
      setError(null);
      try {
        await activateProfile(name);
        await reload();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSwitchingProfile(false);
      }
    },
    [data, reload],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleLoginModalClose = useCallback(() => {
    setLoginModalOpen(false);
    // Refetch settings — credentials.json may have been written by login flow.
    void reload();
  }, [reload]);

  return (
    <section className="page">
      <h1>Settings</h1>
      <p className="muted">
        Anthropic-Login + Profile-Switch via GUI. Andere Einstellungen weiterhin per CLI (
        <code>claude-os auth …</code>, <code>claude-os secrets …</code>).
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
            <dd>
              {data.anthropic.availableProfiles.length === 0 ? (
                <span className="muted">
                  (default — keine Profile angelegt;{' '}
                  <code>claude-os auth profile create &lt;name&gt;</code>)
                </span>
              ) : (
                <select
                  className="profile-select"
                  value={data.anthropic.activeProfile ?? ''}
                  onChange={(e) => void handleProfileSwitch(e.target.value)}
                  disabled={!sidecarOk || switchingProfile}
                  title={
                    sidecarOk
                      ? 'Profil wechseln (schreibt auth-active-profile.json)'
                      : 'Sidecar nicht erreichbar — Read-Only-Modus'
                  }
                >
                  {data.anthropic.activeProfile === null && (
                    <option value="" disabled>
                      (kein Profil aktiv)
                    </option>
                  )}
                  {data.anthropic.availableProfiles.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
              {switchingProfile && <span className="muted"> · wechsle …</span>}
            </dd>
            <dt>.credentials.json vorhanden</dt>
            <dd>
              <YesNo value={data.anthropic.credentialsFileExists} />{' '}
              <code className="muted">{data.anthropic.credentialsFile}</code>{' '}
              <button
                type="button"
                className="btn-primary"
                onClick={() => setLoginModalOpen(true)}
                disabled={!sidecarOk}
                title={
                  sidecarOk
                    ? 'Oeffnet claude auth login in einem embedded Terminal'
                    : 'Sidecar nicht erreichbar — Read-Only-Modus'
                }
              >
                {data.anthropic.credentialsFileExists ? 'Neu einloggen' : 'Login'}
              </button>
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
      {loginModalOpen && <AuthLoginModal onClose={handleLoginModalClose} />}
    </section>
  );
}

export function SecretsPage() {
  const [data, setData] = useState<SecretsListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [addModalOpen, setAddModalOpen] = useState(false);
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
        Set/Update via GUI (Wert per Tauri-IPC zum Sidecar). <code>get</code> bleibt CLI-only —
        Werte verlassen niemals den Sidecar in die GUI hinein.
      </p>
      <Status loading={loading} error={error} />
      {actionError && <p className="banner banner-error">{actionError}</p>}
      {data && (
        <>
          <p className="muted">
            Backend: <code>{data.backend}</code> · {data.count} Einträge{' '}
            <button
              type="button"
              className="btn-primary"
              onClick={() => setAddModalOpen(true)}
              disabled={!sidecarOk || data.locked}
              data-testid="secret-add-button"
              title={
                !sidecarOk
                  ? 'Sidecar nicht erreichbar — Read-Only-Modus'
                  : data.locked
                    ? 'Backend gesperrt — Master-Key fehlt'
                    : 'Neues Secret hinzufuegen oder existierendes ueberschreiben'
              }
            >
              + Secret hinzufuegen
            </button>
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
      {addModalOpen && (
        <SecretAddModal
          onClose={() => setAddModalOpen(false)}
          onSaved={() => {
            void refresh();
          }}
        />
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

// ============================================================================
// McpClientsPage (v1.7 Phase B) — Live-Status der konfigurierten MCP-Server
// ============================================================================

export function McpClientsPage() {
  const sidecarOk = useSidecarOk();
  const [data, setData] = useState<McpClientsStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reprobing, setReprobing] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getMcpClientsStatus();
      setData(result);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleReprobe = useCallback(
    async (serverKey: string) => {
      setReprobing(serverKey);
      try {
        await reprobeMcpClient(serverKey);
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setReprobing(null);
      }
    },
    [reload],
  );

  useEffect(() => {
    void reload();
    let unlisten: (() => void) | null = null;
    onMcpClientEvent((evt) => {
      // Auto-Refresh nur bei status-changed oder tick-finished;
      // tick-started/skip-overlap sind reines progress feedback.
      if (evt.type === 'status-changed' || evt.type === 'tick-finished') {
        void reload();
      }
    })
      .then((un) => {
        unlisten = un;
      })
      .catch(() => {
        /* listen failed — log will show via status banner */
      });
    return () => {
      if (unlisten !== null) unlisten();
    };
  }, [reload]);

  return (
    <section className="page">
      <h1>MCP-Clients</h1>
      <Status loading={loading} error={error} />
      {data && (
        <>
          <div className="row" style={{ alignItems: 'center', gap: '8px' }}>
            <p className="muted" style={{ flex: 1 }}>
              {data.count} MCP-Server live geprobt — Watcher tickt alle 60s.
            </p>
            <button type="button" disabled={loading} onClick={reload}>
              {loading ? 'Lade …' : 'Refresh'}
            </button>
          </div>
          {data.entries.length === 0 ? (
            <p className="muted">
              Noch keine MCP-Server entdeckt. Der Watcher tickt alle 60s; sobald die Configs
              eintreffen werden sie hier auftauchen.
            </p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Server</th>
                  <th>Host</th>
                  <th>Status</th>
                  <th>Details</th>
                  <th>Probed</th>
                  <th>Aktion</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((s) => (
                  <tr key={s.key}>
                    <td>{s.entry.name}</td>
                    <td className="muted">{s.entry.host}</td>
                    <td>
                      <span className={`mcp-status mcp-status--${s.result.kind}`}>
                        {s.result.kind}
                      </span>
                    </td>
                    <td className="ellipsis">
                      {s.result.kind === 'alive'
                        ? `${s.result.toolsCount} Tools · ${s.result.durationMs}ms · ${s.result.protocolVersion}`
                        : 'message' in s.result
                          ? s.result.message
                          : s.result.kind === 'crashed'
                            ? `exit=${s.result.exitCode ?? '?'} stderr=${s.result.stderr.slice(0, 80)}`
                            : ''}
                    </td>
                    <td className="muted">{s.probedAt}</td>
                    <td>
                      <button
                        type="button"
                        disabled={!sidecarOk || reprobing !== null}
                        title={
                          sidecarOk
                            ? 'Sofort neu proben statt auf Watcher-Tick warten'
                            : 'Read-Only-Modus'
                        }
                        onClick={() => handleReprobe(s.key)}
                      >
                        {reprobing === s.key ? 'Probe …' : 'Re-Probe'}
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
