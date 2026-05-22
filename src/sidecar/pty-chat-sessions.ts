/**
 * PTY-basierte Chat-Sessions (v1.x).
 *
 * Ablöser fuer die line-buffered `ChatSessions` aus `chat-sessions.ts`
 * (v1.2 MVP, PR #29). Statt `child_process.spawn` mit gepipeden stdio
 * benutzen wir hier `node-pty.spawn()` — echtes ConPTY/UnixPTY mit
 * TTY-detection, ANSI-Cursor-Control und Resize-Support.
 *
 * Was das ueber das MVP hinaus loest:
 *  - Interaktive Prompts (`claude /login`, sudo-Passwort, readline)
 *  - ANSI-Cursor-Control + Farben kommen 1:1 durch
 *  - PTY-Resize via `chat.resize` RPC
 *  - Single combined data-stream (PTY merged stdout/stderr — kein eigener
 *    stream-typ-Diskriminator mehr)
 *
 * Was bewusst unveraendert bleibt:
 *  - MAX_SESSIONS = 8 ring-guard
 *  - M1-Defense (Shell-Metachar-args refused bei `.cmd`/`.bat`-Wrappern)
 *  - m13: `CLAUDE_OS_SECRETS_KEY` aus child-env strippen
 *  - SIGTERM-with-2s-SIGKILL-fallback bei kill()
 *
 * Spike-validated: `useConptyDll: true` umgeht node-ptys internen
 * `child_process.fork('conpty_console_list_agent')` der unter pkg-Bundles
 * nicht funktioniert (Helper-Process kann nicht re-spawn'en).
 *
 * RPC surface (registered in src/sidecar/methods/pty.ts):
 *   pty.spawn({args: string[], cols?: number, rows?: number})
 *     -> {sessionId: string}
 *   pty.write({sessionId, input: string}) -> {ok: true}
 *   pty.resize({sessionId, cols: number, rows: number}) -> {ok: true}
 *   pty.kill({sessionId}) -> {ok: true}
 *
 * Notification emissions:
 *   method: "pty.data"  params: {sessionId, data: string}
 *   method: "pty.exit"  params: {sessionId, exitCode: number|null,
 *                                signal: string|null}
 *
 * @module @sidecar/pty-chat-sessions
 */
import { randomUUID } from 'node:crypto';
import type { IPty } from 'node-pty';
import { resolveRoot } from '../core/environment/index.js';
import { BinaryNotFoundError, resolveClaudeBinary } from '../domains/claude-bridge/index.js';
import { loadNodePty } from './pty-binding-loader.js';

const KILL_GRACE_MS = 2_000;
const MAX_SESSIONS = 8;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * M1 (carry-over aus chat-sessions.ts:46): wenn die claude-binary
 * `.cmd`/`.bat` ist (Windows-Wrapper) und wir shell:true setzen
 * muessten, escape Node 20+ args via CVE-2024-27980-Fix. node-pty
 * forkt direkt ohne shell-flag — aber wir wollen die Args-Hygiene
 * trotzdem behalten als Defense-in-depth fuer den Fall dass jemand
 * jemals shell-arg-injection via Wrapper-`.bat` versucht.
 */
const SHELL_INJECTION_METACHARS = /[&|<>"`^]/;

export class PtyChatSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PtyChatSessionError';
  }
}

interface PtySession {
  readonly id: string;
  readonly pty: IPty;
  killTimer: NodeJS.Timeout | null;
}

export type PtyNotificationEmitter = (method: string, params: unknown) => void;

export interface PtySpawnOpts {
  readonly cols?: number;
  readonly rows?: number;
  /**
   * Additional env-vars merged into the child process env. Wird NACH der
   * `CLAUDE_OS_SECRETS_KEY`-strip applied, sodass eine versehentliche
   * Wiedereinfuehrung des secrets-keys via envOverrides moeglich waere —
   * Caller-Verantwortung das nicht zu tun. Verwendet von `auth.login`
   * fuer `ANTHROPIC_CONFIG_DIR` (profile-aware).
   */
  readonly envOverrides?: Readonly<Record<string, string>>;
}

export class PtyChatSessions {
  private readonly sessions = new Map<string, PtySession>();
  private readonly nodePty: typeof import('node-pty');

  constructor(private readonly emit: PtyNotificationEmitter) {
    this.nodePty = loadNodePty();
  }

  spawn(args: readonly string[], opts: PtySpawnOpts = {}): { sessionId: string } {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(
        `pty.spawn: too many active sessions (${this.sessions.size}/${MAX_SESSIONS}); kill some first`,
      );
    }

    let rootPath: string | undefined;
    try {
      rootPath = resolveRoot({}).path;
    } catch {
      // root not resolvable — resolveClaudeBinary will still try $PATH
    }

    const binary = resolveClaudeBinary({
      ...(rootPath === undefined ? {} : { rootPath }),
    });

    // M1: shell-metachar-args refused bei .cmd/.bat. node-pty selbst
    // launched ohne shell, aber wenn `claude.cmd` intern wieder den
    // ConPTY-host als cmd.exe spawned, koennte ein argument-string mit
    // `&` oder `|` Metachars getrennte commands aufmachen.
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary.path)) {
      for (const arg of args) {
        if (SHELL_INJECTION_METACHARS.test(arg)) {
          throw new PtyChatSessionError(
            `pty.spawn: arg contains shell metacharacter (refused for safety): "${arg}"`,
          );
        }
      }
    }

    // m13 (carry-over aus chat-sessions.ts:109): CLAUDE_OS_SECRETS_KEY
    // aus dem child-env strippen. claude.exe ist 3rd-party — der
    // file-store-master-key darf nicht via env leaken.
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key === 'CLAUDE_OS_SECRETS_KEY') continue;
      if (value !== undefined) childEnv[key] = value;
    }
    // envOverrides werden NACH der secrets-key-strip applied.
    // Anwendungsfall: ANTHROPIC_CONFIG_DIR fuer profile-aware auth.login.
    if (opts.envOverrides !== undefined) {
      for (const [key, value] of Object.entries(opts.envOverrides)) {
        childEnv[key] = value;
      }
    }

    const cols = opts.cols ?? DEFAULT_COLS;
    const rows = opts.rows ?? DEFAULT_ROWS;

    // Spike-finding: useConptyDll:true vermeidet den fork-based
    // conpty_console_list_agent helper der unter pkg-Bundles bricht.
    // Auf POSIX ist die Option no-op.
    const pty = this.nodePty.spawn(binary.path, [...args], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.cwd(),
      env: childEnv,
      useConpty: true,
      useConptyDll: true,
    });

    const id = randomUUID();
    const session: PtySession = { id, pty, killTimer: null };
    this.sessions.set(id, session);

    pty.onData((data) => {
      this.emit('pty.data', { sessionId: id, data });
    });
    pty.onExit(({ exitCode, signal }) => {
      if (session.killTimer !== null) {
        clearTimeout(session.killTimer);
        session.killTimer = null;
      }
      this.sessions.delete(id);
      this.emit('pty.exit', {
        sessionId: id,
        exitCode,
        signal: typeof signal === 'number' ? String(signal) : (signal ?? null),
      });
    });

    return { sessionId: id };
  }

  /**
   * Writes input chunk to the PTY. Unlike `chat.write`, the input is
   * NOT line-buffered — every keystroke (incl. control codes wie
   * Ctrl-C \x03, arrow keys \x1b[A) flowt direkt durch.
   */
  write(sessionId: string, input: string): void {
    const session = this.requireSession(sessionId);
    session.pty.write(input);
  }

  /**
   * Adjusts the PTY's cols/rows. Wird vom Frontend gerufen wenn
   * xterm.js's FitAddon einen window-resize observes.
   */
  resize(sessionId: string, cols: number, rows: number): void {
    // Validate params first — don't leak session-existence info on
    // malformed input.
    if (!Number.isInteger(cols) || cols <= 0) {
      throw new Error(`pty.resize: cols must be a positive integer, got ${cols}`);
    }
    if (!Number.isInteger(rows) || rows <= 0) {
      throw new Error(`pty.resize: rows must be a positive integer, got ${rows}`);
    }
    const session = this.requireSession(sessionId);
    session.pty.resize(cols, rows);
  }

  kill(sessionId: string): void {
    const session = this.requireSession(sessionId);
    try {
      session.pty.kill();
    } catch {
      // already dead — exit handler will fire
    }
    // node-pty.kill() sendet SIGHUP/equivalent. Wenn das nach 2s nicht
    // greift, hard-kill via process.kill mit der bekannten pid.
    session.killTimer = setTimeout(() => {
      try {
        process.kill(session.pty.pid, 'SIGKILL');
      } catch {
        // process already gone
      }
    }, KILL_GRACE_MS);
  }

  /** Test/diagnostic accessor. */
  activeCount(): number {
    return this.sessions.size;
  }

  /** Best-effort shutdown of all live sessions (used on sidecar exit). */
  async shutdownAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        session.pty.kill();
      } catch {
        // skip
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  private requireSession(sessionId: string): PtySession {
    const s = this.sessions.get(sessionId);
    if (s === undefined) throw new Error(`pty: unknown sessionId "${sessionId}"`);
    return s;
  }
}

export { BinaryNotFoundError };
