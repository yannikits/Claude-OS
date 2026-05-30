/**
 * Minimal bearer GET for the NinjaOne v2 API. Returns parsed JSON or a typed
 * BridgeResult error. No retry / no relogin — the bridge proactively refreshes
 * the token via the 60s cache margin (ADR-0038: no caching of secrets, but the
 * short-lived OAuth token may be reused until near-expiry).
 *
 * @module @domains/msp-bridges/ninja/http-client
 */
import type { BridgeResult } from '../types.js';
import { classifyHttpStatus, classifyThrown } from './classify-error.js';

export async function ninjaGet<T>(
  url: string,
  token: string,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<{ ok: true; data: T } | { ok: false; error: BridgeResult<never> }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      ...(signal ? { signal } : {}),
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

  try {
    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: 'error',
        message: `invalid JSON: ${err instanceof Error ? err.message : 'unknown'}`,
      },
    };
  }
}
