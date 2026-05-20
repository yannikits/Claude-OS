# Spec — `--auto-deps`-Flag für `catalog install`

**Status:** Draft (Spec-Only, Impl wartet auf PR #32 Merge)
**Datum:** 2026-05-20
**Voraussetzung:** Phase 5o (Plugin-Binding-Resolution, PR #32) gemerged.
**Folge-Phase:** "Phase 5p" oder direkt v1.5 — finaler Name beim Impl.

## 1. Ziel

`claude-os catalog install <id-or-source> --auto-deps` zieht **transitiv** alle benötigten Provider aus dem Marketplace, statt den User zur manuellen Pre-Installation jedes Capability-Providers zu zwingen.

Heute (Stand v1.5 nach PR #32):
1. User ruft `catalog install marketplace:acme/skill-a`.
2. SkillA hat `requires: ['mcp:redis>=2.0.0']`.
3. `lockCatalog` schreibt `bindings: []` + Warning `"binding resolution failed: no installed plugin provides capability 'mcp:redis>=2.0.0' (required by 'skill-a')"`.
4. User muss Warning lesen, manuell `catalog install marketplace:acme/mcp-redis` ausführen, dann erneut `catalog install marketplace:acme/skill-a`.

Mit `--auto-deps`:
1. User ruft `catalog install marketplace:acme/skill-a --auto-deps`.
2. CLI fetched SkillA-Tarball, liest dessen `plugin.json`, sieht `requires: ['mcp:redis>=2.0.0']`.
3. CLI sucht im Marketplace nach einem passenden Provider — findet `acme/mcp-redis` (versioniert `>= 2.0.0`).
4. CLI fügt `acme/mcp-redis` zur catalog-Konfig hinzu (BEFORE `acme/skill-a` in der Reihenfolge), persistiert beide.
5. `lockCatalog` läuft normal durch, Bindings sind populated.

## 2. CLI-Signatur

```text
claude-os catalog install <source> [options]
  <source>           marketplace:owner/name | github:owner/repo[@ref] | local:./path
  --auto-deps        Resolve & install transitive marketplace requires automatically.
                     Default: false (preserves v1.0 behavior).
  --no-auto-deps     Explicit opt-out (equivalent to omitting --auto-deps).
  --scope <user|project>   Where to install (default: user)
  --json             Machine-readable output.
  --dry-run          Print what would be installed without writing config or downloading tarballs.
```

**Default-Verhalten** bleibt OHNE `--auto-deps` exakt wie vorher — kein Verhaltens-Drift für existierende Workflows oder CI-Skripte.

## 3. Resolution-Algorithmus

Pseudocode:

```
resolve(target, marketplace, catalog, visited):
  if target.id in visited:
    return CycleError(visited.path-from(target.id))
  visited.push(target.id)

  manifest = read-tarball-manifest(target)  // re-use Phase 5o tarball-peek
  newEntries = []
  for require in (manifest.requires ?? []):
    cap = parse-capability(require)
    if catalog.provides(cap):    // already satisfied by an existing entry
      continue
    provider = marketplace.find-best-provider(cap)
    if provider is None:
      return MissingProviderError(cap, target.id)
    recurseResult = resolve(provider, marketplace, catalog, visited)
    if recurseResult is Error:
      return recurseResult
    newEntries.push(...recurseResult.entries)

  newEntries.push(target)
  visited.pop()
  return { entries: newEntries }
```

**Wichtige Eigenschaften:**

- **DFS-Resolution:** Provider werden vor ihren Consumern in `newEntries` eingefügt — Install-Reihenfolge.
- **Visited-Set per Resolution-Run:** verhindert Endlosrekursion bei zyklischen Deps.
- **Cycle-Detection IST ein Hard-Error** — kein "best-effort", kein partieller Install. Gibt klare Fehlermeldung `"cyclic dependency: A -> B -> C -> A"`.
- **Marketplace.find-best-provider** nutzt den existierenden CapabilityResolver (Phase 5g): sucht `acme/mcp-redis` der `mcp:redis>=2.0.0` provided. Bei mehreren Kandidaten gewinnt **höchste Version** die das Constraint erfüllt; bei Tie der **lexikographisch kleinere Provider-ID**.
- **AmbiguousProvider-Behandlung:** wenn der Best-Provider-Suchbaum mehrere Provider mit **unterschiedlicher Provider-ID** für dieselbe Capability findet, ist das ein `AmbiguousProviderError` — User muss explizit `--prefer <id>` setzen (Folge-Flag in v1.6, in v1.5 ist's Hard-Error).
- **Pre-Installed-Check:** wenn der User bereits eine Version des Providers manuell installiert hat (egal welche), wird der Resolver-Pfad nicht erneut gefetcht. Existing catalog gewinnt.

## 4. State-Transitions

| Vorher (catalog.json) | Befehl | Nachher |
|---|---|---|
| `{entries: [skill-a]}`, skill-a fehlt mcp-redis | `install marketplace:acme/skill-a --auto-deps` | `{entries: [mcp-redis, skill-a]}` (alphabetisch) |
| `{entries: [mcp-redis]}` (manuell installiert) | `install marketplace:acme/skill-a --auto-deps` | `{entries: [mcp-redis, skill-a]}` (kein erneuter mcp-redis-Install) |
| `{entries: [mcp-redis@1.0]}` (zu alt für `>=2.0`) | `install marketplace:acme/skill-a --auto-deps` | `MissingProviderError` (existing mcp-redis erfüllt's nicht, Marketplace hat keinen kompatiblen) ODER `VersionUpgradeRequired` (Marketplace hat 2.0, User muss explizit `--upgrade mcp-redis` setzen — Folge-Flag) |
| `{entries: [a, b]}` mit zyklischen requires | `install marketplace:acme/c --auto-deps` (c needs a, a needs c) | `CyclicDependencyError("a -> c -> a")` |

## 5. Fehlerverhalten

Alle Fehler sind **transactional** — bei jedem Fehler wird **nichts** in `catalog.json` persistiert. Tarball-Cache bleibt populated (das ist OK, das ist nur Performance, kein State).

| Fehler | Exit-Code | JSON-Output | Text-Output |
|---|---|---|---|
| `MissingProviderError` | 4 | `{ok:false, code:'missing-provider', capability:'mcp:redis>=2.0.0', requiredBy:'skill-a'}` | `Error: no provider found for capability "mcp:redis>=2.0.0" (required by "skill-a")` |
| `VersionConflictError` | 4 | `{ok:false, code:'version-conflict', ...}` | `Error: ...` |
| `CyclicDependencyError` | 5 | `{ok:false, code:'cyclic-dep', cycle:['a','b','c','a']}` | `Error: cyclic dependency detected: a -> b -> c -> a` |
| `AmbiguousProviderError` | 6 | `{ok:false, code:'ambiguous', candidates:['acme/mcp-redis','sigma/mcp-redis']}` | `Error: ambiguous provider for "mcp:redis", candidates: acme/mcp-redis, sigma/mcp-redis. Re-run with --prefer <id>.` |
| Tarball-Fetch-Failure (mid-resolution) | 7 | `{ok:false, code:'fetch-failed', url:'...', status:404}` | `Error: tarball fetch failed for ...` |
| Marketplace-Registry-Failure | 8 | `{ok:false, code:'registry-unreachable', ...}` | `Error: marketplace registry unreachable: ...` |

`--dry-run` produziert **dasselbe** stdout wie ein erfolgreicher Install, aber mit zusätzlichem `dryRun: true`-Flag im JSON, und persistiert nichts.

## 6. Edge-Cases

1. **Mixed-Source-Resolution:** `--auto-deps` resolved Marketplace-Sources. Wenn ein Marketplace-Eintrag transitiv ein `github:`-Source provides, akzeptieren wir das (der GitHub-Source steht in `marketplace.json` als provider-Eintrag). `local:`-Sources sind NIE auto-deps-Resolution-Quelle (User muss sie manuell pinnen, sie haben keinen versionierten Provider-Eintrag).

2. **Bereits installierte ältere Version eines Providers:** wie oben beschrieben → `VersionUpgradeRequired`-Error in v1.5; `--upgrade <id>`-Flag wird v1.6-Material wenn häufig genug gewünscht.

3. **Disabled-Entries:** wenn ein Provider `enabled: false` in der catalog.json hat, gilt er **nicht** als satisfied. Auto-Deps würde ihn enable'n (das ist die User-Erwartung). Pre-Impl-Frage: bewahren wir den disabled-Zustand bei Re-Install, oder enable'n wir? Spec-Decision: **enable, mit Hinweis** im Output (`info: skill-a depended on mcp-redis which was disabled — re-enabled by --auto-deps`).

4. **Idempotenz:** Zweimaliges `install --auto-deps` mit identischer Catalog soll No-Op sein. Tests müssen das verifizieren.

5. **Concurrent Installs:** v1.5 unterstützt keinen Parallel-Install-Lock. Wenn zwei Prozesse gleichzeitig `--auto-deps` laufen, ist das Verhalten undefiniert. v1.6-Hardening: File-Lock auf `catalog.json`.

6. **Marketplace-Pagination:** wenn der Marketplace > 1000 Einträge hat, muss `find-best-provider` paginiert lookup'en. v1.5 Pre-Spike: Marketplace-Registry-Loader auf in-memory Map-Aufbau prüfen, dann Lookup O(1). Wenn die Map-Größe Memory-relevant wird, indexierte Suche.

## 7. Test-Matrix

Pflicht-Tests bei Impl:

- **TF-1** — Linear-Chain: `install A --auto-deps` resolved `A` → `B` → `C` (kein vorher installiertes); Reihenfolge in `catalog.json` korrekt.
- **TF-2** — Pre-Installed: `install A --auto-deps` mit `B` bereits installiert; nur `A` wird hinzugefügt, `B` bleibt unverändert.
- **TF-3** — Version-Constraint-OK: `B@2.0.0` matched `A's requires:['mcp:foo>=1.0.0']`; Lock-Bindings sind populated.
- **TF-4** — Version-Constraint-Conflict: bestehendes `B@1.0.0` erfüllt `>=2.0.0` nicht, Marketplace hat keinen kompatiblen → MissingProviderError.
- **TF-5** — Cyclic-Dep: `A` requires `B`, `B` requires `A` → CyclicDependencyError mit Pfad.
- **TF-6** — Ambiguous-Provider: zwei Provider mit unterschiedlicher Id provided dieselbe Capability → AmbiguousProviderError.
- **TF-7** — Idempotenz: zweimaliges identisches `install --auto-deps` ändert `catalog.json` nicht.
- **TF-8** — Default-Verhalten: ohne `--auto-deps` ist `catalog install` semantisch identisch zu pre-Impl (keine Behavior-Drift-Tests).
- **TF-9** — `--dry-run`: keine FS-Writes, exakt der Plan wird gedruckt.
- **TF-10** — Transactional-Failure: Mid-Resolution-Fetch-Fail rollt zurück — `catalog.json` ist unverändert.
- **TF-11** — Disabled-Provider-Re-Enable: existing `B (enabled: false)` matched A's require → B wird auf `enabled: true` gesetzt, Info-Warning emittiert.
- **TF-12** — Mixed-Source: A (marketplace) requires B (github via marketplace's provider-mapping) → funktioniert end-to-end.

Tests laufen gegen tmpdir-Fixtures mit injectable Fetch (siehe Phase 5o-Pattern). Ein einziger E2E gegen echten GitHub-Tarball ist OK aber gated hinter `RUN_SLOW_TESTS=1` (Network-Required).

## 8. Implementation-Reihenfolge (für späteres Phase-Tracking)

1. Resolution-Engine in `src/domains/catalog/auto-deps-resolver.ts` (Pure-Func, kein FS).
2. Marketplace-Provider-Lookup (extend `MarketplaceRegistry`).
3. Catalog-Mutation-Layer (`addEntries(scopedCatalog, [entries], {preserveOrder: 'deps-first'})`).
4. CLI-Flag-Wiring + Output-Presenter (Text + `--json`).
5. Tests TF-1 bis TF-12.
6. Doc-Update in README + `docs/architecture/adr/0010-...` (oder Folge-ADR mit `--auto-deps`-Verhalten).

## 9. Out-of-Scope für v1.5-Impl

- `--upgrade <id>` für Version-Bumps existing entries (separater Spec, v1.6).
- `--prefer <id>` für AmbiguousProvider-Disambiguation (v1.6).
- `--no-cache` zum Bypass des Tarball-Caches (v1.6-Hardening).
- Concurrent-Install-Lock auf `catalog.json` (v1.6).
- Auto-Removal von nicht-mehr-benötigten transitiven Deps (`--prune`-Subcommand, v1.7).
- Marketplace-Source-Authentication für private Marketplaces (v2+).

## 10. Referenzen

- ADR-0009 — Source-Model (parsing-source.ts)
- ADR-0010 — Capability-based Plugin-Deps
- ADR-0015 — Plugin-Binding-Resolution (Phase 5o)
- Phase 5o-Code (`src/domains/catalog/{tarball-manifest-reader,binding-resolver,lock-builder}.ts`)
- `tasks/todo.md` v1.5+-Roadmap
