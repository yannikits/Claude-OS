/**
 * Modal mit embedded xterm.js Terminal fuer den Anthropic-Login-Flow.
 *
 * Spawnt `claude auth login` via `auth.login` RPC (intern PtyChatSessions
 * mit profile-aware ANTHROPIC_CONFIG_DIR). User interagiert direkt mit
 * dem PTY — der echte OAuth-Flow oeffnet den OS-Browser, wartet auf
 * Callback, schreibt `.credentials.json`. Modal auto-zeigt Exit-Status,
 * close-Button laesst User raus + triggert refetch.
 *
 * @module gui/components/auth-login-modal
 */
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  authLogin,
  onPtyData,
  onPtyExit,
  type PtyDataPayload,
  type PtyExitPayload,
  ptyKill,
  ptyResize,
  ptyWrite,
} from '../lib/rpc';

export interface AuthLoginModalProps {
  readonly onClose: () => void;
}

export function AuthLoginModal({ onClose }: AuthLoginModalProps) {
  const termHostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writeHandlerRef = useRef<{ dispose: () => void } | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const listenersReadyRef = useRef<Promise<unknown> | null>(null);
  const spawnInFlightRef = useRef(false);

  const [exitInfo, setExitInfo] = useState<{ code: number | null; signal: string | null } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  // Mount terminal once. Carry-over pattern aus ChatPage (ADR-0021).
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
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(termHostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // teardown — ignore
      }
      const id = activeSessionIdRef.current;
      if (id !== null) {
        void ptyResize(id, term.cols, term.rows).catch(() => {});
      }
    });
    ro.observe(termHostRef.current);

    return () => {
      ro.disconnect();
      writeHandlerRef.current?.dispose();
      writeHandlerRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Subscribe pty.data + pty.exit, filter by activeSessionIdRef.
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
        termRef.current?.write(
          `\r\n\x1b[33m[login process exited code=${p.exitCode ?? 'null'} signal=${p.signal ?? 'null'}]\x1b[0m\r\n`,
        );
        writeHandlerRef.current?.dispose();
        writeHandlerRef.current = null;
        setExitInfo({ code: p.exitCode, signal: p.signal });
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

  // Auto-spawn auth.login on mount (after terminal is ready).
  useEffect(() => {
    if (spawnInFlightRef.current) return;
    spawnInFlightRef.current = true;
    const term = termRef.current;
    if (term === null) {
      spawnInFlightRef.current = false;
      return;
    }
    (async () => {
      try {
        if (listenersReadyRef.current !== null) {
          await listenersReadyRef.current;
        }
        const { sessionId } = await authLogin({ cols: term.cols, rows: term.rows });
        activeSessionIdRef.current = sessionId;
        writeHandlerRef.current?.dispose();
        writeHandlerRef.current = term.onData((data) => {
          void ptyWrite(sessionId, data).catch(() => {});
        });
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const handleClose = useCallback(() => {
    // If the login is still running, kill it before closing.
    const id = activeSessionIdRef.current;
    if (id !== null) {
      void ptyKill(id).catch(() => {});
    }
    onClose();
  }, [onClose]);

  const exitSuccessful = exitInfo !== null && exitInfo.code === 0;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is intentionally a click-target for click-outside-to-close; the inner panel is the actual dialog with proper role.
    // biome-ignore lint/a11y/useKeyWithClickEvents: ESC-handling is on the inner panel (focus-trap); backdrop only handles mouse clicks.
    <div className="modal-backdrop" onClick={handleClose}>
      <div
        className="modal-panel"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') handleClose();
        }}
        role="dialog"
        aria-label="Anthropic Login"
      >
        <header className="modal-header">
          <h2>Anthropic Login</h2>
          <button
            type="button"
            className="modal-close"
            onClick={handleClose}
            title="Schliessen (laufender Login wird abgebrochen)"
          >
            ×
          </button>
        </header>
        <p className="muted">
          <code>claude auth login</code> startet OAuth-Flow im OS-Browser. Eingaben unten gehen
          direkt in die PTY-Session.
        </p>
        {error !== null && <p className="banner banner-error">{error}</p>}
        <div className="modal-terminal-host" ref={termHostRef} data-testid="auth-terminal-host" />
        {exitInfo !== null && (
          <p
            className={exitSuccessful ? 'banner banner-ok' : 'banner banner-error'}
            data-testid="auth-exit-banner"
          >
            {exitSuccessful
              ? 'Login erfolgreich abgeschlossen. Schliesse das Fenster um Settings zu aktualisieren.'
              : `Login mit Exit-Code ${exitInfo.code ?? 'null'} beendet. Du kannst das Fenster schliessen und es erneut versuchen.`}
          </p>
        )}
        <footer className="modal-footer">
          <button type="button" className="btn-primary" onClick={handleClose}>
            {exitSuccessful ? 'Fertig' : 'Schliessen'}
          </button>
        </footer>
      </div>
    </div>
  );
}
