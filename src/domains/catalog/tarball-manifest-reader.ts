/**
 * tarball-manifest-reader — extracts a `plugin.json` manifest from a
 * cached tarball without doing a full disk extract.
 *
 * Closes the Phase 5o v1-simplification: previously `lockCatalog`
 * emitted `bindings: []` because the resolver had no access to each
 * plugin's `requires` / `provides`. This module peeks into the cached
 * `.tar.gz` via `tar.list` + `onentry` and returns a parsed
 * `PluginManifest` (or `null` when the entry simply doesn't carry a
 * manifest — skills and mcp entries are leaves and don't need one).
 *
 * Conventions:
 *   - GitHub tarballs always nest under one wrapper directory
 *     `<repo>-<sha>/`. We default to `stripComponents = 1` so callers
 *     get the same view as `sync-applier`'s extract.
 *   - The first matching `plugin.json` wins (a plugin should only ship
 *     one). Defensive against odd archives with multiple — first one
 *     in tar-order is returned, the rest are ignored silently.
 *   - JSON-parse errors and schema-validation failures resolve as
 *     `{ ok: false, reason }` so callers can attach the reason to the
 *     `LockBuilder` warnings array.
 *
 * @module @domains/catalog/tarball-manifest-reader
 */
import { Type } from '@sinclair/typebox';
import { list as tarList } from 'tar';
import { assertValid, ValidationError } from '../../core/validation/index.js';
import type { PluginManifest } from './capability-resolver.js';

/** Manifest schema kept deliberately small — matches ADR-0010 §27. */
const ManifestSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[A-Za-z0-9._-]+$', minLength: 1, maxLength: 256 }),
    version: Type.String({ pattern: '^\\d+(?:\\.\\d+){0,2}$' }),
    requires: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 256 }),
    ),
    provides: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 256 }),
    ),
  },
  { additionalProperties: true },
);

const MANIFEST_BASENAME = 'plugin.json';

export type ManifestReadResult =
  | { readonly ok: true; readonly manifest: PluginManifest }
  | { readonly ok: false; readonly reason: string };

/**
 * Sentinel `reason` string callers use to distinguish "no manifest in
 * archive" from "manifest present but malformed". Exposed separately so
 * callers can match against the literal without type narrowing through
 * the discriminated union.
 */
export const NO_MANIFEST_REASON = 'tarball does not contain a plugin.json entry';

/** No manifest in the archive — distinct from a malformed one. */
export const NO_MANIFEST: ManifestReadResult = {
  ok: false,
  reason: NO_MANIFEST_REASON,
};

export interface ReadOpts {
  /** Number of leading path components to strip. Default 1 (github wrapper). */
  readonly stripComponents?: number;
}

function stripPath(p: string, strip: number): string | null {
  // Normalise to forward slashes (tar uses POSIX paths even on Windows).
  const parts = p
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg.length > 0);
  if (parts.length <= strip) return null;
  return parts.slice(strip).join('/');
}

/**
 * Streams the cached tarball and returns the first `plugin.json` it
 * encounters, parsed + schema-validated.
 *
 * Resolves to:
 *   - `{ ok: true, manifest }` on success
 *   - `{ ok: false, reason }` when the manifest is missing or invalid
 *
 * Rejects only on I/O errors against the tar file itself.
 */
export async function readPluginManifestFromTarball(
  tarballPath: string,
  opts: ReadOpts = {},
): Promise<ManifestReadResult> {
  const strip = opts.stripComponents ?? 1;
  const chunks: Buffer[] = [];
  let captured = false;
  let captureDone = false;

  await tarList({
    file: tarballPath,
    onentry: (entry) => {
      if (captured) {
        entry.resume();
        return;
      }
      const type = entry.type;
      // tar v7 emits File / OldFile / NextFileHasLongLinkpath etc. We
      // only care about regular file payloads.
      if (type !== 'File' && type !== 'OldFile' && type !== 'ContiguousFile') {
        entry.resume();
        return;
      }
      const stripped = stripPath(String(entry.path), strip);
      if (stripped !== MANIFEST_BASENAME) {
        entry.resume();
        return;
      }
      captured = true;
      entry.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      entry.on('end', () => {
        captureDone = true;
      });
      // Don't call entry.resume() here — tar v7 needs the listener to
      // drive the read. Adding 'data' listeners triggers flow mode.
    },
  });

  if (!captured) return NO_MANIFEST;
  if (!captureDone) {
    // Stream finished without reaching 'end' for our entry — treat as
    // truncated.
    return { ok: false, reason: 'plugin.json entry stream ended early' };
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: `plugin.json failed to parse: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    assertValid(ManifestSchema, parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      return { ok: false, reason: `plugin.json schema violation: ${err.message}` };
    }
    return {
      ok: false,
      reason: `plugin.json schema check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const manifestData = parsed as {
    id: string;
    version: string;
    requires?: string[];
    provides?: string[];
  };
  const manifest: PluginManifest = {
    id: manifestData.id,
    version: manifestData.version,
    ...(manifestData.requires === undefined ? {} : { requires: manifestData.requires }),
    ...(manifestData.provides === undefined ? {} : { provides: manifestData.provides }),
  };
  return { ok: true, manifest };
}
