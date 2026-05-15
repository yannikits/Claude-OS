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

## Format

Jede ADR folgt der knappen Nygard-Variante:

- **Status** — `Vorgeschlagen` | `Akzeptiert` | `Verworfen` | `Abgelöst durch ADR-XXXX`
- **Kontext** — was das Problem ist
- **Entscheidung** — was wir wählen
- **Konsequenzen** — was sich daraus ergibt (positiv und negativ)
- **Alternativen** — was wir verworfen haben und warum
- **Quellen** — Referenzen
