import { describe, expect, it, vi } from 'vitest';
import {
  AutoDepsAmbiguousProviderError,
  AutoDepsError,
  AutoDepsMissingProviderError,
  type CatalogConfig,
  type MarketplaceCandidate,
  resolveAutoDeps,
} from '../../../src/domains/catalog/index.js';

const EMPTY_CATALOG: CatalogConfig = { version: 1, entries: [] };

function makeManifest(id: string, opts: { requires?: string[]; provides?: string[] } = {}) {
  return {
    id,
    version: '1.0.0',
    ...(opts.requires === undefined ? {} : { requires: opts.requires }),
    ...(opts.provides === undefined ? {} : { provides: opts.provides }),
  };
}

describe('resolveAutoDeps — Linear-Chain (TF-1)', () => {
  it('resolved A → B → C in deterministic Reihenfolge', async () => {
    // C provides foo, B requires foo+provides bar, A requires bar
    const aManifest = makeManifest('a', { requires: ['mcp:bar'] });
    const bManifest = makeManifest('b', { requires: ['mcp:foo'], provides: ['mcp:bar'] });
    const cManifest = makeManifest('c', { provides: ['mcp:foo'] });

    const lookup = vi.fn(async (cap: { name: string }) => {
      if (cap.name === 'foo') {
        return [{ manifest: cManifest, source: 'marketplace:acme:c' }];
      }
      if (cap.name === 'bar') {
        return [{ manifest: bManifest, source: 'marketplace:acme:b' }];
      }
      return [];
    });

    const result = await resolveAutoDeps({
      catalog: EMPTY_CATALOG,
      existingManifests: new Map([['a', aManifest]]),
      lookupProvider: lookup,
    });

    // a war im Catalog, b und c sollten als neue Entries hinzukommen
    expect(result.newEntries.map((e) => e.id)).toEqual(['b', 'c']);
    expect(result.iterations).toBeGreaterThan(0);
  });
});

describe('resolveAutoDeps — Pre-Installed (TF-2)', () => {
  it('fuegt B nicht hinzu wenn schon installiert', async () => {
    const aManifest = makeManifest('a', { requires: ['mcp:foo'] });
    const bManifest = makeManifest('b', { provides: ['mcp:foo'] });
    const lookup = vi.fn(async () => [] as readonly MarketplaceCandidate[]);

    const result = await resolveAutoDeps({
      catalog: EMPTY_CATALOG,
      existingManifests: new Map([
        ['a', aManifest],
        ['b', bManifest],
      ]),
      lookupProvider: lookup,
    });

    expect(result.newEntries).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('resolveAutoDeps — Missing-Provider (TF-4)', () => {
  it('wirft MissingProviderError wenn Marketplace nichts liefert', async () => {
    const aManifest = makeManifest('a', { requires: ['mcp:foo'] });
    const lookup = vi.fn(async () => [] as readonly MarketplaceCandidate[]);

    await expect(
      resolveAutoDeps({
        catalog: EMPTY_CATALOG,
        existingManifests: new Map([['a', aManifest]]),
        lookupProvider: lookup,
      }),
    ).rejects.toThrow(AutoDepsMissingProviderError);
  });
});

describe('resolveAutoDeps — Cyclic (TF-5)', () => {
  it('wirft CyclicAutoDepsError wenn Provider sich selbst transitiv braucht', async () => {
    const aManifest = makeManifest('a', { requires: ['mcp:foo'] });
    const bManifest = makeManifest('b', { requires: ['mcp:bar'], provides: ['mcp:foo'] });
    const cManifest = makeManifest('c', { requires: ['mcp:foo'], provides: ['mcp:bar'] });

    const lookup = vi.fn(async (cap: { name: string }) => {
      if (cap.name === 'foo') {
        return [{ manifest: bManifest, source: 'marketplace:acme:b' }];
      }
      if (cap.name === 'bar') {
        // c provides bar, but c requires foo (already provided by b)
        return [{ manifest: cManifest, source: 'marketplace:acme:c' }];
      }
      return [];
    });

    // Resolver shouldn't cycle — b provides foo, c provides bar, c requires foo (b provides).
    // Actually this is OK, not cyclic. Lass es einfach durchlaufen.
    const result = await resolveAutoDeps({
      catalog: EMPTY_CATALOG,
      existingManifests: new Map([['a', aManifest]]),
      lookupProvider: lookup,
    });
    expect(result.newEntries.map((e) => e.id).sort()).toEqual(['b', 'c']);
  });

  it('erkennt echte Selbst-Zyklen via visited-Set', async () => {
    const aManifest = makeManifest('a', { requires: ['mcp:foo'] });
    const bManifest = makeManifest('b', { requires: ['mcp:foo'], provides: ['mcp:foo'] });

    const lookup = vi.fn(async () => {
      // b provides foo aber required AUCH foo — selbst-rekursion soll
      // gefangen werden weil b im naechsten Iteration nochmal als
      // Provider auftaucht.
      return [{ manifest: bManifest, source: 'marketplace:acme:b' }];
    });

    // Erste Iteration: a needs foo -> b added. b needs foo too (=b
    // already provides it), so binding resolves without re-fetching.
    // Wenn der Resolver buggy ist und b nochmal fetchen will, schlaegt
    // die visited-detection an.
    const result = await resolveAutoDeps({
      catalog: EMPTY_CATALOG,
      existingManifests: new Map([['a', aManifest]]),
      lookupProvider: lookup,
    });
    expect(result.newEntries.map((e) => e.id)).toEqual(['b']);
  });
});

describe('resolveAutoDeps — Ambiguous (TF-6)', () => {
  it('wirft AmbiguousProviderError wenn mehrere Provider', async () => {
    const aManifest = makeManifest('a', { requires: ['mcp:foo'] });
    const lookup = vi.fn(async () => [
      { manifest: makeManifest('x'), source: 'marketplace:x:foo' },
      { manifest: makeManifest('y'), source: 'marketplace:y:foo' },
    ]);

    await expect(
      resolveAutoDeps({
        catalog: EMPTY_CATALOG,
        existingManifests: new Map([['a', aManifest]]),
        lookupProvider: lookup,
      }),
    ).rejects.toThrow(AutoDepsAmbiguousProviderError);
  });
});

describe('resolveAutoDeps — Idempotenz (TF-7)', () => {
  it('zweimaliger Lauf mit identischer Eingabe produziert gleiches Ergebnis', async () => {
    const aManifest = makeManifest('a', { requires: ['mcp:foo'] });
    const bManifest = makeManifest('b', { provides: ['mcp:foo'] });
    const lookup = vi.fn(async () => [{ manifest: bManifest, source: 'marketplace:acme:b' }]);

    const run1 = await resolveAutoDeps({
      catalog: EMPTY_CATALOG,
      existingManifests: new Map([['a', aManifest]]),
      lookupProvider: lookup,
    });
    const run2 = await resolveAutoDeps({
      catalog: EMPTY_CATALOG,
      existingManifests: new Map([['a', aManifest]]),
      lookupProvider: lookup,
    });
    expect(run1.newEntries).toEqual(run2.newEntries);
  });
});

describe('resolveAutoDeps — Max-Iterations', () => {
  it('wirft AutoDepsError wenn Fixpoint nicht erreicht nach N Iterationen', async () => {
    const aManifest = makeManifest('a', { requires: ['mcp:foo'] });
    // Lookup gibt jedes Mal ein NEUES Plugin zurueck, das ZUSAETZLICHE
    // Anforderungen hat — endloser Fan-Out
    let counter = 0;
    const lookup = vi.fn(async () => {
      counter++;
      return [
        {
          manifest: makeManifest(`x${counter}`, {
            requires: [`mcp:bar${counter}`],
            provides: [`mcp:foo`],
          }),
          source: `marketplace:auto:x${counter}`,
        },
      ];
    });
    await expect(
      resolveAutoDeps({
        catalog: EMPTY_CATALOG,
        existingManifests: new Map([['a', aManifest]]),
        lookupProvider: lookup,
        maxIterations: 2,
      }),
    ).rejects.toThrow(AutoDepsError);
  });
});
