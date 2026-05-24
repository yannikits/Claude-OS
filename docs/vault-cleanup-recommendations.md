# Vault-Cleanup nach Migration

Befund aus der Migration-Session (2026-05-24). Diese Punkte braucht eine kurze manuelle Sichtung von Yannik. Alle Empfehlungen sind reversibel — Backup-ZIP `vault-backup-20260524-201849.zip` liegt eine Woche neben dem Vault.

## 1. Orphan-File im `msp-customers/`-Root

**Datei:** `Claude-OS/workspaces/msp-customers/2026-03-25 - Veeam Console Installationsfehler auf Hyper-V.md`

**Inhalt-Analyse:**
- Markiert als `# ⚠️ VERALTET - Siehe: Veeam-B&R-Fehler-Lösungsmatrix`
- Generischer Veeam-Console-Installationsfehler auf Hyper-V — **kein Customer-spezifischer Bezug** im Text auffindbar
- Liegt im `msp-customers/`-Root statt in einem `<TANSS-ID>/`-Subfolder
- Hat folglich keine `workspace/tenant/classification`-Augmentation bekommen (das Skript scannt nur Subfolder)

**Empfehlung:** verschieben nach `Claude-OS/workspaces/msp-internal/` (allgemeine MSP-Tool-Doku ohne Customer-Bezug). Danach:

```powershell
pwsh ./scripts/augment-msp-frontmatter.ps1 -VaultPath "<vault>" -Execute
```

Der Augmenter weist dann `workspace: msp-internal` + `classification: operational` zu.

**Alternative:** wenn die Note doch zu einem konkreten Customer gehört, in den passenden `msp-customers/<id>/`-Folder verschieben und neu augmenten.

## 2. Mögliche Duplikate zwischen `personal/Archive/Deprecated/` und `msp-customers/<id>/`

Sieben Datei-Titel kommen in **beiden** Pfaden vor:

| Datei | msp-customers (sortiert) | personal/Claude-Knowledge/Archive/Deprecated |
|---|---|---|
| `2026-03-13 - SQL Server Anmeldefehler beheben.md` | 10011 Rukwid | ✓ |
| `2026-04-20 - SQL Server Anmeldefehler 18456 beheben.md` | 10011 Rukwid | ✓ |
| `2026-04-07 - Veeam Restore Points in Hyper-V löschen.md` | 10040 Bühle | ✓ |
| `2026-04-21 - Securepoint firewall Site-to-Site VPN Verbindungsproblem.md` | 10412 Grosso | ✓ |
| `2026-03-23 - Postfachmigration und Exchange-Konfiguration.md` | 10439 Graf+Klett | ✓ |
| `2026-03-31 - Firewall-Einrichtung und VPN-Konfiguration.md` | 10439 Graf+Klett | ✓ |
| `2026-03-25 - Veeam Console Installationsfehler auf Hyper-V.md` | (Orphan) | ✓ |

**Body-Hash-Check (ohne Frontmatter):** Alle 7 Paare unterscheiden sich um wenige Zeilen (typisch 4 Zeilen Differenz, 30-50 Byte Größenunterschied). Der semantische Inhalt scheint identisch zu sein — beide Versionen beginnen wortgleich mit dem `mine-obsidian` / claude-chat-Export-Header.

**Empfehlung:** die `personal/Claude-Knowledge/Archive/Deprecated/`-Versionen löschen, **wenn** sich nach Stichprobe in Obsidian bestätigt, dass sie tatsächlich derselbe Export sind. Die `msp-customers/<id>/`-Versionen sind die kanonischen (mit Workspace/Tenant/Classification-Frontmatter).

**Manueller Vergleich-Pfad:**
```powershell
# Diff einer Paarung
git diff --no-index `
  "<vault>\Claude-OS\workspaces\msp-customers\10011 - Elektrotechnik Rukwid GmbH\2026-03-13 - SQL Server Anmeldefehler beheben.md" `
  "<vault>\Claude-OS\workspaces\personal\Claude-Knowledge\Archive\Deprecated\2026-03-13 - SQL Server Anmeldefehler beheben.md"
```

(Vault ist nicht im git-Repo, deshalb `git diff --no-index` mit absoluten Pfaden.)

## 3. Backup-ZIP-Lebenszyklus

Backup liegt unter `C:\Users\reapertakashi\OneDrive - Privatperson\GitHub\vault-backup-20260524-201849.zip` (~1.9 MB, enthält die 4 Movables vor der Migration).

**Empfehlung:**
- Eine Woche behalten als Sicherheitsnetz
- Wenn nach 7 Tagen nichts fehlt → löschen (`Remove-Item <pfad>`)
- Wenn etwas fehlt → über die Rollback-Sektion in `docs/vault-migration-guide.md`

## 4. Strays am Vault-Root

Bereits erledigt (gelöscht am 2026-05-24). Hier nur zur Doku festgehalten, damit die Liste vollständig ist:

```
2, Diese, ­ƒÆí, Passe, Routing`, Skript    # alle 0-Byte, alle PowerShell-Redirection-Unfälle
```

Falls neue solche Files entstehen: der Vault-Migration-Script erkennt sie als `STRAY` im Dry-Run-Output.

## 5. Nicht-mehr-aktuelle Klärungspunkte

| Punkt | Status |
|---|---|
| Anthropic-API-Modell-ID setzen | **moot**: per ADR-0003 delegiert claude-os an `bin/claude.exe`, das die Modell-Auswahl intern verwaltet. Kein `CLAUDE_OS_MODEL`-Env-Var nötig. |

## Was nach diesem Cleanup aussteht

- Phase 1 (Claude-Bridge stabilisieren) per ROADMAP.md — ist Implementierungsarbeit, kein Cleanup
- Private Repos `claude-os-msp` und `house-watch` anlegen — sobald Phase 6 bzw. Side-Skills relevant werden
- AGENTS.md-Subagent-Definitionen unter `.claude/agents/<name>.md` schreiben — sobald konkrete Sub-Agent-Spawn-Patterns gebraucht werden
