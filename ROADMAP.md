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

## Ist-Stand (per Gemini-Audit 2026-05-24)

**Bereits gebaut:**
- Repo-Skeleton, `package.json`, CI (`.github/workflows/ci.yml`)
- Biome + Vitest konfiguriert
- `AGENTS.md`, `tasks/todo.md`, `tasks/lessons.md`
- CLI-Skeleton via Commander (`src/cli/index.ts`, `claude-os.cmd`)
- Claude-Bridge in `src/domains/claude-bridge/`
- Vault-Sync-Domain (teilweise) in `src/domains/vault-sync/`
- MCP-Integration (`src/mcp/`)
- Tauri-Sidecar (`src/sidecar/`)
- Tauri-Bundle-CI für MSI/DMG

**Noch nicht gebaut:**
- `SOUL.md`, `TOOLS.md` (Root-Level)
- FTS5-Index für Vault
- Provider-Abstraktion (nur direkt-Anthropic vorhanden)
- Multi-Workspace-Vault-Layer
- MSP-Bridges (separates privates Repo, Phase 6)
- Skill-Auto-Promotion
- House-Watch (separates privates Repo, Phase 9+)

## Phasen

| Phase | Inhalt | Status | DoD |
|---|---|---|---|
| **0 — Bootstrap** | Repo, CI, Lint, Test, Tauri-Bundle | weitgehend done | `npm run build` grün, Biome+Vitest sauber, CI grün auf Windows |
| **1 — Claude-Bridge stabilisieren** | Subprocess-Spawn-Lifecycle, Heartbeat-Logging, Secrets-Leak-Prevention, PTY-Pfad-Audit (ADR-0003 + ADR-0021 Implementation) | done (2026-05-24, Audit-Trail in `tasks/todo.md` §Phase 1 Stabilisierung) | Stream-Pass-Through via `stdio:'inherit'` — by-design kein Buffer-Hang, **kein** Wrapper-Timeout (Memory 569/577/578); 180s-Long-Running-Regression-Test in nightly CI; node-pty Sideload-Pattern auditiert (ADR-0021) |
| **2 — Memory MVP** | Vault-Sync (Multi-Workspace, ADR-0031), Linear-Scan-Retrieval, Note-Write mit Frontmatter | teilweise | MVP-Workflow durchläuft End-to-End in Vitest + manuellem GUI-Test |
| **3 — Memory FTS5** | SQLite-Index, watchdog-Trigger, Workspace-scoped Top-K-Ranking (ADR-0025) | offen | Cross-Session-Recall über 3 Sessions; Index-Failure degradiert sauber |
| **4 — Skill-Engine** | Skill-Loader, Description-Matching, Workspace-Path-Resolution | offen | 3 User-Skills funktional eingebunden, malicious SKILL.md sicher abgewiesen |
| **5 — Self-Improvement** | Lessons-Auto-Promotion zu Skill-Drafts, Sandbox, Review-Gate (ADR-0026) | offen | Auto-Vorschlag entsteht, läuft erst nach Yannik-Approval scharf |
| **6 — MSP-Bridges (Read-Only)** | TANSS/Ninja/Veeam (ADR-0027, separates Private-Repo per ADR-0030) | offen | Audit-Log pro API-Call, Schema-validiert, kein Write-Pfad |
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
