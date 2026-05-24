# Environment-Konfiguration (`.env`)

claude-os liest per-machine-Konfiguration aus `.env` im Repo-Root (alternativ `<claude-os-root>/.env`). Die Datei ist in `.gitignore` und bleibt **lokal** — sie enthält maschinen-spezifische Pfade und (potenziell) Secrets.

## Erstellen

Lege im Repo-Root eine Datei `.env` an mit den unten beschriebenen Variablen. Es gibt kein `.env.example` (per deny-policy für dotfiles im Setup) — diese Doku ist die Vorlage.

## Variablen

### `CLAUDE_OS_VAULT_PATH` (Pflicht für Memory-Befehle)

Absoluter Pfad zum Obsidian-Vault-Root (per ADR-0031). Workspaces leben unter:

```
<CLAUDE_OS_VAULT_PATH>/Claude-OS/workspaces/<workspace-id>/
```

Beispiele:

```dotenv
# Windows (OneDrive)
CLAUDE_OS_VAULT_PATH=D:\OneDrive\Obsidian Vault

# POSIX
CLAUDE_OS_VAULT_PATH=/home/yannik/Obsidian/Vault
```

Optional für install-only Befehle (`doctor`, `ai`, `secrets`, …) — diese funktionieren ohne `CLAUDE_OS_VAULT_PATH`.

### `CLAUDE_OS_DEFAULT_WORKSPACE` (Optional)

Default-Workspace beim Start. Ohne Setting nutzt claude-os `personal` (ADR-0031). Erlaubte Formen:

```dotenv
CLAUDE_OS_DEFAULT_WORKSPACE=personal
CLAUDE_OS_DEFAULT_WORKSPACE=msp-internal
CLAUDE_OS_DEFAULT_WORKSPACE=msp-customers/acme-gmbh
```

## Resolution-Order

`.env`-Datei wird in dieser Reihenfolge gesucht:

1. Explicit `envFilePath`-Argument (nur in Tests)
2. `<claude-os-root>/.env` (Root via `CLAUDE_OS_ROOT` env oder `.claude-os-root`-Marker)
3. `process.cwd()/.env` (als Fallback wenn 1 + 2 fehlen)

Fehlende `.env` ist **kein Fehler** — Env-Variablen können auch extern gesetzt sein (CI, shell-export, system env).

## Verwandte Configs

- `CLAUDE_OS_ROOT` — install-tree (ADR-0002, getrennt von `CLAUDE_OS_VAULT_PATH`)
- `CLAUDE_OS_DATA_DIR` — per-machine data dir (default `%APPDATA%/claude-os/`, `~/.config/claude-os/`)
- `CLAUDE_OS_PORTABLE=1` — aktiviert portable-fallback wenn kein Root resolved werden kann
- `ANTHROPIC_CONFIG_DIR` — Multi-Profile-Auth-Sandbox (ADR-0011)
- `CLAUDE_OS_SECRETS_BACKEND` — `keyring` (default) oder `file` (für Sidecar/CI)

Alle weiteren werden direkt aus `process.env` gelesen, nicht aus `.env`.
