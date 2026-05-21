/**
 * Tarball installer — download → sha256-verify → extract to destination.
 *
 * Cache key is the lowercase-hex sha256 of the archive bytes. Repeated
 * installs of the same archive are no-op-fast (cached file is reused;
 * extraction is idempotent because tar.extract overwrites in-place).
 *
 * Phase 5e (ADR-0009 §31).
 *
 * @module @domains/catalog/tarball-installer
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { safeExtractTar, UnsafeTarballError } from './safe-tar-extract.js';

export class TarballInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarballInstallError';
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

interface InstallOpts {
  /** Source URL (https / file://). */
  readonly url: string;
  /** Cache root directory, e.g. `<dataRoot>/cache`. */
  readonly cacheDir: string;
  /** Extraction destination directory. */
  readonly destination: string;
  /** When provided, the computed sha256 MUST match this value. */
  readonly expectedSha256?: string;
  /** Inject a fetch implementation (tests). Default `globalThis.fetch`. */
  readonly fetchFn?: FetchFn;
  /** Strip N leading path components on extract (tar `strip`). Default 0. */
  readonly stripComponents?: number;
}

export interface InstallResult {
  /** Absolute path of the cached tarball (`<cacheDir>/<sha256>.tar.gz`). */
  readonly cachedPath: string;
  /** Where the archive was extracted. */
  readonly destination: string;
  /** Lowercase-hex sha256 of the downloaded bytes. */
  readonly sha256: string;
  /** True when the cache already had this hash and no download was needed. */
  readonly alreadyCached: boolean;
  /** Bytes pulled over the network (0 when alreadyCached). */
  readonly bytesDownloaded: number;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').toLowerCase();
}

function defaultFetch(): FetchFn {
  if (typeof globalThis.fetch !== 'function') {
    throw new TarballInstallError(
      'globalThis.fetch is not available — supply opts.fetchFn or use Node 18+',
    );
  }
  return globalThis.fetch.bind(globalThis);
}

async function readArchiveByExpectedHash(opts: InstallOpts): Promise<Buffer | null> {
  if (opts.expectedSha256 === undefined) return null;
  const expected = opts.expectedSha256.toLowerCase();
  const path = join(opts.cacheDir, `${expected}.tar.gz`);
  if (!existsSync(path)) return null;
  try {
    const buf = readFileSync(path);
    if (sha256Hex(buf) !== expected) {
      try {
        unlinkSync(path);
      } catch {
        /* best-effort */
      }
      return null;
    }
    return buf;
  } catch {
    return null;
  }
}

/**
 * m15 (2026-05-21 code-review): max-response-size cap. Verhindert dass
 * ein 10GB-Tarball den Sidecar OOM-killt bevor der sha256-Check feuern
 * kann. Default 200 MB (deutlich ueber dem groessten gesehenen Plugin
 * von ~30 MB).
 */
const MAX_TARBALL_BYTES = 200 * 1024 * 1024;

async function fetchArchive(opts: InstallOpts): Promise<Buffer> {
  const fetchFn = opts.fetchFn ?? defaultFetch();
  let response: Response;
  try {
    response = await fetchFn(opts.url);
  } catch (err) {
    throw new TarballInstallError(
      `network fetch failed for ${opts.url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new TarballInstallError(
      `fetch ${opts.url} returned HTTP ${response.status} ${response.statusText}`,
    );
  }
  // m15: cap via Content-Length-Header wenn vorhanden; sonst bail bei
  // arrayBuffer() wenn > MAX_TARBALL_BYTES.
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declared) && declared > MAX_TARBALL_BYTES) {
      throw new TarballInstallError(
        `refused tarball ${opts.url}: Content-Length ${declared} > MAX ${MAX_TARBALL_BYTES} bytes`,
      );
    }
  }
  const arr = await response.arrayBuffer();
  if (arr.byteLength > MAX_TARBALL_BYTES) {
    throw new TarballInstallError(
      `refused tarball ${opts.url}: received ${arr.byteLength} bytes > MAX ${MAX_TARBALL_BYTES}`,
    );
  }
  return Buffer.from(arr);
}

function persistCache(buf: Buffer, opts: InstallOpts, sha256: string): string {
  mkdirSync(opts.cacheDir, { recursive: true });
  const finalPath = join(opts.cacheDir, `${sha256}.tar.gz`);
  if (existsSync(finalPath)) return finalPath;
  const tmp = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, buf, { mode: 0o644 });
  renameSync(tmp, finalPath);
  return finalPath;
}

async function extractIntoDestination(
  cachedPath: string,
  destination: string,
  stripComponents: number,
): Promise<void> {
  mkdirSync(destination, { recursive: true });
  try {
    await safeExtractTar({
      file: cachedPath,
      cwd: destination,
      strip: stripComponents,
      // destination ist exklusiv fuer diesen Install — bei UnsafeTarball
      // Error wird kein partial-state hinterlassen.
      cleanupOnFailure: true,
    });
  } catch (err) {
    if (err instanceof UnsafeTarballError) {
      throw new TarballInstallError(`refused unsafe tarball ${cachedPath}: ${err.message}`);
    }
    throw new TarballInstallError(
      `tar extract failed for ${cachedPath} into ${destination}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Downloads (or reuses) the tarball at `opts.url`, verifies its sha256
 * if the caller supplied one, caches the archive under
 * `<cacheDir>/<sha256>.tar.gz`, and extracts it into `opts.destination`.
 */
export async function installFromTarball(opts: InstallOpts): Promise<InstallResult> {
  let bytesDownloaded = 0;
  let alreadyCached = false;
  let archiveBuf = await readArchiveByExpectedHash(opts);
  if (archiveBuf !== null) {
    alreadyCached = true;
  } else {
    archiveBuf = await fetchArchive(opts);
    bytesDownloaded = archiveBuf.length;
  }
  const sha256 = sha256Hex(archiveBuf);
  if (opts.expectedSha256 !== undefined && opts.expectedSha256.toLowerCase() !== sha256) {
    throw new TarballInstallError(
      `sha256 mismatch for ${opts.url}: expected ${opts.expectedSha256.toLowerCase()}, got ${sha256}`,
    );
  }
  const cachedPath = persistCache(archiveBuf, opts, sha256);
  await extractIntoDestination(cachedPath, opts.destination, opts.stripComponents ?? 0);
  return {
    cachedPath,
    destination: opts.destination,
    sha256,
    alreadyCached,
    bytesDownloaded,
  };
}

/** Default cache-dir convention: `<dataRoot>/cache`. */
export function tarballCacheDirFor(dataRoot: string): string {
  return join(dataRoot, 'cache');
}
