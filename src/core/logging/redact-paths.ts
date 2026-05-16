/**
 * Centralized redaction-path list per ADR-0013.
 *
 * Pino fast-redact JSONPath patterns. The `*` wildcard matches a single
 * property level; `*.token` redacts `token` anywhere it appears at depth 2+.
 *
 * **MAINTENANCE RULE (code-review gate)**:
 * - Add a path here when introducing a new domain field that may carry
 *   secrets (tokens, passwords, API keys, refresh tokens, cookies).
 * - **Removing** a path is a security regression — requires explicit
 *   rationale in the PR description and a second reviewer.
 *
 * @see https://github.com/pinojs/pino/blob/main/docs/redaction.md
 * @see docs/architecture/adr/0013-logging-pino.md
 *
 * @module @core/logging/redact-paths
 */

export const REDACT_PATHS = [
  // Generic credential field names
  '*.password',
  '*.passwd',
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.accessToken',
  '*.refreshToken',
  '*.privateKey',
  '*.secret',
  '*.cookie',
  '*.authorization',
  // Anthropic-specific (per ADR-0011)
  'env.ANTHROPIC_API_KEY',
  'env.CLAUDE_CODE_OAUTH_TOKEN',
  'env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  // Other AI providers
  'env.OPENAI_API_KEY',
  'env.GEMINI_API_KEY',
  'env.GOOGLE_API_KEY',
  // Git hosting platforms
  'env.GITHUB_TOKEN',
  'env.GITLAB_TOKEN',
  // Domain-specific blanket redactions
  'credentials',
  'credentials.*',
  'auth.token',
  'auth.refreshToken',
  'auth.accessToken',
] as const;

export const REDACT_CENSOR = '[REDACTED]';
