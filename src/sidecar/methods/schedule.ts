/**
 * Schedule-Namespace RPCs: add / remove / setEnabled / list.
 * Split aus `sidecar/methods.ts` (M21).
 *
 * @module @sidecar/methods/schedule
 */
import { join } from 'node:path';
import {
  addSchedule,
  CronParseError,
  nextFire,
  parseCron,
  readSchedules,
  removeSchedule,
  type ScheduleEntry,
  ScheduleError,
  setEnabled as setScheduleEnabled,
  writeSchedules,
} from '../../domains/scheduler/index.js';
import { mtimeCached } from '../mtime-cache.js';
import type { RpcDispatcher } from '../rpc.js';
import { type MethodsContext, requireBoolean, requireString } from './_shared.js';

export function registerScheduleMethods(dispatcher: RpcDispatcher, ctx: MethodsContext): void {
  dispatcher.register('schedule.add', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as {
      id?: string;
      cron?: string;
      command?: string;
      description?: string;
      disabled?: boolean;
    };
    const id = requireString(params.id, 'id', 'schedule.add');
    const cron = requireString(params.cron, 'cron', 'schedule.add');
    const command = requireString(params.command, 'command', 'schedule.add');
    try {
      parseCron(cron);
    } catch (err) {
      if (err instanceof CronParseError) {
        throw new Error(`schedule.add: cron invalid — ${err.message}`);
      }
      throw err;
    }
    const machine = ctx.machinePaths();
    const store = readSchedules(machine.dataDir);
    const entry: ScheduleEntry = {
      id,
      cron,
      command,
      createdAt: new Date().toISOString(),
      enabled: params.disabled !== true,
      ...(params.description === undefined ? {} : { description: params.description }),
    };
    try {
      writeSchedules(machine.dataDir, addSchedule(store, entry));
    } catch (err) {
      if (err instanceof ScheduleError) {
        throw new Error(`schedule.add: ${err.message}`);
      }
      throw err;
    }
    return { entry };
  });

  dispatcher.register('schedule.remove', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { id?: string };
    const id = requireString(params.id, 'id', 'schedule.remove');
    const machine = ctx.machinePaths();
    try {
      writeSchedules(machine.dataDir, removeSchedule(readSchedules(machine.dataDir), id));
    } catch (err) {
      if (err instanceof ScheduleError) {
        throw new Error(`schedule.remove: ${err.message}`);
      }
      throw err;
    }
    return { id, removed: true };
  });

  dispatcher.register('schedule.setEnabled', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { id?: string; enabled?: boolean };
    const id = requireString(params.id, 'id', 'schedule.setEnabled');
    const enabled = requireBoolean(params.enabled, 'enabled', 'schedule.setEnabled');
    const machine = ctx.machinePaths();
    try {
      writeSchedules(
        machine.dataDir,
        setScheduleEnabled(readSchedules(machine.dataDir), id, enabled),
      );
    } catch (err) {
      if (err instanceof ScheduleError) {
        throw new Error(`schedule.setEnabled: ${err.message}`);
      }
      throw err;
    }
    return { id, enabled };
  });

  dispatcher.register('schedule.list', () => {
    const machine = ctx.machinePaths();
    // M14: nur die READ-path cached. Add/Remove/Enable rufen direkt
    // readSchedules ohne cache, weil sie sofort writeSchedules folgen —
    // ein cache-Hit zwischen read und write wuerde stale-Daten ueber-
    // schreiben.
    const schedulesPath = join(machine.dataDir, 'schedules.json');
    const store = mtimeCached(
      schedulesPath,
      () => readSchedules(machine.dataDir),
      ctx.schedulesCache,
    );
    const enriched = store.entries.map((entry: ScheduleEntry) => {
      let next: string | null = null;
      try {
        const fire = nextFire(parseCron(entry.cron));
        next = fire === null ? null : fire.toISOString();
      } catch {
        next = null;
      }
      return { ...entry, next };
    });
    return { count: enriched.length, entries: enriched };
  });
}
