/**
 * Safe tar.extract wrapper — verhindert symlink/hardlink-Schreibversuche
 * und Pfad-Traversal beim Auspacken von Plugin-Tarballs aus dem
 * Marketplace / GitHub.
 *
 * Threat-Modell (C3 Code-Review-Session 2026-05-21):
 *   Ein malicious tarball aus `marketplace:` oder `github:owner/repo`
 *   kann Symlinks (`bad -> /`) und Hardlinks shippen. Default-`tar.extract`
 *   folgt Symlinks bei Folge-Entries (CVE-2024-28863-Familie) und kann
 *   ausserhalb von `destination` schreiben.
 *
 * Mitigation:
 *   - Per-Entry `filter` rejected `SymbolicLink`/`Link`/`..`-Pfade BEVOR
 *     sie auf Disk landen — verworfene Entries werden gesammelt und
 *     nach `extract` als Fehler geworfen.
 *   - `preserveOwner: false` — kein uid/gid-Restore.
 *   - `unlink: true` — overwrite via unlink+create statt write-through
 *     (extra Schutz gegen pre-existing-symlink-target).
 *
 * @module @domains/catalog/safe-tar-extract
 */
import { rmSync } from 'node:fs';
import { extract as tarExtract } from 'tar';

export class UnsafeTarballError extends Error {
  constructor(
    message: string,
    public readonly violations: readonly string[],
  ) {
    super(message);
    this.name = 'UnsafeTarballError';
  }
}

export interface SafeExtractOpts {
  /** Absoluter Pfad zum Tarball. */
  readonly file: string;
  /** Extraktions-Verzeichnis. */
  readonly cwd: string;
  /** Strip-N-Components (siehe tar `strip`). Default 0. */
  readonly strip?: number;
  /**
   * Wenn true und `UnsafeTarballError` geworfen wird, wird der Inhalt
   * von `cwd` rekursiv geloescht — verhindert partial-extracted clean
   * entries auf Disk wenn der Tarball Bad-Entries enthielt. Default
   * false (caller darf entscheiden ob das dest exklusiv fuer den Pull
   * gehoert).
   */
  readonly cleanupOnFailure?: boolean;
}

/**
 * Wraps `tar.extract` mit Security-Filter. Wirft `UnsafeTarballError`
 * wenn der Tarball verbotene Entries enthielt; ggf. wurden vorherige
 * "saubere" Entries zwar geschrieben, aber NIE durch einen Symlink
 * gefolgt.
 */
export async function safeExtractTar(opts: SafeExtractOpts): Promise<void> {
  const violations: string[] = [];
  await tarExtract({
    file: opts.file,
    cwd: opts.cwd,
    strip: opts.strip ?? 0,
    preserveOwner: false,
    unlink: true,
    filter: (path, stat) => {
      // ALLOW-list (statt vorher Deny-list): nur File/Directory/
      // GNULongPath sind erlaubt. Alles andere (SymbolicLink, Link
      // (hardlink), CharacterDevice, BlockDevice, FIFO, ContiguousFile,
      // GNUSparse, unbekannte Typen) wird abgelehnt — Codex-Round-2
      // finding: Deny-list erlaubt zukuenftige Tar-Type-Varianten.
      const type = (stat as { type?: string }).type ?? 'File';
      if (type !== 'File' && type !== 'Directory' && type !== 'GNULongPath') {
        violations.push(`forbidden-type ${type}: ${path}`);
        return false;
      }
      // Strip-Components passiert NACH filter; pruefe ../-Segmente vor
      // strip.
      const segments = path.split(/[/\\]/);
      if (segments.some((s) => s === '..')) {
        violations.push(`parent-dir-segment: ${path}`);
        return false;
      }
      // Absolute paths — tar v7 lehnt sie standardmaessig ab, aber doppelt
      // genaeht haelt besser. `/etc/passwd` oder `C:\Windows\...` würde
      // hier gefangen werden.
      if (path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path)) {
        violations.push(`absolute-path: ${path}`);
        return false;
      }
      return true;
    },
  });
  if (violations.length > 0) {
    if (opts.cleanupOnFailure === true) {
      // Loesche alle bereits geschriebenen clean-entries — verhindert
      // partial-extract-state auf Disk. Caller muss garantieren dass
      // cwd exklusiv fuer diese Extraktion ist.
      try {
        rmSync(opts.cwd, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
    const preview = violations.slice(0, 5).join(', ');
    const suffix = violations.length > 5 ? ` (…+${violations.length - 5} more)` : '';
    throw new UnsafeTarballError(
      `tarball "${opts.file}" contained ${violations.length} forbidden entries: ${preview}${suffix}`,
      violations,
    );
  }
}
