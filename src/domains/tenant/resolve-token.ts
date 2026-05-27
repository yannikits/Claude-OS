/**
 * Server-mode tenant resolution from bearer tokens (Phase Web-5 +
 * ADR-0033 Stage 1).
 *
 * In headless-server mode (`src/server/`), each authenticated request
 * carries a bearer token. The token's SHA-256 prefix becomes a stable
 * tenant-id that survives container restarts — without a database,
 * without registration. This module owns that mapping; the server's
 * auth-hook is a thin caller.
 *
 * Layering: `src/server/auth.ts` imports `tokenToTenantId` from here.
 * Domain → transport, never the other way round.
 *
 * @module @domains/tenant/resolve-token
 */
import { createHash } from 'node:crypto';
import type { ServerTenantContext } from './types.js';

const TOKEN_TENANT_ID_LENGTH = 12;

/**
 * Deterministic tenant-id from a bearer token. SHA-256 → first 12 hex
 * chars (48-bit space, plenty for homelab scale, short enough to spot
 * in audit-log lines). The full token is NEVER returned or logged.
 *
 * Same token → same id, across processes and container restarts. That's
 * the property that makes this useful as a per-tenant key without
 * needing a persistent registration store.
 */
export function tokenToTenantId(token: string): string {
  if (token.length === 0) {
    throw new Error('tokenToTenantId: token must be non-empty');
  }
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, TOKEN_TENANT_ID_LENGTH);
}

/**
 * Resolve a bearer token to a `ServerTenantContext`. Single-User-MVP
 * answer: workspace is the default `personal`, MSP-tenant is `null`
 * (no customer context), the token-derived tenant-id is set so audit
 * and per-token data isolation can use it.
 *
 * Per-token-workspace-isolation (where each token gets its own
 * `personal-{hash}/` subdir) is intentionally Phase Web-5b — the wire
 * for it is the `tokenTenantId` field surfaced here.
 *
 * Tauri-mode doesn't call this — no tokens involved there.
 */
export function resolveTenantFromToken(token: string): ServerTenantContext {
  return {
    workspace: 'personal',
    tenant: null,
    tokenTenantId: tokenToTenantId(token),
  };
}
