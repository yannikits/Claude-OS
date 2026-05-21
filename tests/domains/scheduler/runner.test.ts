import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CommandParseError,
  chooseShellMode,
  parseCommandTokens,
  type SchedulerEvent,
  startScheduler,
  writeSchedules,
} from '../../../src/domains/scheduler/index.js';

let dataDir: string;
let events: SchedulerEvent[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'claude-os-sched-runner-'));
  events = [];
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

class TimerHarness {
  private cb: (() => void) | null = null;

  setTimeoutFn = (cb: () => void, _ms: number): unknown => {
    this.cb = cb;
    return Symbol('handle');
  };

  clearTimeoutFn = (_h: unknown): void => {
    this.cb = null;
  };

  fire(): void {
    const cb = this.cb;
    this.cb = null;
    if (cb !== null) cb();
  }
}

describe('startScheduler — Tick + Fire', () => {
  it('feuert einen faelligen Entry beim ersten Tick', async () => {
    const harness = new TimerHarness();
    const fakeChild = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fakeChild);

    writeSchedules(dataDir, {
      version: 1,
      entries: [
        {
          id: 'every-minute',
          cron: '* * * * *',
          command: 'echo hello',
          createdAt: '2026-05-20T00:00:00.000Z',
          enabled: true,
        },
      ],
    });

    const handle = startScheduler({
      dataDir,
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      // Erster Tick nach 50ms — wir setzen die Test-Clock auf einen
      // Zeitpunkt nach der naechsten "*"-Minute.
      now: () => new Date('2026-05-20T10:00:30.000Z'),
      spawnFn: spawnFn as never,
    });

    harness.fire(); // initialer 50ms-Tick
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(events.some((e) => e.type === 'fire' && e.entryId === 'every-minute')).toBe(true);
    await handle.stop();
  });

  it('Skip-on-Overlap: zweiter Tick waehrend Child laeuft fired NICHT', async () => {
    const harness = new TimerHarness();
    const fakeChild = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fakeChild);

    writeSchedules(dataDir, {
      version: 1,
      entries: [
        {
          id: 'slow',
          cron: '* * * * *',
          command: 'sleep 1',
          createdAt: '2026-05-20T00:00:00.000Z',
          enabled: true,
        },
      ],
    });

    let currentTime = new Date('2026-05-20T10:00:30.000Z');
    const handle = startScheduler({
      dataDir,
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      now: () => currentTime,
      spawnFn: spawnFn as never,
    });

    harness.fire(); // erster Tick → fire
    expect(spawnFn).toHaveBeenCalledTimes(1);
    // 60s spaeter — naechster Tick. Child laeuft noch (kein exit emit).
    currentTime = new Date('2026-05-20T10:01:30.000Z');
    harness.fire();
    expect(spawnFn).toHaveBeenCalledTimes(1); // KEIN zweiter spawn
    expect(events.some((e) => e.type === 'skip-overlap' && e.entryId === 'slow')).toBe(true);
    await handle.stop();
  });

  it('disabled Entry wird ignoriert', () => {
    const harness = new TimerHarness();
    const spawnFn = vi.fn();
    writeSchedules(dataDir, {
      version: 1,
      entries: [
        {
          id: 'off',
          cron: '* * * * *',
          command: 'echo nope',
          createdAt: '2026-05-20T00:00:00.000Z',
          enabled: false,
        },
      ],
    });
    startScheduler({
      dataDir,
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      now: () => new Date('2026-05-20T10:00:30.000Z'),
      spawnFn: spawnFn as never,
    });
    harness.fire();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('emittiert parse-error bei ungueltigem cron, blockiert nicht andere Entries', () => {
    const harness = new TimerHarness();
    const fakeChild = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fakeChild);
    writeSchedules(dataDir, {
      version: 1,
      entries: [
        {
          id: 'broken',
          cron: 'not a cron',
          command: 'echo x',
          createdAt: '2026-05-20T00:00:00.000Z',
          enabled: true,
        },
        {
          id: 'fine',
          cron: '* * * * *',
          command: 'echo y',
          createdAt: '2026-05-20T00:00:00.000Z',
          enabled: true,
        },
      ],
    });
    startScheduler({
      dataDir,
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      now: () => new Date('2026-05-20T10:00:30.000Z'),
      spawnFn: spawnFn as never,
    });
    harness.fire();
    expect(events.some((e) => e.type === 'parse-error' && e.entryId === 'broken')).toBe(true);
    expect(events.some((e) => e.type === 'fire' && e.entryId === 'fine')).toBe(true);
  });

  it('Output-Lines werden als output-Event emittiert', () => {
    const harness = new TimerHarness();
    const fakeChild = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fakeChild);
    writeSchedules(dataDir, {
      version: 1,
      entries: [
        {
          id: 'echo',
          cron: '* * * * *',
          command: 'echo hi',
          createdAt: '2026-05-20T00:00:00.000Z',
          enabled: true,
        },
      ],
    });
    startScheduler({
      dataDir,
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      now: () => new Date('2026-05-20T10:00:30.000Z'),
      spawnFn: spawnFn as never,
    });
    harness.fire();
    fakeChild.stdout.emit('data', Buffer.from('line1\nline2\n', 'utf8'));
    fakeChild.stderr.emit('data', Buffer.from('warn1\n', 'utf8'));
    fakeChild.emit('exit', 0, null);
    const outputs = events.filter((e) => e.type === 'output');
    expect(outputs.find((e) => e.line === 'line1' && e.stream === 'stdout')).toBeDefined();
    expect(outputs.find((e) => e.line === 'line2' && e.stream === 'stdout')).toBeDefined();
    expect(outputs.find((e) => e.line === 'warn1' && e.stream === 'stderr')).toBeDefined();
    expect(events.find((e) => e.type === 'exit')?.exitCode).toBe(0);
  });

  it('readSchedules-Fehler emittiert parse-error mit entryId "*"', () => {
    const harness = new TimerHarness();
    const spawnFn = vi.fn();
    // schedules.json malformed
    const path = join(dataDir, 'schedules.json');
    require('node:fs').writeFileSync(path, '{ not json', 'utf8');
    startScheduler({
      dataDir,
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      now: () => new Date('2026-05-20T10:00:30.000Z'),
      spawnFn: spawnFn as never,
    });
    harness.fire();
    expect(events.some((e) => e.type === 'parse-error' && e.entryId === '*')).toBe(true);
  });
});

describe('startScheduler — C1 Shell-Injection-Schutz', () => {
  it('parst command in argv-Tokens und spawnt OHNE shell fuer .exe auf Windows', () => {
    const harness = new TimerHarness();
    const fakeChild = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fakeChild);
    writeSchedules(dataDir, {
      version: 1,
      entries: [
        {
          id: 'normal',
          cron: '* * * * *',
          command: 'node.exe ./script.mjs --foo bar',
          createdAt: '2026-05-20T00:00:00.000Z',
          enabled: true,
        },
      ],
    });
    startScheduler({
      dataDir,
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      now: () => new Date('2026-05-20T10:00:30.000Z'),
      spawnFn: spawnFn as never,
      platform: 'win32',
    });
    harness.fire();
    expect(spawnFn).toHaveBeenCalledWith(
      'node.exe',
      ['./script.mjs', '--foo', 'bar'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('parst command in argv-Tokens und spawnt OHNE shell auf POSIX', () => {
    const harness = new TimerHarness();
    const fakeChild = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fakeChild);
    writeSchedules(dataDir, {
      version: 1,
      entries: [
        {
          id: 'posix',
          cron: '* * * * *',
          command: '/usr/bin/node ./script.mjs --foo bar',
          createdAt: '2026-05-20T00:00:00.000Z',
          enabled: true,
        },
      ],
    });
    startScheduler({
      dataDir,
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      now: () => new Date('2026-05-20T10:00:30.000Z'),
      spawnFn: spawnFn as never,
      platform: 'linux',
    });
    harness.fire();
    expect(spawnFn).toHaveBeenCalledWith(
      '/usr/bin/node',
      ['./script.mjs', '--foo', 'bar'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('shell-Metachars werden als argv-Tokens an cmd geliefert, NICHT als shell-OPs interpretiert', () => {
    const harness = new TimerHarness();
    const fakeChild = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fakeChild);
    writeSchedules(dataDir, {
      version: 1,
      entries: [
        {
          id: 'rce-attempt',
          // PoC aus C1: shell:true wuerde '&' als shell-OP interpretieren
          // und calc.exe ausfuehren. Mit unserem Fix wird '&' und 'calc.exe'
          // als argv an `node.exe` durchgereicht — node wuerde es ignorieren
          // oder mit Fehler quittieren, aber NIEMALS calc starten.
          cron: '* * * * *',
          command: 'node.exe script.mjs & calc.exe',
          createdAt: '2026-05-20T00:00:00.000Z',
          enabled: true,
        },
      ],
    });
    startScheduler({
      dataDir,
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      now: () => new Date('2026-05-20T10:00:30.000Z'),
      spawnFn: spawnFn as never,
      platform: 'win32',
    });
    harness.fire();
    expect(spawnFn).toHaveBeenCalledWith(
      'node.exe',
      ['script.mjs', '&', 'calc.exe'],
      expect.objectContaining({ shell: false }),
    );
    // Spawned EXACT one process — nicht eine Kette via shell.
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('aktiviert shell-Modus fuer .cmd/.bat damit Windows-PATH-Resolution greift (Node-arg-escape schuetzt)', () => {
    const harness = new TimerHarness();
    const fakeChild = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fakeChild);
    writeSchedules(dataDir, {
      version: 1,
      entries: [
        {
          id: 'npm-task',
          cron: '* * * * *',
          command: 'npm.cmd run build',
          createdAt: '2026-05-20T00:00:00.000Z',
          enabled: true,
        },
      ],
    });
    startScheduler({
      dataDir,
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      now: () => new Date('2026-05-20T10:00:30.000Z'),
      spawnFn: spawnFn as never,
      platform: 'win32',
    });
    harness.fire();
    expect(spawnFn).toHaveBeenCalledWith(
      'npm.cmd',
      ['run', 'build'],
      expect.objectContaining({ shell: true }),
    );
  });

  it('aktiviert shell-Modus auf Windows fuer extensionlose Tokens (PATHEXT-Resolution)', () => {
    const harness = new TimerHarness();
    const fakeChild = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fakeChild);
    writeSchedules(dataDir, {
      version: 1,
      entries: [
        {
          id: 'extensionless',
          cron: '* * * * *',
          command: 'npm run build',
          createdAt: '2026-05-20T00:00:00.000Z',
          enabled: true,
        },
      ],
    });
    startScheduler({
      dataDir,
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      now: () => new Date('2026-05-20T10:00:30.000Z'),
      spawnFn: spawnFn as never,
      platform: 'win32',
    });
    harness.fire();
    expect(spawnFn).toHaveBeenCalledWith(
      'npm',
      ['run', 'build'],
      expect.objectContaining({ shell: true }),
    );
  });

  it('refused shell-Modus wenn cmd selbst Shell-Metachars enthaelt', () => {
    const harness = new TimerHarness();
    const spawnFn = vi.fn();
    writeSchedules(dataDir, {
      version: 1,
      entries: [
        {
          id: 'malicious-cmd',
          cron: '* * * * *',
          // Quoted, sodass parser cmd = 'x&calc.cmd' produziert. .cmd-Ext
          // wuerde shell-mode triggern, aber Metachar-Check fired.
          command: '"x&calc.cmd" arg',
          createdAt: '2026-05-20T00:00:00.000Z',
          enabled: true,
        },
      ],
    });
    startScheduler({
      dataDir,
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      now: () => new Date('2026-05-20T10:00:30.000Z'),
      spawnFn: spawnFn as never,
      platform: 'win32',
    });
    harness.fire();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(
      events.some(
        (e) =>
          e.type === 'parse-error' &&
          e.entryId === 'malicious-cmd' &&
          e.message?.includes('metacharacters'),
      ),
    ).toBe(true);
  });

  it('emittiert parse-error wenn command leer oder nur whitespace ist', () => {
    const harness = new TimerHarness();
    const spawnFn = vi.fn();
    writeSchedules(dataDir, {
      version: 1,
      entries: [
        {
          id: 'empty',
          cron: '* * * * *',
          command: '   ',
          createdAt: '2026-05-20T00:00:00.000Z',
          enabled: true,
        },
      ],
    });
    startScheduler({
      dataDir,
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      now: () => new Date('2026-05-20T10:00:30.000Z'),
      spawnFn: spawnFn as never,
      platform: 'linux',
    });
    harness.fire();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'parse-error' && e.entryId === 'empty')).toBe(true);
  });

  it('emittiert parse-error bei unterminierten Quotes (kein silent-success)', () => {
    const harness = new TimerHarness();
    const spawnFn = vi.fn();
    writeSchedules(dataDir, {
      version: 1,
      entries: [
        {
          id: 'unterminated',
          cron: '* * * * *',
          command: 'node "missing close',
          createdAt: '2026-05-20T00:00:00.000Z',
          enabled: true,
        },
      ],
    });
    startScheduler({
      dataDir,
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      now: () => new Date('2026-05-20T10:00:30.000Z'),
      spawnFn: spawnFn as never,
      platform: 'linux',
    });
    harness.fire();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(
      events.some(
        (e) =>
          e.type === 'parse-error' &&
          e.entryId === 'unterminated' &&
          e.message?.includes('unterminated'),
      ),
    ).toBe(true);
  });

  it('respektiert gequotete Argumente', () => {
    const harness = new TimerHarness();
    const fakeChild = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fakeChild);
    writeSchedules(dataDir, {
      version: 1,
      entries: [
        {
          id: 'quoted',
          cron: '* * * * *',
          command: 'node script.mjs "hello world" \'foo bar\'',
          createdAt: '2026-05-20T00:00:00.000Z',
          enabled: true,
        },
      ],
    });
    startScheduler({
      dataDir,
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      now: () => new Date('2026-05-20T10:00:30.000Z'),
      spawnFn: spawnFn as never,
      platform: 'linux',
    });
    harness.fire();
    expect(spawnFn).toHaveBeenCalledWith(
      'node',
      ['script.mjs', 'hello world', 'foo bar'],
      expect.objectContaining({ shell: false }),
    );
  });
});

describe('parseCommandTokens — Unit-Tests', () => {
  it('split-bei-whitespace', () => {
    expect(parseCommandTokens('a b c')).toEqual(['a', 'b', 'c']);
  });
  it('multiple whitespace zaehlt als ein delimiter', () => {
    expect(parseCommandTokens('a    b\tc')).toEqual(['a', 'b', 'c']);
  });
  it('leading/trailing whitespace ignoriert', () => {
    expect(parseCommandTokens('   a b   ')).toEqual(['a', 'b']);
  });
  it('double-quotes erhalten interne whitespace', () => {
    expect(parseCommandTokens('a "b c" d')).toEqual(['a', 'b c', 'd']);
  });
  it('single-quotes erhalten interne whitespace', () => {
    expect(parseCommandTokens("a 'b c' d")).toEqual(['a', 'b c', 'd']);
  });
  it('Windows-Pfade mit Backslashes bleiben intakt (\\ ist KEIN Escape)', () => {
    expect(parseCommandTokens('C:\\Tools\\app.exe --x')).toEqual(['C:\\Tools\\app.exe', '--x']);
  });
  it('quoted Windows-Pfade mit Spaces bleiben intakt', () => {
    expect(parseCommandTokens('"C:\\Program Files\\node\\node.exe" -v')).toEqual([
      'C:\\Program Files\\node\\node.exe',
      '-v',
    ]);
  });
  it('unterminierte double-quote wirft CommandParseError', () => {
    expect(() => parseCommandTokens('node "a b')).toThrow(CommandParseError);
  });
  it('unterminierte single-quote wirft CommandParseError', () => {
    expect(() => parseCommandTokens("node 'a b")).toThrow(CommandParseError);
  });
  it('empty input → leeres Array', () => {
    expect(parseCommandTokens('')).toEqual([]);
    expect(parseCommandTokens('   ')).toEqual([]);
  });
  it('empty quoted string produziert ein Token', () => {
    expect(parseCommandTokens('a "" b')).toEqual(['a', '', 'b']);
  });
  it('shell-Metachars bleiben in Tokens (kein Special-Handling)', () => {
    expect(parseCommandTokens('a & b ; c | d')).toEqual(['a', '&', 'b', ';', 'c', '|', 'd']);
  });
});

describe('chooseShellMode — Unit-Tests', () => {
  it('POSIX → immer false', () => {
    expect(chooseShellMode('node', 'linux')).toBe(false);
    expect(chooseShellMode('node.exe', 'linux')).toBe(false);
    expect(chooseShellMode('npm', 'darwin')).toBe(false);
  });
  it('Windows mit .exe → false (kein PATHEXT noetig)', () => {
    expect(chooseShellMode('node.exe', 'win32')).toBe(false);
    expect(chooseShellMode('C:\\app.exe', 'win32')).toBe(false);
  });
  it('Windows mit .cmd/.bat → true (Node arg-escape schuetzt)', () => {
    expect(chooseShellMode('npm.cmd', 'win32')).toBe(true);
    expect(chooseShellMode('script.bat', 'win32')).toBe(true);
    expect(chooseShellMode('NPM.CMD', 'win32')).toBe(true);
  });
  it('Windows extensionlos → true (PATHEXT-Resolution noetig)', () => {
    expect(chooseShellMode('npm', 'win32')).toBe(true);
    expect(chooseShellMode('git', 'win32')).toBe(true);
  });
});
