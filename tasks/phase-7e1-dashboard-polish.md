# Phase 7-E.1 — MSP-Health Dashboard-Polish

**Status:** Plan (Stand 2026-05-30)
**Ziel-Release:** v1.9.3
**Bedingt durch:** ADR-0041 (Dashboard-Foundation), 0037 (Audit-Dashboard für Drill-Down-Target)

## Was 7-E.1 liefert

Drei user-sichtbare Verbesserungen am bestehenden MSP-Health-Dashboard,
fokussiert auf „Production-Ready für > 50 Customer":

1. **Auto-Refresh-Polling** — toggle in der Header-Leiste, Intervalle
   `off` / `1min` / `5min` / `15min`. Default `off`.
2. **Pagination** — page-size 25/50/100, prev/next, page-N-von-M.
3. **Drill-Down-Link zu Audit-Log** — pro Customer-Zeile ein „audit"-
   Button der `/audit?tenant=<slug>&kinds=bridge.read` öffnet.

**Frontend-only.** Kein Backend-Schema-Change, kein neuer Endpoint —
alle Backend-APIs aus v1.9.0 sind suffizient.

## Out-of-Scope für 7-E.1

- Per-Vendor-SLA-Thresholds (kommt als v1.9.4)
- Per-Customer-Mute/Filter (z.B. „hide alle ok")
- Saved-Views / Bookmarks
- Sortierung nach Customer-displayName etc.
- Cell-Hover-Tooltips mit raw-JSON-preview

## Module

### `gui/src/pages/msp-health.tsx`

- `RefreshController` — useState für `intervalSec | null`, useEffect
  setInterval(load(false))
- `Pagination` — useState für `page` + `pageSize`, slice der rows-Liste
- `Drill-down-Button` — neuer Link `<a href={`/audit?tenant=${slug}&kinds=bridge.read`}>` in jeder Zeile
- Layout-Update im Header: kompakte „auto-refresh: off|1m|5m|15m" segmented control + „rows-per-page: 25|50|100" select

### `gui/src/styles.css`

- ~30 LOC neue Klassen für `.msp-health-controls`, `.msp-health-pagination`,
  `.msp-health-drill-link`

### `gui/src/lib/use-msp-auto-refresh.ts`

Kleine Hook-Abstraktion (testbar via vitest):

```ts
export function useAutoRefresh(
  loader: () => void,
  intervalSec: number | null,
): void
```

useEffect mit setInterval/cleanup; null deaktiviert. Tests: timer fires
at correct intervals, cleanup on intervalSec change, cleanup on unmount.

## Tests

- `tests/gui/use-auto-refresh.test.ts` (vitest mit fakeTimers): null no-op,
  fires every intervalSec, cleanup on change/unmount, doesn't double-fire

## Phase-Aufteilung

### A — Hook + Pagination + Auto-Refresh (Frontend)
- `use-msp-auto-refresh.ts` + tests
- Header-Controls + Pagination im msp-health.tsx
- Auto-Refresh wiring
- **Commit:** `feat(msp-health): auto-refresh + pagination (Phase 7-E.1.A)`

### B — Audit-Drill-Down + Styles + Release
- Drill-Down-Link pro Row
- Styles
- ADR-0044 (kurz)
- CHANGELOG v1.9.3
- 4 Manifest-Bumps
- **Commit:** `feat(msp-health): v1.9.3 — drill-down + polish (Phase 7-E.1.B)`

## Verification

- [ ] alle Unit-Tests grün (auto-refresh hook)
- [ ] tsc -p gui clean
- [ ] tsc clean (backend unchanged)
- [ ] biome clean
- [ ] Manual: auto-refresh läuft, pagination funktioniert, Drill-Down-Link
  öffnet Audit-Page mit korrekten Filtern
- [ ] CHANGELOG + Version-Bump in allen 4 Manifests
