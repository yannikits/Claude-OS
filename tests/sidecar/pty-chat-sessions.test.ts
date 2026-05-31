import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyChatSessionError, PtyChatSessions } from '../../src/sidecar/pty-chat-sessions.js';

/**
 * Spawn-Target fuer die PTY-Tests: ein winziges Helper-Script das auf
 * stdout schreibt und auf stdin lauscht. Auf Windows ist `cmd.exe`
 * direkt benutzbar, auf POSIX wird `/bin/sh` gewrappt. Wir vermeiden
 * den `claude.cmd`/`claude.sh`-Wrapper-pattern aus chat-sessions.test.ts
 * weil unter PTY der Wrapper das ConPTY-Lifecycle stoert (cmd.exe-host
 * spawned cmd.exe-Wrapper spawned powershell ... gettin' silly).
 */
function makeFakeClaude(dir: string): void {
  if (process.platform === 'win32') {
    // cmd.exe-Script das einfach `echo args:` + dann eine input-Loop
    // laeuft. ConPTY-host laesst den prompt drauf. exit via Ctrl-C/kill.
    const script = join(dir, 'claude.cmd');
    writeFileSync(
      script,
      ['@echo off', 'echo args: %*', 'echo READY', ':loop', 'goto loop'].join('\r\n'),
    );
    return;
  }
  const script = join(dir, 'claude');
  writeFileSync(
    script,
    ['#!/bin/sh', 'echo "args: $*"', 'echo READY', 'while true; do sleep 1; done'].join('\n'),
    { mode: 0o755 },
  );
}

interface EmittedEvent {
  method: string;
  params: unknown;
}

/**
 * PTY-Tests koennen unter bestimmten Umgebungen (CI ohne tty-Allocation,
 * containerized linux ohne /dev/ptmx) instabil sein. `useConptyDll:true`
 * mitigiert das auf Windows; auf POSIX laeuft node-pty direkt gegen das
 * Kernel-PTY-Interface. Wenn `RUN_PTY_TESTS=0` gesetzt ist, skip den
 * ganzen suite — analog zu `RUN_SLOW_TESTS` Pattern aus 6h.
 */
const PTY_TESTS_DISABLED = process.env.RUN_PTY_TESTS === '0';

describe.skipIf(PTY_TESTS_DISABLED)('PtyChatSessions', () => {
  let tmp: string;
  let oldRoot: string | undefined;

  // Track every PtyChatSessions that spawns real processes so afterEach can
  // tear them down deterministically — see the afterEach comment.
  const live: PtyChatSessions[] = [];
  const track = (p: PtyChatSessions): PtyChatSessions => {
    live.push(p);
    return p;
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-os-pty-'));
    const rootDir = join(tmp, 'root');
    const binDir = join(rootDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(rootDir, '.claude-os-root'),
      '{"version":1,"createdAt":"2026-05-21T00:00:00Z"}',
    );
    makeFakeClaude(binDir);
    oldRoot = process.env.CLAUDE_OS_ROOT;
    process.env.CLAUDE_OS_ROOT = rootDir;
  });

  afterEach(async () => {
    // Kill every spawned PTY before the worker exits. Lingering node-pty /
    // ConPTY handles otherwise crash the vitest worker during teardown on
    // windows CI ("Worker exited unexpectedly" while collecting coverage).
    // The MAX_SESSIONS test in particular left 8 processes behind with only
    // a fire-and-forget kill + fixed 500ms wait.
    for (const p of live) await p.shutdownAll();
    live.length = 0;
    if (oldRoot === undefined) delete process.env.CLAUDE_OS_ROOT;
    else process.env.CLAUDE_OS_ROOT = oldRoot;
  });

  it('spawn emits pty.data with the fake-claude banner', async () => {
    const events: EmittedEvent[] = [];
    const pty = track(new PtyChatSessions((method, params) => events.push({ method, params })));

    const { sessionId } = pty.spawn(['hello', 'world'], { cols: 100, rows: 30 });
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(pty.activeCount()).toBe(1);

    // Wait until the fake-claude wrote READY to the PTY. ConPTY's
    // first-frame includes ANSI init-sequences plus the echoed banner.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for READY')), 8000);
      const interval = setInterval(() => {
        const merged = events
          .filter((e) => e.method === 'pty.data')
          .map((e) => (e.params as { data: string }).data)
          .join('');
        if (merged.includes('READY')) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve();
        }
      }, 50);
    });

    const merged = events
      .filter((e) => e.method === 'pty.data')
      .map((e) => (e.params as { data: string }).data)
      .join('');
    expect(merged).toMatch(/args:/);
    expect(merged).toMatch(/READY/);

    pty.kill(sessionId);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for pty.exit')), 8000);
      const i = setInterval(() => {
        if (events.some((e) => e.method === 'pty.exit')) {
          clearTimeout(timer);
          clearInterval(i);
          resolve();
        }
      }, 50);
    });
    expect(pty.activeCount()).toBe(0);
  }, 20_000);

  it('resize forwards new dimensions to the PTY', async () => {
    const events: EmittedEvent[] = [];
    const pty = track(new PtyChatSessions((method, params) => events.push({ method, params })));

    const { sessionId } = pty.spawn([], { cols: 80, rows: 24 });

    // Just assert it doesn't throw — verifying that the child actually
    // got SIGWINCH would require a deeper helper-script that echoes
    // `tput cols` periodically. Out of scope for unit-tests.
    expect(() => pty.resize(sessionId, 120, 40)).not.toThrow();

    pty.kill(sessionId);
    await new Promise<void>((resolve) => {
      const i = setInterval(() => {
        if (events.some((e) => e.method === 'pty.exit')) {
          clearInterval(i);
          resolve();
        }
      }, 50);
    });
  }, 12_000);

  it('resize rejects non-positive integer dimensions', () => {
    const pty = new PtyChatSessions(() => {});
    // No spawn first — both checks fire before requireSession lookup.
    expect(() => pty.resize('any', 0, 24)).toThrow(/cols must be a positive integer/);
    expect(() => pty.resize('any', 80, -1)).toThrow(/rows must be a positive integer/);
    expect(() => pty.resize('any', 1.5, 24)).toThrow(/cols must be a positive integer/);
  });

  it('write to unknown session throws', () => {
    const pty = new PtyChatSessions(() => {});
    expect(() => pty.write('nope', 'data')).toThrow(/unknown sessionId/);
  });

  it('kill on unknown session throws', () => {
    const pty = new PtyChatSessions(() => {});
    expect(() => pty.kill('nope')).toThrow(/unknown sessionId/);
  });

  it('M1: shell-metachar-args werden rejected wenn .cmd-binary (Win-only)', () => {
    if (process.platform !== 'win32') return;
    const pty = new PtyChatSessions(() => {});
    expect(() => pty.spawn(['safe-arg', '& calc.exe'])).toThrow(PtyChatSessionError);
    expect(() => pty.spawn(['pipe', '|', 'evil'])).toThrow(PtyChatSessionError);
    expect(() => pty.spawn(['"injected\\"'])).toThrow(PtyChatSessionError);
  });

  it('MAX_SESSIONS = 8 ring-guard refused den 9. spawn', async () => {
    const events: EmittedEvent[] = [];
    const pty = track(new PtyChatSessions((method, params) => events.push({ method, params })));

    const sessionIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      sessionIds.push(pty.spawn([]).sessionId);
    }
    expect(pty.activeCount()).toBe(8);
    expect(() => pty.spawn([])).toThrow(/too many active sessions/);

    // Cleanup — sonst leaken die PTY-Handles in den naechsten Test.
    for (const id of sessionIds) {
      pty.kill(id);
    }
    await new Promise((r) => setTimeout(r, 500));
  }, 15_000);
});
