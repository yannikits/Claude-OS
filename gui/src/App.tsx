import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import {
  importToInbox,
  onFilesDropped,
  onInboxChanged,
  onOutboxChanged,
  onSidecarFailed,
  ping,
  type SidecarFailedPayload,
  type WatcherChangeEvent,
} from './lib/rpc';
import { SidecarStatusProvider } from './lib/sidecar-status';
import { StderrDrawer } from './lib/stderr-drawer';
import {
  AgentRunsPage,
  CatalogPage,
  ChatPage,
  Dashboard,
  McpClientsPage,
  SchedulePage,
  SecretsPage,
  SettingsPage,
  VaultPage,
} from './pages';

const NAV = [
  { to: '/', label: 'Dashboard' },
  { to: '/chat', label: 'Chat' },
  { to: '/catalog', label: 'Catalog' },
  { to: '/vault', label: 'Vault' },
  { to: '/agent-runs', label: 'Agent Runs' },
  { to: '/schedule', label: 'Schedule' },
  { to: '/mcp-clients', label: 'MCP-Clients' },
  { to: '/secrets', label: 'Secrets' },
  { to: '/settings', label: 'Settings' },
] as const;

function Layout() {
  return (
    <div className="app">
      <aside className="sidebar">
        <Link to="/" className="brand">
          claude-os
        </Link>
        <nav>
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="loading">
      <div className="spinner" />
      <p>claude-os startet …</p>
    </div>
  );
}

function SidecarFailedBanner({ payload }: { payload: SidecarFailedPayload }) {
  return (
    <div className="banner banner-error" role="alert">
      <strong>Sidecar nicht verfügbar</strong>
      <span>
        {payload.reason} (nach {payload.strikes} Versuchen). UI läuft im Read-Only-Modus.
      </span>
    </div>
  );
}

const BANNER_TTL_MS = 5_000;

export function App() {
  const [showLoading, setShowLoading] = useState(true);
  const [failure, setFailure] = useState<SidecarFailedPayload | null>(null);
  const [lastInbox, setLastInbox] = useState<WatcherChangeEvent | null>(null);
  const [lastOutbox, setLastOutbox] = useState<WatcherChangeEvent | null>(null);
  const [lastDrop, setLastDrop] = useState<{ count: number; ts: number } | null>(null);
  const failureRef = useRef<SidecarFailedPayload | null>(null);
  failureRef.current = failure;

  // Poll ping() until sidecar is ready (supervisor spawns the sidecar in
  // setup() but it takes ~1-2s; fixed 500ms grace was a race that left
  // Dashboard mounted before any RPC could succeed). Hard cap at 15s so
  // the SidecarFailedBanner still gets a chance to render if 3-strikes
  // gives up.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = Date.now();
    const MAX_WAIT_MS = 15_000;
    const tick = async () => {
      if (cancelled) return;
      try {
        await ping();
        setShowLoading(false);
      } catch {
        if (Date.now() - start > MAX_WAIT_MS) {
          setShowLoading(false);
          return;
        }
        timer = setTimeout(tick, 250);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!lastDrop) return;
    const t = setTimeout(() => setLastDrop(null), BANNER_TTL_MS);
    return () => clearTimeout(t);
  }, [lastDrop]);

  useEffect(() => {
    if (!lastInbox) return;
    const t = setTimeout(() => setLastInbox(null), BANNER_TTL_MS);
    return () => clearTimeout(t);
  }, [lastInbox]);

  useEffect(() => {
    if (!lastOutbox) return;
    const t = setTimeout(() => setLastOutbox(null), BANNER_TTL_MS);
    return () => clearTimeout(t);
  }, [lastOutbox]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    onSidecarFailed(setFailure).then((u) => unsubs.push(u));
    onInboxChanged(setLastInbox).then((u) => unsubs.push(u));
    onOutboxChanged(setLastOutbox).then((u) => unsubs.push(u));
    onFilesDropped(async ({ paths }) => {
      // Hard-gate against the read-only mode: if the supervisor has emitted
      // sidecar://failed there's no point firing inbox.import — the RPC
      // would just error and clutter logs. Drop the event silently and let
      // the banner explain why nothing happened.
      if (failureRef.current !== null) return;
      try {
        const r = await importToInbox(paths);
        setLastDrop({ count: r.count, ts: Date.now() });
      } catch (e) {
        console.error('inbox.import failed:', e);
      }
    }).then((u) => unsubs.push(u));
    return () => {
      for (const u of unsubs) u();
    };
  }, []);

  if (showLoading) return <LoadingScreen />;

  return (
    <SidecarStatusProvider failure={failure}>
      <Router>
        <div className="app-root">
          {failure && <SidecarFailedBanner payload={failure} />}
          {lastDrop && (
            <div className="banner" role="status" key={lastDrop.ts}>
              {lastDrop.count} Datei(en) in den Inbox kopiert.
            </div>
          )}
          {(lastInbox || lastOutbox) && (
            <div className="banner muted" role="status">
              {lastInbox && (
                <span>
                  inbox: {lastInbox.event} {lastInbox.path}
                </span>
              )}
              {lastOutbox && (
                <span>
                  {' '}
                  · outbox: {lastOutbox.event} {lastOutbox.path}
                </span>
              )}
            </div>
          )}
          <Routes>
            <Route path="/" element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="chat" element={<ChatPage />} />
              <Route path="catalog" element={<CatalogPage />} />
              <Route path="vault" element={<VaultPage />} />
              <Route path="agent-runs" element={<AgentRunsPage />} />
              <Route path="schedule" element={<SchedulePage />} />
              <Route path="mcp-clients" element={<McpClientsPage />} />
              <Route path="secrets" element={<SecretsPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
          </Routes>
          <StderrDrawer />
        </div>
      </Router>
    </SidecarStatusProvider>
  );
}
