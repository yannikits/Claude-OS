# Claude OS — Roadmap

Phasen sind sequenziell. Phase überspringen nur via ADR in `tasks/adr/`. Definition of Done (DoD) ist objektiv prüfbar.

## MVP — "Was kann Yannik an Tag 1?"

> **MVP-Workflow:** Yannik öffnet die Claude-OS-Tauri-GUI im Default-Workspace `personal`, tippt eine Aufgabe ein. Claude-OS lädt relevante Notes aus dem Obsidian-Vault (Top-K via FTS-Suche, workspace-scoped), schickt Prompt + Context an Anthropic, Yannik sieht die Antwort, kann sie als neue Note speichern (mit Frontmatter + Klassifikation). Nächste Session findet die Note via Recall wieder.

**MVP-DoD:**
- [ ] Tauri-GUI öffnet sich, zeigt Eingabefeld + Workspace-Indicator
- [ ] Vault-Path aus `.env` gelesen, Verbindung verifiziert, Default-Workspace `personal` aktiv
- [ ] Top-K-Retrieval läuft (initial Linear-Scan, FTS später)
- [ ] Prompt mit Context-Injection wird komponiert und an `bin/claude.exe` delegiert (ADR-0003 — kein eigenes Provider-Interface, kein eigenes API-Key-Management, kein hardgenageltes Modell. Modell-Auswahl liegt bei `claude.exe` selbst.)
- [ ] Response wird angezeigt
- [ ] "Speichern als Note" schreibt Markdown mit Frontmatter
- [ ] Recall in Folge-Session findet die Note

## Ist-Stand (per Status-Audit 2026-05-25)

**Phasen 0–6 als Code shipped** (alle als PRs offen, sequenziell/stacked mergen). 250+ neue vitest-cases, full-suite-stable, biome+tsc-clean auf jeder Phase. Siehe Phasen-Tabelle für PR-Mapping.

**Bereits in main:**
- Repo-Skeleton, `package.json`, CI (`.github/workflows/ci.yml`) inkl. nightly-slow-job für claude-bridge regression-guard
- Biome + Vitest konfiguriert
- `AGENTS.md`, `tasks/todo.md`, `tasks/lessons.md`
- CLI via Commander (`src/cli/index.ts`, `claude-os.cmd`)
- `src/domains/claude-bridge/` (Phase 1 stabilisiert, stdio:'inherit', kein Wrapper-Timeout)
- `src/domains/vault-sync/` (Phase 2 alt — branch-aware snapshot-sync)
- `src/domains/workspace/` (Phase 2a — Multi-Workspace per ADR-0031)
- `src/domains/notes/` (Phase 2b — frontmatter-validated Notes)
- `src/domains/retrieval/` (Phase 2c — BM25 linear-scan)
- `src/core/config/` (Phase 2a — `.env` loader)
- MCP-Integration (`src/mcp/`)
- Tauri-Sidecar (`src/sidecar/`)
- Tauri-Bundle-CI für MSI/DMG

**In offenen PRs (warten auf Merge):**
- `src/domains/ask/` + CLI `ask`/`save-note` (PR #142)
- GUI Memory-Page + sidecar-RPCs für workspace/notes/retrieval (PR #143)
- `src/domains/memory-index/` mit sql.js FTS4 + indexer + watcher + dispatcher (PRs #144–147)
- `src/domains/skills/` Skill-Engine-Loader + Matcher + CLI (PR #148)
- `src/domains/skill-lifecycle/` Foundation (lessons-reader + draft-generator) (PR #149)
- `src/core/audit/` + `src/domains/tenant/` Public-Core-Foundation für MSP (PR #150)

**Noch nicht gebaut:**
- `SOUL.md`, `TOOLS.md` (Root-Level)
- Phase 7 MSP-Bridges Write (approval-gate, ADR-0027 §Phase-7)
- Phase 8 GUI Polish (Tray, Auto-Update via Tauri-Updater, ADR-0028/0018) — **deprioritisiert 2026-05-27** zugunsten Web/Linux-Server-Distribution (siehe §"Distribution-Pivot 2026-05-27")
- Phase 9 Side-Skills (House-Watch, separates Private-Repo per ADR-0030)
- Phase-5-completion: Sandbox-Process-Isolation, Yannik-Signatur-Flow, Audit-Log-Format-Finalisierung
- MSP-Bridge-Impls (separates `claude-os-msp` per ADR-0030)

**Phase Web vollständig shipped (2026-05-27):** Headless-HTTP-Variante mit Web-UI ist Primary-Distribution. Siehe `tasks/phase-server-web.md`. Tauri-Desktop bleibt funktional als Sekundär-Distribution.

## Distribution-Pivot 2026-05-27

Yannik priorisiert die **Web-Anwendung mit Linux-Server-OS** als Primary-Distribution. Tauri-Desktop-Codesigning (macOS/Windows) ist damit niedrige Priorität — Signing kostet $99/y (Apple) + $200/y (OV-Cert), zahlt sich für den aktuellen Use-Case nicht aus.

**Folgen:**
- `tasks/todo.md` Phase 8a (macOS Codesigning + Notarization) und Phase 8b (Windows Authenticode-Signing) sind deprioritisiert. Re-Aufnahme nur wenn breitere Desktop-Distribution gewünscht wird.
- Phase 8e (Tag v1.3.0) wartete auf 8a/8b — bleibt damit offen. Web-Distribution shippt unter eigener Version (siehe `docker-compose.example.yml` Image-Tag).
- `docs/macos-gatekeeper.md` und `docs/windows-smartscreen.md` (geplant) bleiben als User-Workarounds dokumentiert; werden nicht aktiv obsoleted.
- Linux-Build-Pfad (ADR-0018 AppImage-zsync) bleibt aktiv, weil er die Desktop-Variante für Linux-Self-Hoster abdeckt.

## MSP-Cockpit-Pivot 2026-05-30

Yannik weitet das MSP-Health-Dashboard (read-only) zum **MSP-Operations-Cockpit** aus:
Automations-Engine (deterministisch, Claude nur Read/Suggest), TANSS-Write (Kommentar → Status),
NinjaOne-Bridge + Script-Trigger, RBAC (Viewer/Operator/Admin). Plan + DoD je Sub-Phase:
`tasks/phase-msp-cockpit.md` (Sub-Phasen MC-A..MC-I). Logische Fortsetzung von Phase 7 (MSP-Write).
Claude OS bleibt Kern, das Cockpit wird Flaggschiff-Modul (kein Identitätswechsel).

## Phasen

| Phase | Inhalt | Status | DoD |
|---|---|---|---|
| **0 — Bootstrap** | Repo, CI, Lint, Test, Tauri-Bundle | weitgehend done | `npm run build` grün, Biome+Vitest sauber, CI grün auf Windows |
| **1 — Claude-Bridge stabilisieren** | Subprocess-Spawn-Lifecycle, Heartbeat-Logging, Secrets-Leak-Prevention, PTY-Pfad-Audit (ADR-0003 + ADR-0021 Implementation) | done (2026-05-24, Audit-Trail in `tasks/todo.md` §Phase 1 Stabilisierung) | Stream-Pass-Through via `stdio:'inherit'` — by-design kein Buffer-Hang, **kein** Wrapper-Timeout (Memory 569/577/578); 180s-Long-Running-Regression-Test in nightly CI; node-pty Sideload-Pattern auditiert (ADR-0021) |
| **2 — Memory MVP** | Vault-Sync (Multi-Workspace, ADR-0031), Linear-Scan-Retrieval, Note-Write mit Frontmatter | **substantially shipped** (PRs #135 2a workspace, #136 2b notes, #140 2c retrieval, #141 2d docs, #142 2e CLI ask/save-note, #143 2f GUI memory) | MVP-Workflow End-to-End via CLI + GUI Memory-Page; 111 neue Tests; Variante B (claude.exe-Delegation per ADR-0003) statt direct Anthropic-API |
| **3 — Memory FTS5** | SQLite-Index, watchdog-Trigger, Workspace-scoped Top-K-Ranking (ADR-0025) | **substantially shipped** (PRs #144 3a scaffold, #145 3b indexer, #146 3c+3d+3e watcher+search+dispatcher, #147 3f sidecar service) | sql.js + FTS4 (statt FTS5 — sql.js-WASM-limitation, in schema.ts dokumentiert) + Phase-2c BM25-Scorer auf FTS-Kandidaten; failure-mode-fallback zu linear-scan via dispatcher; sidecar boot-tolerant wenn vault unkonfiguriert; 56 neue Tests |
| **4 — Skill-Engine** | Skill-Loader, Description-Matching, Workspace-Path-Resolution | **shipped** (PR #148) | Workspace-scoped SKILL.md Loader + BM25-Description-Matcher; `claude-os skills list/show/match` CLI; strict skill-name validation `/^[a-z0-9][a-z0-9_-]*$/` refuses malicious names auf Path-Layer (vor Read); 33 neue Tests |
| **5 — Self-Improvement** | Lessons-Auto-Promotion zu Skill-Drafts, Sandbox, Review-Gate (ADR-0026) | **foundation shipped** (PR #149); sandbox + signature + review-GUI gated per ADR-0026 §"Implementation Gated" | Public-Core-Foundation: lessons-reader + draft-generator + lifecycle-types + `_drafts/` bucket (Phase-4-Loader filtert via skill-name-regex automatisch raus). **OUT OF SCOPE im aktuellen Foundation-PR:** Sandbox-Process-Isolation, Yannik-Ed25519-Signatur-Flow (GUI), Audit-Log-Format-Finalisierung (SECURITY.md §4) |
| **6 — MSP-Bridges (Read-Only)** | TANSS/Ninja/Veeam (ADR-0027, separates Private-Repo per ADR-0030) | **public-core foundation shipped** (PR #150); bridge-impls leben in privatem `claude-os-msp` per ADR-0030 | Public-Core: AuditLogger (JSONL, per-UTC-day rotation, 0o600), TenantContext-Resolver + assertActiveTenant/assertNoActiveTenant guards mit descriptive CrossTenantAccessError/NoTenantContextError. Bridge-Impls (TANSS/Ninja/Veeam/M365/Securepoint) im private repo |
| **7 — MSP-Bridges (Write)** | Approval-Gate, Write-Operations (ADR-0027 §Phase-7) | offen | Approval-Token-Flow, Rollback-Pfad, Tenant-Isolation-Test grün |
| **8 — GUI Polish** | Tauri-Companion, Tray, Multi-Workspace-Switcher, Auto-Update (ADR-0028 für Win/Mac, ADR-0018 für Linux) | offen | macOS + Windows-Build verteilbar, Auto-Update funktioniert |
| **9 — Side-Skills (House-Watch etc.)** | Immobilien-Crawler (separates Private-Repo, konsumiert Public-Core) | offen | dedizierter Workspace, isoliert von MSP-Daten |

## Reihenfolge-Regeln

- Phase 1 (Claude-Bridge) **vor** Phase 2 (Memory MVP) — sonst kein AI-Call möglich
- Phase 3 (FTS5) **kann parallel** zu Phase 4 (Skills) laufen
- Phase 6 (MSP-Read) **erst nach** SECURITY.md finalisiert und ADR-0027 implementiert
- Phase 7 (MSP-Write) **niemals** ohne explizite, dokumentierte Yannik-Freigabe pro Bridge
- Phase 5 (Self-Improvement) **niemals** ohne Sandbox + Review (ADR-0026)

## Geschwindigkeits-Heuristik

- Phase 1+2 sollten in ≤ 2 Wochen MVP-tauglich sein
- Phase 6 frühestens, wenn Phase 0-5 stabil — sonst sind MSP-Tickets das mit dem höchsten Schadenspotential
- Bei Schleifen-Verhalten (Phase-Reset > 2× auf gleicher Phase): `three-brain`-Routing für Architektur-Review

## Was rausgefallen ist (gegenüber Original-Spec 2026-05-24)

- "Python 3.12 + uv + Electron + Typer" → ersetzt durch Ist-Stack TS+Tauri+MCP
- "Hetzner Cloud Phase 4+" → keine zentrale Cloud-Komponente. Cloud-Plan eigene ADR wenn relevant.
- "Multi-Channel Telegram/Signal/Slack Phase 4" → verschoben auf Phase 9+ als optionale Skills
- "macOS + Windows + Linux gleichermaßen" → Windows ist Primary (Yannik-Setup), macOS secondary, Linux best-effort
- "Identische Outputs bei Provider-Wechsel" → entfällt: kein Multi-Provider-Setup (ADR-0003 Delegation an claude.exe)
- "Modell-ID hardgenagelt (claude-opus-4-7)" → entfällt: Modell-Auswahl liegt bei claude.exe selbst

## Klärungspunkte abgehakt (ehemals Sec. 12 der Original-Spec)

| Frage | Entscheidung | ADR |
|---|---|---|
| Repo-Ort | Hybrid: Public-Core + Private-MSP + Private-House | ADR-0030 |
| Lizenz | MIT für Public-Core, proprietär für private Repos | ADR-0029 |
| GUI-Framework | Tauri 2.x | ADR-0001 |
| AI-Layer-Strategie | Delegation an claude.exe (kein eigenes Provider-Interface) | ADR-0003 |
| Vault-Strategie | Multi-Workspace mit `personal/` Default | ADR-0031 |
| House-Watch | Eigenes Private-Repo | ADR-0030 |

## Video-Insights (`I Replaced OpenClaw and Hermes...mp4`, 22 Min, 2026-05-24)

Volltext: `three-brain-out/2026-05-24-claude-os-spec/gemini-video.md`.

**Bestätigt unsere Entscheidungen** (keine Änderung nötig):
- 4-Layer-Memory-Topology (CLAUDE.md + AGENTS.md + SKILL.md + lessons.md) — bereits etabliert
- Obsidian-Vault als Source-of-Truth — `ARCHITECTURE.md` §5
- Skill-Loader-Pattern (Markdown-driven) — `ROADMAP.md` Phase 4
- Self-Improving braucht Sandbox+Review — ADR-003
- Modell-Routing statt hardcoded IDs — ADR-001

**Neue Patterns zum Übernehmen (priorisiert):**
| Pattern | Phase | Begründung |
|---|---|---|
| `loop`-Command für proactive Monitoring ("On-Call-Engineer") | Phase 4+ als Built-in oder Skill | Native Claude-Code-Feature, ersetzt externe Cron — passt zu Local-First |
| Self-Healing-Memory-Graph (JSON-LD über Vault-Notes) | Phase 3+ als Ergänzung zu FTS5 | Adressiert Context-Drift in großen Vaults; ADR vor Implementation |
| Mega-Prompt-Wizard für Workspace-Bootstrap | Phase 4+ als Onboarding-Skill | Reduziert Setup-Reibung beim Anlegen neuer Customer-Workspaces |

**Bewusst NICHT übernommen:**
| Pattern | Warum nicht |
|---|---|
| `--dangerously-skip-permissions` für Lights-out | Widerspricht `SECURITY.md` §6 MSP-Approval-Gates |
| SSH Fleet Propagation (Mac Mini als Server-Node) | Kein aktueller Need, Tauri ist Local-First |
| Telegram-Plugin "Pocket Claude" | Phase 9+ als optionaler Skill, nicht core (siehe Multi-Channel-Verschiebung oben) |

**Risiko-Hinweise aus dem Video** (übereinstimmend mit Codex-Review):
- Self-writing `learnings.md` ohne Sandbox = MSP-untragbar → unsere ADR-003 ist der Counter
- Stack-Drift zwischen Spec und Code = der Hauptpunkt unseres Splits
