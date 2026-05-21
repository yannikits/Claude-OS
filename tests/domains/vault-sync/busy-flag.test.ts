import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BusyFlag, type BusyState } from '../../../src/domains/vault-sync/index.js';

describe('BusyFlag', () => {
  let tmpBase: string;
  let filePath: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-busy-'));
    filePath = join(tmpBase, 'vault-sync-state.json');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  function makeFlag(
    overrides: Partial<{
      hostname: string;
      pid: number;
      isPidAlive: (pid: number) => boolean;
      now: () => Date;
    }> = {},
  ): BusyFlag {
    return new BusyFlag({
      filePath,
      hostname: overrides.hostname ?? 'test-host',
      pid: overrides.pid ?? 1234,
      isPidAlive: overrides.isPidAlive ?? (() => true),
      now: overrides.now ?? (() => new Date('2026-05-17T10:00:00.000Z')),
    });
  }

  it('starts with no state file', () => {
    const flag = makeFlag();
    expect(flag.read()).toBeNull();
    expect(existsSync(filePath)).toBe(false);
  });

  it('acquire writes the envelope and read returns it', () => {
    const flag = makeFlag();
    expect(flag.acquire('snapshot')).toBe(true);
    const state = flag.read();
    expect(state).not.toBeNull();
    expect(state?.busy).toBe(true);
    expect(state?.reason).toBe('snapshot');
    expect(state?.pid).toBe(1234);
    expect(state?.hostname).toBe('test-host');
    expect(state?.acquiredAt).toBe('2026-05-17T10:00:00.000Z');
  });

  it('blocks a second acquire while the first PID is alive on the same host', () => {
    const owner = makeFlag({ pid: 100, isPidAlive: () => true });
    expect(owner.acquire('snapshot')).toBe(true);

    const challenger = makeFlag({ pid: 200, isPidAlive: () => true });
    expect(challenger.acquire('snapshot-2')).toBe(false);
  });

  it('treats same-host state as stale when the PID is dead', () => {
    const owner = makeFlag({ pid: 100, isPidAlive: () => true });
    owner.acquire('snapshot');

    const successor = makeFlag({
      pid: 200,
      isPidAlive: (pid) => pid !== 100,
    });
    expect(successor.acquire('snapshot-2')).toBe(true);
  });

  it('treats cross-host state as non-stale even if local PID-probe would say dead', () => {
    const flagA = makeFlag({ hostname: 'machine-A', pid: 100, isPidAlive: () => false });
    flagA.acquire('snapshot');

    const flagB = makeFlag({ hostname: 'machine-B', pid: 100, isPidAlive: () => false });
    expect(flagB.acquire('snapshot')).toBe(false);
  });

  it('release clears the state file', () => {
    const flag = makeFlag();
    flag.acquire('snapshot');
    flag.release();
    expect(flag.read()).toBeNull();
    expect(existsSync(filePath)).toBe(false);
  });

  it('release is a no-op when not held', () => {
    const flag = makeFlag();
    expect(() => flag.release()).not.toThrow();
  });

  it('forceReset clears state held by another host', () => {
    const flagA = makeFlag({ hostname: 'machine-A', pid: 99, isPidAlive: () => true });
    flagA.acquire('snapshot');

    const flagB = makeFlag({ hostname: 'machine-B', pid: 200 });
    flagB.forceReset();
    expect(flagB.read()).toBeNull();
  });

  it('returns null for corrupt JSON on disk', () => {
    writeFileSync(filePath, '{not real json');
    const flag = makeFlag();
    expect(flag.read()).toBeNull();
  });

  it('returns null for type-mismatched envelope', () => {
    const bogus = { busy: 'no', reason: 1, pid: 'p', hostname: null, acquiredAt: 5 };
    writeFileSync(filePath, JSON.stringify(bogus));
    const flag = makeFlag();
    expect(flag.read()).toBeNull();
  });

  it('persists ISO-8601 with millisecond precision via custom now()', () => {
    const fixed = new Date('2026-05-17T08:30:15.987Z');
    const flag = makeFlag({ now: () => fixed });
    flag.acquire('snapshot');
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as BusyState;
    expect(parsed.acquiredAt).toBe('2026-05-17T08:30:15.987Z');
  });

  describe('C5: TOCTOU-safety via openSync wx', () => {
    it('zweiter acquire scheitert selbst wenn read() racy null zurueckgibt', () => {
      // Reproduziert die TOCTOU-Race: Prozess A schreibt, Prozess B's
      // read() liefert (durch Cache/Race) noch null — aber tryExclusive
      // Write trifft das exclusive-create und bekommt EEXIST.
      const flagA = makeFlag({ pid: 100 });
      expect(flagA.acquire('snap-a')).toBe(true);

      class LyingFlag extends BusyFlag {
        override read(): BusyState | null {
          return null;
        }
      }
      const flagB = new LyingFlag({
        filePath,
        hostname: 'test-host',
        pid: 200,
        isPidAlive: () => true,
      });
      expect(flagB.acquire('snap-b')).toBe(false);

      // Verifikation: As lock-state bleibt unangetastet.
      const state = makeFlag().read();
      expect(state?.pid).toBe(100);
      expect(state?.reason).toBe('snap-a');
    });

    it('korrupter file-state blockt acquire (kein silent-overwrite)', () => {
      // C5: vorher hat acquire() einen corrupt file ueberschrieben. Das
      // war konvenient, aber unsicher — eine race mit einem laufenden
      // legitimen acquire wuerde durch den Overwrite zerstoert.
      // Neuer Vertrag: corrupt → blocked, User muss `vault unlock`.
      writeFileSync(filePath, '{not real json', 'utf8');
      const flag = makeFlag();
      expect(flag.acquire('snap')).toBe(false);
      // forceReset/release loescht den corrupt file → naechster acquire
      // klappt.
      flag.forceReset();
      expect(flag.acquire('snap')).toBe(true);
    });

    it('release nach acquire erlaubt fresh acquire (kein orphan file)', () => {
      const flagA = makeFlag({ pid: 100 });
      expect(flagA.acquire('snap-a')).toBe(true);
      flagA.release();
      expect(existsSync(filePath)).toBe(false);

      const flagB = makeFlag({ pid: 200 });
      expect(flagB.acquire('snap-b')).toBe(true);
      expect(flagB.read()?.pid).toBe(200);
    });

    it('stale-pid-recovery loescht orphan und vergibt acquire korrekt', () => {
      // Same-host alter Prozess ist gecrasht: pid 100 ist tot.
      const corpse = makeFlag({ pid: 100, isPidAlive: () => true });
      corpse.acquire('crashed-snapshot');

      const successor = makeFlag({
        pid: 200,
        isPidAlive: (pid) => pid !== 100, // pid 100 dead, alles andere alive
      });
      expect(successor.acquire('clean-snap')).toBe(true);
      expect(successor.read()?.pid).toBe(200);
    });

    it('Codex-Round-2: release() von foreign owner ist no-op', () => {
      // Prozess A haelt den Lock. Prozess B ruft release() — darf
      // den Lock NICHT clearen.
      const owner = makeFlag({ pid: 100 });
      expect(owner.acquire('owner-snap')).toBe(true);

      const foreigner = makeFlag({ pid: 200 });
      foreigner.release();

      // Lock haelt weiter — owner's state unangetastet.
      expect(existsSync(filePath)).toBe(true);
      expect(makeFlag().read()?.pid).toBe(100);
    });

    it('Codex-Round-2: forceReset() cleart auch foreign locks (user-explicit-unlock)', () => {
      // Cross-Host-Crash-Recovery: User auf Maschine B sagt explizit
      // "der Lock von Maschine A ist tot, raus damit".
      const flagA = makeFlag({ hostname: 'machine-A', pid: 99 });
      flagA.acquire('snap');

      const flagB = makeFlag({ hostname: 'machine-B', pid: 200 });
      flagB.forceReset();
      expect(flagB.read()).toBeNull();
      expect(existsSync(filePath)).toBe(false);
    });
  });
});
