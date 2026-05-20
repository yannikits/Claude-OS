# ADR-0020 — Auto-Deps Fixed-Point-Resolution mit Marketplace-Lookup (v1.5)

**Status:** Akzeptiert
**Datum:** 2026-05-20
**Bedingt durch:** Auto-Deps-Pipeline PRs [#39](https://github.com/yannikits/Claude-portable/pull/39) (Resolver), [#43](https://github.com/yannikits/Claude-portable/pull/43) (CLI), [#44](https://github.com/yannikits/Claude-portable/pull/44) (E2E), [#47](https://github.com/yannikits/Claude-portable/pull/47) (GUI). ADR-0010 etablierte das Capability-System; diese ADR dokumentiert die konkrete Implementation der transitiven Auto-Deps-Auflösung.

## Kontext

Phase 5g (Capability-Resolver) und Phase 5o (Plugin-Binding-Resolution in lockCatalog) hatten die Foundation gebaut: ein Plugin deklariert `requires` und `provides`, der CapabilityResolver findet pro Plugin den passenden Provider aus einem `Catalog`. Was fehlte: **transitive Auflösung gegen einen Marketplace**.

User-Story: "Ich will `skill-a` installieren das `mcp:redis` braucht. Ich will NICHT erst manuell `mcp-redis` installieren muessen. claude-os soll im Marketplace nachschauen, `mcp-redis` finden, fetchen, und beides installieren — als ein User-Action."

Drei Architektur-Optionen wurden überlegt:

| Option | Wann passiert die Auflösung? | Mehrwert | Trade-off |
|---|---|---|---|
| **A: Pre-build Index** | Vor jedem `catalog install` einmalig: `marketplace.refreshIndex` → on-disk `<dataDir>/marketplace-capability-index.json` | sehr schnell pro Install | ETag-Re-Validierung + Cache-Eviction-Logik nötig |
| **B: Lazy auf Anforderung** | Beim ersten `catalog install --auto-deps`: iteriere alle Marketplaces, fetche Tarballs, peeke Manifeste | keine On-Disk-Index-Pflege | langsam beim ersten Install pro Session |
| **C: Cache als Hybrid** | A + per-Lauf in-memory-Cache | beste UX | komplexeste Implementation |

## Entscheidung

**Option B — Lazy in-memory Index mit closure-scoped Cache pro Lookup-Instance.** Folge-PRs koennen zu Option C upgraden ohne API-Bruch.

### Pipeline-Phasen (v1.5)

```
catalog install <source> --auto-deps --registry <path>
       │
       ▼
1. parseSource(<source>)         — nur github: in v1.5
       │
       ▼
2. lockCatalog stub-fetch        — Target-Tarball cachen
       │
       ▼
3. readPluginManifestFromTarball — plugin.json peek
       │
       ▼
4. createMarketplaceProviderLookup
       └─ lazy-builds Index beim ersten Call
       │
       ▼
5. resolveAutoDeps (iterativer Fixed-Point)
       └─ Loop bis fixed-point ODER maxIterations
            ├─ resolveBindings(existing + accumulated)
            ├─ Sammle unmet requires (eine pro Iteration)
            ├─ lookupProvider(cap) → MarketplaceCandidate[]
            └─ visited-Set Check → CyclicAutoDepsError
       │
       ▼
6. writeCatalog (target + new providers)
       │
       ▼
7. lockCatalog (full re-lock)
       │
       ▼
8. applyLock → FS-Extract aller Tarballs
       │
       ▼
   AutoDepsInstallResult zurueck zum Caller (CLI ODER Sidecar-RPC)
```

### Resolver-Algorithmus (Phase 5)

Iterative-fixed-point mit **einer Capability pro Iteration**:

```ts
function resolveAutoDeps({existingManifests, lookupProvider, maxIterations=5}) {
  const aggregateManifests = new Map(existingManifests);
  const newEntries: CatalogEntry[] = [];
  const visited = new Set([...aggregateManifests.keys()]);

  for (let i = 0; i < maxIterations; i++) {
    const bindings = resolveBindings([...aggregateManifests]);
    const unmet = collectUnmetCapabilities(bindings);
    if (unmet.length === 0) return /* fixed-point reached */;

    const next = unmet[0];                              // EINE Capability pro Iteration
    const candidates = await lookupProvider(parseCap(next));
    if (candidates.length === 0) throw MissingProviderError;
    if (candidates.length > 1) throw AmbiguousProviderError;

    const chosen = candidates[0];
    if (visited.has(chosen.id)) throw CyclicAutoDepsError;
    visited.add(chosen.id);
    aggregateManifests.set(chosen.id, chosen.manifest);
    newEntries.push(toEntry(chosen));
  }
  throw "did not converge";  // Bug-Cycle
}
```

**Warum eine Capability pro Iteration?** Bei `M` unmet caps und naivem Parallel-Resolve könnten zwei capabilities gleichzeitig zum gleichen Provider führen — der dann doppelt in `newEntries` landet und beim writeCatalog dedup'd werden müsste. Sequenzielles Resolve plus visited-Set ist deterministisch + cycle-safe ohne Edge-Case-Code.

**Warum Hard-Error bei AmbiguousProvider?** v1.5 hat keine UI-Disambiguation. User muss explizit eine Marketplace-Source angeben um die Mehrdeutigkeit aufzulösen. v1.6 könnte ein `--prefer <id>`-Flag bringen.

### Provider-Lookup (Phase 5q)

`createMarketplaceProviderLookup({registry, cacheDir, fetch?, readManifest?})` ist eine **Factory** die einen `ProviderLookup` zurückgibt — kein langlebiges Objekt mit eigenem State, sondern eine Closure-gebundene Funktion.

```ts
const lookup = createMarketplaceProviderLookup({...});

// Erster Aufruf: baut den Index
//  - marketplaces() listet alle bekannten Marketplaces
//  - Pro Marketplace × Plugin: registry.resolve() liefert github-Source
//  - Tarball-Fetch via cached fetchAndCache
//  - Manifest-Peek via tarball-manifest-reader
//  - Map<source, PluginManifest> wird in Closure-Scope gehalten

await lookup(parseCap('mcp:redis')); // baut den Index + matched
await lookup(parseCap('mcp:postgres')); // cached Index, nur matched
```

Toleranz: einzelne Fetch-Fehler oder Manifest-Parse-Fehler reduzieren das Provider-Set, crashen aber nicht den Lookup. Plugins die kein Manifest haben werden silent ignoriert (analog zu Phase 5o `NO_MANIFEST`-Behandlung in lockCatalog).

## Konsequenzen

### Positiv

- **Ein User-Befehl, kompletter Flow:** `catalog install --auto-deps` macht parse + fetch + peek + resolve + writeCatalog + lockCatalog + applyLock in einem Schritt. Vorher: User musste lockCatalog + sync manuell aufrufen.
- **Domain-Function + Sidecar-Wire + GUI symmetrisch:** die `installFromGithubWithAutoDeps`-Funktion ist transport-agnostisch — CLI und Sidecar (für GUI) rufen die gleiche Pipeline. Erspart Code-Duplikation und Drift-Risiko.
- **Test-friendly:** `lookupProvider` ist injectable im Resolver. Tests können fake provider-Maps verwenden ohne echte Tarballs zu bauen.
- **Cycle-safe:** visited-Set verhindert dass ein selbst-rekursives Plugin (es providet was es requires) endlos läuft.

### Negativ / Akzeptierte Trade-offs

- **Performance beim ersten Install pro Session:** alle Tarballs aller Marketplaces fetchen ist teuer. Mitigation: Cache-Dir wird zwischen Sessions persistent gehalten, nur SHA-mismatches fetchen erneut.
- **Keine On-Disk-Index-Persistence:** zwischen `claude-os`-Aufrufen wird der Index neu gebaut (Tarball-Cache bleibt erhalten, aber die Manifest-Map ist in-memory). Akzeptiert für v1.5; Phase B kann das adressieren.
- **Eine-Capability-pro-Iteration ist O(N²):** bei N unmet caps werden N Iterationen gebraucht. Akzeptabel weil N typischerweise <10.
- **Hard-Error bei AmbiguousProvider:** User muss neu-versuchen statt UI-Auswahl. v1.6-Material.
- **Version-Constraint-Matching ist NUR im binding-resolver:** der ProviderLookup matched nur auf `kind+name`. Wenn zwei Marketplace-Plugins beide `mcp:redis` providen aber unterschiedliche Versionen, kommt die Version-Constraint-Auswahl erst im binding-resolver runter dem Lookup. Mitigation: binding-resolver wirft `VersionConflictError` wenn keine Version passt; AmbiguousProvider könnte heuristisch durch Version-sort verhindert werden (v1.6).

### Konstraints fuer Folge-Phasen

- **Phase 5q `--auto-deps`-Flag:** registry-Path Pflicht; `marketplace:` und `local:` Sources sind v1.6-Material.
- **v1.6 Hardening-Liste:**
  - On-Disk-Capability-Index mit ETag-Re-Validation
  - Parallel-Fetches mit Concurrency-Cap
  - Version-Constraint-Match im Provider-Lookup
  - `--prefer <id>` für AmbiguousProvider
  - `marketplace:` und `local:` als Target-Sources

## Alternativen verworfen

**Pre-Built On-Disk Index (Option A):** Vorzeitig optimiert. Wir kennen keinen realen Use-Case mit so vielen Marketplace-Plugins dass die Lazy-Variante langsam wird. ETag-Cache-Invalidation ist nicht-trivial; lieber später mit konkretem Profiling-Befund.

**Greedy DFS statt Iterative-Fixed-Point:** Würde `lookupProvider` rekursiv innerhalb von `resolveAutoDeps` aufrufen — funktioniert aber macht Cycle-Detection komplexer und macht es schwerer "ein candidate pro iteration"-Determinismus zu garantieren.

**Greedy Provider-Selection (höchste Version):** Klingt vernünftig aber bricht Determinismus zwischen Marketplace-Versions-Bumps. Lieber Hard-Error + explizite User-Aktion bei Mehrdeutigkeit.

## Referenzen

- ADR-0009 — Artefakt-Source-Model
- ADR-0010 — Capability-based Plugin-Deps
- ADR-0015 — Plugin-Binding-Resolution (Phase 5o)
- `docs/specs/auto-deps-flag.md` — User-facing Spec
- `src/domains/catalog/auto-deps-resolver.ts` — Resolver-Algorithm
- `src/domains/catalog/marketplace-provider-lookup.ts` — Lazy-Index
- `src/domains/catalog/auto-deps-install.ts` — End-to-End-Pipeline
- `src/sidecar/methods.ts` — `catalog.installAutoDeps`-RPC
- `gui/src/pages/index.tsx CatalogPage` — UI-Wire
