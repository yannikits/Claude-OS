# ADR-0026 — Skill-Auto-Promotion Lifecycle

**Status:** Akzeptiert (Konzept) — Implementation gated auf Self-Improvement-Phase
**Datum:** 2026-05-24
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

### Implementation Gated

Phase darf erst starten, wenn:
- Sandbox-Process-Isolation prototyped und in Vitest verifiziert — **offen**
- Yannik-Signatur-Flow im Tauri-GUI implementiert (analog ADR-0023 Native-Password-Pattern) — **offen**
- Audit-Log-Format finalisiert (siehe SECURITY.md §4) — **erledigt 2026-05-27** (Phase-5-completion-PR; v1-Schema, schema_version-Feld, retention-Policy, file-mode 0o600, UTC-day-Rotation)

Discovery + concrete next-steps für die beiden verbleibenden Gates siehe `three-brain-out/2026-05-27-phase-5-completion/plan.md`.

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
