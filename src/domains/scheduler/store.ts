/**
 * Schedule-Persistierung in `<dataDir>/schedules.json`.
 *
 * Atomic write via tempfile+rename damit ein crash mid-write das File
 * nicht korrumpiert. JSON-Format mit `version: 1` als Migration-Anchor
 * (analog zu `vault-config`, `catalog-store`).
 *
 * Read ist resilient: fehlendes File → empty store; defekter JSON →
 * `ScheduleError` mit klarer Meldung. Wird in Tests gegen tmpdir
 * gemockt.
 *
 * @module @domains/scheduler/store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  EMPTY_SCHEDULE_STORE,
  type ScheduleEntry,
  ScheduleError,
  type ScheduleStore,
} from './types.js';

const STORE_FILENAME = 'schedules.json';

export function schedulePathFor(dataDir: string): string {
  return join(dataDir, STORE_FILENAME);
}

export function readSchedules(dataDir: string): ScheduleStore {
  const path = schedulePathFor(dataDir);
  if (!existsSync(path)) return EMPTY_SCHEDULE_STORE;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ScheduleError(
      `schedules.json konnte nicht gelesen werden: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ScheduleError(
      `schedules.json ist kein valides JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    (parsed as { version: unknown }).version !== 1 ||
    !('entries' in parsed) ||
    !Array.isArray((parsed as { entries: unknown }).entries)
  ) {
    throw new ScheduleError(
      `schedules.json hat ungültiges Schema (erwartet {version:1, entries:[]})`,
    );
  }
  return parsed as ScheduleStore;
}

export function writeSchedules(dataDir: string, store: ScheduleStore): void {
  const finalPath = schedulePathFor(dataDir);
  mkdirSync(dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, encoding: 'utf8' });
  renameSync(tmpPath, finalPath);
}

export class ScheduleNotFoundError extends ScheduleError {
  constructor(id: string) {
    super(`Schedule-Entry mit id "${id}" existiert nicht`);
    this.name = 'ScheduleNotFoundError';
  }
}

export class ScheduleDuplicateIdError extends ScheduleError {
  constructor(id: string) {
    super(`Schedule-Entry mit id "${id}" existiert bereits`);
    this.name = 'ScheduleDuplicateIdError';
  }
}

export function addSchedule(store: ScheduleStore, entry: ScheduleEntry): ScheduleStore {
  if (store.entries.some((e) => e.id === entry.id)) {
    throw new ScheduleDuplicateIdError(entry.id);
  }
  return { version: 1, entries: [...store.entries, entry] };
}

export function removeSchedule(store: ScheduleStore, id: string): ScheduleStore {
  if (!store.entries.some((e) => e.id === id)) {
    throw new ScheduleNotFoundError(id);
  }
  return { version: 1, entries: store.entries.filter((e) => e.id !== id) };
}

export function setEnabled(store: ScheduleStore, id: string, enabled: boolean): ScheduleStore {
  if (!store.entries.some((e) => e.id === id)) {
    throw new ScheduleNotFoundError(id);
  }
  return {
    version: 1,
    entries: store.entries.map((e) => (e.id === id ? { ...e, enabled } : e)),
  };
}
