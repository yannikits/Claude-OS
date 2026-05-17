pub mod rpc;
pub mod supervisor;

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
        .setup(|app| {
            let state = Arc::new(SupervisorState::default());
            app.manage(state.clone());
            app.manage(Arc::new(DropDedup::default()));
            supervisor::start(app.handle().clone(), state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc_call])
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
