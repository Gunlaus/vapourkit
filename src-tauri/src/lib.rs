//! Initial Tauri host. Processing remains in Electron until the IPC contract
//! is migrated feature-by-feature. This host is not yet the production app.

#[tauri::command]
fn host_status() -> HostStatus {
    HostStatus {
        host: "tauri",
        migration_stage: "foundation",
    }
}

#[derive(serde::Serialize)]
struct HostStatus {
    host: &'static str,
    migration_stage: &'static str,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![host_status])
        .run(tauri::generate_context!())
        .expect("error while running Vapourkit Tauri host");
}
