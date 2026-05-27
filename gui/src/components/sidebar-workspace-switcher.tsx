/**
 * Sidebar-Workspace-Switcher — MSP-D (per three-brain plan 2026-05-27).
 *
 * Kompakte Variante des `WorkspaceIndicator`, sichtbar in der Sidebar
 * auf JEDER Page. Klick öffnet ein Dropdown mit allen verfügbaren
 * Workspaces; Auswahl ruft `workspace.activate` + refreshed via
 * `workspace://switched`-Event.
 *
 * Yannik wechselt typisch 5-10× pro Tag zwischen Customer-Workspaces.
 * Sichtbarkeit auf jeder Page macht den Switch zu einem 1-Click-Move
 * statt einem Settings-Page-Detour.
 *
 * Multi-Tenant safety: dieselbe RPC-Surface wie der existing
 * Indicator — kein neuer Code-Pfad. Source-of-Truth ist das Sidecar.
 *
 * @module gui/components/sidebar-workspace-switcher
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getWorkspaceCurrent,
  getWorkspaceList,
  onWorkspaceSwitched,
  switchWorkspace,
  type WorkspaceCurrent,
  type WorkspaceEntry,
} from '../lib/rpc';

interface State {
  current: WorkspaceCurrent | null;
  workspaces: WorkspaceEntry[];
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: State = {
  current: null,
  workspaces: [],
  loading: true,
  error: null,
};

const MSP_CUSTOMER_PREFIX = 'msp-customers/';

function shortLabel(id: string): string {
  if (id.startsWith(MSP_CUSTOMER_PREFIX)) return id.slice(MSP_CUSTOMER_PREFIX.length);
  if (id === 'msp-internal') return 'MSP-Intern';
  if (id === 'personal') return 'Persönlich';
  return id;
}

function colorClass(id: string): string {
  if (id.startsWith(MSP_CUSTOMER_PREFIX)) return 'workspace-switcher--customer';
  if (id === 'msp-internal') return 'workspace-switcher--internal';
  if (id === '_unsorted') return 'workspace-switcher--warning';
  return 'workspace-switcher--personal';
}

export function SidebarWorkspaceSwitcher() {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const [switching, setSwitching] = useState(false);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [current, list] = await Promise.all([getWorkspaceCurrent(), getWorkspaceList()]);
      setState({ current, workspaces: list.workspaces, loading: false, error: null });
    } catch (err) {
      setState({
        current: null,
        workspaces: [],
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    void onWorkspaceSwitched(() => {
      void refresh();
    }).then((u) => {
      unsub = u;
    });
    return () => {
      unsub?.();
    };
  }, [refresh]);

  // Close dropdown on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        buttonRef.current !== null &&
        !buttonRef.current.contains(target) &&
        menuRef.current !== null &&
        !menuRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleSwitch = useCallback(
    async (id: string) => {
      if (state.current?.active === id) {
        setOpen(false);
        return;
      }
      setSwitching(true);
      setOpen(false);
      try {
        await switchWorkspace(id);
        await refresh();
      } catch (err) {
        setState((s) => ({
          ...s,
          error: err instanceof Error ? err.message : String(err),
        }));
      } finally {
        setSwitching(false);
      }
    },
    [state.current?.active, refresh],
  );

  if (state.loading) {
    return (
      <div className="workspace-switcher workspace-switcher--loading">
        <span className="workspace-switcher__label">Workspace</span>
        <span className="workspace-switcher__value">…</span>
      </div>
    );
  }

  if (state.error !== null || state.current === null) {
    return (
      <div
        className="workspace-switcher workspace-switcher--error"
        title={state.error ?? 'Workspace nicht konfiguriert'}
      >
        <span className="workspace-switcher__label">Workspace</span>
        <span className="workspace-switcher__value">⚠ nicht konfig.</span>
      </div>
    );
  }

  const activeId = state.current.active;
  const activeColorClass = colorClass(activeId);

  return (
    <div className={`workspace-switcher ${activeColorClass}`}>
      <span className="workspace-switcher__label">Workspace</span>
      <button
        ref={buttonRef}
        type="button"
        className="workspace-switcher__button"
        onClick={() => setOpen((v) => !v)}
        disabled={switching}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Aktiv: ${activeId} · klicken zum wechseln`}
      >
        <span className="workspace-switcher__value">{shortLabel(activeId)}</span>
        <span className="workspace-switcher__chevron" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open && (
        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: listbox role with li/button children is the canonical select-replacement pattern (children are the interactive elements; the ul is just the container)
        <ul ref={menuRef} className="workspace-switcher__menu" role="listbox">
          {state.workspaces.map((w) => {
            const isActive = w.id === activeId;
            return (
              <li
                key={w.id}
                className={`workspace-switcher__item ${colorClass(w.id)} ${
                  isActive ? 'workspace-switcher__item--active' : ''
                }`}
              >
                <button
                  type="button"
                  onClick={() => void handleSwitch(w.id)}
                  disabled={isActive || switching}
                  aria-current={isActive ? 'true' : undefined}
                >
                  <span className="workspace-switcher__item-label">{shortLabel(w.id)}</span>
                  <span className="workspace-switcher__item-id">{w.id}</span>
                  {w.path === null && (
                    <span className="workspace-switcher__item-hint">not-yet-created</span>
                  )}
                </button>
              </li>
            );
          })}
          {!state.workspaces.some((w) => w.id === activeId) && (
            <li
              className={`workspace-switcher__item ${activeColorClass} workspace-switcher__item--active`}
            >
              <button type="button" disabled>
                <span className="workspace-switcher__item-label">{shortLabel(activeId)}</span>
                <span className="workspace-switcher__item-id">{activeId}</span>
                <span className="workspace-switcher__item-hint">orphan</span>
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
