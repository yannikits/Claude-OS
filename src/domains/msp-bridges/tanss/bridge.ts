/**
 * TanssBridge — single-instance-per-MSP Read-Bridge for TANSS.
 *
 * One `probe(customer)` performs ONE HTTP-Call:
 *   GET {serverUrl}/api/v1/tickets/company/{customer.bridges.tanss.customerId}
 *
 * The response (often wrapped as `{ content: TanssTicket[] }` by TANSS,
 * sometimes as a bare array depending on installation) is unwrapped
 * defensively, then mapped via the pure `mapTanssTickets()` to a
 * compact `TanssStatus`.
 *
 * Contract guarantees (per ADR-0038):
 *   1. Never throws — all failures land in BridgeResult
 *   2. Returns 'misconfigured' if customer has no bridges.tanss section
 *      and DOES NOT make an HTTP call in that case
 *   3. Fetches the apiToken via `config.getApiToken()` on EVERY probe
 *      (no caching), so token rotation works
 *   4. Reports the real durationMs measured from start to return
 *
 * @module @domains/msp-bridges/tanss/bridge
 */
import type { CustomerRecord } from '../../msp-customers/index.js';
import type { BridgeKind, BridgeProbe, BridgeResult, ReadBridge } from '../types.js';
import { createTanssHttpClient, type TanssHttpClient } from './http-client.js';
import { mapTanssTickets } from './mapper.js';
import type { TanssBridgeConfig, TanssStatus, TanssTicketRaw } from './types.js';

export class TanssBridge implements ReadBridge<TanssStatus> {
  readonly kind: BridgeKind = 'tanss';
  private readonly http: TanssHttpClient;
  private readonly apiBase: string;

  constructor(private readonly config: TanssBridgeConfig) {
    this.http = createTanssHttpClient(config);
    this.apiBase = normaliseApiBase(config.apiBase);
  }

  async probe(customer: CustomerRecord): Promise<BridgeProbe<TanssStatus>> {
    const probedAt = new Date().toISOString();
    const start = Date.now();
    const ids = customer.bridges?.tanss;
    if (!ids) {
      return done(customer, probedAt, start, {
        kind: 'misconfigured',
        message: 'customer.yaml has no bridges.tanss section',
      });
    }

    let apiToken: string | null;
    try {
      apiToken = await this.config.getApiToken();
    } catch (err) {
      // ADR-0038: never throw. A locked/misconfigured secrets-backend
      // (e.g. EncryptedFileStore without $CLAUDE_OS_SECRETS_KEY) must surface
      // as a clean auth-failed, not a thrown exception.
      return done(customer, probedAt, start, {
        kind: 'auth-failed',
        message: `secrets-backend error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (apiToken === null || apiToken.length === 0) {
      return done(customer, probedAt, start, {
        kind: 'auth-failed',
        message: 'no apiToken in secrets-backend (key: tanss/apiToken)',
      });
    }

    const path = `${this.apiBase}/tickets/company/${ids.customerId}`;
    const response = await this.http.getJson<unknown>(path, apiToken);
    if (!response.ok) {
      return done(customer, probedAt, start, response.error);
    }

    const tickets = extractTickets(response.data);
    if (tickets === null) {
      return done(customer, probedAt, start, {
        kind: 'error',
        message: 'unexpected TANSS response shape — neither array nor {content:[...]}',
      });
    }

    const status = mapTanssTickets(tickets);
    return done<TanssStatus>(customer, probedAt, start, { kind: 'ok', data: status });
  }
}

/** Default `/api/v1`; ensure a leading slash and strip a trailing one. */
function normaliseApiBase(base: string | undefined): string {
  const raw = (base ?? '/api/v1').trim();
  const withLead = raw.startsWith('/') ? raw : `/${raw}`;
  return withLead.endsWith('/') ? withLead.slice(0, -1) : withLead;
}

/** TANSS wraps most lists as `{ content: [...] }` but bare arrays occur too. */
function extractTickets(raw: unknown): TanssTicketRaw[] | null {
  if (Array.isArray(raw)) return raw as TanssTicketRaw[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { content?: unknown }).content)) {
    return (raw as { content: TanssTicketRaw[] }).content;
  }
  return null;
}

function done<T>(
  customer: CustomerRecord,
  probedAt: string,
  start: number,
  result: BridgeResult<T>,
): BridgeProbe<T> {
  return {
    bridgeKind: 'tanss',
    customerSlug: customer.slug,
    probedAt,
    durationMs: Date.now() - start,
    result,
  };
}
