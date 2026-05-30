import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogger } from '../../../../src/core/audit/index.js';
import type { AuditEntry } from '../../../../src/core/audit/types.js';
import { withAuditTrail } from '../../../../src/domains/msp-bridges/index.js';
import { TanssBridge } from '../../../../src/domains/msp-bridges/tanss/index.js';
import type {
  TanssBridgeConfig,
  TanssTicketRaw,
} from '../../../../src/domains/msp-bridges/tanss/types.js';
import type { CustomerRecord } from '../../../../src/domains/msp-customers/index.js';

const SERVER = 'https://tanss.example.com';
const TOKEN = 'apiKey-XYZ';

function customerWithTanss(customerId = 42): CustomerRecord {
  return {
    slug: 'mueller-gmbh',
    displayName: 'Mueller GmbH',
    bridges: { tanss: { customerId } },
  };
}

function customerWithout(): CustomerRecord {
  return { slug: 'naked', displayName: 'Naked' };
}

/** Builds a Response-like object the bridge's fetch will see. */
function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function tanssWrapped(tickets: TanssTicketRaw[]): unknown {
  return { content: tickets };
}

describe('TanssBridge.probe', () => {
  it('returns misconfigured WITHOUT making a fetch call when bridges.tanss is missing', async () => {
    const fetchMock = vi.fn();
    const cfg: TanssBridgeConfig = {
      serverUrl: SERVER,
      getApiToken: async () => TOKEN,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    };
    const b = new TanssBridge(cfg);
    const probe = await b.probe(customerWithout());
    expect(probe.result.kind).toBe('misconfigured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns auth-failed WITHOUT making a fetch call when getApiToken() yields null', async () => {
    const fetchMock = vi.fn();
    const cfg: TanssBridgeConfig = {
      serverUrl: SERVER,
      getApiToken: async () => null,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    };
    const b = new TanssBridge(cfg);
    const probe = await b.probe(customerWithTanss());
    expect(probe.result.kind).toBe('auth-failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('happy path: parses {content:[...]} → ok with TanssStatus', async () => {
    const tickets: TanssTicketRaw[] = [
      { id: 1, subject: 'Drucker offline', status: 'OPEN', updateDate: '2026-05-28T10:00:00Z' },
      { id: 2, subject: 'Done', status: 'closed', updateDate: '2026-05-27T10:00:00Z' },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tanssWrapped(tickets)));
    const b = new TanssBridge({
      serverUrl: SERVER,
      getApiToken: async () => TOKEN,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    const probe = await b.probe(customerWithTanss(42));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe(`${SERVER}/api/v1/tickets/company/42`);
    expect(opts.method).toBe('GET');
    expect(opts.headers.apiToken).toBe(TOKEN);
    expect(opts.headers).not.toHaveProperty('Authorization');
    expect(probe.result.kind).toBe('ok');
    if (probe.result.kind === 'ok') {
      expect(probe.result.data.openCount).toBe(1);
      expect(probe.result.data.totalCount).toBe(2);
      expect(probe.result.data.sample?.id).toBe(1);
    }
    expect(probe.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('happy path: bare array (alt TANSS variant) also works', async () => {
    const tickets: TanssTicketRaw[] = [{ id: 1, subject: 's', status: 'open' }];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tickets));
    const b = new TanssBridge({
      serverUrl: SERVER,
      getApiToken: async () => TOKEN,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    const probe = await b.probe(customerWithTanss());
    expect(probe.result.kind).toBe('ok');
  });

  it('401 → auth-failed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const b = new TanssBridge({
      serverUrl: SERVER,
      getApiToken: async () => TOKEN,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    const probe = await b.probe(customerWithTanss());
    expect(probe.result.kind).toBe('auth-failed');
  });

  it('429 with Retry-After → rate-limited with the right retryAfterSec', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '45' } }));
    const b = new TanssBridge({
      serverUrl: SERVER,
      getApiToken: async () => TOKEN,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    const probe = await b.probe(customerWithTanss());
    expect(probe.result.kind).toBe('rate-limited');
    if (probe.result.kind === 'rate-limited') {
      expect(probe.result.retryAfterSec).toBe(45);
    }
  });

  it('404 → misconfigured (customerId unknown to TANSS)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    const b = new TanssBridge({
      serverUrl: SERVER,
      getApiToken: async () => TOKEN,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    const probe = await b.probe(customerWithTanss(9999));
    expect(probe.result.kind).toBe('misconfigured');
  });

  it('500 → unreachable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    const b = new TanssBridge({
      serverUrl: SERVER,
      getApiToken: async () => TOKEN,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    expect((await b.probe(customerWithTanss())).result.kind).toBe('unreachable');
  });

  it('thrown TypeError("fetch failed") → unreachable', async () => {
    const err = Object.assign(new Error('fetch failed'), { name: 'TypeError' });
    const fetchMock = vi.fn().mockRejectedValue(err);
    const b = new TanssBridge({
      serverUrl: SERVER,
      getApiToken: async () => TOKEN,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    expect((await b.probe(customerWithTanss())).result.kind).toBe('unreachable');
  });

  it('unexpected response shape (non-array, no content) → error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ foo: 'bar' }));
    const b = new TanssBridge({
      serverUrl: SERVER,
      getApiToken: async () => TOKEN,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    expect((await b.probe(customerWithTanss())).result.kind).toBe('error');
  });

  it('serverUrl with trailing slash is normalised', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tanssWrapped([])));
    const b = new TanssBridge({
      serverUrl: `${SERVER}/`,
      getApiToken: async () => TOKEN,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    await b.probe(customerWithTanss(7));
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${SERVER}/api/v1/tickets/company/7`);
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
    const b = new TanssBridge({
      serverUrl: SERVER,
      getApiToken: async () => TOKEN,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      timeoutMs: 50,
    });
    const probe = await b.probe(customerWithTanss());
    expect(probe.result.kind).toBe('unreachable');
  });

  it('calls getApiToken() once per probe (no caching) — proves the contract', async () => {
    const tokenFn = vi.fn().mockResolvedValue(TOKEN);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tanssWrapped([])));
    const b = new TanssBridge({
      serverUrl: SERVER,
      getApiToken: tokenFn,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    await b.probe(customerWithTanss());
    await b.probe(customerWithTanss());
    await b.probe(customerWithTanss());
    expect(tokenFn).toHaveBeenCalledTimes(3);
  });
});

describe('TanssBridge — apiBase override + secret-store resilience', () => {
  it('uses a configured apiBase instead of the default /api/v1', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tanssWrapped([])));
    const b = new TanssBridge({
      serverUrl: SERVER,
      apiBase: '/backend/api/v1',
      getApiToken: async () => TOKEN,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    await b.probe(customerWithTanss(42));
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${SERVER}/backend/api/v1/tickets/company/42`);
  });

  it('normalises a trailing slash on apiBase', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tanssWrapped([])));
    const b = new TanssBridge({
      serverUrl: SERVER,
      apiBase: '/backend/api/v1/',
      getApiToken: async () => TOKEN,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    await b.probe(customerWithTanss(7));
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${SERVER}/backend/api/v1/tickets/company/7`);
  });

  it('defaults to /api/v1 when apiBase is omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tanssWrapped([])));
    const b = new TanssBridge({
      serverUrl: SERVER,
      getApiToken: async () => TOKEN,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    await b.probe(customerWithTanss(5));
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${SERVER}/api/v1/tickets/company/5`);
  });

  it('returns auth-failed (never throws) when getApiToken() rejects — ADR-0038', async () => {
    const fetchMock = vi.fn();
    const b = new TanssBridge({
      serverUrl: SERVER,
      getApiToken: async () => {
        throw new Error('Encrypted-file backend is locked: no master key');
      },
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    const probe = await b.probe(customerWithTanss());
    expect(probe.result.kind).toBe('auth-failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tolerates null / non-object elements in the ticket array (never throws — ADR-0038)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ content: [{ id: 1, status: 'OPEN' }, null, 'x', 5] }));
    const b = new TanssBridge({
      serverUrl: SERVER,
      getApiToken: async () => TOKEN,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    const probe = await b.probe(customerWithTanss());
    expect(probe.result.kind).toBe('ok');
    if (probe.result.kind === 'ok') {
      expect(probe.result.data.totalCount).toBe(1); // only the valid object counts
      expect(probe.result.data.openCount).toBe(1);
    }
  });

  it('whitespace-only apiBase falls back to the /api/v1 default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tanssWrapped([])));
    const b = new TanssBridge({
      serverUrl: SERVER,
      apiBase: '   ',
      getApiToken: async () => TOKEN,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    await b.probe(customerWithTanss(9));
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${SERVER}/api/v1/tickets/company/9`);
  });
});

describe('TanssBridge + withAuditTrail integration', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tanss-audit-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function readEvents(): AuditEntry[] {
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

  it('writes bridge.read event with action=bridge.tanss.probe on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tanssWrapped([])));
    const inner = new TanssBridge({
      serverUrl: SERVER,
      getApiToken: async () => TOKEN,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    const logger = new AuditLogger({ auditDir: dir });
    const bridge = withAuditTrail(inner, logger);
    await bridge.probe(customerWithTanss());
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('bridge.tanss.probe');
    expect(events[0]?.kind).toBe('bridge.read');
    expect(events[0]?.outcome).toBe('ok');
    // PII check: NO apiToken, NO subject in details
    const detailsStr = JSON.stringify(events[0]?.details ?? {});
    expect(detailsStr).not.toContain(TOKEN);
    expect(detailsStr).not.toContain('subject');
  });

  it('writes outcome=denied for 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const inner = new TanssBridge({
      serverUrl: SERVER,
      getApiToken: async () => TOKEN,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    const logger = new AuditLogger({ auditDir: dir });
    await withAuditTrail(inner, logger).probe(customerWithTanss());
    expect(readEvents()[0]?.outcome).toBe('denied');
  });
});
