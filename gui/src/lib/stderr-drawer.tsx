/**
 * Stderr-Drawer — collapsible debug-log panel for sidecar stderr.
 *
 * Subscribes to the `sidecar://stderr` Tauri event (emitted by the
 * supervisor in `gui/src-tauri/src/supervisor.rs` for every line the
 * Node sidecar writes to stderr). Lines are appended to a ring buffer
 * (MAX_LINES=200) and rendered in a slide-up drawer that the user can
 * toggle from a floating button in the bottom-right corner.
 *
 * Why: v1.1 wired the event but the renderer had nowhere to surface it.
 * This closes the loop so debugging a misbehaving sidecar doesn't require
 * tailing %APPDATA%/claude-os/logs/sidecar.YYYY-MM-DD.log by hand.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { onSidecarStderr, type SidecarStderrPayload } from './rpc';

const MAX_LINES = 200;

interface StderrLine {
  /** Local-clock ISO timestamp (we don't get the sidecar's pino timestamp). */
  readonly ts: string;
  readonly line: string;
}

export interface StderrDrawerProps {
  /** Optional injection of the subscriber for tests. */
  readonly subscribe?: typeof onSidecarStderr;
}

function appendBounded(prev: StderrLine[], next: StderrLine): StderrLine[] {
  const merged = [...prev, next];
  return merged.length > MAX_LINES ? merged.slice(merged.length - MAX_LINES) : merged;
}

export function StderrDrawer({ subscribe = onSidecarStderr }: StderrDrawerProps): ReactNode {
  const [lines, setLines] = useState<StderrLine[]>([]);
  const [open, setOpen] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    subscribe((payload: SidecarStderrPayload) => {
      if (cancelled) return;
      setLines((prev) => appendBounded(prev, { ts: new Date().toISOString(), line: payload.line }));
    }).then((u) => {
      if (cancelled) {
        u();
        return;
      }
      unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [subscribe]);

  useEffect(() => {
    if (open && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines, open]);

  return (
    <>
      <button
        type="button"
        className="stderr-toggle"
        onClick={() => setOpen((o) => !o)}
        title={open ? 'Drawer einklappen' : 'Sidecar-Stderr-Drawer öffnen'}
        aria-label="Sidecar Stderr Drawer toggle"
      >
        <span className="stderr-toggle-label">stderr</span>
        <span className="stderr-toggle-count">{lines.length}</span>
      </button>
      {open && (
        <aside className="stderr-drawer" aria-label="Sidecar Stderr Log">
          <header className="stderr-drawer-header">
            <strong>Sidecar Stderr</strong>
            <span className="muted">
              {lines.length}/{MAX_LINES} Zeilen
            </span>
            <span className="stderr-drawer-actions">
              <button type="button" onClick={() => setLines([])} className="stderr-clear">
                Leeren
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Drawer schließen"
                className="stderr-close"
              >
                ✕
              </button>
            </span>
          </header>
          <div className="stderr-drawer-log" ref={logRef} data-testid="stderr-drawer-log">
            {lines.length === 0 ? (
              <p className="muted">Noch keine Stderr-Lines empfangen.</p>
            ) : (
              lines.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: append-only ring buffer; ts+i is stable for the rendered lifetime
                <div key={`${l.ts}-${i}`} className="stderr-line">
                  <span className="stderr-line-ts">{l.ts.slice(11, 23)}</span>
                  <span className="stderr-line-text">{l.line}</span>
                </div>
              ))
            )}
          </div>
        </aside>
      )}
    </>
  );
}
