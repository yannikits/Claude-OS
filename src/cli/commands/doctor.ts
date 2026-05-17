/**
 * `claude-os doctor` command — runs self-diagnostic checks and prints
 * either a human-readable report or JSON depending on the global
 * `--json` flag.
 *
 * Standalone modes (suppress the regular check suite):
 *   --migrate-git-metadata   Move `<root>/vault/.git/` to the external
 *                            per-machine git-metadata directory (ADR-0002,
 *                            Phase 1.5). Idempotent.
 *
 * @module @cli/commands/doctor
 */
import type { Command } from 'commander';
import { runDoctor } from '../../core/doctor/index.js';
import { RootNotFoundError, resolveRoot } from '../../core/environment/index.js';
import { migrateGitMetadata } from '../../core/git-metadata/index.js';
import { formatDoctorReportJson, formatDoctorReportText } from '../presenters/doctor.js';
import { formatMigrationResultJson, formatMigrationResultText } from '../presenters/migration.js';

interface GlobalOpts {
  readonly root?: string;
  readonly json?: boolean;
}

interface DoctorOpts {
  readonly migrateGitMetadata?: boolean;
}

function printAndExit(output: string, code: number): never {
  // biome-ignore lint/suspicious/noConsole: CLI presenter output goes to stdout by design
  console.log(output);
  process.exit(code);
}

async function runMigrate(json: boolean, explicitRoot: string | undefined): Promise<void> {
  try {
    const root = resolveRoot(explicitRoot === undefined ? {} : { explicit: explicitRoot });
    const result = await migrateGitMetadata({ rootPath: root.path });
    const output = json ? formatMigrationResultJson(result) : formatMigrationResultText(result);
    printAndExit(output, result.state === 'error' ? 1 : 0);
  } catch (err) {
    if (err instanceof RootNotFoundError) {
      const payload = {
        state: 'error',
        message: 'Root resolution failed before migration could start',
        error: err.message,
      };
      const output = json
        ? JSON.stringify(payload, null, 2)
        : `[FAIL] root-resolution: ${err.message}`;
      printAndExit(output, 1);
    }
    throw err;
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description(
      'Self-diagnostic: root resolution, node version, git, claude binary, write permission. ' +
        'Use --migrate-git-metadata to move vault/.git/ out of the cloud-mount.',
    )
    .option(
      '--migrate-git-metadata',
      'Move <root>/vault/.git/ to the external per-machine git-metadata directory (ADR-0002). Skips regular checks.',
    )
    .action(async (opts: DoctorOpts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      const json = globals.json ?? false;

      if (opts.migrateGitMetadata === true) {
        await runMigrate(json, globals.root);
        return;
      }

      const report = await runDoctor(
        globals.root === undefined ? {} : { explicitRoot: globals.root },
      );
      const output = json ? formatDoctorReportJson(report) : formatDoctorReportText(report);
      // biome-ignore lint/suspicious/noConsole: CLI presenter output goes to stdout by design
      console.log(output);
      if (report.overall === 'fail') {
        process.exit(1);
      }
    });
}
