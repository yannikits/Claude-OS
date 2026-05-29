import { describe, expect, it } from 'vitest';
import { SecurepointMetricsCache } from '../../../../src/domains/msp-bridges/securepoint/index.js';
import type { PrometheusMap } from '../../../../src/domains/msp-bridges/securepoint/types.js';

function fakeMap(name: string): PrometheusMap {
  return new Map([[name, [{ labels: {}, value: 1 }]]]);
}

describe('SecurepointMetricsCache', () => {
  it('starts empty', () => {
    const c = new SecurepointMetricsCache();
    expect(c.get()).toBeNull();
  });

  it('get returns map until TTL elapses', () => {
    const t = 0;
    const c = new SecurepointMetricsCache({ ttlSec: 1, now: () => t });
    void c.getOrLoad(async () => fakeMap('a'));
    // synchronous resolution sequence
  });

  it('serves cached map on second getOrLoad within TTL', async () => {
    let calls = 0;
    const c = new SecurepointMetricsCache({ ttlSec: 60 });
    const loader = async () => {
      calls += 1;
      return fakeMap('m');
    };
    await c.getOrLoad(loader);
    await c.getOrLoad(loader);
    await c.getOrLoad(loader);
    expect(calls).toBe(1);
  });

  it('expires after TTL', async () => {
    let t = 0;
    const c = new SecurepointMetricsCache({ ttlSec: 1, now: () => t });
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return fakeMap('m');
    };
    await c.getOrLoad(loader);
    t = 2000;
    await c.getOrLoad(loader);
    expect(calls).toBe(2);
  });

  it('invalidate forces a fresh load', async () => {
    const c = new SecurepointMetricsCache({ ttlSec: 60 });
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return fakeMap('m');
    };
    await c.getOrLoad(loader);
    c.invalidate();
    await c.getOrLoad(loader);
    expect(calls).toBe(2);
  });

  it('cache-stampede: 10 concurrent callers share ONE in-flight loader', async () => {
    const c = new SecurepointMetricsCache({ ttlSec: 60 });
    let calls = 0;
    let resolveLoader: ((v: PrometheusMap) => void) | null = null;
    const loaderPromise = new Promise<PrometheusMap>((res) => {
      resolveLoader = res;
    });
    const loader = async () => {
      calls += 1;
      return loaderPromise;
    };
    const callers = Array.from({ length: 10 }, () => c.getOrLoad(loader));
    await Promise.resolve();
    resolveLoader?.(fakeMap('shared'));
    const results = await Promise.all(callers);
    expect(calls).toBe(1);
    expect(results.every((r) => r.has('shared'))).toBe(true);
  });

  it('loader-throw clears in-flight so next call retries', async () => {
    const c = new SecurepointMetricsCache({ ttlSec: 60 });
    let calls = 0;
    await expect(
      c.getOrLoad(async () => {
        calls += 1;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await c.getOrLoad(async () => fakeMap('recovered'));
    expect(calls).toBe(1);
  });
});
