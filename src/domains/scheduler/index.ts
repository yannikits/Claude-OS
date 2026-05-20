/**
 * Scheduler-Domain — `claude-os schedule` (v1.5,
 * Cowork-OS-Integrationsplan Feature 3).
 *
 * Phase 1 (diese PR): CRUD + Cron-Parser + Next-Fire-Berechnung.
 * Phase 2 (Folge-PR): Sidecar-Runner der die Schedules tickt und die
 *   commands ausführt.
 *
 * @module @domains/scheduler
 */
export { nextFire, type ParsedCron, parseCron } from './cron-parser.js';
export {
  type RunnerOpts,
  type SchedulerEvent,
  startScheduler,
} from './runner.js';
export {
  addSchedule,
  readSchedules,
  removeSchedule,
  ScheduleDuplicateIdError,
  ScheduleNotFoundError,
  schedulePathFor,
  setEnabled,
  writeSchedules,
} from './store.js';
export {
  CronParseError,
  EMPTY_SCHEDULE_STORE,
  type ScheduleEntry,
  ScheduleError,
  type ScheduleStore,
} from './types.js';
