/**
 * `claude-os doctor` command — runs self-diagnostic checks and prints
 * either a human-readable report or JSON depending on the global
 * `--json` flag.
 *
 * @module @cli/commands/doctor
 */
import type { Command } from 'commander';
import { runDoctor } from '../../core/doctor/index.js';
import { formatDoctorReportText, formatDoctorReportJson } from '../presenters/doctor.js';

interface GlobalOpts {
  readonly root?: string;
  readonly json?: boolean;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description(
      'Self-diagnostic: root resolution, node version, git, claude binary, write permission',
    )
    .action(async (_opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      const report = await runDoctor(
        globals.root === undefined ? {} : { explicitRoot: globals.root },
      );
      const output = (globals.json ?? false)
        ? formatDoctorReportJson(report)
        : formatDoctorReportText(report);
      // biome-ignore lint/suspicious/noConsole: CLI presenter output goes to stdout by design
      console.log(output);
      if (report.overall === 'fail') {
        process.exit(1);
      }
    });
}
