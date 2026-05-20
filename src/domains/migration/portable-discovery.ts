/**
 * Discovery für claude-portable-v0.x-Installationen.
 *
 * Verifiziert ob ein gegebener Pfad ein v0.x-Layout enthält und
 * sammelt alle Informationen, die der Plan-Builder anschließend
 * für den `MigrationPlan` braucht.
 *
 * Bewusst lenient: fehlende Sub-Verzeichnisse sind Warnings, kein
 * Hard-Error — auf USB-Sticks waren historisch unterschiedlich
 * vollständige Setups in Umlauf. Der Plan-Builder entscheidet
 * dann, was er mit den fehlenden Teilen macht.
 *
 * `package.json` wird probeweise gelesen um die Version zu
 * ermitteln; wenn nicht vorhanden oder kaputt, gibt's `unknown`.
 *
 * @module @domains/migration/portable-discovery
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { MigrationError, type PortableSource } from './types.js';

const ENV_FILE_NAMES = new Set(['.env', '.env.local', '.env.development', '.env.production']);
const VERSION_FALLBACK = 'unknown';

function isExistingDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readPackageVersion(root: string): string {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return VERSION_FALLBACK;
  try {
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // ignore — fallback below
  }
  return VERSION_FALLBACK;
}

function walkForEnvFiles(root: string, depthLimit = 4): string[] {
  const found: string[] = [];
  const stack: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(entry.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(entry.path, e.name);
      if (e.isDirectory()) {
        if (entry.depth >= depthLimit) continue;
        if (
          e.name === 'node_modules' ||
          e.name === '.git' ||
          e.name === 'vault' ||
          e.name === 'bin'
        ) {
          continue;
        }
        stack.push({ path: full, depth: entry.depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      if (ENV_FILE_NAMES.has(e.name) || extname(e.name) === '.env') {
        found.push(relative(root, full));
      }
    }
  }
  return found.sort();
}

/**
 * Inspiziert `root` auf ein v0.x-claude-portable-Layout.
 *
 * Wirft `MigrationError` wenn der Pfad nicht existiert oder
 * gar keine v0.x-typischen Marker gefunden werden (kein vault/,
 * kein config/, keine start.bat). Sonst gibt's eine
 * `PortableSource`-Struktur mit den entdeckten Pfaden und Warnings.
 */
export function discoverPortable(root: string): PortableSource {
  if (!isExistingDir(root)) {
    throw new MigrationError(`Quellpfad existiert nicht oder ist kein Verzeichnis: ${root}`);
  }
  const vaultDir = isExistingDir(join(root, 'vault')) ? join(root, 'vault') : null;
  const configDir = isExistingDir(join(root, 'config')) ? join(root, 'config') : null;
  const hasStart =
    existsSync(join(root, 'start.bat')) ||
    existsSync(join(root, 'start.ps1')) ||
    existsSync(join(root, 'setup.bat'));

  const warnings: string[] = [];
  if (vaultDir === null) warnings.push('vault/ nicht gefunden — Daten-Migration entfällt');
  if (configDir === null) warnings.push('config/ nicht gefunden — Catalog-Migration entfällt');
  if (!hasStart && vaultDir === null && configDir === null) {
    throw new MigrationError(
      `Pfad ${root} enthält weder vault/ noch config/ noch einen claude-portable-Launcher — vermutlich kein v0.x-Layout`,
    );
  }
  if (!hasStart) warnings.push('Keine start.bat/start.ps1/setup.bat gefunden (USB-Launcher)');

  const envFiles = walkForEnvFiles(root);
  const detectedVersion = readPackageVersion(root);
  return {
    root,
    vaultDir,
    configDir,
    envFiles,
    detectedVersion,
    warnings,
  };
}
