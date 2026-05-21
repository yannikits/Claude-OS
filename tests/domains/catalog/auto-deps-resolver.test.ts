import { describe, expect, it, vi } from 'vitest';
import {
  AutoDepsAmbiguousProviderError,
  AutoDepsError,
  AutoDepsMissingProviderError,
  type CatalogConfig,
  CyclicAutoDepsError,
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
  it('wirft CyclicAutoDepsError wenn Marketplace dieselbe Provider-ID fuer zwei verschiedene Caps zurueckgibt', async () => {
    // A requires foo. Marketplace returns B (provides foo, requires bar).
    // Iter 1: B added → visited = {a, b}.
    // Iter 2: B needs bar (unmet). Marketplace returns B AGAIN for bar
    // (inconsistent marketplace — claims B provides bar via a second
    // manifest variant). Resolver sees `visited.has('b')` → throws.
    const aManifest = makeManifest('a', { requires: ['mcp:foo'] });
    const bManifestFirst = makeManifest('b', {
      requires: ['mcp:bar'],
      provides: ['mcp:foo'],
    });
    const bManifestSecond = makeManifest('b', { provides: ['mcp:bar'] });

    const lookup = vi.fn(async (cap: { name: string }) => {
      if (cap.name === 'foo') {
        return [{ manifest: bManifestFirst, source: 'marketplace:acme:b' }];
      }
      if (cap.name === 'bar') {
        return [{ manifest: bManifestSecond, source: 'marketplace:acme:b-alt' }];
      }
      return [];
    });

    await expect(
      resolveAutoDeps({
        catalog: EMPTY_CATALOG,
        existingManifests: new Map([['a', aManifest]]),
        lookupProvider: lookup,
      }),
    ).rejects.toThrow(CyclicAutoDepsError);

    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('Linear-Chain ohne echte Zyklen laeuft sauber durch', async () => {
    // Sanity-check: A → B (provides foo, requires bar), C (provides bar)
    // ist KEIN Zyklus. Beide werden hinzugefuegt.
    const aManifest = makeManifest('a', { requires: ['mcp:foo'] });
    const bManifest = makeManifest('b', { requires: ['mcp:bar'], provides: ['mcp:foo'] });
    const cManifest = makeManifest('c', { provides: ['mcp:bar'] });

    const lookup = vi.fn(async (cap: { name: string }) => {
      if (cap.name === 'foo') {
        return [{ manifest: bManifest, source: 'marketplace:acme:b' }];
      }
      if (cap.name === 'bar') {
        return [{ manifest: cManifest, source: 'marketplace:acme:c' }];
      }
      return [];
    });

    const result = await resolveAutoDeps({
      catalog: EMPTY_CATALOG,
      existingManifests: new Map([['a', aManifest]]),
      lookupProvider: lookup,
    });
    expect(result.newEntries.map((e) => e.id).sort()).toEqual(['b', 'c']);
  });

  it('Selbst-providende Plugins (B requires foo + provides foo) brauchen keinen weiteren Provider', async () => {
    const aManifest = makeManifest('a', { requires: ['mcp:foo'] });
    const bManifest = makeManifest('b', { requires: ['mcp:foo'], provides: ['mcp:foo'] });

    const lookup = vi.fn(async () => {
      return [{ manifest: bManifest, source: 'marketplace:acme:b' }];
    });

    // Iter 1: foo unmet → B added (visited={a,b}). Iter 2: B requires
    // foo, aber B selbst provides foo → resolveBindings findet binding
    // → KEIN unmet mehr → Fixpoint. Lookup wird nur EINMAL gerufen.
    const result = await resolveAutoDeps({
      catalog: EMPTY_CATALOG,
      existingManifests: new Map([['a', aManifest]]),
      lookupProvider: lookup,
    });
    expect(result.newEntries.map((e) => e.id)).toEqual(['b']);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe('resolveAutoDeps — Version-Konflikt (existingManifests-Kollision)', () => {
  it('wirft CyclicAutoDepsError wenn Marketplace eine ID liefert die bereits in existingManifests existiert', async () => {
    // Catalog hat c@1.0.0 das KEIN foo provides. A requires foo.
    // Marketplace lookup fuer foo gibt c@2.0.0 zurueck (gleiche id,
    // andere Version, claims foo). visited startet mit {a, c} →
    // chosen.manifest.id 'c' kollidiert → CyclicAutoDepsError.
    const aManifest = makeManifest('a', { requires: ['mcp:foo'] });
    const cInstalled = {
      id: 'c',
      version: '1.0.0',
      provides: ['mcp:something-else'],
    };
    const cMarketplaceV2 = makeManifest('c', { provides: ['mcp:foo'] });

    const lookup = vi.fn(async () => [
      { manifest: cMarketplaceV2, source: 'marketplace:acme:c@2.0.0' },
    ]);

    await expect(
      resolveAutoDeps({
        catalog: EMPTY_CATALOG,
        existingManifests: new Map([
          ['a', aManifest],
          ['c', cInstalled],
        ]),
        lookupProvider: lookup,
      }),
    ).rejects.toThrow(CyclicAutoDepsError);
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
