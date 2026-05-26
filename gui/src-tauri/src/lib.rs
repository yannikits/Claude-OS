pub mod rpc;
pub mod supervisor;

use once_cell::sync::Lazy;
use serde_json::{Value, json};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use supervisor::SupervisorState;
use tauri::{DragDropEvent, Emitter, Manager, WindowEvent};

#[tauri::command]
async fn rpc_call(
    state: tauri::State<'_, Arc<SupervisorState>>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let rpc_opt = state.rpc.lock().await.clone();
    let rpc = rpc_opt.ok_or_else(|| "sidecar not available".to_string())?;
    rpc.call(&method, params).await.map_err(|e| e.to_string())
}

/// v1.x.+2: probe ob ein native password-Dialog ueberhaupt verfuegbar ist.
/// Win/macOS: tinyfiledialogs nutzt OS-built-in APIs → immer verfuegbar.
/// Linux: tinyfiledialogs versucht zenity → kdialog → matedialog → qarma →
/// pluma → fallback-text-mode. Wir probe'n den ersten erfolgreichen.
/// Result wird via once_cell gecached — kein wiederholtes which-probing.
static LINUX_DIALOG_AVAILABLE: Lazy<bool> = Lazy::new(|| {
    if !cfg!(target_os = "linux") {
        return true;
    }
    let candidates = ["zenity", "kdialog", "matedialog", "qarma"];
    for cmd in &candidates {
        let probe = std::process::Command::new("which")
            .arg(cmd)
            .output();
        if let Ok(out) = probe {
            if out.status.success() && !out.stdout.is_empty() {
                return true;
            }
        }
    }
    false
});

/// v1.x.+2: native password-input via tinyfiledialogs.
///
/// Security-property: der Wert lebt ausschliesslich im Rust-stack der
/// spawn_blocking-task + im SidecarRpc.call-Future. Er wird NIE in den
/// return-payload dieser Tauri-command geschrieben — der Renderer
/// bekommt nur `{ key, backend, updated }`-Shape von der secrets.set
/// RPC-response zurueck.
///
/// Linux-fallback: wenn kein dialog-binary verfuegbar ist, returnt der
/// Command einen typed `dialog-unavailable`-Error. Frontend detected
/// das und schaltet auf den Inline-password-input-Mode aus PR #96.
#[tauri::command]
async fn set_secret_native(
    state: tauri::State<'_, Arc<SupervisorState>>,
    key: String,
) -> Result<Value, String> {
    let trimmed = key.trim().to_string();
    if trimmed.is_empty() {
        return Err("key must be non-empty".to_string());
    }
    if !*LINUX_DIALOG_AVAILABLE {
        return Err("dialog-unavailable".to_string());
    }
    let rpc_opt = state.rpc.lock().await.clone();
    let rpc = rpc_opt.ok_or_else(|| "sidecar not available".to_string())?;

    // tinyfiledialogs::password_box ist sync + blocking. spawn_blocking
    // verhindert dass der tokio runtime im async Tauri-command festhaengt.
    let dialog_key = trimmed.clone();
    let value_opt = tokio::task::spawn_blocking(move || {
        tinyfiledialogs::password_box(
            "claude-os — Secret",
            &format!("Wert fuer Secret '{}':", dialog_key),
        )
    })
    .await
    .map_err(|e| format!("dialog task panic: {e}"))?;

    let Some(value) = value_opt else {
        return Err("cancelled".to_string());
    };

    let params = json!({ "key": trimmed, "value": value });
    rpc.call("secrets.set", params)
        .await
        .map_err(|e| e.to_string())
}

const DROP_DEDUP_WINDOW_MS: u64 = 200;

#[derive(Default)]
struct DropDedup {
    last: Mutex<Option<(u64, u64)>>,
}

impl DropDedup {
    fn should_emit(&self, paths: &[PathBuf]) -> bool {
        let mut hasher = DefaultHasher::new();
        for p in paths {
            p.hash(&mut hasher);
        }
        let hash = hasher.finish();
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let mut guard = self.last.lock().unwrap();
        let dup = guard
            .as_ref()
            .is_some_and(|(prev_hash, prev_ts)| *prev_hash == hash && now_ms.saturating_sub(*prev_ts) < DROP_DEDUP_WINDOW_MS);
        if !dup {
            *guard = Some((hash, now_ms));
        }
        !dup
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // Phase 8 — Auto-Update plugin per ADR-0028. The plugin itself is
        // always registered so the JS-side `@tauri-apps/plugin-updater`
        // API doesn't blow up when imported. The actual update-check is
        // gated by tauri.conf.json plugins.updater.active — set to false
        // by default so dev-builds without a real signing keypair don't
        // ping the GitHub-Release endpoint accidentally.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let state = Arc::new(SupervisorState::default());
            app.manage(state.clone());
            app.manage(Arc::new(DropDedup::default()));
            supervisor::start(app.handle().clone(), state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc_call, set_secret_native])
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<Arc<SupervisorState>>().inner().clone();
                    supervisor::graceful_shutdown(state).await;
                    app.exit(0);
                });
            }
            WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                let dedup = window.state::<Arc<DropDedup>>().inner().clone();
                if !dedup.should_emit(paths) {
                    return;
                }
                let payload = json!({
                    "paths": paths.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>()
                });
                let _ = window.emit("files://dropped", payload);
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running claude-os-shell");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn drop_dedup_suppresses_identical_paths_within_window() {
        let dedup = DropDedup::default();
        let paths = vec![PathBuf::from("/tmp/a.txt"), PathBuf::from("/tmp/b.txt")];
        assert!(dedup.should_emit(&paths));
        assert!(!dedup.should_emit(&paths));
    }

    #[test]
    fn drop_dedup_allows_different_paths() {
        let dedup = DropDedup::default();
        assert!(dedup.should_emit(&[PathBuf::from("/tmp/a.txt")]));
        assert!(dedup.should_emit(&[PathBuf::from("/tmp/b.txt")]));
    }
}
