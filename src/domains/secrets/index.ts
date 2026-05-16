/**
 * Secrets domain — keychain-primary, encrypted-file-fallback secret
 * storage per ADR-0004 (Phase 3d).
 *
 * @module @domains/secrets
 */
export type {
  SecretBackend,
  SecretMetadata,
  SecretStore,
} from './types.js';
export {
  SecretsError,
  SecretBackendUnavailableError,
  SecretsLockedError,
} from './types.js';
export { KeyringStore, probeKeyring } from './keyring-store.js';
export { EncryptedFileStore } from './encrypted-file-store.js';
export { createSecretStore } from './factory.js';
