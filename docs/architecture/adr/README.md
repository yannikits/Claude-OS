# Architecture Decision Records

Dokumentiert die fundamentalen Architektur-Entscheidungen für die Evolution von `claude-portable` zu **Claude Develop Environment OS**.

## Index

| ID | Titel | Status | Datum |
|----|-------|--------|-------|
| [0001](0001-gui-framework-tauri.md) | GUI-Framework: Tauri 2.x | Akzeptiert | 2026-05-15 |
| [0002](0002-cloud-mount-data-placement.md) | Cloud-Mount: nur Plain-Text, Git und SQLite extern | Akzeptiert | 2026-05-15 |
| [0003](0003-hybrid-cli-with-claude-exe-delegation.md) | Hybrid-CLI mit Delegation an Anthropic-`claude.exe` | Akzeptiert | 2026-05-15 |
| [0004](0004-secrets-via-napi-rs-keyring.md) | Secrets via `@napi-rs/keyring`, nicht `keytar` | Akzeptiert | 2026-05-15 |
| [0005](0005-selective-merge-update-pattern.md) | Selective-Merge-Update-Pattern (claudesidian-inspiriert) | Akzeptiert | 2026-05-15 |
| [0006](0006-tauri-node-sidecar-ipc.md) | Tauri ↔ Node-Sidecar IPC: Long-lived JSON-RPC über stdin/stdout | Akzeptiert | 2026-05-15 |
| [0007](0007-mcp-bundle-per-domain-deferred.md) | MCP-Bundle pro Domain (Deferred to v1.1) | Akzeptiert (Deferred) | 2026-05-15 |
| [0008](0008-git-backend-simple-git.md) | Git-Backend für v1: `simple-git` (System-Git-Wrapper) | Akzeptiert | 2026-05-15 |
| [0009](0009-artefact-source-model-dual-mode.md) | Artefakt-Quellen-Modell: Dual-Mode + Lock-File | Akzeptiert | 2026-05-15 |
| [0010](0010-capability-based-plugin-deps.md) | Plugin-Deps via Capabilities, nicht npm-Peer-Deps | Akzeptiert | 2026-05-15 |
| [0011](0011-anthropic-cli-auth-integration.md) | Anthropic-CLI Auth-Integration (State-Check, Refresh-Mutex, Multi-Profile) | Akzeptiert | 2026-05-15 |
| [0012](0012-schema-validation-typebox.md) | Schema-Validation mit TypeBox (statt zod) | Akzeptiert | 2026-05-15 |
| [0013](0013-logging-pino.md) | Strukturiertes Logging mit pino (Redaction, Rotation, Tauri-Stderr-Mirror) | Akzeptiert | 2026-05-16 |
| [0014](0014-code-quality-biome.md) | Code-Quality-Toolchain: biome mit ESLint-Hybrid-Escape | Akzeptiert | 2026-05-16 |
| [0015](0015-plugin-binding-resolution.md) | Plugin-Binding-Resolution (Phase 5o) | Akzeptiert | 2026-05-20 |
| [0016](0016-mcp-single-server-bridge.md) | MCP-Single-Server-Bridge (v1.4) | Akzeptiert | 2026-05-20 |
| [0017](0017-chat-view-mvp-line-buffered.md) | Chat-View-MVP über line-buffered `child_process` (v1.2) | Akzeptiert | 2026-05-20 |
| [0018](0018-appimage-zsync-self-update.md) | AppImage Self-Update via zsync (v1.3) | Akzeptiert | 2026-05-20 |
| [0019](0019-sidecar-background-services.md) | Sidecar Background-Services-Pattern (v1.5/v1.7) | Akzeptiert | 2026-05-20 |
| [0020](0020-auto-deps-fixed-point-resolution.md) | Auto-Deps Fixed-Point-Resolution (v1.5) | Akzeptiert | 2026-05-20 |
| [0021](0021-pty-upgrade-xterm-node-pty.md) | Full-TTY Chat-View via node-pty + xterm.js (v1.x) | Akzeptiert | 2026-05-21 |
| [0022](0022-gui-auth-and-secrets-mutation.md) | GUI Anthropic-Login + Profile-Switch + Secrets-Edit (v1.x.+1) | Akzeptiert | 2026-05-22 |
| [0023](0023-profile-crud-and-native-password.md) | GUI Profile-Create/Delete + Native Password-Input (v1.x.+2) | Akzeptiert | 2026-05-22 |
| [0024](0024-mcp-trust-prompt-model.md) | MCP-Server Trust-Prompt-Model (M3) | Akzeptiert | 2026-05-23 |
| [0025](0025-memory-indexing-fts5.md) | Memory-Indexierung via FTS5 in SQLite | Akzeptiert (Konzept) | 2026-05-24 |
| [0026](0026-skill-auto-promotion-lifecycle.md) | Skill-Auto-Promotion Lifecycle (draft → quarantined → reviewed → active) | Akzeptiert (Konzept) | 2026-05-24 |
| [0027](0027-msp-bridge-permission-model.md) | MSP-Bridge Permission-Modell (Read-Only Phase 6, Write Phase 7 mit Approval-Gate) | Akzeptiert | 2026-05-24 |
| [0028](0028-tauri-updater-windows-macos.md) | Tauri-Updater für Windows + macOS Self-Update (ergänzt ADR-0018 Linux) | Akzeptiert (Konzept) | 2026-05-24 |
| [0029](0029-license-mit-public-core.md) | Lizenz: MIT für Public-Core, proprietär für Private-Repos | Akzeptiert | 2026-05-24 |
| [0030](0030-repo-strategy-hybrid.md) | Repo-Strategie: Hybrid Public-Core + Private MSP/House | Akzeptiert | 2026-05-24 |
| [0031](0031-vault-multi-workspace.md) | Vault-Strategie: Multi-Workspace mit `personal/` als Default | Akzeptiert | 2026-05-24 |
| [0032](0032-server-deployment-headless-http.md) | Server-Deployment: Headless HTTP-Variante | Akzeptiert | 2026-05-26 |
| [0033](0033-server-multi-user-token-list.md) | Server Multi-User Stage 1 (Token-Liste) | Akzeptiert | 2026-05-26 |
| [0034](0034-skill-sandbox-process-isolation.md) | Skill-Sandbox via `child_process.fork` | Akzeptiert | 2026-05-27 |
| [0035](0035-signing-ed25519-foundation.md) | Yannik-Ed25519-Signatur-Flow (Foundation) | Akzeptiert | 2026-05-27 |
| [0036](0036-multi-user-stage-2-email-password.md) | Server Multi-User Stage 2 (Email/Passwort + Session-Cookies) | Akzeptiert | 2026-05-28 |
| [0037](0037-audit-trail-dashboard.md) | Audit-Trail-Dashboard (Read-only Web-UI über JSONL-Audit) | shipped | 2026-05-29 |
| [0038](0038-msp-health-foundation.md) | MSP-Health-Foundation (Customer-Repo + Bridge-Interface) | shipped | 2026-05-29 |
| [0039](0039-tanss-read-bridge.md) | TANSS Read-Bridge (Phase 7-B) | shipped | 2026-05-29 |
| [0040](0040-veeam-read-bridge.md) | Veeam Read-Bridge (per-customer VBR, Phase 7-C) | shipped | 2026-05-29 |
| [0041](0041-msp-health-aggregate-dashboard.md) | MSP-Health Aggregat-Dashboard (Phase 7-E) | shipped | 2026-05-29 |
| [0042](0042-sophos-read-bridge.md) | Sophos XG/XGS Read-Bridge (Phase 7-D) | shipped | 2026-05-30 |
| [0043](0043-securepoint-read-bridge.md) | Securepoint USC Read-Bridge (Phase 7-D.2) | shipped | 2026-05-30 |

## Format

Jede ADR folgt der knappen Nygard-Variante:

- **Status** — `Vorgeschlagen` | `Akzeptiert` | `Verworfen` | `Abgelöst durch ADR-XXXX`
- **Kontext** — was das Problem ist
- **Entscheidung** — was wir wählen
- **Konsequenzen** — was sich daraus ergibt (positiv und negativ)
- **Alternativen** — was wir verworfen haben und warum
- **Quellen** — Referenzen
