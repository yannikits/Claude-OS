# ADR-0044 — MSP-Health Dashboard-Polish (Phase 7-E.1)

**Status:** shipped (2026-05-30, v1.9.3)
**Bedingt durch:** ADR-0041 (Dashboard-Foundation), 0037 (Audit-Dashboard)

## Kontext

ADR-0041 lieferte das MSP-Health-Dashboard mit manueller Refresh-Logic
und unpaginated tabelle. Mit vier Bridges live und wachsender
Customer-Zahl wurden drei Pain-Points sichtbar:

1. **Polling manuell:** Yannik muss alle paar Minuten klicken um aktuelle
   Daten zu sehen — bei einem Cache-TTL von 60s ist das verschwendete
   Aufmerksamkeit.
2. **No pagination:** > 50 Customer = scrollig + langsame Render.
3. **No drill-down zu Audit:** „Ich sehe die Veeam-Zelle ist rot — wann
   ging das kaputt?" erfordert manuelles Wechseln nach Audit-Log und
   Filter-Bauen.

## Entscheidung

Drei **frontend-only** Verbesserungen, kein Backend-Schema-Change:

### 1. Auto-Refresh-Polling

Header-Segment-Control: `off` / `1m` / `5m` / `15m`. Default `off`.
Wenn aktiv: `setInterval` ruft `load(false)` (cache-aware, kein
unnötiger force-bust).

Implementation: `gui/src/lib/use-msp-auto-refresh.ts` als generische
React-Hook mit:
- `loaderRef` für closure-stale-Schutz (re-render ändert nicht den Timer)
- `useEffect` cleanup-on-unmount und cleanup-on-intervalSec-change
- null-or-≤0 → no-op (off)

7 vitest-Tests decken: null-no-op, fire-at-interval, latest-loader-via-ref,
reset-on-interval-change, cleanup-on-unmount, stop-on-null-switch.

### 2. Pagination

Footer-Bar mit page-size-segment (25/50/100, default 50) +
prev/next + page-info „page N / M (X total)". Slice macht der Client
auf der bereits geholten `snap.rows`-Liste (kein zusätzlicher
Backend-Roundtrip pro Seitenwechsel).

### 3. Audit-Drill-Down-Link pro Zeile

Neue Spalte `AUDIT` rechts. Pro Zeile ein `<a href="/audit?tenant=
<slug>&kinds=bridge.read">audit</a>`. `onClick` stoppt Propagation
damit der Row-Expand nicht mit-getriggert wird.

Das öffnet die Audit-Trail-Page (ADR-0037) mit vorbefüllten Filtern auf
diesen Customer + nur Bridge-Read-Events.

## Konsequenzen

**Positiv:**
- Yannik kann das Dashboard offen lassen → auto-refresh hält's frisch
- > 200 Customer paginated cleanly (page-N statt full-table-scroll)
- Drill-Down macht „warum ist das rot" eine 1-Click-Frage
- Backend unverändert → zero risk für regression auf API-Layer

**Negativ / Trade-offs:**
- Auto-Refresh-Polling auf 1m bei 100 Customers könnte den Server-Cache
  warm halten und die Backend-Probes aktiver auslasten — wir verlassen
  uns auf den 60s-TTL auf der `/api/msp-health/rows`-Route
- Pagination im Client → für > 1000 Customer wäre server-side bessere
  Lösung. Deferred bis das problem real ist.
- Drill-Link öffnet `/audit?...` in derselben Tab — falls Yannik den
  ausgeklappten State behalten will, muss er auf "back" drücken. Lasse
  ich so weil "neuer Tab" mit `target="_blank"` für intra-app-Links
  schlechte UX wäre.

**Folge-Schritte:**
- Phase 7-E.2 (deferred) — per-Vendor-SLA-Thresholds (z.B.
  veeam-failed > 24h → red), saved-views, hide-all-ok-toggle

## Referenzen
- ADR-0037 Audit-Trail-Dashboard
- ADR-0041 MSP-Health Aggregat-Dashboard
- `gui/src/lib/use-msp-auto-refresh.ts`
- `gui/src/pages/msp-health.tsx`
