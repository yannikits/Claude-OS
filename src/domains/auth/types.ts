/**
 * Anthropic-auth domain types (Phase 5d, ADR-0011).
 *
 * @module @domains/auth/types
 */

/** How the auth state was determined. */
export type AuthSource =
  | 'cli' // `claude auth status` subprocess parsed
  | 'file' // .credentials.json read directly
  | 'env' // CLAUDE_CODE_OAUTH_* env-vars present (CI mode)
  | 'no-creds'; // nothing found

/** Aggregate auth state surfaced to callers + CLI/GUI. */
export interface AuthState {
  readonly loggedIn: boolean;
  readonly source: AuthSource;
  /** Token expiry as ISO-8601, when known. */
  readonly expiresAt?: string;
  /** Granted OAuth scopes (when known). */
  readonly scopes?: readonly string[];
  /** Active profile name (when multi-profile is in use). */
  readonly profile?: string;
  /** Warning surfaced to the user (e.g. expiry in < 1h, schema drift). */
  readonly warning?: string;
}

/** A single multi-profile entry. */
export interface AuthProfile {
  readonly name: string;
  readonly configDir: string;
  readonly active: boolean;
}

/** On-disk shape of `.credentials.json` (Anthropic-CLI-owned). */
export interface CredentialsFileEnvelope {
  readonly claudeAiOauth: {
    readonly accessToken: string;
    readonly refreshToken: string;
    /** Unix ms. */
    readonly expiresAt: number;
    readonly scopes: readonly string[];
  };
}

/** Result of validating a `.credentials.json` against the expected shape. */
export interface SchemaCheckResult {
  readonly ok: boolean;
  readonly missingFields: readonly string[];
  readonly warning?: string;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class AuthProfileExistsError extends AuthError {
  constructor(message: string) {
    super(message);
    this.name = 'AuthProfileExistsError';
  }
}

export class AuthProfileMissingError extends AuthError {
  constructor(message: string) {
    super(message);
    this.name = 'AuthProfileMissingError';
  }
}
