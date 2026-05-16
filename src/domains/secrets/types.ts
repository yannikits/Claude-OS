/**
 * Secrets domain types (Phase 3d, ADR-0004).
 *
 * @module @domains/secrets/types
 */

/** Backend that produced or accepted a secret. */
export type SecretBackend = 'keyring' | 'encrypted-file';

/** Lightweight metadata about a stored secret (never includes value). */
export interface SecretMetadata {
  readonly key: string;
  readonly backend: SecretBackend;
}

/**
 * Adapter interface implemented by `KeyringStore` and
 * `EncryptedFileStore`. All operations are async so the keyring's sync
 * native bindings and the file-based fallback expose the same surface.
 *
 * IMPORTANT — values are never to be logged, even at trace level
 * (ADR-0004 §51). Implementations MUST surface keys but never values
 * in their structured log output.
 */
export interface SecretStore {
  readonly backend: SecretBackend;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(): Promise<readonly SecretMetadata[]>;
}

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsError';
  }
}

export class SecretBackendUnavailableError extends SecretsError {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBackendUnavailableError';
  }
}

export class SecretsLockedError extends SecretsError {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsLockedError';
  }
}
