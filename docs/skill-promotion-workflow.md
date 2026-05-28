# Skill-Promotion-Workflow — Self-Improvement-Loop für Claude OS

> Status: Phase 5c shipped 2026-05-28. Implementiert per ADR-0026 (Lifecycle), ADR-0034 (Sandbox), ADR-0035 (Signing). MSP-E Note-to-Skill folgt als separate Spec.

Diese Anleitung beschreibt den End-to-End-Flow vom **Lessons-Eintrag** zum **aktiven Skill** — also Yannik's Self-Improvement-Loop: erkenne ein wiederkehrendes Pattern, lass es als Draft-Skill generieren, prüfe Side-by-Side, signiere mit Ed25519, aktiviere.

## Architektur in 60 Sekunden

```
tasks/lessons.md
    ↓ readLessonsFile()
LessonEntry[]
    ↓ lessonToDraftSkill()
DraftSkill                   →  <vault>/.../skills/_drafts/<name>/SKILL.md     [state: draft]
    ↓ claude-os skill promote <name> --to-quarantined
                             →  <vault>/.../skills/_quarantined/<name>/SKILL.md [state: quarantined]
    ↓ optional: claude-os skill promote <name> --run-sandbox --script-path …
                             →  <quarantined-dir>/.sandbox-run.json  (Audit-Log: skill.invoke)
    ↓ proposeReview         →  ReviewProposal{diffHash, beforeContent, afterContent, classification, sandboxRunSummary}
    ↓ Yannik signiert Ed25519 (offline)        →  SignedEnvelope
    ↓ claude-os skill promote <name> --to-active --signed-envelope sig.json
                             →  <vault>/.../skills/<name>/SKILL.md   [state: active]
                             →  Audit-Log: skill.promote (envelope.signedAt + publicKeyB64)
```

Drei Eintrittspunkte, gleiche Pipeline:

| Surface | Implementation | Use-Case |
|---|---|---|
| **CLI** | `claude-os skill …` | Power-User, CI-Skripte |
| **Sidecar-RPC** | `skill.*` (Phase 5c-3) | GUI + MCP-read-only-Inspektion |
| **GUI** | `SkillReviewPage` (Phase 5c-4) | Browser + Tauri-Approval |

## State-Machine

```
draft → quarantined → reviewed → active → deprecated → disabled
                                       ↘ reactivate ↗
```

| State | Bucket | Loadable? |
|---|---|---|
| `draft` | `_drafts/<n>/` (Underscore-Prefix → vom Phase-4-Loader ignoriert) | nein |
| `quarantined` | `_quarantined/<n>/` (Underscore-Prefix) | nein, nur per `--run-sandbox` |
| `reviewed` | übergangs-Marker (in der Praxis sofort `active`) | nein |
| `active` | `<n>/` (kein Prefix) | ja |
| `deprecated` | `<n>/` mit `state: deprecated` | ja, mit Warnung |
| `disabled` | `<n>/` mit `state: disabled` | nein, bleibt im Repo zur Forensik |

## Schritt-für-Schritt-Workflow

### 1. Lesson schreiben (Yannik manuell)

Nach jeder relevanten Korrektur ergänze `tasks/lessons.md` (siehe CLAUDE.md §6):

```markdown
## 2026-05-28 — Migration-Vorbereitungs-Pattern

**Situation:** Was passiert ist
**Lektion:** Welches Verhalten ändert sich daraus
**Anwendung:** Wann und wo das relevant ist
```

### 2. Draft generieren

```bash
$ claude-os mine-lessons          # parses lessons.md → draft proposals
$ # OR direct: lessonToDraftSkill() via custom script
$ claude-os skill list-drafts
2026-05-28T08:00:00Z  migration-vorbereitung   …/_drafts/migration-vorbereitung
```

Der Draft liegt unter `<vault>/Claude-OS/workspaces/<ws>/skills/_drafts/<name>/SKILL.md`. Frontmatter enthält:

```yaml
---
name: migration-vorbereitung
description: Wann dieser Skill triggern soll
classification: personal   # oder customer-confidential
state: draft
generated_at: 2026-05-28T08:00:00Z
---
```

### 3. Quarantäne

```bash
$ claude-os skill promote migration-vorbereitung --to-quarantined
[OK] skill.promote migration-vorbereitung: draft → quarantined (…/_quarantined/migration-vorbereitung)
```

Audit-Eintrag: `kind: 'skill.promote', action: 'draft-to-quarantined'`.

### 4. (Optional) Sandbox-Run

Falls der Skill ein Test-Skript hat:

```bash
$ claude-os skill promote migration-vorbereitung \
    --run-sandbox \
    --script-path /abs/path/to/script.mjs \
    --input-json /abs/path/to/test-input.json \
    --timeout-ms 15000

[OK] skill.sandbox migration-vorbereitung — duration=842ms
```

Resultat persistiert nach `<quarantined-dir>/.sandbox-run.json`. GUI rendert das in der Sandbox-Run-Card neben dem Diff.

**Sandbox-Constraints** (ADR-0034 + Phase-5b-net-guard):
- `child_process.fork` Isolation, kein FS-Write außer Sandbox-Root
- `fetch` net-guard mit Hostname-Allowlist (Default leer)
- 30s default Timeout, hard-kill bei Überschreitung
- Skill-ID-Validation (`/^[a-z0-9][a-z0-9_-]*$/`)

### 5. Review-Proposal generieren

```bash
$ claude-os skill propose-review migration-vorbereitung --json > proposal.json
```

`proposal.json` enthält:
```json
{
  "ok": true,
  "name": "migration-vorbereitung",
  "classification": "personal",
  "beforeContent": "",
  "afterContent": "---\n…\n---\n# Migration …\n",
  "diffHash": "1a2b3c4d…(64 hex chars)",
  "sandboxRunSummary": { … } | null
}
```

`diffHash` = SHA-256 über canonical `{beforeContent, afterContent, classification}`. Wird in die Signatur eingebettet (Tamper-Schutz).

### 6. Signieren (Ed25519, offline)

Yannik's Keypair lebt im Secret-Store unter `claude-os-signing-private-key` (per ADR-0004 keyring oder encrypted-file Fallback). Signing-Payload:

```json
{
  "skillId": "migration-vorbereitung",
  "diffHash": "1a2b3c4d…",
  "classification": "personal",
  "reviewedAtIso": "2026-05-28T08:30:00Z"
}
```

CLI:

```bash
$ claude-os signing sign --payload-file payload.json --output envelope.json
```

Wire-Format `SignedEnvelope` (ADR-0035):

```json
{
  "payload": { "skillId": …, "diffHash": …, "classification": …, "reviewedAtIso": … },
  "signatureB64": "…64-byte base64url ed25519-sig…",
  "publicKeyB64": "…32-byte base64url public-key…",
  "signedAt": "2026-05-28T08:30:00Z",
  "algorithm": "ed25519-sha256-canonjson"
}
```

### 7. Aktivieren

```bash
$ claude-os skill promote migration-vorbereitung --to-active --signed-envelope envelope.json
[OK] skill.promote migration-vorbereitung: quarantined → active (…/skills/migration-vorbereitung)
```

Server-side passiert (in dieser Reihenfolge):

1. `verifyEnvelope(envelope)` — Ed25519-Signature gegen die canonical JSON
2. `envelope.payload.diffHash === currentDiffHash` (kein In-Flight-Tamper)
3. `envelope.payload.skillId === request.name`
4. Optional: `envelope.publicKeyB64 === expectedPublicKeyB64` (pinned-Key gegen Keypair-Swap)
5. **Audit-Eintrag FIRST** (`kind: 'skill.promote', action: 'review-approved'`)
6. Old-Active-Version (falls vorhanden) wird nach `<name>.prev-<ts>/` snapshot
7. `_quarantined/<n>/` → `<n>/` (rename, EXDEV-fallback via copy+rm)
8. Frontmatter-State auf `active` gesetzt

Bei Verifikations-Failure: `PromoteError(code: 'signature-invalid' | 'signature-mismatch-diff-hash')`. Kein FS-Move.

### 8. (Später) Deprecate / Disable / Reactivate

```bash
$ claude-os skill promote migration-vorbereitung --deprecate
$ claude-os skill promote migration-vorbereitung --disable
$ claude-os skill promote migration-vorbereitung --reactivate   # nur von deprecated/disabled
```

Sind Frontmatter-Only-Flips, kein FS-Move. Audit-Trail bleibt.

## GUI-Flow (Browser-Build, Phase 5c-4)

1. Server läuft (`claude-os serve` mit Multi-User-Stage-2 oder Bearer-Token)
2. Browser → `/skill-review` (Sidebar-Eintrag "Skill-Review")
3. Pending-Liste links → Auswahl rendert Side-by-Side-Diff + Sandbox-Run-Card rechts
4. **Customer-Confidential**-Skills bekommen einen prominenten roten Warn-Banner
5. "Signieren + aktivieren …" → CLI-Hint-Modal (Stub-Implementation bis Phase 5c-5)
6. User signiert offline + ruft `claude-os skill promote --to-active` aus dem Terminal

Tauri-Native-Password-Approval (Phase 5c-5) wird die `--signed-envelope`-Hand-Off-Schleife ersetzen durch einen einzigen Click → native password-prompt → in-process signPayload → ein-RPC-Call.

## Audit-Trail

Jede Transition schreibt eine JSONL-Entry nach `<dataDir>/audit/audit-YYYY-MM-DD.jsonl`:

```json
{
  "schema_version": 1,
  "at": "2026-05-28T08:30:01.123Z",
  "kind": "skill.promote",
  "action": "review-approved",
  "workspace": "personal",
  "outcome": "ok",
  "details": {
    "skillName": "migration-vorbereitung",
    "diffHash": "1a2b3c4d…",
    "classification": "personal",
    "signedAt": "2026-05-28T08:30:00Z",
    "publicKeyB64": "…"
  },
  "pid": 12345,
  "hostname": "claude-os-server"
}
```

UTC-day-Rotation, file-mode `0o600`, retention per ADR-0027 §"Audit-Store".

## Sicherheits-Stellungnahme

- **Lifecycle-Gating:** ein Draft kann nicht direkt aktiv werden. Quarantäne ist Pflicht-Stop.
- **Tamper-Protection:** `diffHash` ist in den Signed-Envelope eingebettet. Modifizieren des SKILL.md nach Sign aber vor Activate → `signature-mismatch-diff-hash`.
- **Keypair-Swap-Defense:** optionaler `expectedPublicKeyB64`-Pin im `--to-active`-Flow. Wer den anchored, hat Schutz auch wenn der Signing-Store kompromittiert wird.
- **No-Auto-Loop:** keine automatische Promote-Pipeline. Jede Transition ist explizit (CLI flag, RPC call, GUI button).
- **Sandbox-Constraints:** quarantined skills laufen in `child_process.fork`-Sandbox mit fs/net-Whitelist; 30s Hard-Timeout.
- **Audit-FIRST auf Approve:** Audit-Entry wird vor dem FS-Move geschrieben. Audit-Store-Failure → kein half-moved Skill auf disk.
- **MCP-Excludes:** Mutating skill-RPCs sind **nicht** als MCP-Tools exposed. Approval gehört nicht über agentic Tool-Calls.

## Troubleshooting

**"PromoteError [not-found]: ..."** — Skill-Name stimmt nicht oder ist im falschen Bucket. Check via `claude-os skill list-drafts` + `list-quarantined`.

**"PromoteError [wrong-state]: ..."** — z.B. `--reactivate` auf einen `active` Skill. Lifecycle-Diagramm beachten.

**"PromoteError [signature-mismatch-diff-hash]: ..."** — quarantined SKILL.md wurde nach `propose-review` modifiziert. `propose-review` neu ausführen + erneut signieren.

**"PromoteError [signature-invalid]: ..."** — Envelope-Signature failt verify. Public-Key falsch oder Payload manipuliert. Bei pinned-key: deren `publicKeyB64` mit erwartetem matchen.

**"PromoteError [audit-write-failed]: ..."** — Audit-Store nicht schreibbar (Disk full / Permissions). FS-Move nicht durchgeführt — Skill bleibt in `_quarantined/`. Audit-Verzeichnis reparieren + erneut versuchen.

## Referenzen

- ADR-0026 — Skill-Auto-Promotion Lifecycle (status + status-decisions)
- ADR-0034 — Skill-Sandbox via `child_process.fork`
- ADR-0035 — Yannik-Ed25519-Signatur-Foundation
- SECURITY.md §4 — Audit-Store-Spec
- `tasks/phase-5c-skill-promotion-gui.md` — Sub-Phase-Tracker
- `tasks/phase-msp-e-note-to-skill.md` — Follow-up Note-to-Skill
