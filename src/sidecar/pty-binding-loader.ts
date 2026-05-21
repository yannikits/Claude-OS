/**
 * Sideload-Loader fuer node-pty.
 *
 * Hintergrund: `@yao-pkg/pkg` (unser Sidecar-Bundler) bundlet nur Files
 * die statisch via `require('literal-string')` referenziert werden.
 * `createRequire(import.meta.url).require(x)` ist dynamisch — pkg
 * traced das nicht, also wird node-pty NICHT in den Snapshot bundleled.
 * Zusaetzlich braucht node-pty seine `.node`-Bindings on-disk
 * (Native-Module funktionieren nicht im Snapshot).
 *
 * Loesung: nach `npm run sidecar:build` wird das komplette
 * `node_modules/node-pty/`-Package nach `binaries/node-pty/` neben den
 * Sidecar kopiert (inkl. `lib/`, `package.json`, `prebuilds/<arch>/`).
 * Tauri's `bundle.resources` zieht das in den finalen App-Installer.
 * Dieser Loader resolved zur Runtime den Sideload-Pfad via
 * `dirname(process.execPath) + '/node-pty'`. node-ptys eigener
 * `loadNativeModule` findet seine `.node`-Files dann ueber die
 * normalen relativen Pfade.
 *
 * Dev-mode (`node dist/sidecar/index.js`): faellt auf
 * `require('node-pty')` aus dem `node_modules/`-Tree zurueck.
 *
 * Spike-validated auf Windows 10 mit useConptyDll:true.
 *
 * @module @sidecar/pty-binding-loader
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const requireCjs = createRequire(import.meta.url);

/**
 * Default-Pfad fuer sideloaded node-pty-Package, abgeleitet aus
 * `process.execPath`. Beispiel auf Windows:
 *   execPath: C:\...\binaries\claude-os-sidecar-x86_64-pc-windows-msvc.exe
 *   node-pty: C:\...\binaries\node-pty\
 */
function defaultNodePtyDir(): string {
  return join(dirname(process.execPath), 'node-pty');
}

/**
 * Laed node-pty entweder aus dem sideloaded-Pfad (production / pkg) oder
 * via regular module-resolution aus node_modules (dev / unit-tests).
 * Env-var `CLAUDE_OS_NODE_PTY_DIR` ueberschreibt den default.
 */
export function loadNodePty(): typeof import('node-pty') {
  const override = process.env.CLAUDE_OS_NODE_PTY_DIR;
  if (typeof override === 'string' && override.length > 0) {
    return requireCjs(override) as typeof import('node-pty');
  }
  const sideloadDir = defaultNodePtyDir();
  try {
    return requireCjs(sideloadDir) as typeof import('node-pty');
  } catch {
    // Dev-mode fallback: normale module-resolution. In den Unit-Tests
    // zeigt `process.execPath` auf das `node`-binary, neben dem es kein
    // `node-pty/` gibt — wir holen es aus `node_modules/node-pty/`.
    return requireCjs('node-pty') as typeof import('node-pty');
  }
}
