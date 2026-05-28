/**
 * Double-submit-cookie CSRF protection (Phase Web-7-2, ADR-0036 draft).
 *
 * Cookies are automatically attached by browsers to same-site requests,
 * including those triggered by attacker-controlled third-party origins.
 * `SameSite=Strict` already blocks the cross-site case — but defence in
 * depth requires a second mechanism that doesn't rely on browser policy
 * alone (Safari Intelligent Tracking can downgrade Strict to Lax in
 * specific scenarios; some self-hosted setups proxy through subdomains
 * where Strict semantics get fuzzy).
 *
 * Double-submit: when the server issues `claude_os_csrf` cookie, the
 * client must also echo the same value in the `x-csrf-token` header on
 * state-changing requests. Same-origin JS can read both; cross-origin
 * JS cannot read the cookie (SameSite=Strict), so it can't fill in the
 * header. The mismatch → 403.
 *
 * Bearer-token clients (no cookie) skip CSRF entirely — the bearer
 * itself is the unforgeable credential and is never auto-attached by
 * the browser to cross-site requests.
 *
 * @module @server/csrf
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 32-byte CSPRNG hex — 64 chars. */
export function newCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

/** Constant-time string compare. */
export function csrfEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
