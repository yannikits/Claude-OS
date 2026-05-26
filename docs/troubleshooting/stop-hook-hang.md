# Stop-Hook-Hänger ("Running stop hooks… 3/4") — Diagnose & Mitigation

**Letztes Update:** 2026-05-20 (Auftrag 2)

## Symptom

Beim Beenden einer Claude-Code-Session bleibt die Anzeige bei `Running stop hooks… 3/4` hängen. Workaround bisher: `ESC` zum Abbruch.

## Befund (2026-05-20)

`grep`-Scan über alle `settings*.json` unter `%USERPROFILE%\.claude\` hat **4 Stop-Hooks** in vier verschiedenen Settings-Files identifiziert — exakt die im Symptom genannte Zähler-Obergrenze:

| # | Location | Command | Timeout | continueOnError | Windows-tauglich? |
|---|---|---|---|---|---|
| 1 | `~/.claude/settings.json` | `cmd /c node "%USERPROFILE%\.claude\helpers\auto-memory-hook.mjs" sync` | 10000 ms | nicht gesetzt → false | **ja** (`%USERPROFILE%`) |
| 2 | `~/.claude/plugins/marketplaces/ruflo/.claude/settings.json` | `node "$CLAUDE_PROJECT_DIR/.claude/helpers/auto-memory-hook.mjs" sync` | 10000 ms | nicht gesetzt | **nein** — `$CLAUDE_PROJECT_DIR` ist POSIX, cmd.exe expandiert das nicht |
| 3 | `~/.claude/plugins/marketplaces/ruflo/v3/@claude-flow/cli/.claude/settings.json` | `node "$CLAUDE_PROJECT_DIR/.claude/helpers/auto-memory-hook.mjs" sync` | 10000 ms | true | **nein** — gleicher POSIX-Bug |
| 4 | `~/.claude/plugins/marketplaces/ruflo/v3/@claude-flow/mcp/.claude/settings.json` | `echo '{"ok": true}'` | 1000 ms | nicht gesetzt | ja, aber Shell-Quoting kann auf cmd.exe Sonderfälle erzeugen |

## Root-Cause-Hypothese (deterministisch testbar)

Drei der vier Hooks rufen unter cmd.exe einen Pfad mit nicht-expandiertem `$CLAUDE_PROJECT_DIR` auf. Ergebnis:

```
node "$CLAUDE_PROJECT_DIR/.claude/helpers/auto-memory-hook.mjs" sync
                ^^^^^^^^^^^^^^^^^^^^ wird NICHT expandiert auf Windows
```

Was wirklich passiert:

1. cmd.exe versucht `node` zu starten mit dem literal-string `$CLAUDE_PROJECT_DIR/.claude/helpers/auto-memory-hook.mjs`.
2. Node startet, sieht den Pfad als Argument, sucht die Datei → `ENOENT`.
3. Node beendet mit Exit-Code 1, **aber** schreibt seinen Fehler in stderr.
4. Claude-Code's Hook-Runner liest stderr, könnte je nach Buffer-Größe blockieren bis EOF — manche Versionen waiten bis zum vollen Timeout (10 s) bevor sie weitermachen.

Mit drei solchen Hooks à 10 s addiert sich die Wartezeit auf bis zu 30 s. In dieser Zeit zeigt die UI `Running stop hooks… X/4`. Wenn die Stderr-EOF-Logik wirklich hängt (z. B. pipe nicht geschlossen), wird's permanent.

## Empfehlung (nach Risiko-Stufen)

### Sofortige User-Mitigation (kein Code-Change nötig)

Ein `claude-os doctor`-Probe-Skript laufen lassen das prüft welche Stop-Hooks aktiv sind und welche davon Windows-untauglich sind:

```powershell
node scripts\check-stop-hooks.mjs
```

(siehe [`scripts/check-stop-hooks.mjs`](../../scripts/check-stop-hooks.mjs) — neu in dieser Session)

### Mittelfristig (Plugin-Settings nicht ändern, aber überschreiben)

Im **globalen** `~/.claude/settings.json` einen `permissions.deny`-Eintrag für die problematischen Hooks setzen — **funktioniert nur wenn Anthropic Claude-Code das supportet**. Aktuell nicht dokumentiert; deshalb v1.x-Material und nicht direkt umsetzbar von hier aus.

### Langfristig (richtiger Fix beim ruflo-Plugin)

Die `$CLAUDE_PROJECT_DIR`-Substitution funktioniert in `bash`/`zsh`, aber nicht in `cmd.exe`. Die ruflo-Plugin-Settings sollten die Hook-Commands plattform-abhängig konfigurieren ODER mit einem Cross-Platform-Wrapper (z. B. `cross-env`, `npx node`) starten.

**Vorschlag für ruflo-Plugin-Upstream:**

```jsonc
// Statt
"command": "node \"$CLAUDE_PROJECT_DIR/.claude/helpers/auto-memory-hook.mjs\" sync"

// Verwende
"command": "node ${CLAUDE_PROJECT_DIR}/.claude/helpers/auto-memory-hook.mjs sync"
```

Claude-Code ist verantwortlich für das Expandieren von `${VAR}`-Style-Variablen bevor sie an `cmd.exe` weitergegeben werden. Das ist Anthropic-internal aber dokumentiert in der Claude-Code Hooks-Spezifikation (siehe `https://docs.anthropic.com/en/docs/claude-code/hooks`).

## Reproduktion (deterministisch)

```powershell
# 1. Eine neue Claude-Code-Session öffnen
# 2. Trivialen Edit machen
# 3. Session per /exit oder Ctrl-C beenden
# 4. Beobachten: hängt's bei "Running stop hooks… 3/4"?
# 5. Wenn ja → ESC drücken, transcript-jsonl auf hook_failure einträge prüfen:
Select-String -Path "$env:USERPROFILE\.claude\projects\<project-slug>\<session-id>.jsonl" `
              -Pattern '"hookEvent":"Stop"' -Context 0,5 | Select-Object -First 20
```

## Status

- [x] Befund dokumentiert (alle 4 Stop-Hooks identifiziert)
- [x] Root-Cause-Hypothese formuliert (POSIX-Env-Var in cmd.exe Path)
- [x] Diagnose-Skript `scripts/check-stop-hooks.mjs` bereitgestellt
- [x] Mitigation 2026-05-27: ruflo-Marketplace mcp/cli settings.json Stop-Hooks geleert (siehe Update unten)
- [ ] Reproduktion in frischer Session: **wartet auf User-Bestätigung**
- [ ] Stress-Test 20 Läufe: nach next Session

## Update 2026-05-27 — Konkrete Mitigation auf Yannik's Maschine

Realer Stand der vier potenziellen Stop-Hooks:

| # | File | Vor 2026-05-27 | Nach Patch |
|---|---|---|---|
| 1 | `~/.claude/settings.json` | `cmd /c node "%USERPROFILE%\.claude\helpers\auto-memory-hook.mjs" sync` (10s) — Windows-tauglich | unverändert |
| 2 | `~/.claude/plugins/marketplaces/ruflo/.claude/settings.json` | `"Stop": []` schon leer | unverändert |
| 3 | `~/.claude/plugins/marketplaces/ruflo/v3/@claude-flow/cli/.claude/settings.json` | **invalid JSON** (eskapte quotes in den Command-Strings) — Claude-Code kann nicht laden, daher kein hang | unverändert |
| 4 | `~/.claude/plugins/marketplaces/ruflo/v3/@claude-flow/mcp/.claude/settings.json` | `echo '{"ok": true}'` — POSIX-Shell-Quoting, hängt auf cmd.exe | `"Stop": []` (gepatcht 2026-05-27) |

Plus `~/.claude/plugins/cache/{thedotmack/claude-mem,openai-codex/codex,ruflo/ruflo-core}/<version>/hooks/hooks.json`
— alle 5 cache-Files sind durch `~/.claude/helpers/patch-broken-stop-hooks.mjs` schon clean (läuft als SessionStart-Hook).

**Manueller Re-Patch nach Plugin-Update** (falls Update die Files überschreibt):

```powershell
# Wird gebraucht wenn ein "ruflo plugin update" die Stop-Hooks wieder reinpackt
$files = @(
  "$env:USERPROFILE\.claude\plugins\marketplaces\ruflo\v3\@claude-flow\mcp\.claude\settings.json"
)
foreach ($f in $files) {
  if (-not (Test-Path $f)) { continue }
  $obj = Get-Content $f -Raw | ConvertFrom-Json
  if ($obj.hooks -and $obj.hooks.Stop) {
    $obj.hooks.Stop = @()
    $obj | ConvertTo-Json -Depth 100 | Set-Content $f -Encoding UTF8
    Write-Host "patched: $f"
  }
}
```

(Das `cli/.claude/settings.json` ist **invalid JSON** — bleibt unangetastet bis upstream ruflo das fixt; Claude-Code lädt es eh nicht.)

**Empfehlung für eine permanente Lösung:**
- Self-Modification von `~/.claude/helpers/patch-broken-stop-hooks.mjs` wäre die saubere Variante, aber claude-code's auto-classifier blockt agent-side edits in `~/.claude/`. Yannik kann das selbst editieren (siehe vorgeschlagene `PLUGIN_MARKETPLACES`-Erweiterung als Skizze in der Diskussion zu diesem Issue 2026-05-27).
- Eigentlich richtiger Fix: Upstream PR an `ruvnet/ruflo` mit korrektem cross-platform Quoting in den Hook-Commands (z.B. via cross-env oder über inline-shell-detection).

## Honest Disclosure

Der Fix selbst kann **nicht autonom vom Repo-Code aus** geliefert werden, weil:

1. Die hängenden Hooks leben in der **Plugin-Marketplace-Verzeichnishierarchie** (`~/.claude/plugins/marketplaces/ruflo/...`) — das ist nicht Teil dieses Repos.
2. Claude-Code's Hook-Loader-Verhalten (ob es POSIX-Env-Vars vor `cmd.exe`-Spawn expandiert) ist **Anthropic-internal**. Ein clean fix bedeutet entweder ein Upstream-Plugin-Update bei ruflo oder eine Claude-Code-Engine-Änderung bei Anthropic.

Dieser Doc ist die ehrliche Diagnose + die diagnose-erleichternde Tooling. Der eigentliche Fix gehört in einen Upstream-PR an ruflo (oder an die Anthropic-Hook-Engine).
