/**
 * End-to-end pipeline test for the automation engine, composed exactly as the
 * server wires it (minus the Fastify HTTP transport): real loadRules from a
 * YAML file, real MspHealthAggregator + prober/mapper (with a stub bridge),
 * real diff + evaluate, real dispatch into the real NotificationBus.
 *
 * Proves that a genuine bridge status transition produces an `automation://alert`
 * on the bus and lands in the fired-action log — the integration the unit tests
 * could not observe on their own.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ActionSink,
  createFiredActionLog,
  dispatchFiredAction,
  loadRules,
  startAutomationEngine,
} from '../../src/domains/automation/index.js';
import { AggregateCache, MspHealthAggregator } from '../../src/domains/msp-aggregate/index.js';
import { BridgeRegistry } from '../../src/domains/msp-bridges/index.js';
import type {
  BridgeKind,
  BridgeProbe,
  BridgeResult,
  ReadBridge,
} from '../../src/domains/msp-bridges/types.js';
import type { CustomerRecord } from '../../src/domains/msp-customers/index.js';
import { createNotificationBus } from '../../src/server/events-sse.js';

const RULE = `id: tanss-down-alert
trigger:
  bridge: tanss
  customers: all
condition:
  statusIn:
    - unreachable
actions:
  - type: dashboard-alert
    message: TANSS nicht erreichbar
`;

/** Stub bridge whose result can be mutated between probes. */
class MutableBridge<T> implements ReadBridge<T> {
  public result: BridgeResult<T>;
  constructor(
    public readonly kind: BridgeKind,
    initial: BridgeResult<T>,
  ) {
    this.result = initial;
  }
  async probe(c: CustomerRecord): Promise<BridgeProbe<T>> {
    return {
      bridgeKind: this.kind,
      customerSlug: c.slug,
      probedAt: new Date().toISOString(),
      durationMs: 1,
      result: this.result,
    };
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'automation-pipeline-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('automation pipeline (server composition)', () => {
  it('emits automation://alert + logs the firing when a bridge transitions', async () => {
    writeFileSync(join(dir, 'tanss.yaml'), RULE);

    const stub = new MutableBridge<unknown>('tanss', { kind: 'ok', data: {} });
    const registry = new BridgeRegistry();
    registry.register(stub);
    const customers: CustomerRecord[] = [
      { slug: 'acme', displayName: 'Acme', bridges: { tanss: { customerId: 1 } } },
    ];
    const aggregator = new MspHealthAggregator({
      registry,
      listCustomers: async () => customers,
      cache: new AggregateCache({ ttlSec: 60 }),
    });

    const bus = createNotificationBus();
    const alerts: unknown[] = [];
    bus.subscribe((method, params) => {
      if (method === 'automation://alert') alerts.push(params);
    });
    const firedLog = createFiredActionLog();
    const sink: ActionSink = {
      alert: (fired) => bus.emit('automation://alert', fired),
      audit: () => {},
    };

    let pending: (() => void | Promise<void>) | null = null;
    const engine = startAutomationEngine({
      loadRules: () => loadRules(dir).rules,
      getSnapshot: () => aggregator.forceRefresh(), // fresh probe each tick
      emit: (fired) => {
        firedLog.record(fired);
        dispatchFiredAction(fired, sink);
      },
      setTimeoutFn: (cb) => {
        pending = cb;
        return 1;
      },
      clearTimeoutFn: () => {
        pending = null;
      },
    });
    const tick = async (): Promise<void> => {
      const cb = pending;
      pending = null;
      await cb?.();
    };

    await tick(); // baseline: tanss ok
    expect(alerts).toHaveLength(0);

    stub.result = { kind: 'unreachable', message: 'connection refused' };
    await tick(); // ok -> unreachable

    expect(alerts).toHaveLength(1);
    const firings = firedLog.recent();
    expect(firings).toHaveLength(1);
    expect(firings[0]?.ruleId).toBe('tanss-down-alert');
    expect(firings[0]?.slug).toBe('acme');
    expect(firings[0]?.action.type).toBe('dashboard-alert');

    engine.stop();
  });
});
