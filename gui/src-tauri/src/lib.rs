pub mod rpc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| {
            // Phase 6d wires sidecar lifecycle here.
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running claude-os-shell");
}
