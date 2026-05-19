# ADR-0018 — AppImage Self-Update via standalone-zsync

**Status:** Akzeptiert
**Datum:** 2026-05-20
**Bedingt durch:** v1.3 Phase 8c (PR [#21](https://github.com/yannikits/Claude-portable/pull/21))

## Kontext

Phase 8 (Cross-Platform-Hardening) musste eine Self-Update-Mechanik für Linux liefern. Auf Windows haben wir mittelfristig MSI-Installer mit Authenticode + WiX-Major-Upgrades, auf macOS DMG + Notarization + Sparkle-style appcast. Linux ist anders: AppImage ist ein Single-File-Bundle, ohne traditionellen Paketmanager-Integration.

Im AppImage-Ökosystem ist der etablierte Update-Standard **`zsync`**: ein Delta-Sync-Protokoll, das ähnlich `rsync` nur die geänderten Blöcke nachlädt. Tools wie `AppImageUpdate` lesen ein begleitendes `.AppImage.zsync`-Manifest und ersetzen die alte Datei in-place.

Tauri v2 hat einen `bundle.appimage.includeUpdater` Flag, der angeblich einen integrierten Updater bundlet. Das klang verlockend, aber Recon ergab:

- Tauri's "AppImage Updater" hängt am gleichen `tauri-plugin-updater` wie Windows/macOS und braucht eine eigene Update-Server-Infrastruktur mit signiertem Manifest.
- Wir haben keinen Update-Server. GitHub Releases ist der einzige Distribution-Channel.
- Der Flag-Wert ist in Tauri-2.x noch instabil dokumentiert und kann sich ändern.

Alternative: ein **standalone-zsync-Workflow** — `zsyncmake` erzeugt das `.AppImage.zsync`-Manifest aus dem AppImage, beide Files werden als Release-Assets hochgeladen, User lädt sich `AppImageUpdate` lokal und zeigt ihm die Update-URL.

## Entscheidung

**Standalone `zsyncmake` im CI-Bundle-Workflow erzeugt das `.AppImage.zsync`-Manifest. Tauri's `bundle.appimage.includeUpdater` wird NICHT verwendet.**

### Implementierungsdetails (PR #21)

1. **CI-Workflow `tauri-bundle.yml` linux-job erweitert um drei Steps:**
   ```yaml
   - run: sudo apt-get install -y zsync
   - run: zsyncmake -u "<release-asset-url>" -o "claude-os-*.AppImage.zsync" "claude-os-*.AppImage"
     if: startsWith(github.ref, 'refs/tags/')
   - uses: softprops/action-gh-release@v2
     with:
       files: "*.AppImage.zsync"
   ```

2. **upload-artifact-Glob inkl. `*.AppImage.zsync`** für non-tag-Runs (PR-CI), damit der Artifact-Download zum manuellen Testen mitkommt.

3. **`docs/linux-updates.md`** erklärt Usern die Update-Procedure:
   - `appimageupdatetool` über Distro-Paketmanager installieren
   - `appimageupdatetool ./claude-os-x.y.z.AppImage` ausführen
   - Tool liest das embedded `update_info` Feld und nutzt das zsync-Manifest

4. **Update-Info-Embedding** über `gh-releases-zsync|<owner>|<repo>|latest|*.AppImage.zsync`-Format als optionale Verbesserung (deferred bis konkrete Update-Cadence steht). Aktuell muss der User die zsync-URL manuell kennen oder via Releases-Page kopieren.

## Konsequenzen

### Positiv

- **Kein eigener Update-Server nötig** — GitHub Releases hostet beide Files, AppImageUpdate fetcht direkt von dort.
- **Kein Tauri-internes Updater-Signing-Setup** — keine zusätzlichen Keys, kein eigener `tauri.conf.json` `updater`-Block, keine Update-Manifest-JSON-Pipeline.
- **Echte Delta-Updates** — bei einer 50 MB AppImage spart der User typischerweise 90 %+ Download bei Patch-Releases.
- **Forward-kompatibel** — wenn Tauri später eine ausgereifte `bundle.appimage.includeUpdater`-Implementation liefert, können wir umsteigen. Die zsync-Manifest-Pipeline ist additiv, nicht ersetzend.
- **Workflow-CI grün auf erstem Lauf** — kein Apt-Cache-Drift, kein zsync-Tool-Issue.

### Negativ / Akzeptierte Trade-offs

- **User muss `appimageupdatetool` selbst installieren** — kein In-App-Update-Button in v1.3. Doku weist darauf hin.
- **Kein automatischer Background-Check** — anders als bei Sparkle/Squirrel/MSI-Schema. User muss aktiv das Update-Tool starten. Akzeptabel für v1.3 weil die Update-Cadence noch niedrig ist.
- **Echte Delta-Verifikation braucht zwei Releases** — der erste tag-getriggerte Run generiert nur das erste Manifest, das delta-Verhalten lässt sich erst vom v1.3 → v1.4 nachweisen. Workflow-CI ist grün, Roundtrip-Smoke wartet auf v1.4.
- **AppImage-spezifisch** — Snap, Flatpak und `.deb` haben das nicht. v1.3 sagt explizit: Linux = AppImage.

### Konstraints für Folge-Phasen

- **Update-URL-Format muss stabil bleiben** zwischen Releases. Die zsync-Manifest-URL ist im AppImage embedded (über `-u`-Flag von `zsyncmake`). Wenn wir die Repo-URL-Struktur ändern, müssen wir vorher eine Migrations-Release fahren die beide Manifests hostet.
- **In-App-Update-UI** ist v1.4+-Material. Pattern: ein "Update verfügbar"-Banner in der GUI checked via Tauri-Side `fetch` auf das `.AppImage.zsync`-Manifest, vergleicht die SHA1 mit der embedded.
- **Snap/Flatpak-Distributionen** bleiben out-of-scope für v1.x. Wenn Demand auftaucht, eigener ADR.

## Alternativen verworfen

**Tauri's `bundle.appimage.includeUpdater`:** Verworfen weil die Tauri-Updater-Pipeline einen eigenen Update-Server erwartet und wir keinen haben. Außerdem ist die Tauri-2.x-Doc zum Thema dünn.

**Generic-Update-via-Re-Download:** Kein Delta. Bei 50 MB AppImage zumutbar, aber für Mobile-Tethering oder limited-Data-Plans unfreundlich. zsync löst das mit minimalem Overhead.

**`linuxdeploy --plugin updateinformation`-Postprocessing:** Würde die zsync-Info im AppImage selbst einbetten — moderne Approach. Funktioniert aber nicht out-of-the-box mit `tauri-action`'s AppImage-Bundling, was uns Custom-Build-Steps in den CI gezwungen hätte. Pragmatischer Standalone-zsync-Workflow ist einfacher zu warten.

**Self-hosted Update-JSON-Manifest:** Wir hätten eine `update.json` im Repo serven können, die Tauri-Updater daran ranzieht. Aber dann brauchen wir GitHub Pages oder ähnliches als Update-Server, plus Signing-Setup. Cost-of-ownership größer als der UX-Gewinn.

## Referenzen

- ADR-0001 — Tauri als GUI-Framework
- PR [#21](https://github.com/yannikits/Claude-portable/pull/21) — Phase 8c AppImage-zsync-Implementierung
- `.github/workflows/tauri-bundle.yml`
- `docs/linux-updates.md`
- [zsync project](http://zsync.moria.org.uk/)
- [AppImageUpdate](https://github.com/AppImage/AppImageUpdate)
