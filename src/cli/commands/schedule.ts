/**
 * `claude-os schedule` — CRUD für zeit-basierte Tasks
 * (v1.5, Cowork-OS-Integrationsplan Feature 3).
 *
 * Sub-Commands:
 *  - `add <id> --cron "<expr>" --command "<shell>"`  Eintrag anlegen
 *  - `list`                                          alle Einträge
 *  - `remove <id>`                                    Eintrag löschen
 *  - `enable <id>` / `disable <id>`                  enabled-State togglen
 *
 * Persistiert atomar in `<dataDir>/schedules.json`. Der eigentliche
 * Sidecar-Runner (Ticken + Ausführen) kommt in einer Folge-PR — diese
 * PR liefert nur die CRUD-Foundation + Cron-Parser.
 *
 * @module @cli/commands/schedule
 */

import type { Command } from 'commander';
import { resolveMachinePaths } from '../../core/paths/index.js';
import {
  addSchedule,
  CronParseError,
  nextFire,
  parseCron,
  readSchedules,
  removeSchedule,
  type ScheduleEntry,
  ScheduleError,
  setEnabled,
  writeSchedules,
} from '../../domains/scheduler/index.js';
import { type GlobalOpts, printJson, printLine } from '../output.js';

function dataDir(): string {
  return resolveMachinePaths().dataDir;
}

function renderEntry(entry: ScheduleEntry, next: Date | null): string {
  const status = entry.enabled ? 'on' : 'off';
  const nextStr = next === null ? '(nicht erreichbar)' : next.toISOString();
  const desc = entry.description === undefined ? '' : `  — ${entry.description}`;
  return `${entry.id}  [${status}]  cron="${entry.cron}"  next=${nextStr}${desc}\n  $ ${entry.command}`;
}

export function registerScheduleCommand(program: Command): void {
  const cmd = program.command('schedule').description('Zeit-basierte Tasks verwalten.');

  cmd
    .command('add <id>')
    .description('Neuen zeit-basierten Task anlegen.')
    .requiredOption('--cron <expression>', '5-Field cron-Expression, z. B. "0 8 * * *"')
    .requiredOption(
      '--command <shell>',
      'Shell-Command der ausgeführt wird wenn die Zeit fällig wird',
    )
    .option('--description <text>', 'Optionale Beschreibung')
    .option('--disabled', 'Eintrag direkt als disabled anlegen')
    .action(
      async (
        id: string,
        opts: { cron: string; command: string; description?: string; disabled?: boolean },
        command,
      ) => {
        const globalOpts = command.optsWithGlobals() as GlobalOpts;
        try {
          parseCron(opts.cron);
        } catch (err) {
          const msg =
            err instanceof CronParseError ? err.message : `cron-Parse-Fehler: ${String(err)}`;
          if (globalOpts.json === true) {
            printJson({ ok: false, code: 'cron-parse-error', message: msg });
          } else {
            console.error(`Fehler: ${msg}`);
          }
          process.exit(2);
        }
        const entry: ScheduleEntry = {
          id,
          cron: opts.cron,
          command: opts.command,
          createdAt: new Date().toISOString(),
          enabled: opts.disabled !== true,
          ...(opts.description === undefined ? {} : { description: opts.description }),
        };
        const dir = dataDir();
        const store = readSchedules(dir);
        try {
          writeSchedules(dir, addSchedule(store, entry));
        } catch (err) {
          if (err instanceof ScheduleError) {
            if (globalOpts.json === true) {
              printJson({ ok: false, code: 'schedule-error', message: err.message });
            } else {
              console.error(`Fehler: ${err.message}`);
            }
            process.exit(3);
          }
          throw err;
        }
        if (globalOpts.json === true) {
          printJson({ ok: true, entry });
        } else {
          printLine(`[OK] Eintrag "${id}" angelegt.`);
          const next = nextFire(parseCron(opts.cron));
          printLine(`  nächste Ausführung: ${next?.toISOString() ?? '(nicht erreichbar)'}`);
        }
      },
    );

  cmd
    .command('list')
    .description('Alle Einträge listen.')
    .action(async (_opts, command) => {
      const globalOpts = command.optsWithGlobals() as GlobalOpts;
      const store = readSchedules(dataDir());
      if (globalOpts.json === true) {
        const enriched = store.entries.map((e) => {
          let next: string | null = null;
          try {
            const parsed = parseCron(e.cron);
            const fire = nextFire(parsed);
            next = fire === null ? null : fire.toISOString();
          } catch {
            next = null;
          }
          return { ...e, next };
        });
        printJson({ schedules: enriched });
        return;
      }
      if (store.entries.length === 0) {
        printLine('(keine Schedule-Einträge)');
        return;
      }
      for (const entry of store.entries) {
        let next: Date | null = null;
        try {
          next = nextFire(parseCron(entry.cron));
        } catch {
          next = null;
        }
        printLine(renderEntry(entry, next));
        printLine('');
      }
    });

  cmd
    .command('remove <id>')
    .description('Eintrag entfernen.')
    .action(async (id: string, _opts, command) => {
      const globalOpts = command.optsWithGlobals() as GlobalOpts;
      const dir = dataDir();
      try {
        writeSchedules(dir, removeSchedule(readSchedules(dir), id));
      } catch (err) {
        if (err instanceof ScheduleError) {
          if (globalOpts.json === true) {
            printJson({ ok: false, code: 'schedule-error', message: err.message });
          } else {
            console.error(`Fehler: ${err.message}`);
          }
          process.exit(3);
        }
        throw err;
      }
      if (globalOpts.json === true) {
        printJson({ ok: true, removed: id });
      } else {
        printLine(`[OK] Eintrag "${id}" entfernt.`);
      }
    });

  for (const [verb, on] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    cmd
      .command(`${verb} <id>`)
      .description(`Eintrag ${verb === 'enable' ? 'aktivieren' : 'deaktivieren'}.`)
      .action(async (id: string, _opts, command) => {
        const globalOpts = command.optsWithGlobals() as GlobalOpts;
        const dir = dataDir();
        try {
          writeSchedules(dir, setEnabled(readSchedules(dir), id, on));
        } catch (err) {
          if (err instanceof ScheduleError) {
            if (globalOpts.json === true) {
              printJson({ ok: false, code: 'schedule-error', message: err.message });
            } else {
              console.error(`Fehler: ${err.message}`);
            }
            process.exit(3);
          }
          throw err;
        }
        if (globalOpts.json === true) {
          printJson({ ok: true, id, enabled: on });
        } else {
          printLine(`[OK] Eintrag "${id}" ${on ? 'aktiviert' : 'deaktiviert'}.`);
        }
      });
  }
}
