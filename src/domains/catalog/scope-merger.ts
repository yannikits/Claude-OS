/**
 * ScopeMerger — produces an effective view of two scope roots per
 * ADR-0009 §29:
 *
 *   userRoot     (e.g. ~/.claude/)         — defaults for the user
 *   projectRoot  (e.g. <vault>/.claude/)   — project-local overrides
 *
 * On overlap, the project entry wins. Both roots are walked recursively
 * with directory paths normalised to forward-slash relative paths so
 * tests and presenters are platform-stable.
 *
 * @module @domains/catalog/scope-merger
 */
import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';

export type Scope = 'user' | 'project';

export interface ScopedFile {
  /** Forward-slash relative path against the originating scope root. */
  readonly relPath: string;
  readonly scope: Scope;
  /** Absolute path to the source file. */
  readonly absolutePath: string;
}

export interface MergeOpts {
  readonly userRoot?: string;
  readonly projectRoot?: string;
}

function normaliseRel(rel: string): string {
  return rel.replaceAll('\\', '/');
}

function walkFiles(root: string): { rel: string; abs: string }[] {
  if (!existsSync(root)) return [];
  const out: { rel: string; abs: string }[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true, encoding: 'utf8' }) as Dirent[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        out.push({ rel: normaliseRel(relative(root, abs)), abs });
      }
    }
  }
  return out;
}

/**
 * Returns the merged scope view sorted by relPath. Project entries
 * override user entries for identical relPaths. Each file appears
 * exactly once with the scope flag indicating its origin.
 */
export function mergeScopes(opts: MergeOpts): readonly ScopedFile[] {
  const effective = new Map<string, ScopedFile>();
  if (opts.userRoot !== undefined) {
    for (const f of walkFiles(opts.userRoot)) {
      effective.set(f.rel, { relPath: f.rel, scope: 'user', absolutePath: f.abs });
    }
  }
  if (opts.projectRoot !== undefined) {
    for (const f of walkFiles(opts.projectRoot)) {
      effective.set(f.rel, { relPath: f.rel, scope: 'project', absolutePath: f.abs });
    }
  }
  return [...effective.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/** Returns true when `relPath` resolves to a real file under either root. */
export function existsInAnyScope(relPath: string, opts: MergeOpts): boolean {
  if (opts.projectRoot !== undefined) {
    const abs = join(opts.projectRoot, relPath);
    if (existsSync(abs)) {
      try {
        if (statSync(abs).isFile()) return true;
      } catch {
        /* fallthrough */
      }
    }
  }
  if (opts.userRoot !== undefined) {
    const abs = join(opts.userRoot, relPath);
    if (existsSync(abs)) {
      try {
        if (statSync(abs).isFile()) return true;
      } catch {
        /* fallthrough */
      }
    }
  }
  return false;
}
