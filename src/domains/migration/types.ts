/**
 * Type-Definitionen für die `migrate --from-portable`-Domain
 * (Auftrag 1c v1.5).
 *
 * Drei zentrale Begriffe:
 *  - `PortableSource` ist eine entdeckte claude-portable-v0.x-Installation
 *    (Pfade zu vault/, config/, .env-Dateien).
 *  - `MigrationPlan` ist die geplante Mutationsmenge — was kopiert,
 *    was übersprungen, welche Secrets müssen interaktiv überführt werden.
 *  - `MigrationResult` ist das Ergebnis nach Ausführung (mit Logs und
 *    konkret kopierten Dateigrößen).
 *
 * Bewusst keine Anbindung an die echten claude-os-Domains hier —
 * `types.ts` bleibt rein und kann von CLI-Layer und Tests gleich
 * importiert werden.
 *
 * @module @domains/migration/types
 */

/** Verzeichnislayout, das eine v0.x-Installation erfüllen muss. */
export interface PortableSource {
  /** Root-Pfad zur claude-portable-v0.x-Installation. */
  readonly root: string;
  /** `<root>/vault` falls vorhanden, sonst null. */
  readonly vaultDir: string | null;
  /** `<root>/config` falls vorhanden, sonst null. */
  readonly configDir: string | null;
  /** Liste gefundener .env-Dateien (mit relativem Pfad ab `root`). */
  readonly envFiles: readonly string[];
  /** Versions-Hinweis (z. B. aus `package.json` oder leeres `'unknown'`). */
  readonly detectedVersion: string;
  /** Optionale Warnungen, die bei der Discovery aufgefallen sind. */
  readonly warnings: readonly string[];
}

/**
 * Ein einzelner Schritt des Migrationsplans. Schritte sind atomar
 * (entweder ganz oder gar nicht ausgeführt). Reihenfolge ist die
 * Reihenfolge der Ausführung.
 */
export type PlanStepKind = 'copy-tree' | 'migrate-git-metadata' | 'collect-secrets';

export interface CopyTreeStep {
  readonly kind: 'copy-tree';
  readonly source: string;
  readonly destination: string;
  /** Glob-Patterns (relativ zum Source), die NICHT kopiert werden. */
  readonly exclude: readonly string[];
  readonly label: string;
}

export interface MigrateGitMetadataStep {
  readonly kind: 'migrate-git-metadata';
  /** Zielroot, in dem `doctor --migrate-git-metadata` läuft. */
  readonly target: string;
}

export interface CollectSecretsStep {
  readonly kind: 'collect-secrets';
  /** Liste der gefundenen Secret-Keys (KEINE Values!). */
  readonly keys: readonly string[];
  /** Pfade der .env-Files, aus denen die Keys stammen. */
  readonly sources: readonly string[];
}

export type PlanStep = CopyTreeStep | MigrateGitMetadataStep | CollectSecretsStep;

export interface MigrationPlan {
  readonly source: PortableSource;
  /** Zielroot für die Migration (im Cloud-Mount). */
  readonly target: string;
  readonly steps: readonly PlanStep[];
  /** Findings, die der User vor Execute zur Kenntnis nehmen sollte. */
  readonly notes: readonly string[];
  /** Wenn `true`, ist das Target bereits eine valide claude-os-Installation. */
  readonly targetAlreadyMigrated: boolean;
}

/** Resultat eines einzelnen Plan-Schritts nach Execute. */
export interface StepResult {
  readonly step: PlanStep;
  /**
   * M29 (2026-05-21 code-review): `'aborted'` markiert Schritte die nach
   * einem vorherigen `failed`-Step uebersprungen wurden — vorher
   * surfaceten sie als `'skipped'` was wie ein dry-run aussah.
   */
  readonly status: 'success' | 'skipped' | 'failed' | 'aborted';
  readonly message: string;
  /** Anzahl kopierter Files (nur bei copy-tree gefüllt). */
  readonly filesCopied?: number;
  /** Anzahl summierter Bytes (nur bei copy-tree gefüllt). */
  readonly bytesCopied?: number;
}

export interface MigrationResult {
  readonly plan: MigrationPlan;
  readonly results: readonly StepResult[];
  /** Liste aller unbekannten Felder (key → Quelle), die beim Parsen
   *  gefunden wurden. Werden NICHT verworfen, sondern gemeldet. */
  readonly unknownFields: readonly { readonly key: string; readonly source: string }[];
  readonly success: boolean;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}
