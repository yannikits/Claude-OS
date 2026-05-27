# Phase 5/7 Discovery — Self-Improvement Sandbox + MSP-Write Gates

**Datum:** 2026-05-27
**Status:** Discovery + Plan + Klärungsslot (KEINE Implementation der gated Items in dieser Session)
**Vorausgegangen:** PR mit Audit-Log v1-Format-Finalisierung (befüllt Gate 3 aus ADR-0026)

## Was bereits in diesem PR liefert (kein Block, kein ADR-Review nötig)

**Audit-Log-Format finalisiert (Phase 5 §"Implementation Gated" — Gate 3):**
- `AUDIT_SCHEMA_VERSION = 1` als kanonisches Feld in jedem AuditEntry
- `pruneAuditFiles()` in `@core/audit/retention` mit:
  - Default 90 Tage (per SECURITY.md §4.3)
  - Konfigurierbar via `$CLAUDE_OS_AUDIT_RETENTION_DAYS` (1 Tag … 7 Jahre clamped für DSGVO MSP-Kontext)
  - Idempotent + dry-run-Mode + filename-driven (löscht NUR `audit-YYYY-MM-DD.jsonl`, lässt `.gz` / stray files alleine)
  - Non-fatal bei single-file-unlink-failures (Windows-file-locks)
- SECURITY.md §4.2/§4.3 updated mit v1-Format + retention-policy
- ADR-0026 §"Implementation Gated" Audit-Log-Gate als done abgehakt

Tests: 17 audit tests grün (11 retention + 6 logger existing).

## Was BLOCKIERT bleibt — zwei Gates, eigene Reviews nötig

### Gate 1 — Sandbox-Process-Isolation für quarantined-Skills (ADR-0026 §"Sandbox")

**Aufwand-Schätzung:** L (8-14h), eigener ADR + Spike-Prototyping
**Block-Risk:** mittel-hoch — Node-worker_threads-Isolation hat platform-Limits

**Drei Implementations-Optionen mit Trade-offs:**

| Option | Pro | Contra | Aufwand |
|---|---|---|---|
| **A) `node:worker_threads`** + fs-wrapper + Hostname-Allowlist | im selben Node-Process, low-latency RPC, kein extra-Binary | wirklich isoliert? Worker hat full Node-API access, fs-wrapper ist defense-in-depth nicht hard-barrier | M |
| **B) `node:child_process.fork`** mit chroot-style data-dir | echter Prozess, klares ipc, kill-on-timeout trivial | Windows hat kein chroot — Dummy-Verzeichnis-Sandboxing nur via Path-Validation, kein OS-Enforcement | M |
| **C) WASM-Runtime** (Wasmtime/wasmer mit Node-Embedding) | echte Capability-Isolation, kein-fs / kein-net Default | Skill-Author muss WASM-kompatible-Subset schreiben → großer DX-Hit | XL |

**Empfehlung (ohne user-input):** Option **B** als Phase-5a Spike. Echte Process-Boundary + Cross-Platform-pragmatic. Path-Validation als documented-defense-in-depth (nicht hard barrier auf Windows). WASM bleibt als v2-Material für echte security-isolation-Anforderung.

### Gate 2 — Yannik-Ed25519-Signatur-Flow (ADR-0026 §"Review-Gate" + ADR-0023 als Vorbild)

**Aufwand-Schätzung:** M (5-8h), eigener ADR
**Block-Risk:** niedrig — Pattern existiert bereits (ADR-0023 Native-Password-Pattern)

**Drei Sub-Items:**
1. **Ed25519-Key-Generation + Storage** in NAPI-RS Keyring (ADR-0004) — `claude-os auth signing-key create` CLI
2. **Tauri-GUI-Modal** mit Side-by-Side-Diff (vor-Skill ⇔ nach-Skill) + nativem Password-Dialog für Key-Unlock (analog `set_secret_native` aus ADR-0023)
3. **Sign + Verify Functions** im public-core (`@domains/skill-lifecycle/signing.ts`) — signature in Audit-Log + Skill-Frontmatter

**Empfehlung:** kann **vor** Gate 1 angegangen werden — signing-foundation ist unabhängig vom Sandbox-Choice und macht claude-os-msp-Approval-Flow (Phase 7) gleich mit nutzbar.

## Phase 7 (MSP-Write) — was Public-Core JETZT vorbereiten kann

ADR-0027 §"Phase 7" sagt:
> Approval-Token + Yannik-Signatur (Ed25519 aus Keyring, ADR-0004) ins Audit-Log

→ Das ist **exakt Gate 2** aus Phase 5. **Approval-Token-Foundation kann public-core sein** (`@domains/approval-token`), Bridge-Calls aus claude-os-msp konsumieren dann nur das Public-Interface.

Konkrete Public-Core-Vorbereitung für Phase 7:
- `ApprovalToken`-Schema (ed25519-signed payload mit `kind / scope / nonce / expiresAt / signedBy`)
- `signApprovalToken` + `verifyApprovalToken` helpers
- Audit-Log-Integration (signature im `details`-Feld)
- Doctor-Check `serverSigningEnv` (keypair vorhanden? nicht expired?)

Das ist ein **eigener kleiner PR** (~4-6h), unabhängig vom Sandbox-Choice. Macht Phase 7 nicht "fertig" — aber gibt claude-os-msp die foundation-bricks.

## Klärungs-Slot — Yannik-Entscheidungen vor Implementation

1. **Sandbox-Option für Gate 1**: A (worker_threads), B (child_process.fork — empfohlen), C (WASM)? Oder erst spike-prototypen + dann entscheiden?
2. **Reihenfolge Gate 1 vs Gate 2**: Signing-Foundation zuerst (mein Vorschlag — entkoppelt + macht Phase 7 prep gleich mit), oder Sandbox zuerst (per ADR-0026-Reihenfolge)?
3. **Phase 7 Public-Core-Vorbereitung**: Soll ich `@domains/approval-token` direkt als nächsten PR machen (4-6h, klein, kein ADR-Review), oder erst auf Gate 2 (Signing) warten?
4. **Sandbox-Process-Isolation auf Windows**: akzeptierst du die "Path-Validation als documented-defense-in-depth, kein OS-Enforcement"-Lösung für Option B, oder ist das ein Showstopper?
5. **DSGVO 7-Jahres-Retention**: ist der MAX_RETENTION_DAYS=7y für MSP-Kunden mit DSGVO-Pflicht wirklich oft genug? Oder gibt es Kunden die längere Aufbewahrungsfristen brauchen (Tax-Authorities 10y in DE)?

Ohne diese Antworten würde ich raten und das ist genau das Risiko bei security-relevanten Features.

## Three-brain artefacts

- `three-brain-out/2026-05-27-msp-productivity/` — Vorgang aus dieser Session (MSP-A/B/C/D)
- `three-brain-out/2026-05-27-phase-5-completion/plan.md` — dieses Dokument
