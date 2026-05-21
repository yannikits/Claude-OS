/**
 * Shared CLI output + root-resolution helpers (M19 + M22, 2026-05-21
 * code-review).
 *
 * Vorher: jedes `src/cli/commands/*.ts` (11 Dateien) hatte eine eigene
 * Kopie von `GlobalOpts`/`printJson`/`printLine`/`printErr` plus den
 * `resolveRoot + try/catch (RootNotFoundError)`-Block in mehreren
 * action-Handlern. Drift-Risk: ein Fix in einer Datei propagierte
 * nicht in die anderen.
 *
 * Diese Datei konsolidiert die 4 Helpers + den resolveRoot-Wrapper.
 * Konvention: alle CLI-Commands importieren von hier; lokale Kopien
 * werden entfernt.
 *
 * @module @cli/output
 */
import { type ResolvedRoot, RootNotFoundError, resolveRoot } from '../core/environment/index.js';

export interface GlobalOpts {
  readonly root?: string;
  readonly json?: boolean;
}

export function printJson(payload: unknown): void {
  // biome-ignore lint/suspicious/noConsole: CLI presenter output by design
  console.log(JSON.stringify(payload, null, 2));
}

export function printLine(line: string): void {
  // biome-ignore lint/suspicious/noConsole: CLI presenter output by design
  console.log(line);
}

export function printErr(line: string): void {
  console.error(line);
}

/**
 * Resolves the cloud-mount root via `resolveRoot`. Wenn
 * `RootNotFoundError` geworfen wird, druckt eine user-friendly
 * Error-Message mit dem command-name als Prefix und beendet den
 * Prozess mit exit-code 1. Alle anderen Errors werden weitergeworfen.
 *
 * Use: `const root = resolveRootOrExit(globals, "catalog install")`.
 */
export function resolveRootOrExit(globals: GlobalOpts, commandName: string): ResolvedRoot {
  try {
    return resolveRoot(globals.root === undefined ? {} : { explicit: globals.root });
  } catch (err) {
    if (err instanceof RootNotFoundError) {
      printErr(`${commandName}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
