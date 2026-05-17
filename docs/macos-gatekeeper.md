# macOS: Gatekeeper-Workaround für unsigniertes DMG

claude-os v1 wird unsigniert released (kein Apple-Developer-Account). Beim ersten Doppelklick auf `claude-os.dmg` blockt Gatekeeper mit:

> "claude-os" can't be opened because it is from an unidentified developer.

Drei Workarounds, je nach Trust-Level.

## Option A: Per-Datei Quarantine entfernen (empfohlen)

```bash
xattr -d com.apple.quarantine ~/Downloads/claude-os.dmg
open ~/Downloads/claude-os.dmg
```

Sicher, minimal, lokal. Du sagst macOS: "ich kenne diese eine Datei, geh weg".

Nach der Installation kann der gleiche Trick für die App nötig sein:

```bash
xattr -d com.apple.quarantine /Applications/claude-os.app
```

## Option B: Right-Click → Open (one-time prompt)

1. DMG mounten (Doppelklick).
2. Im DMG-Fenster: **Right-Click auf claude-os.app** → Open.
3. Gatekeeper-Dialog erscheint mit Open-Knopf (statt nur OK).
4. Open klicken.

Diese Wahl wird gemerkt — beim nächsten Start läuft die App ohne Prompt.

## Option C: Gatekeeper systemweit für unsignierte Apps lockern (nicht empfohlen)

Nur für Entwickler-Maschinen.

```bash
sudo spctl --master-disable
```

Re-Enable danach:

```bash
sudo spctl --master-enable
```

## Was claude-os v1 NICHT macht

- Keine Code-Signatur (kein Apple Developer ID Application Cert).
- Keine Notarization (notwendig macht das den Open-Dialog komplett verschwinden — kommt in v1.x mit dev-cert).
- Keine Hardened Runtime.

## Future (v1.x): signiert + notarisiert

Geplant für v1.x sobald ein Apple-Dev-Account verfügbar ist. Workflow-Patch in `.github/workflows/tauri-bundle.yml` wird folgende ENVs erwarten:

- `APPLE_CERTIFICATE` (base64-encoded `.p12`)
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY` (e.g. `Developer ID Application: ...`)
- `APPLE_ID` + `APPLE_PASSWORD` (App-spezifisches PW für Notarization)
- `APPLE_TEAM_ID`

`tauri-apps/tauri-action@v0` picked diese Variablen automatisch auf — kein weiteres Doc-Change nötig wenn das passiert.

## Verifikation nach Open

```bash
codesign -dv --verbose /Applications/claude-os.app
# Expected: "code object is not signed at all" — wenn das steht, ist alles wie erwartet (v1).

xattr -l /Applications/claude-os.app
# Sollte com.apple.quarantine NICHT mehr listen wenn Option A oder B benutzt wurde.
```
