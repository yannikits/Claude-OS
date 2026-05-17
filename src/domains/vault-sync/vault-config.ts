/**
 * Persistent vault-sync config (Phase 2f).
 *
 * Stored as JSON at `<dataRoot>/vault-config.json`. The CLI surface
 * (`vault conflict-mode <mode>`, `vault schedule --enable/--disable
 * [--idle-seconds N]`) reads/writes this file; the Phase 6 sidecar
 * consumes the same file to decide whether to start the scheduler at
 * boot.
 *
 * Shape:
 *   {
 *     "conflictMode": "abort" | "prefer-local" | "prefer-remote",
 *     "idleSeconds": 300,
 *     "scheduleEnabled": false
 *   }
 *
 * @module @domains/vault-sync/vault-config
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConflictMode } from './conflict-policy.js';

export interface VaultConfig {
  readonly conflictMode: ConflictMode;
  readonly idleSeconds: number;
  readonly scheduleEnabled: boolean;
}

export const DEFAULT_VAULT_CONFIG: VaultConfig = {
  conflictMode: 'abort',
  idleSeconds: 300,
  scheduleEnabled: false,
};

const CONFLICT_MODES: readonly ConflictMode[] = ['abort', 'prefer-local', 'prefer-remote'];

function isValidConfig(parsed: unknown): parsed is VaultConfig {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.conflictMode !== 'string') return false;
  if (!(CONFLICT_MODES as readonly string[]).includes(obj.conflictMode)) return false;
  if (typeof obj.idleSeconds !== 'number' || obj.idleSeconds <= 0) return false;
  if (typeof obj.scheduleEnabled !== 'boolean') return false;
  return true;
}

/** Loads the config, returning defaults when missing/corrupt. */
export function loadVaultConfig(filePath: string): VaultConfig {
  if (!existsSync(filePath)) return DEFAULT_VAULT_CONFIG;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return DEFAULT_VAULT_CONFIG;
  }
  if (raw.trim().length === 0) return DEFAULT_VAULT_CONFIG;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isValidConfig(parsed)) return parsed;
    return DEFAULT_VAULT_CONFIG;
  } catch {
    return DEFAULT_VAULT_CONFIG;
  }
}

/**
 * Updates the config with a partial patch and persists atomically.
 * Returns the merged config.
 */
export function updateVaultConfig(filePath: string, patch: Partial<VaultConfig>): VaultConfig {
  const current = loadVaultConfig(filePath);
  const next: VaultConfig = { ...current, ...patch };
  if (!isValidConfig(next)) {
    throw new Error(
      `Invalid vault config after patch: ${JSON.stringify(next)} ` +
        `(conflictMode must be one of ${CONFLICT_MODES.join('|')}, idleSeconds > 0)`,
    );
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, filePath);
  return next;
}
