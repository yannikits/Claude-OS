/**
 * Resolves the on-disk path of the users `.sqlite` file.
 *
 * Per ADR-0036 draft + ADR-0002 (per-machine paths), the user store
 * lives under `<dataDir>/users.sqlite` — NEVER inside the vault. Vault
 * folders are sometimes synced via cloud-sync clients (OneDrive, Drive)
 * which violate SQLite file-locking semantics (Lesson 2026-05-15
 * "Cloud-Sync != Replikations-Layer"). The data-dir is always local.
 *
 * @module @domains/users/paths
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const USERS_DB_FILENAME = 'users.sqlite';

/**
 * Returns the absolute path of the users `.sqlite` file. Does NOT create
 * the parent directory — callers writing to it should call
 * `ensureUsersDir(dataDir)` first.
 */
export function resolveUsersDbPath(dataDir: string): string {
  return join(dataDir, USERS_DB_FILENAME);
}

/**
 * Ensures the data-dir exists (lazy bootstrap). Idempotent. Returns the
 * dir path.
 */
export function ensureUsersDir(dataDir: string): string {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  return dataDir;
}
