/**
 * Secrets domain — keychain-primary, encrypted-file-fallback secret
 * storage per ADR-0004 (Phase 3d).
 *
 * @module @domains/secrets
 */

export { EncryptedFileStore } from './encrypted-file-store.js';
export { createSecretStore } from './factory.js';
export { KeyringStore, probeKeyring } from './keyring-store.js';
export type {
  SecretBackend,
  SecretMetadata,
  SecretStore,
} from './types.js';
export {
  SecretBackendUnavailableError,
  SecretsError,
  SecretsLockedError,
} from './types.js';
