# ADR-0026 — Skill-Auto-Promotion Lifecycle

**Status:** Akzeptiert — Phase 5c shipped 2026-05-28 (Gates 1-4)
**Datum:** 2026-05-24 (Konzept), 2026-05-28 (Implementation-Closeout für Gate 3)
**Bedingt durch:** Spec-Split (PR #123) — Self-Improving-Skill-Loop braucht Security-Gate

## Kontext

Hermes/DSPy/GEPA-Pattern: aus Lessons werden automatisch neue Skills generiert oder bestehende verbessert. Risiken bei direkter Aktivierung LLM-generierter Skills:

- LLM-generierter Code könnte versehentlich Daten exfiltrieren (Logging an externen Endpoint)
- Customer-Konflikte mit Approval-Pflicht aus SECURITY.md
- Stille Verschlechterung der Skill-Qualität ohne Review
- Im MSP-Kontext (Phase 6+) potenziell haftungsrelevant

## Entscheidung

**Skill-Lifecycle mit harten Gates und User-Signatur.**

```
draft → quarantined → reviewed → active → deprecated → disabled
```

### State-Definitionen

- **draft:** Auto-generiert aus `tasks/lessons.md`. Liegt unter `workspace/skills/_drafts/`. Nicht ladbar im normalen Loader.
- **quarantined:** Manuell aus `draft` promoted. Liegt im Sandbox-Workspace. Read-only-Test mit synthetischen Inputs erlaubt. Kein Filesystem-Write außer `<sandbox>/`. Kein Netz außer Allowlist. Kein Zugriff auf `customer-confidential`-Notes. Timeout 30s pro Tool-Call.
- **reviewed:** Yannik hat den Diff (Side-by-Side in GUI) gesehen und signiert (lokaler Ed25519-Key im Keyring per ADR-0004). Audit-Log enthält Signatur + Diff-Hash.
- **active:** Im normalen Skill-Loader. Kann jederzeit zu `deprecated`/`disabled`.
- **deprecated:** Warnung bei Nutzung, noch ladbar. Migrations-Hinweis im SKILL.md.
- **disabled:** Nicht ladbar. Bleibt im Repo zur Forensik.

### Bei `customer-confidential`-Touchpoint

Zusätzlicher Confirm-Step beim Review. Der Diff-Render muss die `customer-confidential`-Pfade highlighten.

### Sandbox-Anforderungen

Quarantined-Skills laufen in eigenem Worker-Thread oder separatem Sidecar-Process:
- File-System auf `<sandbox>/` chrooted (oder via `fs`-Wrapper limitiert)
- Netz auf Hostname-Allowlist (Default leer)
- Kein Vault-Zugriff außer in `workspaces/_sandbox/`
- 30s Timeout pro Operation, hard kill bei Überschreitung

### Implementation Status (2026-05-28)

Alle Gates der Self-Improvement-Phase sind shipped als gestackte PRs in Phase 5c:

| Gate | Anforderung | Status |
|---|---|---|
| 1 | Sandbox-Process-Isolation via `child_process.fork` | ✓ ADR-0034 (PR #177) — net-guard Phase 5b (PR #181) |
| 2 | Ed25519-Signatur-Foundation (Public-Core) | ✓ ADR-0035 (PRs #178 + #179 + #180) |
| 3 | State-Transition-Pipeline + CLI + RPCs + GUI | ✓ Phase 5c (PRs #191, #192, #193, #194) |
| 4 | Audit-Log-Format finalisiert (SECURITY.md §4) | ✓ PR #176 (v1-Schema, schema_version, retention, mode 0o600, UTC-day-Rotation) |

**Phase 5c-1** (PR #191) — `src/domains/skill-lifecycle/promote.ts`: sechs Pure-Async-Transitions (`promoteDraftToQuarantined` / `runQuarantinedSandbox` / `proposeReview` / `approveReview` / `deprecate` / `disable` / `reactivate`) mit typed `PromoteError(code)`. `diffHash` = SHA-256 über canonical `{beforeContent, afterContent, classification}`, bound in die `ReviewApprovalPayload` damit ein Tamper-Between-Sign-And-Activate `signature-mismatch-diff-hash` triggert.

**Phase 5c-2** (PR #192) — `claude-os skill` CLI: `list-drafts` / `list-quarantined` / `list-pending-review` / `propose-review` / `promote <name> --to-quarantined|--run-sandbox|--to-active|--deprecate|--disable|--reactivate`. JSON-mode propagiert `PromoteError.code` direkt.

**Phase 5c-3** (PR #193) — Sidecar-RPCs `skill.*`: 9 Methods wired in `src/sidecar/methods/skill-lifecycle.ts`. Mutating-RPCs **nicht** über MCP-Tools exposed (approval gehört nicht über Tool-Calls).

**Phase 5c-4** (PR #194) — GUI: `SkillReviewPage` mit Pending-List + Side-by-Side-Diff via `diff@9` + Customer-Confidential-Warn-Banner + Sandbox-Run-Card. "Signieren + aktivieren …" als CTA. Web-Build zeigt CLI-Hint-Modal (offline-sign + `--signed-envelope`-Pfad); Tauri-Build dazu folgt in Phase 5c-5.

**Phase 5c-5** (offen) — Tauri-Native-Password-Approval analog ADR-0023 (`sign_skill_promotion_native` Rust-command + spawn_blocking native dialog). **Niedrige Priorität** seit dem Distribution-Pivot 2026-05-27 (Web/Linux ist Primary; Tauri-Desktop-Signing deprioritisiert). Browser-Flow via CLI ist funktional.

**Phase 5c-6** (dieses PR) — ADR-Closeout + `docs/skill-promotion-workflow.md`.

### MSP-E Note-to-Skill (depends auf 5c)

Mit Phase 5c gemerged ist die MSP-E-Spec (`tasks/phase-msp-e-note-to-skill.md`) unlocked: aus einer Note wird ein Draft via `noteToDraftSkill()`, der dann durch die Standard-Pipeline läuft. Folge-PR.

## Konsequenzen

**Positiv**

- Self-Improvement real, aber niemals autonom destruktiv
- Lessons-Loop bleibt Default für die ersten Phasen — Auto-Promotion ist optional
- Audit-Trail für jede aktivierte Skill-Version

**Negativ**

- Zusätzliche GUI-Komplexität für Review-Surface
- Sandbox-Process-Setup ist nicht trivial
- Erster Auto-Skill kommt frühestens Phase 5

## Alternativen verworfen

- **Keine Self-Improvement:** verworfen — Hermes-Pattern hat klaren Mehrwert bei sicherer Implementation
- **Auto-Promotion ohne Review:** verworfen — Security-untragbar bei MSP-Kontext
- **Review per LLM (Codex/Gemini) ohne Mensch:** verworfen für finale Aktivierung; akzeptabel als Pre-Review für Yannik (Heuristik), aber finale Approval bleibt menschlich

## Quellen

- ADR-0004 (Keyring für Signatur-Schlüssel)
- ADR-0023 (Native-Password-Pattern als Vorbild für sensitive UI)
- SECURITY.md §5 (Skill-Lifecycle-Detail)
