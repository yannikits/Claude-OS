/**
 * Session-ID generator. 256-bit CSPRNG via `randomBytes(32)`,
 * `base64url`-encoded for cookie-safe transport (no padding, no `+/=`).
 *
 * Resulting strings are 43 chars long — fits comfortably inside the
 * standard 4KB cookie budget alongside the CSRF cookie.
 *
 * @module @domains/sessions/id
 */
import { randomBytes } from 'node:crypto';

const SESSION_ID_BYTES = 32;

export function newSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString('base64url');
}

/**
 * Cheap structural check — does the candidate look like an id we'd
 * mint? Used to reject malformed cookie values early without touching
 * the store. NOT a security boundary (lookup miss is the only real
 * defence).
 */
export function looksLikeSessionId(s: string): boolean {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{40,48}$/.test(s);
}
