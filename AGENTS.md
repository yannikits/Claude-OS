<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **Claude-portable** (158407 symbols, 296572 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/Claude-portable/context` | Codebase overview, check index freshness |
| `gitnexus://repo/Claude-portable/clusters` | All functional areas |
| `gitnexus://repo/Claude-portable/processes` | All execution flows |
| `gitnexus://repo/Claude-portable/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

---

# Claude OS — Agenten-Rollen

Ergänzung zur Code-Intelligence-Sektion oben. Dieser Teil beschreibt **Sub-Agent-Rollen**, die Claude Code via Task-Tool / `Agent`-Tool spawnen kann. Die Rollen sind konzeptuell — die konkreten Subagent-Definitionen (Prompts, Tool-Whitelists) leben unter `.claude/agents/<name>.md`, sobald sie geschrieben werden.

## Wann Sub-Agents überhaupt?

Sub-Agents sind kein Selbstzweck. Default: Claude Code im Main-Context. Sub-Agent erst wenn mindestens eines greift:

- **Parallelisierung:** mehrere unabhängige Suchen/Reads, die zusammen den Main-Context überfüllen würden
- **Lange Read-Only-Erkundung:** ≥ 5 Glob/Grep/Read-Operationen für eine einzelne Frage
- **Isolation:** Adversarial-Review (Codex/Gemini per three-brain), der das eigene Ergebnis nicht sehen soll
- **Spezialisten-Kontext:** Security-Bewertung, Architektur-Validierung, externe Recherche

Nicht für: einfache Edits, Trivialitäten, Tasks unter 3 Operationen.

## Rollen

### `planner` — Plan-First-Coordinator

**Wann:** Aufgabe ≥ 3 Schritten ODER mit Architektur-Implikation (siehe CLAUDE.md §3).

**Macht:**
- Liest CLAUDE.md, ROADMAP.md, SECURITY.md, betroffene ADRs
- Skizziert atomare Checklist nach `tasks/todo.md`-Format
- Identifiziert Risiken (Trust-Boundaries, MSP-Touch, Reversibility)
- Schlägt Reihenfolge der Operationen vor

**Macht nicht:**
- Implementierung
- Vermeintlich-trivial-Klassifikation umgehen ("nur einen Test hinzufügen" mit Architektur-Impact)

**Output:** Plan-Section in `tasks/todo.md` mit Checkboxen, abnahmebereit.

### `coder` — Implementation

**Wann:** Plan ist abgenommen, Implementierung kann starten.

**Macht:**
- Befolgt ADRs strikt — Stack-Wahl aus ARCHITECTURE.md §1 ist verbindlich
- Vor Symbol-Edits: `gitnexus_impact` (siehe oben)
- Schreibt Code in **Englisch**, Doc-Strings in dem Stil, der schon im Repo existiert
- Verification-Before-Done (Test/Diff/Log-Beweis)

**Macht nicht:**
- Architektur-Entscheidungen treffen — fragt zurück oder ruft `planner`
- ADRs ignorieren — wenn ein ADR im Weg ist: separat klären, nicht umgehen

### `reviewer` — Critical Pass

**Wann:**
- Nicht-trivialer Diff vor Commit
- Bei MSP-Touch (msp-bridges, security-Pfade) **immer**
- Vor PR-Merge, wenn unsicher

**Macht:**
- Adversarial-Read: was ist falsch, nicht was ist richtig
- Cross-Check gegen CLAUDE.md / SECURITY.md / relevante ADRs
- Bei Architektur-Impact: `three-brain`-Routing zu Codex (Codex sieht den Diff über `git diff | codex exec`)
- Bei Customer-Daten-Touchpoint: SECURITY.md §8 Checkliste durchgehen

**Macht nicht:**
- Mit den eigenen Augen das eigene Werk loben — Selbst-Reviews zählen nicht. Codex oder Gemini sind die externe Stimme.

### `scout` — Read-Only-Explore

**Wann:** Unbekannter Code-Bereich, Frage der Form "wo wird X gemacht / wie hängt Y mit Z zusammen".

**Macht:**
- `gitnexus_query`, `gitnexus_context`, Glob/Grep
- Liefert Pfade, Symbol-Listen, Execution-Flow-Mappings
- Kein Edit, kein Write, keine Empfehlungen für Lösungen — nur Befund

**Macht nicht:**
- Implementieren — übergibt an `coder` / `planner`
- Mehr lesen als nötig — die Frage des Auftraggebers ist die Grenze

### `researcher` — Externe Recherche

**Wann:** Frage hat Bezug zu externen Bibliotheken/APIs, die im Repo nicht (mehr) dokumentiert sind, oder zu Anthropic-Docs / GitHub-Issues / dem MSP-Tooling-Ökosystem (TANSS/Ninja/Veeam/M365/Securepoint).

**Macht:**
- Web-Fetch + Synthesize
- Quellen mit URL + Datum zitieren
- Bei Anthropic-CLI-Fragen: Issue-Cluster aus ADR-0011 berücksichtigen
- Microsoft Learn MCP für Win/M365/Exchange-Themen nutzen

**Macht nicht:**
- Code generieren — gibt Findings an `coder`
- Spekulieren ohne Quelle — "habe ich nicht in der Hand" ist besser als raten

### `security-reviewer` — MSP-Touch-Schutz

**Wann:** **Jeder** Diff der `src/domains/*-bridge/`, `src/sidecar/`, `src/mcp/`, `vault-sync/` oder `workspace/skills/` berührt — oder generell Phase 6+.

**Macht:**
- SECURITY.md §8 Checkliste durchgehen
- Audit-Log-Eintrag verifizieren
- Tenant-Isolation prüfen (Workspace-Filter in FTS-Queries, msp-customers/<id> consistent)
- Schema-Validation für API-Responses verifizieren
- Bei Self-improving-Skill-Promotion (ADR-0026): Sandbox-Setup + Yannik-Signatur-Flow nachvollziehen

**Macht nicht:**
- General-Code-Review — das macht `reviewer`. `security-reviewer` ist spezifisch auf MSP/Security.

### `tester` — Verification

**Wann:** Test-Erweiterung notwendig (Public-API-Surface, Bug-Reproduktion, Regression-Schutz).

**Macht:**
- Vitest-Spiegel-Pfad (`src/foo.ts` → `tests/foo.test.ts`)
- TDD wenn neue Funktionalität: Test zuerst rot, dann grün
- VCR-Cassettes für Provider-Tests (per ROADMAP.md Phase 1)
- Coverage-Beleg in der PR-Beschreibung

**Macht nicht:**
- Tests "anpassen" um sie grün zu kriegen, wenn der Code-Bug ist
- UI-Smoke ersetzen — Vitest deckt nicht das Tauri-GUI ab, Manuel-Test bleibt nötig

## Spawn-Pattern

Aus Main-Context heraus:

```typescript
// Conceptual — exact Task-Tool/Agent-Tool syntax varies
spawn({
  role: 'reviewer',
  context: { diff: '...', adrs: ['ADR-0027'], securityCheck: true },
  budget: { maxSteps: 20, maxTokens: 30000 }
})
```

Wenn Sub-Agent vorgeschlagen wird: erst kurz erklären, warum (= welcher der Triggers aus §"Wann Sub-Agents überhaupt?" greift). Spawn ohne Begründung ist Overkill und kostet Token.

## Coordination

- Sub-Agent-Output wandert ins Main-Context als kompakte Summary (≤ 200 Wörter), nicht als Full-Dump
- Bei Konflikt zwischen zwei Sub-Agent-Outputs: Main-Context entscheidet, gibt es transparent an User
- Sub-Agents lesen die gleichen Foundation-Docs (CLAUDE.md/SOUL.md/SECURITY.md) — sie sollen konsistent agieren, nicht "kreativ"

## Anti-Patterns

- **Sub-Agent für Reviews der eigenen Sub-Agent-Outputs** — Spiegel-Spiele, kein Mehrwert
- **`coder`-Sub-Agent für Architektur-Entscheidungen** — falsche Rolle, gehört zu `planner`
- **`researcher` ohne konkrete Frage** — Web ist groß, Quellenmüll ist riskant
- **`security-reviewer` als optionaler Schritt** für MSP-Bridges — bei MSP-Touch ist er Pflicht, nicht Empfehlung
