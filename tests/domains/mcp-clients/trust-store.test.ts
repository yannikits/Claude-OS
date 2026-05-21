/**
 * M3 (2026-05-21 code-review): Tests fuer McpTrustStore — persistente
 * acknowledged-list fuer MCP-Server-Spawn-Gating.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpTrustStore } from '../../../src/domains/mcp-clients/index.js';

describe('McpTrustStore', () => {
  let tmpBase: string;
  let filePath: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-mcp-trust-'));
    filePath = join(tmpBase, 'mcp-trust.json');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  function makeStore(): McpTrustStore {
    return new McpTrustStore({ filePath });
  }

  it('isAcknowledged ist false fuer unknown serverKey', () => {
    expect(makeStore().isAcknowledged('local:claude-flow')).toBe(false);
  });

  it('acknowledge → isAcknowledged true + acknowledgedAt populated', () => {
    const store = makeStore();
    store.acknowledge('local:claude-flow', () => new Date('2026-05-21T10:00:00.000Z'));
    expect(store.isAcknowledged('local:claude-flow')).toBe(true);
    expect(store.acknowledgedAt('local:claude-flow')).toBe('2026-05-21T10:00:00.000Z');
  });

  it('acknowledge ist idempotent — zweiter Call ueberschreibt timestamp NICHT', () => {
    const store = makeStore();
    store.acknowledge('local:srv', () => new Date('2026-05-21T10:00:00.000Z'));
    store.acknowledge('local:srv', () => new Date('2026-05-22T10:00:00.000Z'));
    expect(store.acknowledgedAt('local:srv')).toBe('2026-05-21T10:00:00.000Z');
  });

  it('persistiert acknowledged-set across instances', () => {
    makeStore().acknowledge('local:srv-a', () => new Date('2026-05-21T08:00:00.000Z'));
    makeStore().acknowledge('local:srv-b', () => new Date('2026-05-21T09:00:00.000Z'));
    const replay = makeStore();
    expect(replay.isAcknowledged('local:srv-a')).toBe(true);
    expect(replay.isAcknowledged('local:srv-b')).toBe(true);
    expect(
      replay
        .list()
        .map((e) => e.serverKey)
        .sort(),
    ).toEqual(['local:srv-a', 'local:srv-b']);
  });

  it('revoke entfernt entry + returnt true', () => {
    const store = makeStore();
    store.acknowledge('local:srv');
    expect(store.revoke('local:srv')).toBe(true);
    expect(store.isAcknowledged('local:srv')).toBe(false);
  });

  it('revoke auf unbekannten serverKey → false (no-op)', () => {
    const store = makeStore();
    expect(store.revoke('local:never-was-here')).toBe(false);
  });

  it('list returnt sortiert + frozen snapshot', () => {
    const store = makeStore();
    store.acknowledge('zeta:srv');
    store.acknowledge('alpha:srv');
    store.acknowledge('mike:srv');
    const entries = store.list();
    expect(entries.map((e) => e.serverKey)).toEqual(['alpha:srv', 'mike:srv', 'zeta:srv']);
    for (const e of entries) {
      expect(e.acknowledgedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('malformed JSON file → behandelt als leer (pessimistic)', () => {
    writeFileSync(filePath, '{not valid json');
    const store = makeStore();
    expect(store.list()).toEqual([]);
    // Sollte trotzdem acknowledge schreiben koennen (overrides malformed file)
    store.acknowledge('local:srv');
    expect(store.isAcknowledged('local:srv')).toBe(true);
  });

  it('wrong-version envelope → behandelt als leer', () => {
    writeFileSync(filePath, JSON.stringify({ version: 99, acknowledged: { x: '2026-01-01' } }));
    const store = makeStore();
    expect(store.list()).toEqual([]);
    expect(store.isAcknowledged('x')).toBe(false);
  });

  it('persisted file ist JSON-formatiert (Audit-friendly)', () => {
    makeStore().acknowledge('local:srv', () => new Date('2026-05-21T10:00:00.000Z'));
    const raw = readFileSync(filePath, 'utf8');
    expect(raw).toContain('"acknowledged"');
    expect(raw).toContain('local:srv');
    expect(raw).toContain('2026-05-21T10:00:00.000Z');
    // Pretty-printed (Audit lesbar)
    expect(raw).toContain('\n');
  });
});
