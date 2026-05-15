# ADR-0008 — Git-Backend für v1: `simple-git` (System-Git-Wrapper)

**Status:** Akzeptiert
**Datum:** 2026-05-15
**Bedingt durch:** ADR-0002 (Vault-Sync), ADR-0005 (Selective-Merge) + Researcher-Spike auf git-libs in Node

## Kontext

`domains/vault-sync/` und `domains/update-orchestrator/` brauchen einen git-Client in Node. Drei Kandidaten standen zur Wahl:

- **`simple-git`** (steveukx/git-js) — Wrapper um die System-`git`-Binary
- **`isomorphic-git`** — pure-JS-Implementation, keine externen Abhängigkeiten
- **`nodegit`** — Native Bindings zu libgit2

Researcher-Befund:

- `isomorphic-git` hat **keinen Merge-with-conflicts-Support** und Performance-Issues bei großen Packfiles ([Issue #291](https://github.com/isomorphic-git/isomorphic-git/issues/291)). Das bricht direkt ADR-0005 (Selective-Merge erfordert echten Merge-Pfad).
- `nodegit` hat pre-built-Binaries, die für Electron/Win32 oft kaputt sind und `node-gyp`-Fallback auslösen. Das widerspricht ADR-0004 (Linie "kein Native-Build-Pain") und würde Build-Komplexität auf jede User-Maschine ausstrahlen.
- `simple-git` setzt System-`git` voraus, ist aber bei I/O-bound-Operationen (commit/status/push auf 1k–10k Markdown-Files) ausreichend schnell und hat null Native-Build-Pain.

## Entscheidung

**`simple-git` als git-Client für v1.** System-`git` ist Voraussetzung, geprüft von `claude-os doctor`.

### Constraints

- **Doctor-Pre-flight**: `git --version` läuft beim Startup. Bei Fehlen klarer Error mit Plattform-spezifischer Install-Anleitung (`winget install Git.Git`, `brew install git`, `apt install git`).
- **Windows-Long-Paths**: `git config --global core.longpaths true` automatisch beim ersten Doctor-Run auf Windows (Vault-Strukturen können >260 Zeichen erreichen).
- **Abstraktions-Schicht**: alle git-Ops gehen durch `src/core/git/git-service.ts`, keine direkten `simple-git`-Imports aus Domain-Code. Das erlaubt späteren Drop-in-Tausch.
- **Error-Mapping**: `simple-git`-Errors werden auf `DomainError`-Subklassen abgebildet (`GitNotInstalledError`, `GitLockfileError`, `GitMergeConflictError`).

### v1.2-Pfad

Für Hot-Path-Performance kann später ein **Rust-libgit2-Backend** über Sidecar (ADR-0006 Lifecycle) aktiviert werden. Voraussetzung: `git-service.ts`-Interface bleibt stabil, Implementation-Swap ist drop-in.

## Konsequenzen

**Positiv**

- Null Native-Build-Pain, konsistent mit ADR-0004
- Robustheit: System-`git` handhabt Lockfiles, Interrupts und Edge-Cases korrekt (jahrzehnte-erprobt)
- Selective-Merge (ADR-0005) ist nativ möglich
- Identisches Verhalten auf allen drei OS, sobald System-`git` installiert ist

**Negativ / Aufwand**

- Setup-Voraussetzung: User braucht System-`git` (Doctor leitet bei Bedarf zur Installation)
- Performance unter `nodegit` auf großen Repos — akzeptabel weil Vault-Operationen I/O-bound sind
- Windows-Long-Paths-Edge-Case muss aktiv adressiert werden (siehe Constraints)

## Alternativen

| Option | Bewertung | Grund für Ablehnung |
|--------|-----------|---------------------|
| **`isomorphic-git`** | Verworfen | Kein Merge-with-conflicts-Support — bricht ADR-0005; Perf-Probleme bei großen Packfiles |
| **`nodegit`** | Verworfen v1 | Pre-built-Binaries kaputt für Electron/Win32, native-build-Pain widerspricht ADR-0004 |
| **`exec('git ...')` direkt ohne Wrapper** | Verworfen | Re-Implementierung von `simple-git`'s Quote-Escaping und Promise-API, kein Mehrwert |
| **Rust-libgit2-Sidecar in v1** | Verworfen v1 | Zu früh; Sidecar-Lifecycle (ADR-0006) erst in Phase 6 ausgereift, v1 fokussiert Robustheit |

## Quellen

- [simple-git on npm](https://www.npmjs.com/package/simple-git)
- [isomorphic-git FAQ](https://isomorphic-git.org/docs/en/faq)
- [isomorphic-git Issue #291 — large packfile perf](https://github.com/isomorphic-git/isomorphic-git/issues/291)
- [nodegit Electron prebuilt issues](https://github.com/nodegit/nodegit/issues/904)
- [Git Windows long paths](https://shadynagy.com/solving-windows-path-length-limitations-in-git/)
- Researcher-Spike vom 2026-05-15 (vergleichbare Production-Apps)

## Notiz

Diese ADR ist Implementations-Detail für ADR-0002 (Vault-Sync) und ADR-0005 (Selective-Merge). Phase 2 + Phase 4 in `tasks/todo.md` nutzen `simple-git` über `src/core/git/git-service.ts`.
