/**
 * Migration-Runner — orchestriert den `claude-os migrate --from-portable`-
 * Flow.
 *
 * Phase 1 (plan): discoverPortable() + scanEnvFiles() + Plan-Bau, keine
 * FS-Mutationen. Output: `MigrationPlan` + Notes.
 *
 * Phase 2 (execute): geht die Plan-Steps sequenziell durch, ruft pro
 * `copy-tree`-Step `copyTree()` auf, bei `collect-secrets` werden die
 * Keys nur ausgegeben (User-Action: `claude-os secrets set <key>`),
 * `migrate-git-metadata` ist eine Pointer-Notification (echte
 * Migration läuft via separates `doctor --migrate-git-metadata`).
 *
 * Idempotenz: wenn das Ziel bereits eine valide claude-os-Installation
 * ist (Marker-File `.claude-os-root` vorhanden), markiert der Plan-
 * Builder das mit `targetAlreadyMigrated: true`. Der CLI-Layer
 * entscheidet ob er den Lauf abbricht oder ob `--force` weitermacht.
 *
 * Unbekannte Felder aus .env-Parsing landen in `unknownFields` der
 * Result-Struktur — NIE verworfen.
 *
 * @module @domains/migration/runner
 */
import { existsSync, realpathSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const IS_WINDOWS = platform() === 'win32';

import { type CopyTreeStats, copyTree } from './copy-tree.js';
import { discoverPortable } from './portable-discovery.js';
import { scanEnvFiles } from './secrets-collector.js';
import {
  MigrationError,
  type MigrationPlan,
  type MigrationResult,
  type PlanStep,
  type StepResult,
} from './types.js';

const CONFIG_EXCLUDE: readonly string[] = [
  'cache',
  'cache/**',
  'downloads',
  'downloads/**',
  'file-history',
  'file-history/**',
  'metrics',
  'metrics/**',
  'mcp-health-cache.json',
  'mcp-needs-auth-cache.json',
  'settings.local.json',
  'plugins/cache',
  'plugins/cache/**',
];

const VAULT_EXCLUDE: readonly string[] = ['.git', '.git/**'];

const ROOT_MARKER = '.claude-os-root';

/**
 * Resolved einen Pfad konsistent über existente und nicht-existente
 * Inputs: bei existierendem Pfad via `realpathSync.native` (löst
 * Symlinks UND Windows-8.3-Shortnames); bei nicht-existentem Pfad
 * wandert man die Hierarchie hoch bis zum ersten existenten Vorfahren,
 * resolved den, und hängt die Rest-Segmente an. So vergleichen wir
 * immer canonical forms gegen canonical forms.
 */
function safeResolve(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) {
    try {
      return realpathSync.native(abs);
    } catch {
      return abs;
    }
  }
  let parent = dirname(abs);
  let suffix = abs.slice(parent.length);
  while (parent !== dirname(parent) && !existsSync(parent)) {
    suffix = parent.slice(dirname(parent).length) + suffix;
    parent = dirname(parent);
  }
  try {
    return realpathSync.native(parent) + suffix;
  } catch {
    return abs;
  }
}

function caseNorm(p: string): string {
  return IS_WINDOWS ? p.toLowerCase() : p;
}

/**
 * Verbietet Source/Target-Overlap (gleicher Pfad, einer im anderen
 * verschachtelt) — verhindert Selbst-Überschreiben oder rekursive
 * Endlos-Kopien.
 */
function assertNoOverlap(sourceRoot: string, targetRoot: string): void {
  const src = caseNorm(safeResolve(sourceRoot));
  const dst = caseNorm(safeResolve(targetRoot));
  if (src === dst) {
    throw new MigrationError(`Quelle und Ziel sind identisch (${src}). Migration verboten.`);
  }
  const srcNorm = src.endsWith(sep) ? src : src + sep;
  const dstNorm = dst.endsWith(sep) ? dst : dst + sep;
  if (dstNorm.startsWith(srcNorm)) {
    throw new MigrationError(
      `Ziel ${dst} liegt innerhalb der Quelle ${src}. Würde Selbst-Kopie auslösen.`,
    );
  }
  if (srcNorm.startsWith(dstNorm)) {
    throw new MigrationError(
      `Quelle ${src} liegt innerhalb des Ziels ${dst}. Würde Daten überschreiben.`,
    );
  }
}

export interface BuildPlanOpts {
  readonly sourceRoot: string;
  readonly targetRoot: string;
}

export function buildMigrationPlan(opts: BuildPlanOpts): MigrationPlan {
  assertNoOverlap(opts.sourceRoot, opts.targetRoot);
  const source = discoverPortable(opts.sourceRoot);
  const targetAlreadyMigrated = existsSync(join(opts.targetRoot, ROOT_MARKER));
  const steps: PlanStep[] = [];
  const notes: string[] = [];

  for (const w of source.warnings) notes.push(`(discovery) ${w}`);

  if (source.vaultDir !== null) {
    steps.push({
      kind: 'copy-tree',
      source: source.vaultDir,
      destination: join(opts.targetRoot, 'vault'),
      exclude: VAULT_EXCLUDE,
      label: 'vault/',
    });
  }
  if (source.configDir !== null) {
    steps.push({
      kind: 'copy-tree',
      source: source.configDir,
      destination: join(opts.targetRoot, 'config'),
      exclude: CONFIG_EXCLUDE,
      label: 'config/',
    });
  }

  if (source.vaultDir !== null) {
    steps.push({ kind: 'migrate-git-metadata', target: opts.targetRoot });
    notes.push(
      'Nach Execute: `claude-os doctor --migrate-git-metadata` ausführen — verschiebt vault/.git nach %APPDATA%/claude-os.',
    );
  }

  const envScan = scanEnvFiles(source.root, source.envFiles);
  if (envScan.keys.length > 0) {
    steps.push({
      kind: 'collect-secrets',
      keys: envScan.keys,
      sources: source.envFiles,
    });
    notes.push(
      `${envScan.keys.length} Secret-Key(s) in ${source.envFiles.length} .env-File(s) gefunden — Values niemals automatisch übertragen. Anschließend mit \`claude-os secrets set <key>\` einspeisen.`,
    );
  }
  for (const unknown of envScan.unknownLines) {
    notes.push(
      `(env-parse) unbekannte Zeile in ${unknown.source}: ${unknown.line.slice(0, 80)}${unknown.line.length > 80 ? '...' : ''}`,
    );
  }

  if (targetAlreadyMigrated) {
    notes.push(
      `Ziel ${opts.targetRoot} hat bereits einen .claude-os-root-Marker — Migration wäre re-run. Mit --force ausführen falls absichtlich.`,
    );
  }

  return {
    source,
    target: opts.targetRoot,
    steps,
    notes,
    targetAlreadyMigrated,
  };
}

export interface ExecutePlanOpts {
  readonly plan: MigrationPlan;
  /** Wenn `true`, wird auch dann ausgeführt wenn Target bereits einen Marker hat. */
  readonly force?: boolean;
  /** Wenn `true`, werden die Plan-Steps nur durchlaufen aber nicht ausgeführt. */
  readonly dryRun?: boolean;
  /**
   * Wenn `true`, dürfen bestehende Ziel-Dateien überschrieben werden.
   * Default `false` (verlustfreies Default per Codex-Adversarial-Review).
   */
  readonly overwrite?: boolean;
}

export async function executePlan(opts: ExecutePlanOpts): Promise<MigrationResult> {
  const { plan, force = false, dryRun = false, overwrite = false } = opts;

  // Re-check marker zum Execute-Zeitpunkt — Plan-Bau war evtl. vor
  // Minuten, in der Zwischenzeit könnte jemand das Target initialisiert
  // haben (TOCTOU-Schutz aus Codex-Review).
  const markerExistsNow = existsSync(join(plan.target, ROOT_MARKER));
  if (markerExistsNow && !force) {
    throw new MigrationError(
      `Ziel ${plan.target} ist bereits migriert (.claude-os-root vorhanden). --force erforderlich für Re-Migration.`,
    );
  }

  // Re-Check Overlap auch zum Execute-Zeitpunkt (Symlinks könnten sich
  // geändert haben).
  assertNoOverlap(plan.source.root, plan.target);

  // M29 (2026-05-21 code-review): nach einem `failed`-Step werden
  // Folge-Steps NICHT mehr ausgefuehrt, sondern als `'aborted'`
  // markiert. Vorher liefen sie weiter und retournten `'skipped'` was
  // dry-run-Output identisch sah — User dachte alles waere OK.
  const results: StepResult[] = [];
  let aborted = false;
  for (const step of plan.steps) {
    if (aborted) {
      results.push({
        step,
        status: 'aborted',
        message: 'uebersprungen — vorheriger Schritt ist fehlgeschlagen',
      });
      continue;
    }
    const result = await runStep(step, dryRun, overwrite);
    results.push(result);
    if (result.status === 'failed') aborted = true;
  }
  const success = results.every((r) => r.status !== 'failed' && r.status !== 'aborted');
  return {
    plan,
    results,
    unknownFields: [],
    success,
  };
}

async function runStep(step: PlanStep, dryRun: boolean, overwrite: boolean): Promise<StepResult> {
  if (dryRun) {
    return {
      step,
      status: 'skipped',
      message: `dry-run — würde ausgeführt: ${describeStep(step)}`,
    };
  }
  switch (step.kind) {
    case 'copy-tree': {
      try {
        const stats = await copyTree({
          source: step.source,
          destination: step.destination,
          exclude: step.exclude,
          overwrite,
        });
        return {
          step,
          status: 'success',
          message: `${step.label} → ${step.destination} (${stats.filesCopied} Files, ${formatBytes(stats.bytesCopied)})`,
          filesCopied: stats.filesCopied,
          bytesCopied: stats.bytesCopied,
        };
      } catch (err) {
        return {
          step,
          status: 'failed',
          message: `copy-tree fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    case 'migrate-git-metadata':
      return {
        step,
        status: 'skipped',
        message: `Hinweis: manuell ausführen — claude-os doctor --migrate-git-metadata (Target: ${step.target})`,
      };
    case 'collect-secrets':
      return {
        step,
        status: 'skipped',
        message: `${step.keys.length} Secret-Key(s) gefunden: ${step.keys.join(', ')}. Mit \`claude-os secrets set <key>\` interaktiv übertragen.`,
      };
  }
}

function describeStep(step: PlanStep): string {
  switch (step.kind) {
    case 'copy-tree':
      return `copy ${step.source} → ${step.destination} (exclude ${step.exclude.length} Patterns)`;
    case 'migrate-git-metadata':
      return `doctor --migrate-git-metadata in ${step.target}`;
    case 'collect-secrets':
      return `secrets prompt für ${step.keys.length} Keys aus ${step.sources.length} .env-Files`;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Helper für Tests + CLI — re-export für externe Verifikation.
export type { CopyTreeStats };
export type ExecutedPlanOpts = ExecutePlanOpts;
