/**
 * KeyringStore — OS-keychain-backed SecretStore implementation per
 * ADR-0004. Uses `@napi-rs/keyring` with prebuilt native bindings
 * (no node-gyp build on user machines).
 *
 * Backends per platform:
 *   Windows  →  Credential Manager
 *   macOS    →  Keychain
 *   Linux    →  Secret Service (libsecret / D-Bus)
 *
 * The keyring's `Entry` API is synchronous; we expose async methods so
 * the adapter shape matches the encrypted-file fallback exactly.
 *
 * Service-name is fixed to `claude-os` so all keychain entries appear
 * grouped to the user in the OS UI.
 *
 * @module @domains/secrets/keyring-store
 */
import { Entry, findCredentials } from '@napi-rs/keyring';
import type { SecretMetadata, SecretStore } from './types.js';
import { SecretsError } from './types.js';

const SERVICE_NAME = 'claude-os';

/**
 * Pattern-matches "not found"-style messages across @napi-rs/keyring
 * backends. The library does not throw a typed NoEntry error; backends
 * stringify their native message differently.
 */
function isNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('no such') ||
    msg.includes('not found') ||
    msg.includes('no matching') ||
    msg.includes('no password') ||
    msg.includes('does not exist')
  );
}

export class KeyringStore implements SecretStore {
  readonly backend = 'keyring' as const;

  get(key: string): Promise<string | null> {
    try {
      const value = new Entry(SERVICE_NAME, key).getPassword();
      return Promise.resolve(value);
    } catch (err) {
      if (isNotFound(err)) return Promise.resolve(null);
      return Promise.reject(
        new SecretsError(
          `keyring get failed for "${key}": ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  set(key: string, value: string): Promise<void> {
    try {
      new Entry(SERVICE_NAME, key).setPassword(value);
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(
        new SecretsError(
          `keyring set failed for "${key}": ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  delete(key: string): Promise<boolean> {
    try {
      new Entry(SERVICE_NAME, key).deletePassword();
      return Promise.resolve(true);
    } catch (err) {
      if (isNotFound(err)) return Promise.resolve(false);
      return Promise.reject(
        new SecretsError(
          `keyring delete failed for "${key}": ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  list(): Promise<readonly SecretMetadata[]> {
    try {
      const creds = findCredentials(SERVICE_NAME);
      return Promise.resolve(creds.map((c) => ({ key: c.account, backend: 'keyring' as const })));
    } catch (err) {
      return Promise.reject(
        new SecretsError(
          `keyring list failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }
}

/**
 * Probes the keyring backend by writing then deleting a sentinel key.
 * Used by the factory's capability detection. Returns true if the
 * round-trip succeeds; false on any backend error (D-Bus down, no
 * Credential Manager service, etc.).
 */
export function probeKeyring(): boolean {
  const probeKey = '__claude-os-capability-probe__';
  try {
    const entry = new Entry(SERVICE_NAME, probeKey);
    entry.setPassword('ok');
    // n8 (2026-05-23 todo-audit): bis zu 3 delete-Versuche bevor die
    // Sentinel-Entry akzeptiert wird. Vermeidet dass das probe-Token
    // dauerhaft im OS-Credential-Manager liegt wenn der erste delete
    // race'd (selten bei macOS Keychain, gelegentlich bei D-Bus
    // Secret-Service unter Last). Best-effort — Capability-Detection
    // war zum Zeitpunkt schon erfolgreich (setPassword hat geklappt),
    // also returnen wir `true` auch wenn alle 3 Versuche fehlschlagen.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        entry.deletePassword();
        break;
      } catch {
        // try again — manche keyring-backends sind transient flaky
      }
    }
    return true;
  } catch {
    return false;
  }
}
