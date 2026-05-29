# Phase Audit-Trail-Dashboard — Tier-1 (Tracking)

Branch: `feature/audit-trail-dashboard`
Plan-Datum: 2026-05-29 (nach v1.7.8)
Vorbedingung: v1.7.8 deployed (✅) + admin-emails-allowlist (Web-7-7) ist die Auth-Foundation.

---

## Was wir bauen

Web-UI für die Audit-Log-JSONL-Files (`<dataDir>/audit/audit-YYYY-MM-DD.jsonl`). DSGVO-Compliance + Trust-Story + Investigation-Werkzeug. Read-Only — schreiben tut weiter nur der existierende `AuditLogger`.

**Funktionen:**
- Liste aller Events mit Filter (Kind, Workspace, Tenant, Outcome, Time-Range)
- Pagination (default 50/Seite, max 500)
- Expandable Event-Row für details-Payload
- Export als JSONL + CSV für Compliance-Übergabe
- Stats-Widget (Counts pro Kind in gewähltem Zeitfenster)

**Gating:** komplette Page + alle RPCs nur für User in `CLAUDE_OS_ADMIN_EMAILS` (selber Pattern wie `/api/admin/users*` in Web-7-7).

---

## Phase A — Backend Foundation

- [ ] **A.1** Neue Domain `src/domains/audit-query/`
  - [ ] `types.ts` — `AuditQuery` Filter-Interface, `AuditPage` Result-Shape
  - [ ] `reader.ts` — `readAuditFile(path)` parsed JSONL line-by-line mit Skip-on-malformed
  - [ ] `query.ts` — `queryAudit(opts)`: filtert nach Time-Range (Tag-Granularität → richtige Files), Kind (Set), Workspace, Tenant, Outcome, action-substring. Returnt sortiert (newest-first) + pagination
  - [ ] `stats.ts` — `auditStats(opts)`: aggregierte Counts pro Kind im gewählten Zeitfenster
  - [ ] `export.ts` — `exportAudit(opts, format='jsonl'|'csv')` → string
  - [ ] `index.ts` — Barrel-Export
- [ ] **A.2** Tests in `tests/domains/audit-query/`
  - [ ] `reader.test.ts` — robust gegen partial-lines, malformed-json, missing-file
  - [ ] `query.test.ts` — alle Filter-Kombinationen, time-range crosses day-boundary, pagination, empty-result
  - [ ] `stats.test.ts` — Count-Aggregation pro Kind
  - [ ] `export.test.ts` — CSV-Escaping (commas, quotes, newlines in details), JSONL-Round-trip
- [ ] **A.3** Sidecar-Methods in `src/sidecar/methods/audit.ts`
  - [ ] `audit.list(query)` → `AuditPage`
  - [ ] `audit.stats(query)` → `{ counts: Record<Kind, number>, totalEvents }`
  - [ ] `audit.export(query, format)` → `{ content: string, suggestedFilename: string }`
- [ ] **A.4** Admin-Gating für die RPCs
  - [ ] Lookup: aktueller User aus `req.user.email` → Match gegen `CLAUDE_OS_ADMIN_EMAILS`
  - [ ] Wenn nicht admin: `{ ok: false, code: 'forbidden' }`
- [ ] **A.5** tsc + biome + Backend-Tests grün

## Phase B — Frontend

- [ ] **B.1** `gui/src/lib/rpc.ts` — typed wrappers
  - [ ] `auditList(query)` / `auditStats(query)` / `auditExport(query, format)`
  - [ ] Discriminated `AuditError`-Envelope
- [ ] **B.2** Neue Page `gui/src/pages/audit.tsx`
  - [ ] Page-Header mit Title + WorkspaceIndicator
  - [ ] Filter-Bar — Time-Range-Presets (heute / 7 / 30 Tage / custom), Kind-MultiSelect, Workspace-Dropdown, Outcome-Toggles, Action-Search
  - [ ] Stats-Strip — Counts pro Kind als Pills (operator-console caps + tnum)
  - [ ] Events-Table (`.data-table`-Klasse): Time-UTC · Kind · Action · Workspace · Tenant · Outcome · Details (expandable)
  - [ ] Pagination (Prev / Next + page-size selector)
  - [ ] Export-Buttons (Download CSV / Download JSONL über Blob)
- [ ] **B.3** Komponenten
  - [ ] `gui/src/components/audit-filter-bar.tsx`
  - [ ] `gui/src/components/audit-event-row.tsx` (expandable mit details-pretty-print)
  - [ ] `gui/src/components/audit-stats-strip.tsx`
- [ ] **B.4** Route-Registration in `App.tsx`
  - [ ] Nav-Entry in `SYSTEM`-Section: `Audit-Log` mit `led: 'idle'`
  - [ ] Route `/audit` → `AuditPage`
  - [ ] Nav-Entry nur rendern wenn User Admin ist (sonst hide)
- [ ] **B.5** Frontend-Tests (RTL)
  - [ ] `gui/tests/audit-page.test.tsx` — Filter-State + Pagination + Export
  - [ ] `gui/tests/audit-filter-bar.test.tsx`
  - [ ] `gui/tests/audit-stats-strip.test.tsx`
- [ ] **B.6** vite build + tsc + biome clean
- [ ] **B.7** Operator-Console-Treatment-Check für die Page

## Phase C — Documentation

- [ ] **C.1** ADR-0037 — `docs/architecture/adr/0037-audit-trail-dashboard.md`
  - [ ] Context: DSGVO-Compliance, Trust-Story, Investigation
  - [ ] Decision: read-only Web-UI, admin-gated, ADR-0027-Format unangetastet
  - [ ] Consequences: Performance bei vielen Files (Pagination via Tag-Files), Export-Format-Stability
- [ ] **C.2** User-Doku `docs/audit-trail-guide.md` (DE)
  - [ ] Wie filtern, was bedeuten die Events, wie Export für DSGVO-Anfrage
- [ ] **C.3** (Bonus) Audit-Coverage-Audit
  - [ ] Welche Code-Pfade schreiben aktuell NICHT in Audit obwohl sie sollten?
  - [ ] Liste in `docs/audit-coverage-gaps.md` für späteren Fix

## Phase D — Release

- [ ] **D.1** Version-Bump 1.7.8 → 1.8.0 (Minor — neues Feature)
- [ ] **D.2** CHANGELOG.md `[1.8.0]` section
- [ ] **D.3** PR mit allen 3 Phasen + Review-Sektion ausgefüllt
- [ ] **D.4** Nach Merge: Tag v1.8.0 + Release + Smoke auf Deployment

---

## Review-Sektion (nach Abschluss füllen)

- [ ] tsc clean
- [ ] biome clean
- [ ] Backend-Tests grün (Phase A)
- [ ] Frontend-Tests grün (Phase B)
- [ ] Browser-Smoke nach Merge auf Yannik's Deployment
- [ ] DSGVO-Workflow durchspielen: filter auf User-Email-Hash → CSV-Export
