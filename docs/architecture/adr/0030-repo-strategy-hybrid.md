# ADR-0030 — Repo-Strategie: Hybrid Public-Core + Private MSP/House

**Status:** Akzeptiert (2026-05-24) — **in der Umsetzung überholt, 1 offener Security-Punkt (2026-05-31)**
**Datum:** 2026-05-24
**Bedingt durch:** Spec-Split (PR #123) — Repo-Ort war offen, MSP-Customer-Schutz erzwingt Trennung

> ## Amendment 2026-05-31 — Realität weicht ab (Monorepo) + offener Visibility-Punkt
>
> Die hier beschlossene **3-Repo-Trennung wurde nie ausgeführt.** Faktischer Stand:
>
> - **Monorepo** `yannikits/MSP-Cockpit` (umbenannt von `Claude-portable`/`Claude-OS`).
>   Core **und** alle MSP-Bridges (TANSS, Veeam, Sophos, Securepoint, NinjaOne) liegen
>   direkt in `src/domains/` desselben Repos. Kein separates `claude-os-msp`, kein
>   `house-watch`. `ARCHITECTURE.md` §2 trägt den Drift-Hinweis bereits seit 2026-05-30.
> - Diese Konsolidierung ist **bewusst akzeptiert** — Solo-Dev, koordinierte Cross-Repo-PRs
>   und Drei-Klon-Setup wogen schwerer als der Trennungs-Nutzen (siehe "Negativ" unten,
>   die Punkte sind eingetreten).
>
> **Offener Punkt (nicht abgeschlossen, Entscheidung Yannik):** Das Monorepo ist aktuell
> **PUBLIC**. Das widerspricht dem *Kern-Treiber* dieser ADR (MSP-Code aus der öffentlichen
> Git-History fernhalten, SECURITY.md §6.3). Schweregrad-Kalibrierung (2026-05-31):
>
> - **Committed:** ausschließlich Code (Bridge-Clients, Mapper, Schemas, Reader-Logik) →
>   exponiert *Wettbewerbs-Wissen* (welche Vendors, wie integriert).
> - **Nicht committed:** keine Customer-Config (kein `customers/*.json|yaml` getrackt),
>   `.env`-Secrets sind gitignored, keine Credentials in der History gefunden.
> - Es ist also **kein akuter Customer-Daten-/Credential-Leak**, aber eine bewusste
>   ADR-Verletzung, die eine explizite Entscheidung braucht:
>   **(a)** Repo auf privat stellen (stellt den ADR-0030-Treiber wieder her), **oder**
>   **(b)** Public bewusst akzeptieren (MSP-Integration als OSS-Referenz) — dann diese ADR
>   formal auf "Abgelöst" setzen und SECURITY.md §6.3 entsprechend anpassen.
>
> Bis zur Entscheidung bleibt der Rest dieser ADR als *historischer Kontext* stehen.

## Kontext

Drei Komponenten mit unterschiedlichen Sichtbarkeits-Anforderungen:

1. **Claude-OS-Core** (Sidecar, Vault-Sync, MCP, Tauri-GUI, Auth, Catalog) — generic, OSS-tauglich
2. **MSP-Bridges** (TANSS, NinjaOne, Veeam, M365, Securepoint) — Wettbewerbs-Wissen + Customer-Daten-Risiko
3. **House-Watch** (Immobilien-Crawler) — privater Use-Case ohne MSP-Bezug

## Entscheidung

**Drei Repos mit klarer Dependency-Richtung.**

```
yannikits/Claude-portable    public,  MIT          → Core: Tauri-Shell, Sidecar, MCP, Vault, Skills
yannikits/claude-os-msp      private, proprietär   → TANSS/Ninja/Veeam/M365/Securepoint
yannikits/house-watch        private, proprietär   → Immobilien-Crawler
```

**Dependency-Direction:**

```
claude-os-msp  ──depends-on──>  Claude-portable
house-watch    ──depends-on──>  Claude-portable
```

Niemals umgekehrt. Der Public-Core kennt MSP-Bridges nur als optionale, dynamisch geladene Plugins.

### Plugin-Mechanismus

MSP-Bridges registrieren sich beim Core über die MCP-Tool-Registry (ADR-0007 + ADR-0016) — keine Build-Time-Abhängigkeit. Der Core ruft sie wie jedes andere MCP-Tool auf.

### Verteilung an Yannik

- Claude-OS-Core: Tauri-Bundle (öffentlich, GitHub-Release)
- MSP-Bridges: privates npm-Tarball oder Git-Submodule in Yanniks lokalem Setup
- House-Watch: privates Repo + eigener lokaler Build

### Übergangsplan

1. Aktuelles `Claude-portable` (public) bleibt der Core
2. `claude-os-msp` als neues privates Repo, sobald MSP-Phase startet (Phase 6)
3. `house-watch` als neues privates Repo, sobald House-Phase ansteht (Phase 9+)
4. Im Public-Core: `examples/`-Ordner mit minimalem „Plugin-Pattern"-Demo (keine echten Bridges)

## Konsequenzen

**Positiv**

- MSP-Code bleibt aus Public-Git-History fern (keine versehentlichen Commits)
- House-Watch ist komplett separiert — keine MSP-Customer-Verschmutzung im selben Repo
- Setup-Anleitung wird klarer: User installiert Core, optional MSP-Plugins
- OSS-Sichtbarkeit ohne Customer-Risiko

**Negativ**

- Mehrere Repos zu pflegen — Renovate hilft mit Dep-Updates
- Setup-Aufwand steigt: drei Clone-Operationen statt eine
- Cross-Repo-Refactors brauchen koordinierte PRs

## Alternativen verworfen

- **Mono-Repo public mit MSP-Verzeichnis in `.gitignore`:** versehentliche Commits zu riskant
- **Alles in einem privaten Repo:** verschenkt Public-Sichtbarkeit
- **Submodule statt separate Repos:** UX-feindlich, eingebettete `.gitmodules`-Verwaltung
- **Gitea selbst-hosten:** Ops-Last für Solo-Dev zu hoch

## Quellen

- ADR-0007 (MCP-Bundle-per-Domain — Plugin-Pattern-Vorbild)
- ADR-0016 (MCP-Single-Server-Bridge — Tool-Registry)
- ADR-0029 (Lizenz — MIT public, proprietär privat)
- SECURITY.md §6.3 (Customer-Daten-Schutz)
