# Lessons Learned — Claude Develop Environment OS

Cross-session Pattern-Sammlung. Wird nach jeder Korrektur ergänzt.

Format pro Eintrag:

```
## YYYY-MM-DD — Kurz-Titel
**Situation:** Was passiert ist
**Lektion:** Welches Verhalten ändert sich daraus
**Anwendung:** Wann und wo das relevant ist
```

---

## 2026-05-15 — /grill-me Wert vs. Implementations-Reflex

**Situation:** Im /grill-me wurde B4 = Electron mit Argument "Rust-Toolchain auf 3 Maschinen ist Wartungslast" entschieden. Researcher-Spike anschließend widerlegte das Argument (Rust ist nur Build-Zeit-Dep des Maintainers, Nutzer bekommen reines Binary).

**Lektion:** Grill-Recommendations basieren auf dem Wissensstand des Grills. Ein nachgelagerter Researcher-Spike darf — und soll — Recommendations korrigieren. Nicht zur Kosmetik degradieren ("nur als Risk-Log dokumentieren"), sondern in den Plan einarbeiten, bevor Code geschrieben wird.

**Anwendung:** Nach jedem /grill-me bei nicht-trivialen Tech-Stack-Entscheidungen einen Researcher als Plausibilitäts-Check spawnen. Der Mehrkostenaufwand (~100 s) ist verschwindend gering im Vergleich zu einer falschen Stack-Entscheidung.

---

## 2026-05-15 — Cloud-Sync != Replikations-Layer

**Situation:** Erstes Datenlayout-Design wollte SQLite und `vault/.git/` in den OneDrive-Mount legen. Researcher zeigte unbestreitbare Quellenlage zu Repo- und SQLite-Korruption.

**Lektion:** Cloud-Sync-Clients (OneDrive, Drive, Dropbox) sind File-by-File-Sync — sie kennen weder POSIX-Locks noch Git-atomare-Operationen. Was im Cloud-Mount liegt, muss tolerant gegen "wahllose Reihenfolge von File-Updates" sein. Append-only-Plain-Text ist sicher; relationale DBs und Git-Working-Trees sind es nicht.

**Anwendung:** Vor jedem Cloud-Mount-Design fragen: "Was passiert, wenn die Dateien einzeln und in falscher Reihenfolge auf einer anderen Maschine ankommen?" Wenn die Antwort "Korruption" ist → außerhalb des Mounts platzieren.

---

## 2026-05-15 — Bestehende Vault-Starter-Kits prüfen, statt Wheel neu erfinden

**Situation:** Phase 4 hatte ein `.skill-lock`-File als Lösung für "Auto-Pull überschreibt lokale Skill-Modifikationen" — eine binäre Lock/Unlock-Mechanik ohne Merge-Pfad. Beim Prüfen von Claudesidian (MIT-lizenziert) fanden wir ein ausgereifteres `/upgrade`-Pattern mit Backup, Diff-Review, Resumable-Checklist und Rollback. Das wurde als ADR-0005 übernommen.

**Lektion:** Bevor man eine Update-/Sync-/Konflikt-Mechanik selbst designt, lohnt sich ein 15-minütiger Look in 2–3 existierende Starter-Kits oder Tools in der gleichen Nische. Häufig haben die schon eine Lösung, die wir nicht neu erfinden müssen — und der Code ist oft MIT.

**Anwendung:** Vor jeder neuen Subsystem-Entscheidung (Update-Logik, Plugin-Manager, File-Watcher, Auth-Flow) eine Web-Recon auf 2–3 Production-Repos mit ähnlichem Scope laufen lassen. Das kostet 10–20 Minuten und spart Stunden Eigenentwicklung von Patterns, die bereits gelöst sind.

---

## 2026-05-15 — obsidian-git als gespartes Eigen-Design für Vault-Sync

**Situation:** Phase 2 (Vault-Sync) sollte mit fester Cron-Intervall-Strategie und in-memory Lock-File implementiert werden. Nach Researcher-Spike auf `Vinzent03/obsidian-git` (das exakt gleiche Problem in Production seit Jahren löst) übernommen: Idle-Detection statt Cron, persistenter busy-Flag in SQLite, 3-Modi-Conflict-Policy, gitignore-Default für `.obsidian/workspace*.json` (das ist die Haupt-Konflikt-Quelle bei Multi-Device-Setups). Ergebnis: 4 konkrete Plan-Verbesserungen ohne Eigen-Recherche-Aufwand zu den Edge-Cases.

**Lektion:** Bei jedem Subsystem-Design vor dem Schreiben fragen: "Welches existierende Tool löst genau dieses Problem in Production?" — und dann deren Lessons-Learned-Threads (Issues, Commit-Messages) anschauen. Spart Stunden bis Tage Eigen-Design plus Schmerzen mit Edge-Cases, die andere bereits aufgesammelt haben.

**Anwendung:** Vor jeder Sub-System-Phase (Vault-Sync, Update-Orchestrator, Drag-Drop-UI, Sidecar-IPC) eine 10-Minuten-Recon auf 1-2 vergleichbare Production-Repos. Issues-Tabs sind oft wertvoller als READMEs — dort stehen die schmerzhaften Edge-Cases.

---

## 2026-05-15 — Transport-Agnostic Domain-Interfaces als günstige v1.1-Investition

**Situation:** Bei MCP-Bundle-Pattern (ADR-0007) wurde entschieden, Implementation auf v1.1 zu verschieben. Aber damit das in v1.1 günstig wird, müssen Domain-Interfaces *heute schon* so designed sein, dass kein CLI-/Tauri-/MCP-Import in Domain-Code landet.

**Lektion:** Bei jedem Defer-auf-späteren-Release fragen: "Welche heutigen Code-Entscheidungen machen das spätere Feature günstig oder teuer?" — und die günstig-machenden Constraints **jetzt** einziehen, nicht erst in der späten Release. Domain-Reinheit (transport-agnostic) ist die teuerste Eigenschaft, die nachträglich nachgezogen werden muss.

**Anwendung:** Defer-Entscheidungen IMMER mit "Constraints für v1, damit v1.x günstig wird"-Sektion in der ADR begleiten. Sonst landet die Refactor-Last komplett in der späten Release.

---

## 2026-05-15 — Capability-Manifest schlägt npm-Peer-Deps für Plugin-Systeme

**Situation:** Plugin-Dependency-Auflösung über npm-peer-deps führte in claude-flow und ruflo zu einem Bug-Cluster (Memory 587–593, ruflo Issues #174, #1676). Plugin-Install scheitert, Module nicht resolvable, transitive Konflikte. Researcher-Spike fand zwei Pattern-Vorbilder: VSCode (Extension-Host-Isolation, keine npm-Deps zwischen Extensions) und das Capability-Manifest aus `levnikolaevich/claude-code-skills`. Beide nutzen deklarative Fähigkeits-Anforderungen statt Code-Imports.

**Lektion:** Wenn ein System mehrere "Erweiterungen" hat, deklariert jede Erweiterung **fähigkeitsbasierte** Anforderungen (`requires: ["mcp:filesystem"]`) statt npm-Modul-Anforderungen. Der Orchestrator matched gegen den installierten Katalog. Vermeidet die ganze peer-deps-Hölle und macht Erweiterungen echt isolierbar (jedes hat sein eigenes `node_modules`, kein Hoisting).

**Anwendung:** Bei jedem Plugin-/Extension-/Erweiterungs-Subsystem zuerst überlegen: "Was deklarieren die Erweiterungen über ihre Abhängigkeiten?" Wenn die Antwort "npm-Module" ist → Stop und auf Capability-Manifest umstellen. Regression-Tests müssen die Reproducer-Cases aus den ursprünglichen Bug-Berichten enthalten — sonst wandert das Problem nur eine Ebene tiefer.

---

## 2026-05-15 — Cloud-Sync-Mounts brauchen Polling-Fallback für File-Watcher

**Situation:** chokidar (Industry-Standard für File-Watching in Node) nutzt OS-native APIs (inotify/FSEvents/ReadDirectoryChangesW). Auf "Files On-Demand"-Cloud-Mounts (OneDrive Reparse-Points, Dropbox Smart Sync) liefern diese APIs unzuverlässige Events — manchmal komplett ohne Fehler. Issues paulmillr/chokidar #895/#998/#225 dokumentieren das seit Jahren.

**Lektion:** Bei File-Watchern auf Cloud-Sync-Pfaden NICHT auf native Events vertrauen. Auto-Detect Cloud-Pfade (Pfad-Prefix-Match) und auf `usePolling: true, interval: 2000` umschalten. Performance-Kosten sind akzeptabel (alle 2s ein readdir auf den geänderten Subtree); Zuverlässigkeit gewinnt deutlich.

**Anwendung:** Generell für FS-Watcher-Code: erst Pfad-Klasse erkennen (lokal vs. cloud vs. network-share), dann Strategie wählen. Default-Konfigurationen aus Tutorials sind für reine lokale FS-Operationen optimiert und brechen subtil auf Cloud-Mounts. Dasselbe Pattern gilt vermutlich für andere FS-watchende Tools (esbuild watch, vite watch, tsc --watch).

---

## 2026-05-15 — JSON-Schema-Pflicht ist eine frühe Stack-Entscheidung

**Situation:** Ursprünglich war zod als Schema-Validation-Lib implizit angenommen (Standard in 2026 Node-Ecosystem). Researcher zeigte, dass MCP-Protokoll JSON Schema Draft 2020-12 zwingend erfordert (MCP-TS-SDK #745 + SEP-1613) und zod-to-json-schema-Konvertierung lossy ist (Discriminated Unions, Refinements, Templates verlieren Semantik). Wechsel zu TypeBox jetzt kostet ~100 LOC Format-Wrapper; nachträglich von zod auf TypeBox migrieren wäre 10x teurer.

**Lektion:** Wenn eine Library-Wahl ein bestimmtes Output-Format (hier: JSON Schema Draft 2020-12) erfordern könnte, dann VOR der Implementation prüfen welche Libs das nativ liefern. Standard-Lib-Wahlen nach "was nutzen alle?" ohne diese Pflicht-Output-Frage sind eine bekannte Trap.

**Anwendung:** Bei jeder Library-Auswahl fragen: "Was ist das benötigte Output-Format dieser Daten in 6 Monaten?" — wenn die Antwort ein standardisiertes Schema ist (JSON Schema, Protobuf, GraphQL SDL, OpenAPI), nur Libs in die engere Wahl nehmen, die das nativ produzieren.

---

## 2026-05-16 — Vitest statt Jest in ESM/TypeScript-Projekten

**Situation:** Phase 1a hatte Jest in package.json (memory-zementierter Default aus dem 142h-Plan). Beim Aufsetzen von Phase 1b zeigte sich: Jest+ESM+TypeScript braucht `ts-jest/presets/default-esm`, `extensionsToTreatAsEsm`, `--experimental-vm-modules` Node-Flag plus plattformspezifische Cross-Env-Variablen für npm-Scripts. Drei Konfig-Dateien, mehrere Caveats. Vitest hat zero-config ESM+TS-Support, gleiche `describe/it/expect`-API (Drop-in für Jest-Tests), nutzt Vite-Toolchain die wir für Tauri-Frontend ohnehin brauchen werden.

**Lektion:** Für greenfield ESM+TypeScript-Projekte in 2026 ist Vitest die Default-Wahl, nicht Jest. Jest+ESM ist seit Jahren als "experimental" markiert und das Setup-Overhead ist real. Vitest-Migration ist trivial (gleiche API), Vitest-First-Setup ist trivial (10 Zeilen `vitest.config.ts`).

**Anwendung:** Wenn ein Plan eine Library-Default-Wahl trifft die später als suboptimal erkannt wird (hier: Jest), während des Implementings KORREKT entscheiden statt der Plan-Zementierung zu folgen. Plan-Updates dokumentieren (lessons.md + Commit-Begründung), nicht stillschweigend ändern.

---

## 2026-05-16 — Windows 8.3-Short-Names brauchen `realpathSync.native`

**Situation:** Migrator-Tests scheiterten an Post-Migration-Verifikation: `os.tmpdir()` retourniert `C:\Users\REAPER~1\AppData\Local\Temp` (8.3 short form), während Git in das gitfile die Long-Form `C:\Users\reapertakashi\AppData\Local\Temp` schreibt. Plain `fs.realpathSync` resolved Symlinks, expandiert aber NICHT 8.3-Short-Names — beide Pfade kamen unverändert raus, Vergleich schlug fehl.

**Lektion:** `fs.realpathSync(p)` ≠ `fs.realpathSync.native(p)` auf Windows. Die `.native`-Variante nutzt die OS-eigene Implementation (`GetFinalPathNameByHandle`) und expandiert sowohl Symlinks/Junctions als auch 8.3-Short-Names. Die JS-Variante baut den Pfad selbst über `lstat`-Walks zusammen und fasst Short-Names nicht an.

**Anwendung:** Für jeden Pfad-Vergleich der gegen User-Home/Temp-Verzeichnisse oder andere OS-generierte Pfade läuft, `realpathSync.native` benutzen (mit `try/catch` als Fallback wenn Pfad noch nicht existiert). Insbesondere relevant für: temp-dir-basierte Tests auf Windows, Migrations-Verifikation, Pfad-Equality-Checks zwischen Config-Values und FS-State.

---

## 2026-05-16 — Plattform-bewusste Module brauchen `path.posix`/`path.win32`, nicht runtime `path`

**Situation:** `src/core/paths/machine-paths.ts` akzeptiert `platform: NodeJS.Platform` als Argument und sollte plattform-spezifisch resolven. Initial mit `import { join, resolve } from 'node:path'` geschrieben. Tests die `platform: 'linux'` mit POSIX-Pfad `/home/test/.config/claude-os` injizierten scheiterten auf Windows-Runner mit Output `C:\home\test\.config\claude-os` — `path.resolve` ist zur Runtime an die Host-Platform gebunden, nicht an das Funktions-Argument.

**Lektion:** Wenn ein Modul plattform-bewusste Pfad-Operationen anbietet, MUSS es zwischen `path.posix.*` und `path.win32.*` explizit dispatchen, basierend auf dem `platform`-Parameter — NICHT den runtime-default `path.*` benutzen. Sonst kollabiert die Funktion zur Host-Plattform, Tests sind nicht cross-platform portierbar, und CI-Matrices liefern False-Negatives.

**Anwendung:** Jede plattform-parametrische Pfad-Funktion: helper `pathStyle(platform) → platform === 'win32' ? win32 : posix` und alle internen `join/resolve`-Calls durch den Helper schicken. Gilt analog auch für Module die Tauri/Electron-Sidecar-Pfade resolven (Windows-Build aus macOS-Dev und vice versa).

---

## 2026-05-17 — `diff@9` createPatch hat eigenen Header (kein vanilla unified-diff)

**Situation:** Test assertete `unifiedDiff` matched `^---` am Anfang. Failed weil `createPatch()` in diff v9 zuerst `Index: <filename>\n===\n` ausgibt, bevor `---`/`+++` kommen. Hatte vanilla `diff -u`-Output erwartet, der direkt mit `---` beginnt.

**Lektion:** Bei npm-Paketen die "well-known" Formate ausgeben (unified-diff, JSON-patch, RFC-2822, etc.) NIE auf Format-Position regexen ohne das Output-Format des konkreten Pakets zu verifizieren. Auch wenn der Standard sauber spezifiziert ist, fügen Packages oft eigene Header/Trailer hinzu für ihre Use-Cases.

**Anwendung:** Test-Regexen mit `m`-flag (multiline) gegen Anywhere-Match (`/^---/m`), nicht Strict-Start (`/^---/`). Oder besser: präzise Sentinels matchen die zum konkreten Package gehören (`Index:`, `===`), wenn die im Format expliziert sind.

---

## 2026-05-17 — Readonly-Types blocken `Partial<T>` Mutation; nutze Mapped-Type-Modifier

**Situation:** `src/cli/commands/vault.ts` baute einen `Partial<VaultConfig>`-Patch inkrementell auf (`if (opts.enable) patch.scheduleEnabled = true`). Typecheck schlug fehl: "Cannot assign to 'scheduleEnabled' because it is a read-only property" — `VaultConfig`'s Props sind `readonly`, und `Partial<T>` erbt `readonly`.

**Lektion:** `Partial<T>` macht alle Props optional aber bewahrt `readonly`. Wenn man einen Patch-Builder braucht, muss man `readonly` explizit entfernen: `{ -readonly [K in keyof T]?: T[K] }`. Sonst ist die Variable optisch mutable (durch `?`) aber TypeScript blockt jede Zuweisung.

**Anwendung:** Pattern für inkrementell-aufgebaute Patches:
```typescript
const patch: { -readonly [K in keyof Config]?: Config[K] } = {};
patch.foo = ...;
return updateConfig(path, patch);
```
Gilt analog für jedes Domain-Modell mit readonly-Props. Phase-2f und Phase-3d hatten beide diesen Bedarf.

---

## 2026-05-17 — Bash-Pipe killt Exit-Code via PIPESTATUS, nicht `$?`

**Situation:** Smoke-Test mit `node dist/cli/index.js update --env 2>&1 | head -10 ; echo "exit=$?"` zeigte `exit=0` obwohl Node mit Code 2 exited. `process.exit(2)` lief korrekt, aber `$?` capturet den Exit-Code des LETZTEN Pipe-Glieds (`head -10` = 0), nicht des ersten.

**Lektion:** Bei Exit-Code-Tests von CLI-Tools NIE durch eine Pipe filtern und dann `$?` lesen. Bash setzt `$?` auf das Pipe-Tail. Entweder Pipe entfernen und Output via `>/dev/null` weglenken (`cmd >/dev/null 2>&1 ; echo $?`), oder `${PIPESTATUS[0]}` (bash-specific) für den ersten Glied-Exit nutzen.

**Anwendung:** CLI-Exit-Code-Tests in Smoke-Sequenzen: separate Schritte mit explizitem `$?` direkt nach dem Tool, bevor irgendeine Pipe oder weitere Aufrufe folgen. Oder via Test-Framework (Vitest mit `child_process.spawn`) wo der Exit-Code typed-strukturiert kommt.
