/**
 * NinjaOne OAuth2 client-credentials token acquisition + single-token cache.
 *
 * Flow (NinjaOne Public API):
 *   POST {base}/ws/oauth/token
 *     Content-Type: application/x-www-form-urlencoded
 *     Body: grant_type=client_credentials&client_id=..&client_secret=..&scope=monitoring
 *   Response: { access_token, expires_in, token_type:"Bearer" }
 *
 * One NinjaOne tenant per MSP, so a single cached token (not per-host like
 * Veeam). ADR-0038: credentials fetched per probe by the bridge; the network
 * login only fires when the cached token is missing/expired.
 *
 * @module @domains/msp-bridges/ninja/auth
 */
import type { BridgeResult } from '../types.js';
import { classifyHttpStatus, classifyThrown } from './classify-error.js';

export class NinjaTokenCache {
  private cached: { token: string; expiresAtMs: number } | null = null;
  constructor(private readonly marginMs: number = 60_000) {}

  get(): string | null {
    if (this.cached === null) return null;
    if (Date.now() >= this.cached.expiresAtMs - this.marginMs) return null;
    return this.cached.token;
  }

  set(token: string, expiresInSec: number): void {
    this.cached = { token, expiresAtMs: Date.now() + expiresInSec * 1000 };
  }

  invalidate(): void {
    this.cached = null;
  }
}

export interface ClientCredentialsOpts {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scope: string;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

export type OAuthResult =
  | { ok: true; accessToken: string; expiresInSec: number }
  | { ok: false; error: BridgeResult<never> };

export async function clientCredentialsLogin(opts: ClientCredentialsOpts): Promise<OAuthResult> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    scope: opts.scope,
  }).toString();

  let response: Response;
  try {
    response = await opts.fetchImpl(`${opts.baseUrl}/ws/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    return { ok: false, error: classifyThrown(err) };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: classifyHttpStatus(response.status, response.headers.get('retry-after')),
    };
  }

  let parsed: { access_token?: unknown; expires_in?: unknown };
  try {
    parsed = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  } catch (err) {
    return {
      ok: false,
      error: { kind: 'error', message: `invalid OAuth response JSON: ${shortMsg(err)}` },
    };
  }

  const accessToken = parsed.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return { ok: false, error: { kind: 'error', message: 'OAuth response missing access_token' } };
  }
  const expiresInSec = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600;
  return { ok: true, accessToken, expiresInSec };
}

function shortMsg(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return 'unknown';
}
