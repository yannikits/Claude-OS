# claude-os GUI (Phase 6)

Tauri-2-Desktop-Shell für claude-os.

## Voraussetzungen

- Node ≥ 20 (gleicher Stack wie das CLI-Projekt)
- Rust-Toolchain via [rustup](https://rustup.rs/)
- Plattform-spezifisch:
  - Windows: Visual Studio 2022 Build Tools mit C++-Workload
  - macOS: Xcode CLI Tools (`xcode-select --install`)
  - Linux: `libwebkit2gtk-4.1-dev`, `libssl-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`, `xdotool`

## Verifikation (Phase 6a)

```powershell
cd gui\src-tauri
cargo check
```

`cargo check` validiert dass die Rust-Shell-Sources kompilieren ohne die volle Binary zu linken. Erster Lauf nach rustup-Install lädt Tauri + Transitive-Crates (~300 MB Cargo-Cache, ~3-5 min).

## Sub-Phasen-Status

| Sub-Phase | Inhalt | Status |
|-----------|--------|--------|
| 6a | Tauri-Rust-Shell-Scaffold | shipped |
| 6b | Sidecar-Binary-Build-Script (`$TARGET_TRIPLE`) | shipped |
| 6c | JSON-RPC-Bridge (Rust + Node) | shipped |
| 6d | Sidecar-Lifecycle + Health-Check | pending |
| 6e | Vite + React + TS Frontend | pending |
| 6f | 7 Views | pending |
| 6g | Drag-Drop + inbox/outbox Watcher | pending |
| 6h | Bundling (MSI/DMG/AppImage) | pending |

## Sidecar bauen (Phase 6b)

```powershell
npm run sidecar:build
```

Wrappt `scripts/build-sidecar.{ps1,sh}` plattform-bewusst. Schritte:

1. `npm run build` → frische `dist/cli/index.js`
2. `rustc -Vv` → host-triple (Hoppscotch-Pattern)
3. Triple → pkg-target (z.B. `x86_64-pc-windows-msvc` → `node24-win-x64`)
4. `npx @yao-pkg/pkg dist/cli/index.js --target ... --output gui/src-tauri/binaries/claude-os-sidecar-<TRIPLE>.exe`

Output landet unter `gui/src-tauri/binaries/` mit Triple-Suffix, der Tauris `bundle.externalBin` Auto-Discovery erlaubt.

### Native-Module-Caveat

`@napi-rs/keyring` (Phase 3d Secrets-Store) hat `.node`-Bindings, die `pkg` nicht in den V8-Snapshot embedded. Mitigation: Sidecar setzt `CLAUDE_OS_SECRETS_BACKEND=file` (Force `EncryptedFileStore`-Fallback) — keyring-API umgangen. Wird in Phase 6d beim Sidecar-Spawn als Env-Var injiziert. Alternative (später): `--public-packages "@napi-rs/keyring"` + `.node`-Files neben dem Binary ausliefern. Für v1 ist der File-Fallback sauber & ausreichend.

## Deferrals

- Icons (`icons/*.png`, `*.ico`) shippt Phase 6h zusammen mit dem Bundling-Pass. `cargo check` braucht keine Icons; `cargo build --release` auf Windows braucht eine `.ico` für die `winres`-Embedding — wird in 6h nachgezogen.
- Frontend-Dist (`gui/src/index.html`) shippt Phase 6e. `tauri dev` braucht den Vite-Server (läuft nicht in 6a). `tauri build` braucht `frontendDist`; ist erst ab 6h relevant.
- `tauri.conf.json bundle.externalBin` wired Phase 6d wenn der Sidecar tatsächlich spawned.
