import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatSessionError, ChatSessions } from '../../src/sidecar/chat-sessions.js';

/**
 * Build a tiny shell-script that pretends to be claude. Echoes args on
 * stdout, mirrors stdin lines as ">> <line>", exits 0 when stdin closes.
 * Picks the right wrapper per platform.
 */
function makeFakeClaude(dir: string): void {
  if (process.platform === 'win32') {
    const script = join(dir, 'claude.cmd');
    writeFileSync(
      script,
      [
        '@echo off',
        'echo args: %*',
        'powershell -NoProfile -Command "while ($l = [Console]::In.ReadLine()) { Write-Output (\'>> \' + $l) }"',
        'exit 0',
      ].join('\r\n'),
    );
    return;
  }
  const script = join(dir, 'claude');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'echo "args: $*"',
      'while IFS= read -r line; do echo ">> $line"; done',
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  );
}

interface EmittedEvent {
  method: string;
  params: unknown;
}

describe('ChatSessions', () => {
  let tmp: string;
  let oldRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-os-chat-'));
    const rootDir = join(tmp, 'root');
    const binDir = join(rootDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(rootDir, '.claude-os-root'),
      '{"version":1,"createdAt":"2026-05-19T00:00:00Z"}',
    );
    makeFakeClaude(binDir);
    oldRoot = process.env.CLAUDE_OS_ROOT;
    process.env.CLAUDE_OS_ROOT = rootDir;
  });

  afterEach(() => {
    if (oldRoot === undefined) delete process.env.CLAUDE_OS_ROOT;
    else process.env.CLAUDE_OS_ROOT = oldRoot;
  });

  it('spawn + emits chat.output and chat.exit', async () => {
    const events: EmittedEvent[] = [];
    const chat = new ChatSessions((method, params) => events.push({ method, params }));

    const { sessionId } = chat.spawn(['hello', 'world']);
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(chat.activeCount()).toBe(1);

    // Give the fake script a moment to print its args banner before we
    // feed it stdin. On a loaded Windows CI runner, write-immediately can
    // race the shell's startup and the args banner is then missing from
    // the captured output.
    await new Promise((r) => setTimeout(r, 300));
    chat.write(sessionId, 'goodbye\n');
    setTimeout(() => chat.kill(sessionId), 400);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for chat.exit')), 8000);
      const i = setInterval(() => {
        if (events.some((e) => e.method === 'chat.exit')) {
          clearTimeout(timer);
          clearInterval(i);
          resolve();
        }
      }, 50);
    });

    const stdoutChunks = events
      .filter(
        (e) => e.method === 'chat.output' && (e.params as { stream: string }).stream === 'stdout',
      )
      .map((e) => (e.params as { chunk: string }).chunk)
      .join('');
    expect(stdoutChunks).toMatch(/args:/);
    expect(stdoutChunks).toMatch(/>> goodbye/);
    expect(chat.activeCount()).toBe(0);
  }, 12_000);

  it('kill cleans up active session', async () => {
    const events: EmittedEvent[] = [];
    const chat = new ChatSessions((method, params) => events.push({ method, params }));
    const { sessionId } = chat.spawn([]);
    expect(chat.activeCount()).toBe(1);
    chat.kill(sessionId);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), 8000);
      const i = setInterval(() => {
        if (events.some((e) => e.method === 'chat.exit')) {
          clearTimeout(timer);
          clearInterval(i);
          resolve();
        }
      }, 50);
    });

    expect(chat.activeCount()).toBe(0);
  }, 12_000);

  it('write to unknown session throws', () => {
    const chat = new ChatSessions(() => {});
    expect(() => chat.write('nope', 'data')).toThrow(/unknown sessionId/);
  });

  it('kill on unknown session throws', () => {
    const chat = new ChatSessions(() => {});
    expect(() => chat.kill('nope')).toThrow(/unknown sessionId/);
  });

  it('M1: Shell-Metachar-Args werden rejected wenn .cmd-binary (shell:true mode)', () => {
    if (process.platform !== 'win32') return; // M1 mitigation only fires on win32 .cmd-Binaries
    const chat = new ChatSessions(() => {});
    expect(() => chat.spawn(['safe-arg', '& calc.exe'])).toThrow(ChatSessionError);
    expect(() => chat.spawn(['"injected\\"'])).toThrow(ChatSessionError);
    expect(() => chat.spawn(['pipe', '|', 'evil'])).toThrow(ChatSessionError);
  });

  it('M1: normale args ohne Metachars werden akzeptiert (regression-Schutz)', () => {
    // Cross-platform: braucht keine win32, da Args-Validierung nur bei
    // needsShell=true fired. Auf POSIX werden Args ohnehin nicht
    // shell-interpretiert.
    const chat = new ChatSessions(() => {});
    // Wir koennen den spawn nicht voll testen ohne fake-claude-Setup,
    // aber wir koennen sicherstellen dass der M1-Check KEINEN Error
    // wirft fuer normale args.
    expect(() => chat.spawn(['--help', 'arg-with-equals=value', 'with spaces'])).not.toThrow(
      ChatSessionError,
    );
    // Kill etwaige gestartete session, damit afterEach sauber bleibt
    // (besonders auf Windows ohne fake-claude wird der spawn evtl
    // BinaryNotFoundError werfen — das ist OK, nicht ChatSessionError).
  });
});
