# ADR-0046 — Public-Monorepo akzeptiert: MSP-Bridge-Code als OSS-Referenz

**Status:** Akzeptiert (2026-05-31)
**Löst ab:** ADR-0030 (Repo-Strategie: Hybrid Public-Core + Private MSP/House)
**Bedingt durch:** ADR-0030-Amendment-Befund (Repo ist PUBLIC entgegen ursprünglichem Treiber)

## Kontext

ADR-0030 beschloss eine 3-Repo-Trennung (public Core + privates `claude-os-msp` +
`house-watch`), um MSP-Code aus der öffentlichen Git-History fernzuhalten. Dieser Plan
wurde **nie ausgeführt**: faktisch existiert das Monorepo `yannikits/MSP-Cockpit` (public),
in dem Core und alle MSP-Bridges (TANSS, Veeam, Sophos, Securepoint, NinjaOne) gemeinsam
unter `src/domains/` liegen.

Beim Schließen der Doku-Schuld (2026-05-31) fiel auf, dass das Monorepo PUBLIC ist —
ein direkter Widerspruch zum Kern-Treiber von ADR-0030. Schweregrad-Audit:

- **Committed:** ausschließlich **Code** (Bridge-Clients, Mapper, Schemas, Reader-Logik).
- **Nicht committed:** keine Customer-Config (`customers/*.json|yaml` nicht getrackt),
  `.env`-Secrets gitignored, keine Credentials in der History.
- Exponiert wird damit **Wettbewerbs-Wissen** (welche Vendors, wie integriert),
  **kein** Customer-Daten-/Credential-Leak.

## Entscheidung

**Das Public-Monorepo wird bewusst akzeptiert.** Der MSP-Bridge-Code bleibt öffentlich
als OSS-Referenz-Integration. Die Repo-Separierung aus ADR-0030 entfällt ersatzlos.

Der ursprüngliche Schutz-Treiber ("MSP raus aus public History") wird **nicht** durch
Repo-Trennung erreicht, sondern durch eine **Commit-Disziplin**, die ohnehin schon greift:

1. **Niemals Customer-Daten committen** — Customer-Config lebt im Vault
   (`workspaces/msp-customers/<id>/`), nicht im Repo. `.gitignore` deckt `.env*` ab.
2. **Bridge-Results sind ephemeral** (SECURITY.md §6.1) — kein Cache von Customer-Daten im Repo.
3. **Secrets nur über Keyring/EncryptedFileStore** (ADR-0004), nie als Literal im Code.
4. **CI-Gate:** `npx @claude-flow/cli@latest security scan` + `npm audit` fangen versehentliche
   Secret-/PII-Commits ab (bestehende Pipeline).

Was öffentlich sein **darf**: Integrations-Code, Schemas, generische Vendor-API-Logik.
Was öffentlich **nie** sein darf: konkrete Customer-Identitäten, Hosts, Tokens, Ticket-Inhalte.

## Konsequenzen

**Positiv**
- Ein Repo, ein Build, ein Klon — kein Cross-Repo-Refactor-Schmerz (ADR-0030 "Negativ"-Punkte entfallen).
- MSP-Integration als sichtbare OSS-Referenz (Reputation, Nachnutzbarkeit der generischen Bridge-Patterns).
- Klarere mentale Grenze: die Schutzlinie ist "Customer-Daten", nicht "Repo-Grenze".

**Negativ**
- Wettbewerbs-Wissen (Vendor-Stack + Integrationsweise) ist öffentlich einsehbar — bewusst akzeptiert.
- Die Commit-Disziplin wird sicherheitskritisch: ein versehentlicher Customer-Config-Commit
  wäre in public History sofort exponiert. Mitigation: `.gitignore` + CI-Security-Scan + Review.
- `house-watch` (privater Use-Case) gehört weiterhin **nicht** hier hinein — separat halten.

## Alternativen verworfen

- **Repo auf privat stellen (ADR-0030-Treiber wiederherstellen):** verschenkt OSS-Sichtbarkeit;
  die akute Leak-Gefahr ist mangels committeter Customer-Daten ohnehin gering. Vom Owner verworfen.
- **Nachträglich MSP-Bridges in privates Repo extrahieren:** History-Rewrite-Aufwand ohne realen
  Schutzgewinn (Code ist bereits public-archiviert).

## Quellen

- ADR-0030 (abgelöst) — ursprüngliche 3-Repo-Strategie
- ADR-0004 (Secrets via Keyring), ADR-0029 (Lizenz MIT public)
- SECURITY.md §6 (MSP-Bridges), §6.3 (Tenant-Isolation), §6.4 (DSGVO)
