/**
 * Tauri-Updater helpers (Phase 8 scaffold per ADR-0028).
 *
 * The plugin is **inactive by default** (`tauri.conf.json plugins.updater.active=false`)
 * so dev-builds don't ping the GitHub-Release endpoint. To enable in your
 * own fork:
 *
 *   1. `tauri signer generate -w ~/.tauri/claude-os.key`
 *      Creates Ed25519 private (~/.tauri/claude-os.key) + public (.pub).
 *      Store the PRIVATE key in an OS-Keychain slot, NOT in the repo.
 *   2. Copy the PUBLIC key content into `tauri.conf.json plugins.updater.pubkey`.
 *   3. Flip `plugins.updater.active` to `true`.
 *   4. After bundling, sign each artifact: `tauri signer sign <path-to-msi>`
 *      Output `.sig` files MUST be uploaded next to the artifact in the
 *      GitHub-Release so the endpoint resolves them.
 *
 * Full key-generation walkthrough: `docs/tauri-updater-setup.md`.
 *
 * @module updater
 */
import { check, type Update } from '@tauri-apps/plugin-updater';

export interface CheckOutcome {
  /** True when a newer version is available. */
  readonly available: boolean;
  /** Version string of the available update (when available=true). */
  readonly version?: string;
  /** Release-notes body from the GitHub-Release (when available=true). */
  readonly notes?: string;
  /** Underlying Update handle for `install()` (when available=true). */
  readonly update?: Update;
}

/**
 * Asks the Tauri-Updater plugin to query the endpoint. Returns a
 * normalised outcome so the GUI can render an "Update verfügbar" banner
 * without juggling the plugin's raw shape.
 *
 * Throws when:
 *   - the plugin is registered but `plugins.updater.active=false` (use
 *     `isUpdaterEnabled()` to guard the call in the caller)
 *   - the endpoint is unreachable
 *   - the signature on the resolved manifest doesn't verify against the
 *     pubkey baked into the binary
 */
export async function checkForUpdate(): Promise<CheckOutcome> {
  const update = await check();
  if (update === null) {
    return { available: false };
  }
  const out: CheckOutcome = {
    available: true,
    version: update.version,
    notes: update.body ?? '',
    update,
  };
  return out;
}

/**
 * Downloads + installs the update. The Tauri-side handles the platform-
 * specific install behaviour (MSI installer on Win, drag-and-drop on
 * macOS, AppImage-zsync on Linux per ADR-0018).
 *
 * On Windows with `installMode: "passive"` (the default in our
 * `tauri.conf.json`) the installer runs in the background and quits the
 * app — caller should drain in-flight work first.
 */
export async function installUpdate(update: Update): Promise<void> {
  await update.downloadAndInstall();
}
