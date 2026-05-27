Ripgrep is not available. Falling back to GrepTool.
Attempt 1 failed: You have exhausted your capacity on this model. Your quota will reset after 3s.. Retrying after 5620ms...
Attempt 1 failed: You have exhausted your capacity on this model. Your quota will reset after 1s.. Retrying after 5488ms...
Basierend auf der Analyse der Architektur-Dokumente (ADR-0027, ADR-0031, ADR-0032), der Roadmap und des bestehenden Domain-Codes in `src/domains/` sind dies die 3-5 Features, die Yanniks MSP-Produktivität im täglichen Workflow (Ticket-Bearbeitung, Kundenwechsel, Wissensmanagement) am stärksten steigern würden – unter strikter Einhaltung der "No-API-Key"- und "Multi-Tenant"-Vorgaben.

---

## Feature 1: Cross-Workspace Resolution Discovery
**Use case**: Yannik steht vor einem DNS-Problem bei Kunde A und möchte blitzschnell prüfen, ob er die Lösung bereits bei Kunde B dokumentiert hat oder ob sie in der `msp-internal` Wissensdatenbank steht.
**Builds on**: `memory-index` (fts4), `workspace` (vault-resolver), `retrieval` (scorer).
**New RPC methods**: 
- `retrieval.globalSearch(query: string, options: { includeInternal: boolean }): Promise<RetrievalResult>`
**Domain code**: 
- `src/domains/retrieval/cross-workspace-scanner.ts` (aggregiert Suchergebnisse über mehrere Workspace-Pfade)
**UI surface**: Erweiterung der bestehenden "Memory"-Page um einen Toggle "Global suchen (inkl. msp-internal)".
**Effort**: S (1-3h) — Die FTS-Infrastruktur steht bereits, es müssen nur die Suchpfade in der `memory-index`-Suche temporär erweitert werden.
**Risk**: low — Rein lesender Zugriff, strikte Trennung durch explizites Opt-In (ADR-0031).
**Multi-tenant ready**: yes — Die Tenant-ID wird im `RetrievalHit` mitgeführt, um die Herkunft der Lösung klar zu kennzeichnen.
**Sample data flow**:
1. Frontend sendet `retrieval.globalSearch` mit `query="Securepoint VPN MTU"`.
2. Backend führt FTS4-Query auf `index.db` aus, filtert auf `workspace IN ('personal', 'msp-internal', 'active-customer')`.
3. Ergebnisse werden nach BM25-Score gerankt und mit Herkunfts-Label (z.B. "Lösung von Kunde X") im Browser angezeigt.

---

## Feature 2: Automated Daily Handover Composer
**Use case**: Am Feierabend möchte Yannik seine heute erstellten Notizen und Ticket-Aktivitäten für einen Kollegen zusammenfassen, ohne alles manuell kopieren zu müssen.
**Builds on**: `workspace` (audit-log), `notes` (reader), `ask` (prompt-composer).
**New RPC methods**: 
- `workspace.getDailySummary(date: string, workspaceId: string): Promise<string>`
**Domain code**: 
- `src/domains/workspace/summary-generator.ts` (extrahiert Events aus der `audit-log.ts` und aggregiert neue Notes des Tages).
**UI surface**: Neuer Button "Tages-Handover erstellen" auf der Dashboard- oder Workspace-Page.
**Effort**: M (4-8h) — Erfordert das Parsen der JSONL-Audit-Logs und ein LLM-Prompt-Template für die Zusammenfassung.
**Risk**: low — Nutzt vorhandene Logs; das Risiko besteht nur in unvollständigen Logs bei Abstürzen.
**Multi-tenant ready**: yes — Zusammenfassungen werden pro Workspace generiert (ADR-0031 Compliance).
**Sample data flow**:
1. Yannik klickt "Handover", Backend liest `audit-log.ts` für den heutigen UTC-Tag.
2. `prompt-composer` baut Context aus Log-Events (z.B. "Note 'Veeam Fix' erstellt") und übergibt an `claude-bridge`.
3. Claude generiert eine strukturierte Markdown-Zusammenfassung für das Team-Meeting.

---

## Feature 3: Global MSP-Skill Injection
**Use case**: Yannik hat einen universellen Skill für "M365-User-Onboarding" in seinem `personal`-Workspace entwickelt und möchte diesen nutzen, während er im Workspace von "Kunde XY" arbeitet, ohne den Skill dorthin kopieren zu müssen.
**Builds on**: `skills` (matcher/reader), `workspace` (paths).
**New RPC methods**: 
- `skills.matchGlobal(input: string): Promise<SkillMatch[]>`
**Domain code**: 
- `src/domains/skills/matcher.ts` (Anpassung, um neben lokalen auch einen globalen Pfad wie `personal/Skills-Memory` zu scannen).
**UI surface**: Chat-View zeigt im Skill-Dropdown "Global" vs. "Local" Indikatoren.
**Effort**: S (1-3h) — Der `SkillLoader` muss lediglich ein zusätzliches Verzeichnis in seine Suchliste aufnehmen.
**Risk**: medium — Namenskollisionen möglich (lokaler Skill "setup" überschreibt globalen "setup"). Lösung: Namespacing.
**Multi-tenant ready**: yes — Skills bleiben Read-Only-Injektionen; Ausführung erfolgt im Context des aktiven Tenants.
**Sample data flow**:
1. Yannik tippt "M365 User anlegen" im Kunden-Workspace.
2. `skills.matcher` findet keinen lokalen Skill, aber einen Treffer in `personal/SKILL.md`.
3. Der globale Skill wird geladen und mit den Kunden-spezifischen Daten ausgeführt.

---

## Feature 4: Note-to-Skill Fast Track
**Use case**: Während eines Site-Visits tippt Yannik eine Lösung schnell ins Smartphone (Web-UI). Er erkennt, dass dies ein wiederkehrendes Problem ist und will die Note sofort in einen permanenten, ausführbaren Skill umwandeln.
**Builds on**: `notes` (reader), `skill-lifecycle` (draft-generator), `skills` (frontmatter-schema).
**New RPC methods**: 
- `skill-lifecycle.promoteNote(notePath: string): Promise<{ skillId: string }>`
**Domain code**: 
- `src/domains/skill-lifecycle/note-promoter.ts` (extrahiert Markdown-Logik aus Note und schreibt `SKILL.md`-Eintrag).
**UI surface**: "In Skill umwandeln"-Button in der Einzelansicht einer Notiz.
**Effort**: M (4-8h) — Benötigt Logik zum Transformieren von Freitext in das strukturierte SKILL.md-Format (Draft-Mode).
**Risk**: low — Erzeugt einen Entwurf (`_drafts/`), der erst durch Yannik signiert werden muss (ADR-0026).
**Multi-tenant ready**: yes — Skills werden im selben Workspace wie die Ursprungs-Note erstellt.
**Sample data flow**:
1. Yannik klickt "Promote", Backend liest die Note via `notes.reader`.
2. `draft-generator` erstellt einen Skill-Entwurf basierend auf dem Inhalt der Note.
3. Der neue Skill steht sofort (nach Review) im Kunden-Workspace zur Verfügung.

---

## Feature 5: Contextual "Inbox" Routing
**Use case**: Yannik erhält einen Anruf, öffnet die Claude-OS Web-UI und fängt an zu tippen. Das System soll die Notiz automatisch dem aktiven Kunden-Workspace zuordnen, anstatt sie in einen globalen "Inbox"-Ordner zu werfen.
**Builds on**: `workspace` (state), `notes` (writer), `tenant` (resolve).
**New RPC methods**: 
- `notes.saveToActiveWorkspace(content: string, metadata: Partial<NoteFrontmatter>): Promise<void>`
**Domain code**: 
- Erweiterung von `src/domains/notes/writer.ts` um automatische Frontmatter-Injektion basierend auf `activeWorkspace`.
**UI surface**: "Schnellnotiz"-Widget, das den aktuellen Tenant-Context bereits vorausgefüllt anzeigt.
**Effort**: S (1-3h) — Einfache Verknüpfung von `workspace.state` mit dem `notes.writer`.
**Risk**: low — Verhindert Fehl-Zuordnungen von sensiblen Daten.
**Multi-tenant ready**: yes — Erzwingt korrekte `workspace` und `tenant` Tags (ADR-0031).
**Sample data flow**:
1. Yannik tippt im "Kunde A" Context eine Notiz.
2. Backend injiziert `workspace: msp-customers/kunde-a` und `tenant: kunde-a` automatisch in das Frontmatter.
3. Die Datei wird direkt im korrekten Vault-Unterordner gespeichert.
