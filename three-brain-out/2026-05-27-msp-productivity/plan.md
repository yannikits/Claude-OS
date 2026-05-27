# Three-Brain — MSP-Productivity-Plan (2026-05-27)

**Trigger:** `/three-brain Entwickle das Projekt weiter ... Klärungs-Slot zum Schluss`
**Routes fired:** Gemini (codebase recon, 5 feature proposals) + WebSearch (MSP-pain-points-2026) + Codex (adversarial review).

## Analyse — was wir wissen

**User-Kontext (aus Memory + Repo):**
- Yannik, Die ITeen-Schmiede, kleine MSP
- Tools: TANSS, Ninja, Veeam, M365, Securepoint
- Infrastructure: Proxmox + OPNsense + Docker + Cloudflare
- Claude-OS Web/Linux-Server ist Primary-Distribution (2026-05-27 Pivot)
- Shipped: memory-index (FTS), skill-engine, notes/retrieval, tenant-domain, workspace-domain, audit-log, server (HTTP/SSE/WS), multi-token-auth

**MSP-2026-Pain-Points (Web-Recherche):**
1. Reactive vs. Proactive — Repetitive Tickets fressen Margen
2. Operational Fragmentation — Skalierung ohne mehr Headcount
3. Inconsistent Processes — Customer-Onboarding-Drift
4. Vendor-Ecosystem-Complexity — viele Tools, viele Logins
5. Talent-Shortage — Automation um existing-staff-capacity zu strecken

**Gemini-Vorschläge (5 features):** Cross-Workspace-Resolution-Discovery, Daily-Handover-Composer, Global-Skill-Injection, Note-to-Skill-Fast-Track, Contextual Inbox-Routing.

**Codex-Verdict (adversarial):**
- Ship-First: **Feature 5 Contextual Inbox Routing** (lowest-risk daily-use)
- Ship-Second: **Feature 1 Cross-Workspace-Discovery** — aber NUR mit tighteren tenant-guards
- Reject (zu früh oder zu riskant): F2 (LLM-dependent), F3 (security-risk), F4 (weekly-not-daily)

## Empfehlung — Roadmap

### Phase MSP-A: Contextual Quick-Capture (S, 3-5h)

**Use-Case:** "Anruf kommt rein, Yannik öffnet die Web-UI auf dem zweiten Monitor oder Smartphone, tippt 3 Zeilen, drückt Enter — landet im richtigen Customer-Workspace mit korrekten Frontmatter-Defaults."

**Daily-Hit-Rate-Schätzung:** 5-15× pro Tag (Anrufe, Site-Visits, Kollegen-Anfragen). Höchste Daily-Use-Wahrscheinlichkeit aller 5 Vorschläge.

**Codex-Hardenings übernommen:**
- KEIN neues `notes.saveToActiveWorkspace`-RPC. Stattdessen `notes.write` erweitern um `target: 'active'`-Option, oder server-side default wenn workspace im Payload leer ist
- Backend validiert active-workspace, NICHT der Renderer-State. Tauri und Web nutzen denselben validator
- Ambiguous-state → Reject mit HTTP 409 + Hint "set active workspace explicitly"
- UI zeigt Target-Customer als grosse Badge VOR submit
- Audit-Log-Entry jeder write mit `tenant + workspace + path`
- Path-Traversal-Tests
- Reject caller-supplied frontmatter wenn `workspace`/`tenant` mit aktivem context kollidiert

**Files (geschätzt):**
- `src/domains/notes/writer.ts` — extend mit `resolveTarget()` für active-fallback
- `src/domains/workspace/active-resolver.ts` (new) — single source-of-truth für active-workspace per session
- `src/sidecar/methods/notes.ts` — `notes.write` parameter `{target?: 'active' | {workspace, tenant}}`
- `gui/src/components/quick-capture.tsx` (new) — Mini-Widget mit Customer-Badge, Hotkey "n"
- `gui/src/pages/index.tsx` — Dashboard-Card "Quick-Capture" + Mobile-friendly responsive
- Tests: 8-12 (writer-active-fallback, ambiguous-reject, traversal, frontmatter-conflict, audit-log-entry, parity Tauri↔Server)

### Phase MSP-B: Scoped Cross-Workspace Solution-Search (M, 4-6h)

Nach MSP-A. Implementiert Feature 1 mit Codex's Hardenings:
- Default-Scope: active customer + `msp-internal`
- Cross-Customer = explicit Opt-In im UI (Toggle "auch andere Kunden durchsuchen")
- Jeder Hit zeigt Source-Label (Customer-Anonymisierung optional via Frontmatter-Flag `redact-in-cross-search: true`)
- Audit-Log-Entry jeder cross-customer-Search mit (subject-token-hash, scope, query-hash, result-count)
- Default-Limit 10 Hits

### Phase MSP-C: Skill-Auto-Match in Quick-Capture (optional Folge, S)

Beim Quick-Capture-Eingabe: live-match gegen existing Skills (BM25 via skill-engine). Zeigt "Matching skill: M365-User-Onboarding" als Hint-Card.

### Out-of-Scope für jetzt

- F2 Daily-Handover: braucht LLM-Compose-Pfad, das fügen wir hinzu wenn `ask`-Domain-Output qualitativ besser wird
- F3 Global-Skill-Injection: braucht Skill-Namespacing-ADR — eigenes Vorhaben
- F4 Note-to-Skill-Fast-Track: braucht ADR-0026-Sandbox-Completion (Phase 5)

## Compounding-Ledger

Filed:
- `three-brain-out/2026-05-27-msp-productivity/gemini-analysis.md` — Gemini's 5 features mit RPC-Sketches
- `three-brain-out/2026-05-27-msp-productivity/codex-review.md` — Adversarial review
- `three-brain-out/2026-05-27-msp-productivity/plan.md` — dieser Synthese-Plan
- `three-brain-out/log.md` — append entry

## Sources (MSP-Pain-Points)

- [10 MSP Trends 2026 — Integris](https://integrisit.com/blog/the-10-msp-trends-to-watch-in-2026-and-beyond/)
- [7 MSP Challenges 2026 — DeskDay](https://deskday.com/managed-service-provider-challenges-2026/)
- [MSP Pain Points & Solutions — Worksent](https://worksent.com/blog/msp-painpoints-solutions-best-practices/)
- [Top 10 MSP Challenges — NetSuite](https://www.netsuite.com/portal/resource/articles/business-strategy/msp-challenges.shtml)
- [MSP Solution — Framework IT](https://frameworkit.com/managed-services/the-msp-solution-addressing-top-pain-points-smb-organizations)
