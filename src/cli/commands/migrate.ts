/**
 * `claude-os migrate` — Migrationspfad von claude-portable v0.x nach v1
 * (Auftrag 1c, v1.5).
 *
 * Phase 1 — Plan: ohne Mutationen den Migrationsplan ausgeben (`--plan`).
 * Phase 2 — Execute: Plan ausführen (`--execute`).
 * Default ohne Flag: Plan + warten auf User-Bestätigung — in v1.5
 * implementiert als Hinweis, weil interaktive Prompts (Auftrag 1c-
 * Out-of-Scope für CLI-Layer) erst in v1.6 kommen.
 *
 * @module @cli/commands/migrate
 */
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { resolveRoot } from '../../core/environment/index.js';
import {
  buildMigrationPlan,
  executePlan,
  MigrationError,
  type MigrationPlan,
  type MigrationResult,
  type StepResult,
} from '../../domains/migration/index.js';
import { type GlobalOpts, printJson, printLine } from '../output.js';

interface MigrateOpts {
  readonly fromPortable: string;
  readonly target?: string;
  readonly plan?: boolean;
  readonly execute?: boolean;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly overwrite?: boolean;
}

function renderPlan(plan: MigrationPlan): void {
  printLine(`Source: ${plan.source.root}  (claude-portable v${plan.source.detectedVersion})`);
  printLine(`Target: ${plan.target}${plan.targetAlreadyMigrated ? '  [BEREITS MIGRIERT]' : ''}`);
  printLine('');
  printLine(`Plan-Schritte (${plan.steps.length}):`);
  plan.steps.forEach((step, i) => {
    const n = String(i + 1).padStart(2, ' ');
    switch (step.kind) {
      case 'copy-tree':
        printLine(`  ${n}. copy  ${step.label}  → ${step.destination}`);
        printLine(`        excludes: ${step.exclude.join(', ') || '(keine)'}`);
        break;
      case 'migrate-git-metadata':
        printLine(`  ${n}. doctor --migrate-git-metadata  (target: ${step.target})`);
        break;
      case 'collect-secrets':
        printLine(
          `  ${n}. secrets-collect: ${step.keys.length} Key(s) — ${step.keys.slice(0, 5).join(', ')}${step.keys.length > 5 ? ', ...' : ''}`,
        );
        break;
    }
  });
  if (plan.notes.length > 0) {
    printLine('');
    printLine('Notes:');
    for (const note of plan.notes) printLine(`  - ${note}`);
  }
}

function renderResult(result: MigrationResult): void {
  printLine('');
  printLine(`Execute-Resultat (${result.success ? '[OK]' : '[FAIL]'}):`);
  for (const r of result.results) renderStepResult(r);
}

function renderStepResult(r: StepResult): void {
  const marker = r.status === 'success' ? '[OK]' : r.status === 'failed' ? '[FAIL]' : '[INFO]';
  printLine(`  ${marker} ${r.message}`);
}

export function registerMigrateCommand(program: Command): void {
  program
    .command('migrate')
    .description('Migriert eine claude-portable v0.x-Installation nach claude-os v1.')
    .requiredOption(
      '--from-portable <path>',
      'Pfad zur bestehenden claude-portable v0.x-Installation (z. B. E:\\claude-portable)',
    )
    .option(
      '--target <path>',
      'Zielroot für die Migration (default: aufgelöster claude-os-Root aus $CLAUDE_OS_ROOT)',
    )
    .option('--plan', 'Nur den Plan ausgeben, keine FS-Mutationen (impliziert kein Execute)')
    .option('--execute', 'Plan ausführen')
    .option('--dry-run', 'Mit --execute kombiniert: nur loggen was passiert wäre')
    .option('--force', 'Auch ausführen wenn Target bereits einen .claude-os-root-Marker hat')
    .option(
      '--overwrite',
      'Bestehende Ziel-Dateien überschreiben (Default: verlustfrei, errored auf Konflikt)',
    )
    .action(async (opts: MigrateOpts, command) => {
      const globalOpts = command.optsWithGlobals() as GlobalOpts;
      const targetRoot = opts.target ?? resolveRoot({ explicit: globalOpts.root }).path;
      const sourceRoot = resolve(opts.fromPortable);

      try {
        const plan = buildMigrationPlan({ sourceRoot, targetRoot });

        // `--plan` ist die stärkere Variante von Dry-Run: keine
        // Mutationen, auch wenn `--execute` zusätzlich gesetzt ist.
        const planOnly = opts.plan === true || opts.execute !== true;

        if (planOnly) {
          if (globalOpts.json === true) {
            printJson({ plan });
          } else {
            renderPlan(plan);
            printLine('');
            if (opts.plan === true && opts.execute === true) {
              printLine(
                '(--plan überschreibt --execute. Mit nur --execute (ohne --plan) ausführen.)',
              );
            } else {
              printLine(
                '(Plan-Only-Modus. Mit --execute ausführen. --dry-run zeigt was passieren würde.)',
              );
            }
          }
          return;
        }

        const result = await executePlan({
          plan,
          force: opts.force === true,
          dryRun: opts.dryRun === true,
          overwrite: opts.overwrite === true,
        });
        if (globalOpts.json === true) {
          printJson({ plan, result });
        } else {
          renderResult(result);
        }
        if (!result.success) process.exit(2);
      } catch (err) {
        if (err instanceof MigrationError) {
          if (globalOpts.json === true) {
            printJson({ error: { code: 'migration-error', message: err.message } });
          } else {
            console.error(`Migrationsfehler: ${err.message}`);
          }
          process.exit(3);
        }
        throw err;
      }
    });
}
