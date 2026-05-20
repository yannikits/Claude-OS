# ADR-0015 — Plugin-Binding-Resolution via Tarball-Peek (Phase 5o)

**Status:** Akzeptiert
**Datum:** 2026-05-20
**Bedingt durch:** Phase 5o v1.5+-Deliverable; schließt die `bindings: []`-v1-Simplification aus Phase 5h

## Kontext

ADR-0010 hatte Capability-basierte Plugin-Dependencies als Lösung für das `Memory-587/593`-Cluster (npm-peer-deps kollabieren bei nested incompatible versions) etabliert. Der CapabilityResolver wurde in Phase 5g implementiert, die `catalog.lock.json`-Schema-Felder in Phase 5h vorbereitet — aber `lockCatalog` emittierte weiterhin `bindings: []`. Grund: der Resolver brauchte Zugriff auf jedes Plugin-Manifest (`requires`/`provides`), und das Manifest liegt im Tarball.

Drei Optionen standen zur Diskussion:

| Option | Lese-Zeitpunkt | Cache-Bedarf | Latenz | Komplexität |
|---|---|---|---|---|
| **A: Post-Sync-Rescan** | Nach `applyLock`-Extract | Disk-Extract notwendig | Voller Roundtrip durch `sync` zwingt User zu doppeltem `lock`-Lauf | hoch (zwei-Phasen-Lock) |
| **B: Tarball-Peek während Lock** | Direkt nach Tarball-Fetch | Reuse vorhandener Cache | +~50ms pro Plugin-Tarball | mittel (tar-Streaming) |
| **C: Marketplace-Registry-Vorab-Annotation** | Pull aus Registry | Registry muss `provides`/`requires` mitliefern | Trivial bei Cache-Hit | Registry-API-Change + Drift-Risiko |

## Entscheidung

**Option B — Tarball-Peek während `lockCatalog`.**

### Implementierungsdetails

1. **Streaming statt Extract:** `tar.list({ file, onentry })` aus `tar v7` enumeriert Tarball-Einträge ohne Disk-Write. Nur die `data`-Chunks des ersten `plugin.json` werden gepuffert; alle anderen Entries werden via `entry.resume()` verworfen.

2. **GitHub-Wrapper-Awareness:** GitHub-Tarballs nesten unter `<repo>-<sha>/`. Default `stripComponents: 1` matched die Logik aus `sync-applier.ts`, sodass beide Module die gleiche Sicht auf die Datei-Pfade haben.

3. **4-Pass-Architektur in `lockCatalog`:**
   - **Pass 1:** Fetch + Cache jeder Tarball (unverändert)
   - **Pass 2:** Manifest-Peek nur für `kind: 'plugin'`-Entries (Skill + MCP sind Leaves, ADR-0010)
   - **Pass 3:** Aggregat-`Catalog` aus allen erfolgreich gelesenen Manifests → `resolveCapabilities` pro Plugin-Entry
   - **Pass 4:** Emit Lock-Entries mit ihren (ggf. leeren) Bindings

4. **NO_MANIFEST vs. Malformed:** Ein fehlendes `plugin.json` ist v1-Realität (die meisten Pre-ADR-0010-Plugins haben keins). Wir akzeptieren das stillschweigend (`bindings: []`, kein Warning). Nur Parse-Errors und Schema-Violations werden als Warning surfaced — diese sind authoring-Bugs, die der Autor beheben muss.

5. **Graceful Degradation:** Per-Entry-Resolver-Errors (MissingProvider, VersionConflict, etc.) brechen den Lock nicht ab. Sie produzieren `bindings: []` für das betroffene Entry plus eine Warning-Zeile. Andere Entries werden normal aufgelöst.

6. **Determinismus:** Bindings werden sortiert nach `(capability, providedBy)` damit `catalog.lock.json` zwischen Läufen byte-identisch ist, wenn die Inputs es sind.

## Konsequenzen

### Positiv

- **Single-Pass-Workflow:** `catalog lock` produziert sofort ein voll-aufgelöstes Lock-File; `catalog sync` muss nicht zweimal laufen.
- **Forward-kompatibles Schema:** Plugins ohne Manifest bleiben legal in v1; sie bekommen einfach keine Bindings. ADR-0010-Plugins kriegen volle Resolution.
- **Per-Entry-Isolation:** Eine kaputte plugin.json blockiert den Rest nicht.
- **Test-Friendly:** `LockBuilderOpts.readManifest` ist injectable — die Lock-Builder-Tests müssen keine echten Tarballs bauen.
- **Cache-Reuse:** Pass 2 liest aus dem gleichen `<cacheDir>/<sha256>.tar.gz`, das `sync-applier` später extrahiert. Keine zusätzliche Disk-Belegung.

### Negativ / Akzeptierte Trade-offs

- **Doppelte Tar-Iteration:** Pass 2 streamt jeden Plugin-Tarball, Pass 4 (via `sync-applier`) extrahiert ihn vollständig. Bei `n` Plugins: `O(n)` zusätzliche Tar-Streams. Für v1-Größenordnung (<50 Plugins) vernachlässigbar.
- **Forward-Resolution-only:** Diese Phase deckt `requires` zwischen bereits installierten Plugins ab. **Transitive Marketplace-Auflösung (`--auto-deps`)** ist separat als nächster v1.5-Schritt geplant — sie müsste Marketplace-Lookup + Re-Fetch in den Pass-2-Loop einbauen.
- **No Provider-Disambiguation-UI:** `AmbiguousProviderError` (mehrere Plugins providen dieselbe Capability) wird als Warning gezeigt und produziert `bindings: []`. Eine UI-gestützte Wahl ist v2-Material.

### Konstraints für Folge-Phasen

- **`--auto-deps`-Flag** muss den 4-Pass-Loop um eine fünfte Iteration ergänzen: nach Pass 3 unresolved `requires` sammeln, in Marketplace nachschlagen, transitiv installieren, dann Pass 2-4 erneut.
- **Plugin-Manifest-Schema-Drift:** Wenn ADR-0010 mal um Felder erweitert wird (z.B. `engines`, `peerDeps`), muss `tarball-manifest-reader.ts` `additionalProperties: true` behalten. Schema-Erweiterungen via separater ADR-Migration.

## Alternativen verworfen

**A: Post-Sync-Rescan** wurde verworfen weil es User zwingt, nach jedem `catalog lock` ein zweites `catalog sync` zu laufen damit die Bindings populated werden. Verletzt das v1-Mantra "ein Command, ein Resultat".

**C: Marketplace-Registry-Annotation** scheitert daran, dass `github:`-Sources die Marketplace komplett umgehen können. Wir bräuchten eine zweite Quelle der Wahrheit — Drift-Risiko zwischen Tarball-Manifest und Registry-Annotation wäre garantiert.

## Referenzen

- ADR-0009 — Artefakt-Source-Model (Source-Kinds)
- ADR-0010 — Capability-based Plugin-Deps (Resolver-Algorithmus)
- ADR-0012 — TypeBox-basierte Schema-Validation (Manifest-Schema)
- `src/domains/catalog/tarball-manifest-reader.ts`
- `src/domains/catalog/binding-resolver.ts`
- `src/domains/catalog/lock-builder.ts` (4-Pass-Refactor)
