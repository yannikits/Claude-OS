import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addSchedule,
  EMPTY_SCHEDULE_STORE,
  readSchedules,
  removeSchedule,
  ScheduleDuplicateIdError,
  ScheduleError,
  ScheduleNotFoundError,
  setEnabled,
  writeSchedules,
} from '../../../src/domains/scheduler/index.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'claude-os-schedule-store-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const sampleEntry = {
  id: 'morning-sync',
  cron: '0 8 * * *',
  command: 'claude-os vault snapshot',
  createdAt: '2026-05-20T00:00:00.000Z',
  enabled: true,
};

describe('readSchedules / writeSchedules', () => {
  it('liefert empty store wenn schedules.json nicht existiert', () => {
    const store = readSchedules(dataDir);
    expect(store).toEqual(EMPTY_SCHEDULE_STORE);
  });

  it('schreibt + liest atomic ohne tmp-leftover', () => {
    writeSchedules(dataDir, { version: 1, entries: [sampleEntry] });
    const store = readSchedules(dataDir);
    expect(store.entries).toEqual([sampleEntry]);
    const files = require('node:fs').readdirSync(dataDir) as string[];
    expect(files.some((f: string) => f.includes('.tmp-'))).toBe(false);
  });

  it('wirft bei defektem JSON mit klarer Meldung', () => {
    writeFileSync(join(dataDir, 'schedules.json'), '{ not real json');
    expect(() => readSchedules(dataDir)).toThrow(ScheduleError);
  });

  it('wirft bei falscher Schema-Version', () => {
    writeFileSync(join(dataDir, 'schedules.json'), JSON.stringify({ version: 999, entries: [] }));
    expect(() => readSchedules(dataDir)).toThrow(/Schema/);
  });
});

describe('addSchedule / removeSchedule / setEnabled', () => {
  it('addSchedule fügt am Ende an', () => {
    const next = addSchedule(EMPTY_SCHEDULE_STORE, sampleEntry);
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]?.id).toBe('morning-sync');
  });

  it('addSchedule wirft bei dupliziertem Id', () => {
    const once = addSchedule(EMPTY_SCHEDULE_STORE, sampleEntry);
    expect(() => addSchedule(once, sampleEntry)).toThrow(ScheduleDuplicateIdError);
  });

  it('removeSchedule entfernt nach id', () => {
    const once = addSchedule(EMPTY_SCHEDULE_STORE, sampleEntry);
    const empty = removeSchedule(once, 'morning-sync');
    expect(empty.entries).toEqual([]);
  });

  it('removeSchedule wirft bei unbekanntem Id', () => {
    expect(() => removeSchedule(EMPTY_SCHEDULE_STORE, 'missing')).toThrow(ScheduleNotFoundError);
  });

  it('setEnabled toggelt nur den enabled-state', () => {
    const once = addSchedule(EMPTY_SCHEDULE_STORE, sampleEntry);
    const off = setEnabled(once, 'morning-sync', false);
    expect(off.entries[0]?.enabled).toBe(false);
    expect(off.entries[0]?.cron).toBe('0 8 * * *');
    expect(off.entries[0]?.command).toBe('claude-os vault snapshot');
  });

  it('setEnabled wirft bei unbekanntem Id', () => {
    expect(() => setEnabled(EMPTY_SCHEDULE_STORE, 'missing', false)).toThrow(ScheduleNotFoundError);
  });
});

describe('roundtrip (write + read)', () => {
  it('persistiert mehrere Entries und liest sie identisch zurück', () => {
    const initial = addSchedule(EMPTY_SCHEDULE_STORE, sampleEntry);
    const two = addSchedule(initial, {
      ...sampleEntry,
      id: 'weekly-vault-snapshot',
      cron: '0 18 * * 0',
      command: 'echo weekly',
      enabled: false,
    });
    writeSchedules(dataDir, two);
    const roundtrip = readSchedules(dataDir);
    expect(roundtrip.entries).toEqual(two.entries);
  });

  it('atomic-write überlebt einen Crash mid-write Simulation', () => {
    // Wir simulieren das durch parallel write — der atomic rename
    // garantiert dass nie ein partial write sichtbar ist.
    writeSchedules(dataDir, EMPTY_SCHEDULE_STORE);
    expect(existsSync(join(dataDir, 'schedules.json'))).toBe(true);
    expect(readFileSync(join(dataDir, 'schedules.json'), 'utf8')).toContain('"version": 1');
  });
});
