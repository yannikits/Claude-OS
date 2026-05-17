/**
 * urlLoader — ETag-aware HTTP loader for marketplace registry JSON.
 *
 * Closes the "Marketplace ETag-URL-Fetch deferred" item from the Phase
 * 5 v1-Abweichungen list. Returns a {@link RegistryLoader} compatible
 * with {@link MarketplaceRegistry}, persists the body + ETag side-by-
 * side under `<cacheDir>/marketplace-<sha16>.{json,etag}`, and sends
 * `If-None-Match: <cached-etag>` on subsequent fetches so a 304
 * response reuses the cached body verbatim.
 *
 * Design choices:
 *   - `fetch` is injectable so tests do not need a network.
 *   - Cache key = first 16 hex chars of `sha256(url)` — collision-safe
 *     within a single user's cacheDir and short enough for FS
 *     debugging.
 *   - On 200 with no `etag` header: cache the body but skip writing
 *     the .etag file; next call sends no `If-None-Match` and the
 *     server returns 200 unconditionally. Functionally still works,
 *     just no bandwidth saving.
 *   - On network error or non-200/304: throw {@link
 *     MarketplaceRegistryError} carrying the URL + status. We do NOT
 *     fall back to the stale cached body — silent-stale would mask
 *     genuine registry breakage. Caller is free to write a wrapper
 *     that retries with `fileLoader(cachedPath)` if they want that
 *     semantic.
 *
 * @module @domains/catalog/marketplace-url-loader
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MarketplaceRegistryError,
  type RegistryLoader,
  validateRegistry,
} from './marketplace-registry.js';

type FetchFn = typeof globalThis.fetch;

export interface UrlLoaderOpts {
  readonly url: string;
  readonly cacheDir: string;
  /** Injectable for tests. Defaults to `globalThis.fetch`. */
  readonly fetch?: FetchFn;
}

interface CachePaths {
  readonly json: string;
  readonly etag: string;
}

function cachePathsFor(cacheDir: string, url: string): CachePaths {
  const sha16 = createHash('sha256').update(url).digest('hex').slice(0, 16);
  return {
    json: join(cacheDir, `marketplace-${sha16}.json`),
    etag: join(cacheDir, `marketplace-${sha16}.etag`),
  };
}

function readCachedEtag(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

function readCachedBody(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

export function urlLoader(opts: UrlLoaderOpts): RegistryLoader {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new MarketplaceRegistryError(
      'urlLoader requires a fetch implementation (none on globalThis, none injected)',
    );
  }
  const paths = cachePathsFor(opts.cacheDir, opts.url);

  return async () => {
    mkdirSync(opts.cacheDir, { recursive: true });
    const cachedEtag = readCachedEtag(paths.etag);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (cachedEtag !== undefined) headers['If-None-Match'] = cachedEtag;

    let response: Response;
    try {
      response = await fetchImpl(opts.url, { headers });
    } catch (err) {
      throw new MarketplaceRegistryError(
        `urlLoader: fetch ${opts.url} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (response.status === 304) {
      const cached = readCachedBody(paths.json);
      if (cached === undefined) {
        throw new MarketplaceRegistryError(
          `urlLoader: ${opts.url} returned 304 but no cached body at ${paths.json}`,
        );
      }
      return validateRegistry(cached, opts.url);
    }

    if (!response.ok) {
      throw new MarketplaceRegistryError(
        `urlLoader: ${opts.url} returned HTTP ${response.status} ${response.statusText}`,
      );
    }

    const body = await response.text();
    const validated = validateRegistry(body, opts.url);
    writeAtomic(paths.json, body);
    const newEtag = response.headers.get('etag');
    if (newEtag !== null && newEtag.length > 0) {
      writeAtomic(paths.etag, newEtag);
    }
    return validated;
  };
}
