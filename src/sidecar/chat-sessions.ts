/**
 * Chat sessions — line-buffered claude-binary streaming via child_process (v1.2 MVP).
 *
 * NOT a PTY — this is a plain piped child_process. That means:
 *  - Output is line-buffered, not character-by-character
 *  - No ANSI cursor control / colors from the child are preserved
 *  - Interactive prompts that require TTY detection (passwords, readline)
 *    will NOT work — the child sees a pipe and may fall back to non-interactive mode
 *
 * What it CAN do:
 *  - claude --help, claude --version, single-shot prompts
 *  - Long-running streaming responses
 *  - User-typed lines to stdin (one line per chat.write call)
 *  - Kill via SIGTERM with 2s SIGKILL fallback
 *
 * Full PTY (xterm.js + node-pty) is the v1.x follow-up — node-pty has
 * native-build pain that we want to avoid for v1.2.
 *
 * RPC surface (registered in src/sidecar/methods.ts):
 *   chat.spawn({args: string[]}) -> {sessionId: string}
 *   chat.write({sessionId, input: string}) -> {ok: true}
 *   chat.kill({sessionId}) -> {ok: true}
 *
 * Notification emissions (no id — supervisor forwards to renderer as Tauri events):
 *   method: "chat.output"  params: {sessionId, stream: 'stdout'|'stderr', chunk: string}
 *   method: "chat.exit"    params: {sessionId, exitCode: number|null, signal: string|null}
 *
 * @module sidecar/chat-sessions
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveRoot } from '../core/environment/index.js';
import { BinaryNotFoundError, resolveClaudeBinary } from '../domains/claude-bridge/index.js';

const KILL_GRACE_MS = 2_000;
const MAX_SESSIONS = 8;

/**
 * M1 (2026-05-21 code-review): wenn die claude-binary `.cmd`/`.bat` ist
 * (Windows-Wrapper) und wir shell:true setzen muessen, escape Node 20+
 * args via CVE-2024-27980-Fix. Defense-in-depth: explizit args mit
 * shell-Metachars rejecten — Node-Eskapierung deckt 99 % aller Faelle,
 * aber ein Defensive-Layer kostet nichts.
 */
const SHELL_INJECTION_METACHARS = /[&|<>"`^]/;

export class ChatSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatSessionError';
  }
}

interface Session {
  readonly id: string;
  readonly child: ChildProcessWithoutNullStreams;
  killTimer: NodeJS.Timeout | null;
}

export type ChatNotificationEmitter = (method: string, params: unknown) => void;

export class ChatSessions {
  private readonly sessions = new Map<string, Session>();
  /**
   * v1.x phase e: deprecation-warning soll nur einmal pro Sidecar-
   * Lifetime erscheinen — wir haben keinen pino-Handle hier (das wuerde
   * eine cyclic Dependency mit logger.ts ergeben). Stattdessen
   * single-shot Stderr-write, das durch den Tauri-Supervisor als
   * sidecar://stderr Tauri-Event re-emittiert wird.
   */
  private deprecationWarningEmitted = false;

  constructor(private readonly emit: ChatNotificationEmitter) {}

  spawn(args: readonly string[]): { sessionId: string } {
    // v1.x phase e: chat.* ist Legacy-Pfad seit v1.x.0 — die
    // PTY-basierten pty.* RPCs sind der vollwertige Ersatz. ADR-0021
    // dokumentiert die coexist-policy. Entfernung frueheste v1.x.+1.
    if (!this.deprecationWarningEmitted) {
      this.deprecationWarningEmitted = true;
      process.stderr.write(
        '[deprecated] chat.* RPCs sind line-buffered und werden in v1.x.+1 entfernt — bitte auf pty.* (Full-TTY) migrieren. Siehe ADR-0021.\n',
      );
    }

    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(
        `chat.spawn: too many active sessions (${this.sessions.size}/${MAX_SESSIONS}); kill some first`,
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

    const id = randomUUID();
    // Windows: `.cmd`/`.bat` require `shell: true` since Node 16
    // (CVE-2024-27980). Plain `.exe` runs fine without shell — keep
    // the narrower default for real claude.exe deploys.
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary.path);

    // M1 (2026-05-21 code-review): wenn shell:true aktiv ist, verbiete
    // explizit Shell-Metachars in args. Node 20+ escaped diese korrekt
    // (CVE-2024-27980-Fix), aber das ist Defense-in-depth — falls eine
    // zukuenftige Node-Regression das aushebelt, blockt der Check.
    if (needsShell) {
      for (const arg of args) {
        if (SHELL_INJECTION_METACHARS.test(arg)) {
          throw new ChatSessionError(
            `chat.spawn: arg contains shell metacharacter (refused for safety): "${arg}"`,
          );
        }
      }
    }

    // m13 (2026-05-21 code-review): claude.exe ist ein 3rd-party-Binary
    // — strippe `CLAUDE_OS_SECRETS_KEY` aus dem env damit der
    // file-store-Master-Key nicht ueber den child-process leaken kann.
    const childEnv = { ...process.env };
    delete childEnv.CLAUDE_OS_SECRETS_KEY;

    const child = spawn(binary.path, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
      shell: needsShell,
    });

    const session: Session = { id, child, killTimer: null };
    this.sessions.set(id, session);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      this.emit('chat.output', { sessionId: id, stream: 'stdout', chunk });
    });
    child.stderr.on('data', (chunk: string) => {
      this.emit('chat.output', { sessionId: id, stream: 'stderr', chunk });
    });
    child.on('exit', (code, signal) => {
      if (session.killTimer !== null) {
        clearTimeout(session.killTimer);
        session.killTimer = null;
      }
      this.sessions.delete(id);
      this.emit('chat.exit', { sessionId: id, exitCode: code, signal });
    });
    child.on('error', (err) => {
      this.emit('chat.output', {
        sessionId: id,
        stream: 'stderr',
        chunk: `[chat] spawn error: ${err.message}\n`,
      });
    });

    return { sessionId: id };
  }

  /**
   * Writes one input chunk to the session's stdin.
   *
   * m7 (2026-05-21 code-review): `stdin.write` returnt `false` wenn der
   * internal Stream-Buffer voll ist. Ignoring the return wert kann OOM
   * verursachen bei einem runaway-input-stream auf einem slow child.
   * Wir respektieren das jetzt und retournen den back-pressure-Status,
   * sodass Caller `'drain'`-Events abwarten koennen.
   */
  write(sessionId: string, input: string): { drained: boolean } {
    const session = this.requireSession(sessionId);
    if (!session.child.stdin.writable) {
      throw new Error(`chat.write: session ${sessionId} stdin not writable (already closed?)`);
    }
    const drained = session.child.stdin.write(input);
    return { drained };
  }

  kill(sessionId: string): void {
    const session = this.requireSession(sessionId);
    try {
      session.child.kill('SIGTERM');
    } catch {
      // already dead — exit handler will fire
    }
    session.killTimer = setTimeout(() => {
      try {
        session.child.kill('SIGKILL');
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
        session.child.kill('SIGTERM');
      } catch {
        // skip
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  private requireSession(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (s === undefined) throw new Error(`chat: unknown sessionId "${sessionId}"`);
    return s;
  }
}

export { BinaryNotFoundError };
