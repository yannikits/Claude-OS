# ADR-0014 — Code-Quality-Toolchain: biome v2.x mit ESLint-Hybrid-Escape

**Status:** Akzeptiert (Revision 2026-05-21 — pinned auf ^2.4.15)
**Datum:** 2026-05-16
**Bedingt durch:** Researcher-Spike vom 2026-05-15

> **Revision 2026-05-21 (m2):** Title bezog sich urspruenglich auf
> biome v2.3 (zum Zeitpunkt der ADR-Akzeptanz). Inzwischen sind wir auf
> `^2.4.15` gepinnt (siehe `package.json`). Verhaltens-Aenderungen
> seither: includes-Pattern statt files.ignore + assist.actions.source
> .organizeImports statt organizeImports. Beide via `npx biome migrate`
> in PR (commit 4909fb2) durchgezogen — keine semantische Drift.

## Kontext

claude-os hat Pre-Commit-Hooks (per User-`CLAUDE.md` "Verification Before Done") und CI-Pipelines (Phase 7). Linter + Formatter laufen bei jedem Commit. Geschwindigkeit ist relevant: bei 142h-Plan und ~60 Commits in v1 kostet jeder Sekunde Pre-Commit-Latenz spürbar.

Researcher-Spike hat zwei Toolchains verglichen:

| Kriterium | biome v2.3 | eslint v9 + prettier v3 |
|---|---|---|
| Speed (Pre-Commit-Lauf) | 1.8 s | 27 s (92 % langsamer) |
| TS 5.6+ Support | ja, type-aware seit v2.0 | vollständig via `typescript-eslint` |
| Formatter-Stabilität | sehr stabil seit v1.5 | Prettier stabil, ESLint-Autofix erzeugt teils Noise |
| Plugin-Ökosystem | ~80 % ESLint-Regelabdeckung, **keine** Tauri-spezifischen Plugins | riesig, alle Tauri/React-Plugins verfügbar |
| Konfiguration | eine `biome.json` | `eslint.config.js` + `.prettierrc` + `.prettierignore` |
| Migration-Pfad | `biome migrate eslint` Auto-Port; Rückbau trivial | Etabliert, schwerer abzulösen |

Tauri-Code-Anteil bei uns: ~10 % Rust-Shell (`gui/src-tauri/`, durch `clippy` abgedeckt), ~90 % TypeScript/JavaScript (Domains, CLI, Renderer). Tauri-spezifische Linting-Regeln sind also kaum relevant.

## Entscheidung

**biome v2.3 als primäre Code-Quality-Toolchain.**

### Setup

- Eine `biome.json` im Repo-Root mit strict TS-Rules + Project-spezifischen Ausnahmen
- Pre-Commit-Hook via `husky` + `lint-staged`: `biome check --apply` auf staged Files
- CI-Step (Phase 7): `biome ci` fails bei jedem Lint/Format-Issue
- Dev-Workflow: `npm run check` und `npm run format` als shortcuts

### ESLint-Hybrid-Escape

Falls eine kritische Lint-Regel **keine biome-Entsprechung** hat (z. B. tiefgehende React-Hooks-Regeln oder ein hypothetisches Tauri-Plugin), darf für genau diesen Code-Pfad ESLint zusätzlich konfiguriert werden:

- Dokumentierte Eskalation in `docs/code-quality.md` mit Begründung
- ESLint-Config nur für betroffene Glob-Patterns aktivieren
- Audit alle 3 Monate: ist die Regel inzwischen in biome verfügbar? → ESLint zurückbauen

Diese Escape-Hatch verhindert Toolchain-Tunnelblick — wir geben Performance nicht für eine Pflicht-Regel auf.

## Konsequenzen

**Positiv**

- 10–25× schneller bei Pre-Commit; ~25 Sekunden Wartezeit pro Commit eingespart (bei 60 Commits v1 = ~25 Minuten reine Linter-Zeit)
- Single-Config-File reduziert Config-Drift und Setup-Komplexität
- Migration zurück möglich (`biome migrate eslint` bidirektional), keine Lock-in
- CI-Pipeline-Zeit reduziert sich proportional

**Negativ / Aufwand**

- ~20 % ESLint-Regelabdeckung fehlt → bei spezifischem Bedarf Hybrid-Setup nötig
- Kleinere Community → weniger Stack-Overflow-Coverage, langsamere Antwortzeiten bei exotischen Fragen
- Drift-Risiko falls biome stagniert — Audit-Schritt im Quartal pflicht

## Constraints

- `biome.json` muss strict TS-Rules aktivieren (`recommended: true`, `useExhaustiveDependencies`, `noUnusedVariables`, etc.)
- Pre-Commit-Hook ist **non-bypassable** ohne Begründungskommentar im Commit-Message
- CI-Step `biome ci` muss laufen vor Tests; bei Fail blockiert das den PR
- ESLint-Hybrid-Decisions werden in `docs/code-quality.md` als ADR-Anhang dokumentiert mit Datum, Regel, Grund
- Quartal-Audit: alle Hybrid-Regeln gegen aktuelle biome-Version prüfen; bei verfügbarer Native-Regel ESLint-Entry entfernen

## Alternativen

| Option | Bewertung | Grund für Ablehnung |
|---|---|---|
| **eslint + prettier** (Status quo der Industrie) | Verworfen | 10–25× langsamer; Pre-Commit-Latenz schmerzhaft bei häufigen Commits |
| **rome** | Verworfen | Deprecated, in biome aufgegangen |
| **dprint** | Verworfen | Formatter-only, kein Linter — würde ESLint zusätzlich brauchen |
| **prettier alone** | Verworfen | Kein Linter — bug-anfällige Regeln (no-unused-vars, exhaustive-deps) entfallen |
| **xo (eslint-Wrapper)** | Verworfen | Same speed-issue wie eslint |

## Quellen

- [Biome vs ESLint+Prettier — PkgPulse](https://www.pkgpulse.com/blog/biome-vs-eslint-prettier-linting-2026)
- [Biome Pre-commit 15× faster — fireup.pro](https://fireup.pro/news/pre-commit-hooks-15x-faster-biome-vs-eslint-case-study)
- [biome v2.3 Release Notes](https://biomejs.dev/blog/biome-v2-3)
- [biome migrate eslint Docs](https://biomejs.dev/guides/migrate-eslint-prettier)

## Notiz

Phase 1 in `tasks/todo.md` enthält biome-Setup + `husky`+`lint-staged`-Pre-Commit-Hook. Hybrid-ESLint-Eskalationen werden in `docs/code-quality.md` dokumentiert sobald die erste auftritt.
