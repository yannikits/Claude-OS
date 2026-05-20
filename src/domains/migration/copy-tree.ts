/**
 * Cross-platform recursive directory copy mit Exclude-Patterns.
 *
 * `robocopy` ist Windows-only; wir nutzen `fs.cp` (Node 20+ native)
 * mit eigenem filter-Callback der die Exclude-Patterns prüft. Das
 * funktioniert auf Windows, macOS und Linux einheitlich.
 *
 * Sicherheits-Defaults (nach Codex-Adversarial-Review 2026-05-20):
 *  - `overwrite: false` als Default: bestehende Dateien am Ziel werden
 *    NICHT überschrieben; Kopien gehen nur an neue Pfade. Mit
 *    `overwrite: true` lässt sich der alte Modus zurückholen.
 *  - Symlinks werden NICHT dereferenziert (`fs.cp(...,
 *    {verbatimSymlinks: true})`) — sie bleiben Links und folgen
 *    nicht in fremde Verzeichnisse.
 *  - Quell- und Zielpfad werden in `runner.ts` auf Overlap geprüft
 *    BEVOR `copyTree` aufgerufen wird (siehe `assertNoOverlap`).
 *  - Exclude-Matching ist auf Windows case-insensitiv (sonst sind
 *    `.GIT` oder `Cache` Bypasses für `.git` / `cache`).
 *
 * @module @domains/migration/copy-tree
 */
import { cp, stat } from 'node:fs/promises';
import { platform } from 'node:os';
import { relative, sep } from 'node:path';

const IS_WINDOWS = platform() === 'win32';
const REGEX_SPECIALS = '.+?^()|[]\\';

/** Wandelt ein Glob-Pattern in ein Regex um. `*` matched alles
 *  außer `/`, `**` matched cross-segment. Andere Regex-Specials
 *  werden korrekt escaped. */
function globToRegex(pat: string): RegExp {
  let body = '';
  let i = 0;
  while (i < pat.length) {
    const ch = pat[i] ?? '';
    if (ch === '*' && pat[i + 1] === '*') {
      body += '.*';
      i += 2;
    } else if (ch === '*') {
      body += '[^/]*';
      i += 1;
    } else if (REGEX_SPECIALS.includes(ch)) {
      body += `\\${ch}`;
      i += 1;
    } else {
      body += ch;
      i += 1;
    }
  }
  return new RegExp(`^${body}$`);
}

/**
 * Glob-ähnlicher Matcher — unterstützt `*` (matched alles ohne /),
 * `**` (matched über mehrere Pfad-Segmente) und Subtree-Prefix-Match.
 * Auf Windows case-insensitiv (FS ist es auch).
 */
function matchesAny(relPath: string, patterns: readonly string[]): boolean {
  const normalised = (IS_WINDOWS ? relPath.toLowerCase() : relPath).split(sep).join('/');
  for (const raw of patterns) {
    let pat = raw.replace(/\\/g, '/').replace(/\/$/, '');
    if (IS_WINDOWS) pat = pat.toLowerCase();
    if (normalised === pat) return true;
    if (normalised.startsWith(`${pat}/`)) return true;
    if (pat.includes('*') && globToRegex(pat).test(normalised)) return true;
  }
  return false;
}

export interface CopyTreeOpts {
  readonly source: string;
  readonly destination: string;
  readonly exclude: readonly string[];
  /**
   * Wenn `false` (Default), schlägt `copyTree` fehl falls Ziel-Dateien
   * bereits existieren würden (verlustfreies Default). Mit `true`
   * werden bestehende Dateien überschrieben — nur explizit setzen.
   */
  readonly overwrite?: boolean;
}

export interface CopyTreeStats {
  readonly filesCopied: number;
  readonly bytesCopied: number;
  readonly filesSkipped: number;
  readonly excludedPaths: readonly string[];
}

/**
 * Kopiert `source/` rekursiv nach `destination/`. Bestehende Dateien
 * am Ziel werden bei `overwrite: false` (Default) NICHT überschrieben —
 * fs.cp wirft dann auf ersten Treffer und der Caller bekommt den
 * Fehler propagiert. Caller kann `overwrite: true` setzen wenn explizit
 * gewollt.
 */
export async function copyTree(opts: CopyTreeOpts): Promise<CopyTreeStats> {
  const { source, destination, exclude, overwrite = false } = opts;
  let filesCopied = 0;
  let bytesCopied = 0;
  let filesSkipped = 0;
  const excludedPaths: string[] = [];

  await cp(source, destination, {
    recursive: true,
    force: overwrite,
    errorOnExist: !overwrite,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    filter: (sourcePath) => {
      const rel = relative(source, sourcePath);
      if (rel === '' || rel === '.') return true;
      if (matchesAny(rel, exclude)) {
        excludedPaths.push(rel);
        return false;
      }
      return true;
    },
  });

  // Statistik nach-erfassen — fs.cp gibt selber keinen Counter zurück.
  for await (const entry of walkAsync(destination)) {
    try {
      const s = await stat(entry);
      if (s.isFile()) {
        filesCopied++;
        bytesCopied += s.size;
      }
    } catch {
      filesSkipped++;
    }
  }

  return { filesCopied, bytesCopied, filesSkipped, excludedPaths };
}

async function* walkAsync(root: string): AsyncGenerator<string> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      const full = path.join(current, d.name);
      if (d.isDirectory()) {
        stack.push(full);
      } else if (d.isFile()) {
        yield full;
      }
    }
  }
}
