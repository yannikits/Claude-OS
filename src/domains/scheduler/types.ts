/**
 * Typen für den `claude-os schedule`-Subcommand (v1.5,
 * Cowork-OS-Integrationsplan Feature 3).
 *
 * Eine `ScheduleEntry` ist eine vom User registrierte zeit-basierte
 * Aufgabe: gegebene cron-expression + auszuführender Command.
 * Persistiert atomar in `<dataDir>/schedules.json`.
 *
 * @module @domains/scheduler/types
 */

export interface ScheduleEntry {
  /** Stabile id (uuid oder kebab-case-Label, vom Caller vergeben). */
  readonly id: string;
  /** 5-Field-Cron-Expression, z. B. "0 8 * * *" für täglich 08:00. */
  readonly cron: string;
  /** Shell-Command der ausgeführt werden soll wenn die Cron-Zeit fällig wird. */
  readonly command: string;
  /** ISO-8601 Zeitstempel der Anlage. */
  readonly createdAt: string;
  /** Wenn `false`, wird die Entry ignoriert (User-Disable ohne Löschen). */
  readonly enabled: boolean;
  /** Optionale Beschreibung. */
  readonly description?: string;
}

export interface ScheduleStore {
  readonly version: 1;
  readonly entries: readonly ScheduleEntry[];
}

export const EMPTY_SCHEDULE_STORE: ScheduleStore = {
  version: 1,
  entries: [],
};

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleError';
  }
}

export class CronParseError extends ScheduleError {
  constructor(message: string) {
    super(message);
    this.name = 'CronParseError';
  }
}
