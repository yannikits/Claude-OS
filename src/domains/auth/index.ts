/**
 * Anthropic-auth domain — Phase 5d (ADR-0011).
 *
 * @module @domains/auth
 */

export {
  checkCredentialsSchema,
  hasCiEnvCredentials,
  isAuthError,
  isExpiringSoon,
  readCredentialsFile,
  resolveCredentialsPath,
} from './credentials.js';
export { ProfileManager } from './profile-manager.js';
export { checkAuthState } from './state-check.js';
export type {
  AuthProfile,
  AuthSource,
  AuthState,
  CredentialsFileEnvelope,
  SchemaCheckResult,
} from './types.js';
export {
  AuthError,
  AuthProfileExistsError,
  AuthProfileMissingError,
} from './types.js';
