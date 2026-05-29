import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogger } from '../../../../src/core/audit/index.js';
import type { AuditEntry } from '../../../../src/core/audit/types.js';
import { withAuditTrail } from '../../../../src/domains/msp-bridges/index.js';
import { SecurepointBridge } from '../../../../src/domains/msp-bridges/securepoint/index.js';
import type { SecurepointBridgeConfig } from '../../../../src/domains/msp-bridges/securepoint/types.js';
import type { CustomerRecord } from '../../../../src/domains/msp-customers/index.js';

const API_KEY = 'eyJhbGc.SAMPLE.TOKEN';
const SAMPLE_METRICS = [
  'utm_usc_online_status{utm="UTM-MUELLER",mandant="m1"} 1',
  'utm_usc_online_status{utm="UTM-SCHMITT",mandant="m2"} 0',
  'utm_license_days_valid{utm="UTM-MUELLER"} 200',
  'utm_license_days_valid{utm="UTM-SCHMITT"} 5',
  'utm_other_metric{utm="UTM-MUELLER"} 42',
].join('\n');

function customer(opts: { withSecurepoint?: boolean; deviceId?: string } = {}): CustomerRecord {
  return {
    slug: 'mueller-gmbh',
    displayName: 'Mueller GmbH',
    ...(opts.withSecurepoint !== false
      ? { bridges: { securepoint: { deviceId: opts.deviceId ?? 'UTM-MUELLER' } } }
      : {}),
  };
}

function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain' },
    ...init,
  });
}

function bridge(
  fetchMock: ReturnType<typeof vi.fn>,
  apiKeyFn: SecurepointBridgeConfig['getApiKey'] = async () => API_KEY,
  overrides: Partial<SecurepointBridgeConfig> = {},
): SecurepointBridge {
  return new SecurepointBridge({
    getApiKey: apiKeyFn,
    fetch: fetchMock as unknown as typeof globalThis.fetch,
    ...overrides,
  });
}

describe('SecurepointBridge.probe', () => {
  it('misconfigured WITHOUT making a fetch call when bridges.securepoint is missing', async () => {
    const fetchMock = vi.fn();
    const probe = await bridge(fetchMock).probe(customer({ withSecurepoint: false }));
    expect(probe.result.kind).toBe('misconfigured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('auth-failed WITHOUT making a fetch call when getApiKey returns null', async () => {
    const fetchMock = vi.fn();
    const probe = await bridge(fetchMock, async () => null).probe(customer());
    expect(probe.result.kind).toBe('auth-failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('happy path: fetches metrics, returns SecurepointStatus for matching device', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse(SAMPLE_METRICS));
    const probe = await bridge(fetchMock).probe(customer());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe('https://portal.securepoint.cloud/sms-mgt-api/api/2.0/metrics?version=2.2');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(probe.result.kind).toBe('ok');
    if (probe.result.kind === 'ok') {
      expect(probe.result.data.online).toBe(true);
      expect(probe.result.data.licenseStatus).toBe('valid');
      expect(probe.result.data.licenseDaysRemaining).toBe(200);
    }
  });

  it('respects baseUrl + apiVersion overrides', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse(SAMPLE_METRICS));
    await bridge(fetchMock, async () => API_KEY, {
      baseUrl: 'https://eu.portal.securepoint.cloud/',
      apiVersion: '2.3',
    }).probe(customer());
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://eu.portal.securepoint.cloud/sms-mgt-api/api/2.0/metrics?version=2.3');
  });

  it('shares one upstream fetch across N customer probes within TTL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse(SAMPLE_METRICS));
    const b = bridge(fetchMock);
    await b.probe(customer({ deviceId: 'UTM-MUELLER' }));
    await b.probe(customer({ deviceId: 'UTM-SCHMITT' }));
    await b.probe(customer({ deviceId: 'UTM-MUELLER' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getApiKey called on every probe (no API-key caching beyond per-call)', async () => {
    const keyFn = vi.fn().mockResolvedValue(API_KEY);
    const fetchMock = vi.fn().mockResolvedValue(textResponse(SAMPLE_METRICS));
    const b = bridge(fetchMock, keyFn);
    await b.probe(customer());
    await b.probe(customer());
    await b.probe(customer());
    expect(keyFn).toHaveBeenCalledTimes(3);
    // Single fetch despite 3 probes (cache hit)
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('deviceId not in metrics → misconfigured with typo-hint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse(SAMPLE_METRICS));
    const probe = await bridge(fetchMock).probe(customer({ deviceId: 'UTM-UNKNOWN' }));
    expect(probe.result.kind).toBe('misconfigured');
    if (probe.result.kind === 'misconfigured') {
      expect(probe.result.message).toContain('typo');
    }
  });

  it('HTTP 401 → auth-failed (API-Key invalid)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    expect((await bridge(fetchMock).probe(customer())).result.kind).toBe('auth-failed');
  });

  it('HTTP 500 → unreachable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    expect((await bridge(fetchMock).probe(customer())).result.kind).toBe('unreachable');
  });

  it('thrown TypeError → unreachable', async () => {
    const err = Object.assign(new Error('fetch failed'), { name: 'TypeError' });
    const fetchMock = vi.fn().mockRejectedValue(err);
    expect((await bridge(fetchMock).probe(customer())).result.kind).toBe('unreachable');
  });

  it('AbortController-driven timeout → unreachable', async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, opts: RequestInit) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const b = bridge(fetchMock, async () => API_KEY, { timeoutMs: 50 });
    expect((await b.probe(customer())).result.kind).toBe('unreachable');
  });
});

describe('SecurepointBridge + withAuditTrail integration', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sp-audit-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function events(): AuditEntry[] {
    const out: AuditEntry[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('audit-') || !f.endsWith('.jsonl')) continue;
      for (const line of readFileSync(join(dir, f), 'utf-8').split('\n')) {
        if (line.trim().length === 0) continue;
        out.push(JSON.parse(line) as AuditEntry);
      }
    }
    return out;
  }

  it('writes bridge.read with action=bridge.securepoint.probe + outcome=ok and NO API-key/deviceId in details', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse(SAMPLE_METRICS));
    const inner = bridge(fetchMock);
    const logger = new AuditLogger({ auditDir: dir });
    await withAuditTrail(inner, logger).probe(customer());
    const e = events()[0];
    expect(e?.action).toBe('bridge.securepoint.probe');
    expect(e?.outcome).toBe('ok');
    const ds = JSON.stringify(e?.details ?? {});
    expect(ds).not.toContain(API_KEY);
    expect(ds).not.toContain('UTM-MUELLER');
  });

  it('401 → outcome=denied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const logger = new AuditLogger({ auditDir: dir });
    await withAuditTrail(bridge(fetchMock), logger).probe(customer());
    expect(events()[0]?.outcome).toBe('denied');
  });
});
