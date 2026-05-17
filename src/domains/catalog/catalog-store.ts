/**
 * CatalogStore — typed reader/writer for catalog.json + catalog.lock.json.
 *
 * Pattern mirrors `vault-config.ts` (Phase 2f):
 *   - Atomic tempfile + rename for writes.
 *   - Tolerant reads: missing file -> default empty catalog. Corrupt
 *     JSON -> InvalidCatalogError. Valid-JSON-but-wrong-shape ->
 *     InvalidCatalogError carrying the formatted assertValid errors.
 *
 * Used by the CLI `catalog list` (Phase 5i) and will back the Phase-6
 * sidecar's catalog mutation surface.
 *
 * @module @domains/catalog/catalog-store
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertValid, ValidationError } from '../../core/validation/index.js';
import {
  type CatalogConfig,
  CatalogConfigSchema,
  type CatalogLock,
  CatalogLockSchema,
} from './schema.js';

export const CATALOG_FILENAME = 'catalog.json';
export const CATALOG_LOCK_FILENAME = 'catalog.lock.json';

/** Default empty catalog. Returned by `readCatalog` when no file exists. */
export const EMPTY_CATALOG: CatalogConfig = { version: 1, entries: [] };

export class InvalidCatalogError extends Error {
  constructor(
    message: string,
    public readonly file: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'InvalidCatalogError';
  }
}

interface CatalogPaths {
  readonly catalogPath: string;
  readonly lockPath: string;
}

/**
 * Builds the on-disk paths for catalog.json + catalog.lock.json.
 * Both live under `<root>/config/` per ADR-0002.
 */
export function catalogPathsFor(root: string): CatalogPaths {
  const configDir = join(root, 'config');
  return {
    catalogPath: join(configDir, CATALOG_FILENAME),
    lockPath: join(configDir, CATALOG_LOCK_FILENAME),
  };
}

function readJsonOrThrow(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new InvalidCatalogError(`cannot read ${path}`, path, err);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new InvalidCatalogError(`${path} is not valid JSON`, path, err);
  }
}

function writeJsonAtomic(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, serialized, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Read catalog.json. Returns {@link EMPTY_CATALOG} when the file is
 * absent — letting first-time users run `catalog list` without setup
 * friction. Throws {@link InvalidCatalogError} for unreadable /
 * malformed / schema-violating payloads.
 */
export function readCatalog(catalogPath: string): CatalogConfig {
  if (!existsSync(catalogPath)) return { ...EMPTY_CATALOG, entries: [] };
  const data = readJsonOrThrow(catalogPath);
  try {
    assertValid<CatalogConfig>(CatalogConfigSchema, data, CATALOG_FILENAME);
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new InvalidCatalogError(err.message, catalogPath, err);
    }
    throw err;
  }
  return data as CatalogConfig;
}

/** Write catalog.json atomically. Validates before writing. */
export function writeCatalog(catalogPath: string, catalog: CatalogConfig): void {
  assertValid<CatalogConfig>(CatalogConfigSchema, catalog, CATALOG_FILENAME);
  writeJsonAtomic(catalogPath, catalog);
}

/**
 * Read catalog.lock.json. Returns `null` when absent (no lock yet — a
 * common first-run state, not an error).
 */
export function readCatalogLock(lockPath: string): CatalogLock | null {
  if (!existsSync(lockPath)) return null;
  const data = readJsonOrThrow(lockPath);
  try {
    assertValid<CatalogLock>(CatalogLockSchema, data, CATALOG_LOCK_FILENAME);
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new InvalidCatalogError(err.message, lockPath, err);
    }
    throw err;
  }
  return data as CatalogLock;
}

/** Write catalog.lock.json atomically. Validates before writing. */
export function writeCatalogLock(lockPath: string, lock: CatalogLock): void {
  assertValid<CatalogLock>(CatalogLockSchema, lock, CATALOG_LOCK_FILENAME);
  writeJsonAtomic(lockPath, lock);
}
