/**
 * Inbox-Namespace RPCs: import.
 * Split aus `sidecar/methods.ts` (M21).
 *
 * @module @sidecar/methods/inbox
 */
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { copyFile as fspCopyFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { RpcDispatcher } from '../rpc.js';
import { canonicalizeRoots, isUnder, type MethodsContext } from './_shared.js';

export function registerInboxMethods(dispatcher: RpcDispatcher, ctx: MethodsContext): void {
  dispatcher.register('inbox.import', async (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { paths?: readonly string[] };
    if (!Array.isArray(params.paths)) {
      throw new Error('inbox.import: params.paths must be a string[]');
    }
    const root = ctx.rootPath();
    const inboxDir = join(root, 'inbox');
    mkdirSync(inboxDir, { recursive: true });

    // C2 (2026-05-21 code-review): Path-traversal + symlink-exfil-Schutz.
    // Vorher konnte ein RPC-caller `inbox.import({paths: ["~/.claude/.credentials.json"]})`
    // rufen, das file ins vault/inbox/ kopieren und via vault-sync git-push
    // exfiltrieren. Fix: lstat (kein symlink-follow) + realpath + deny-list
    // gegen sensitive Roots. Codex-Round-2: denyRoots MUSS canonicalized
    // sein damit ein symlink in `machine.dataDir` oder `home` nicht den
    // isUnder-Vergleich umgeht (canonical src vs non-canonical denyRoot).
    const machine = ctx.machinePaths();
    const h = ctx.home();
    const denyRoots: readonly string[] = canonicalizeRoots([
      machine.dataDir,
      join(h, '.claude'),
      root,
    ]);

    const stamp = new Date().toISOString().replaceAll(':', '-');
    const written: string[] = [];
    let counter = 0;
    for (const src of params.paths) {
      if (typeof src !== 'string' || src.length === 0) {
        throw new Error(`inbox.import: each path must be a non-empty string, got ${typeof src}`);
      }
      // lstat (NICHT stat) — symlink-target wird NICHT gefolgt.
      let lstatInfo: ReturnType<typeof lstatSync>;
      try {
        lstatInfo = lstatSync(src);
      } catch (err) {
        throw new Error(
          `inbox.import: cannot stat "${src}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (lstatInfo.isSymbolicLink()) {
        throw new Error(`inbox.import: refusing to copy symlink "${src}"`);
      }
      if (!lstatInfo.isFile()) {
        throw new Error(`inbox.import: not a regular file: "${src}"`);
      }
      // Canonical path zur deny-root-Pruefung. realpathSync auf einem
      // nicht-Symlink ist idempotent + macht relative paths absolut.
      let canonical: string;
      try {
        canonical = realpathSync(src);
      } catch (err) {
        throw new Error(
          `inbox.import: realpath failed for "${src}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      for (const denyRoot of denyRoots) {
        if (isUnder(canonical, denyRoot)) {
          throw new Error(
            `inbox.import: refusing to copy from sensitive root "${canonical}" (under "${denyRoot}")`,
          );
        }
      }
      // Codex-Round-2 finding: per-file counter im Stamp verhindert dass
      // zwei Sources mit gleichem basename (z. B. `C:\a\note.md` + `C:\b\note.md`)
      // dasselbe dest produzieren — sonst ueberschreibt der zweite den
      // ersten silent.
      counter += 1;
      const dest = join(inboxDir, `${stamp}-${counter}-${basename(src)}`);
      await fspCopyFile(canonical, dest);
      written.push(dest);
    }
    return { count: written.length, paths: written };
  });
}
