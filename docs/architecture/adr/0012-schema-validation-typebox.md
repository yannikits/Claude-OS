# ADR-0012 — Schema-Validation: TypeBox als Single-Source-of-Truth

**Status:** Akzeptiert
**Datum:** 2026-05-15
**Bedingt durch:** ADR-0009 (Catalog) + ADR-0010 (Plugin-Manifest) + ADR-0007 v1.1 (MCP-Bundles)

## Kontext

claude-os hat mehrere strukturierte Configs/Manifests, die zur Laufzeit validiert werden müssen:

- `config/catalog.json` + `config/catalog.lock.json` (ADR-0009)
- `plugin.json`-Manifests mit `requires[]` / `provides[]` (ADR-0010)
- `claude-os-config.json` (machine.json + cloud.json, Layered-Config)
- v1.1: MCP-Tool-Schemas für die Adapter-Layer (ADR-0007)

Die bisher implizite Standardannahme war `zod` (am häufigsten verwendet in Node-Ecosystem 2026). Researcher-Spike vom 2026-05-15 hat diese Annahme auf den Prüfstand gestellt.

**Entscheidendes Kriterium**: MCP-Protokoll erfordert **JSON Schema Draft 2020-12** als Tool-Schema-Format (siehe MCP-TS-SDK [#745](https://github.com/modelcontextprotocol/typescript-sdk/issues/745) und [SEP-1613](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1613)). Wenn wir später MCP-Bundles bauen (v1.1, ADR-0007), brauchen wir JSON-Schema-Export aus unseren TypeScript-Typen — verlustfrei.

## Entscheidung

**TypeBox 0.34+ als Schema-Validation-Library für die gesamte Codebase.**

Beispiel-Schema:

```ts
import { Type, Static } from '@sinclair/typebox';

const CatalogEntry = Type.Object({
  id: Type.String(),
  kind: Type.Union([
    Type.Literal('skill'),
    Type.Literal('plugin'),
    Type.Literal('mcp'),
  ]),
  source: Type.String(),
  enabled: Type.Boolean(),
  scope: Type.Union([Type.Literal('user'), Type.Literal('project')]),
});

type CatalogEntry = Static<typeof CatalogEntry>;
```

TypeBox produziert nativ JSON-Schema-Draft-2020-12-Output via `Type.Strict(Schema)`. Validierung läuft über `@sinclair/typebox/value`.

### User-Friendly-Errors

TypeBox-Default-Errors sind Ajv-roh und für End-User nicht lesbar. Wir bauen `src/core/validation/format.ts` (~100 LOC):

```ts
export function formatError(schema: TSchema, value: unknown): string[]
```

Mappt Ajv-Errors auf benutzerfreundliche Strings (z. B. `catalog.entries[2].source: muss mit "marketplace:", "github:" oder "local:" beginnen`).

### Vergleichs-Tabelle (Auszug aus Researcher-Spike)

| Kriterium | zod v4 | **TypeBox 0.34+** | valibot 1.x | ajv 8 |
|---|---|---|---|---|
| Type-Inference | exzellent (`z.infer`) | exzellent (`Static<>`) | exzellent | keine |
| JSON-Schema-Export | extern, lossy | **nativ Draft 2020-12** | extern | input ist Schema |
| Bundle | 15–18 kB | ~9 kB | 1.37 kB | 32 kB gz |
| Speed (100k parse) | 210 ms | **95 ms (mit Ajv)** | 140 ms | baseline |
| Error-Messages | sehr gut | nüchtern (Wrapper nötig) | gut | technisch |

## Konsequenzen

**Positiv**

- v1.1 MCP-Bundle-Generation ist trivial (Schema-Export ist eine Zeile pro Domain-Typ)
- Bundle ~9 kB (vs. zod 15–18 kB) — Tauri-Frontend-Budget-freundlich
- Parse-Speed ~95 ms / 100k (vs. zod 210 ms) — relevant für Bulk-Catalog-Loads
- Single-Source-of-Truth: TS-Type + JSON-Schema + Runtime-Validator aus einer Definition
- MCP-Compat ohne Konvertierungs-Layer

**Negativ**

- Lernkurve: TypeBox-API anders als zod (`Type.Object` statt `z.object`)
- Error-Messages benötigen eigenen Format-Wrapper (~100 LOC, einmaliger Aufwand)
- Kleinere Community als zod → weniger Stack-Overflow-Coverage
- Drift-Risiko: wenn TypeBox abgekündigt würde, müssten Schemas neu geschrieben werden (Migration-Pfad: Ajv-JSON-Output ist portabel, Lib-Tausch theoretisch möglich)

## Constraints

- ALLE Schema-Definitionen liegen in `src/core/schemas/` oder `domains/<x>/schema.ts` — **kein Mix** mit zod oder anderen Libs
- Validation-Errors gehen IMMER durch `formatError()` bevor sie an CLI-Presenters oder Tauri-Renderer gegeben werden
- JSON-Schema-Export per `Type.Strict()` ist Default für extern-konsumierte Schemas (catalog.json, plugin.json, MCP-Tool-Schemas)
- Schemas haben Versioning-Feld als oberster Property (`version: 1`), Migration-Logik ist explizit

## Alternativen

| Option | Bewertung | Grund für Ablehnung |
|---|---|---|
| **zod v4** | Verworfen | Externe `zod-to-json-schema`-Konvertierung ist lossy (Discriminated Unions, Refinements, Templates verlieren Semantik); v1.1 MCP-Adapter wird teurer |
| **valibot 1.x** | Verworfen | Kleineres Bundle, aber JSON-Schema-Export nur via External-Lib; gleiches Problem wie zod |
| **ajv mit raw JSON-Schemas** | Verworfen | Keine TS-Type-Inference — Types müssten parallel manuell gepflegt werden, Drift-Garantie |
| **Manuelle Validator-Funktionen** | Verworfen | Boilerplate-Explosion, kein structured Error-Reporting, kein JSON-Schema-Export |

## Quellen

- [TypeBox Repo](https://github.com/sinclairzx81/typebox)
- [MCP TS-SDK #745 — JSON Schema Draft 2020-12](https://github.com/modelcontextprotocol/typescript-sdk/issues/745)
- [MCP SEP-1613 — 2020-12 als Default](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1613)
- [Schema-Benchmarks 2026](https://schemabenchmarks.dev/blog/welcome)
- [Zod vs TypeBox 2026 PkgPulse](https://www.pkgpulse.com/blog/zod-vs-typebox-2026)

## Notiz

Phase 1 in `tasks/todo.md` enthält den TypeBox-Setup-Spike inkl. `formatError`-Wrapper. Alle Schemas in späteren Phasen nutzen TypeBox. Diese ADR supersedes die implizite zod-Annahme aus früheren Plan-Iterationen.
