import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
