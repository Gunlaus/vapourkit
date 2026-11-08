use crate::{discovery, encoder, metadata, profiles, queue, script_check, settings, vapoursynth};
use std::sync::Arc;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HostStatus {
    host: &'static str,
    migration_stage: &'static str,
    platform: &'static str,
}

#[tauri::command]
fn host_status() -> HostStatus {
    HostStatus {
        host: "tauri",
        migration_stage: "native-processing-preview",
        platform: std::env::consts::OS,
    }
}

#[tauri::command]
fn native_processing_status(state: tauri::State<'_, Arc<encoder::EncoderState>>) -> bool {
    encoder::is_busy(state.inner())
}

#[tauri::command]
async fn discover_dependency(tool: String) -> Result<discovery::ToolLocation, String> {
    tauri::async_runtime::spawn_blocking(move || discovery::discover(&tool))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn inspect_media(path: String) -> Result<metadata::MediaInfo, String> {
    tauri::async_runtime::spawn_blocking(move || metadata::inspect(&path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn encode_sample(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<encoder::EncoderState>>,
    input: String,
    output: String,
    options: encoder::EncodeOptions,
    script: Option<String>,
) -> Result<String, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        encoder::transcode(state, input, output, options, script, progress_sink(app))
    })
    .await
    .map_err(|error| error.to_string())?
    .map(|outcome| match outcome {
        encoder::Outcome::Completed => "completed".into(),
        encoder::Outcome::Cancelled => "cancelled".into(),
    })
}

#[tauri::command]
fn cancel_sample(state: tauri::State<'_, Arc<encoder::EncoderState>>) -> Result<bool, String> {
    encoder::cancel(state.inner())
}

#[tauri::command]
async fn load_native_settings() -> Result<settings::NativeSettings, String> {
    tauri::async_runtime::spawn_blocking(settings::load)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_native_settings(settings: settings::NativeSettings) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || settings::save(settings))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_native_profiles() -> Result<Vec<profiles::Profile>, String> {
    tauri::async_runtime::spawn_blocking(profiles::list)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_native_profile(profile: profiles::Profile) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || profiles::save(profile))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_native_profile(name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || profiles::delete(&name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn vapoursynth_preflight() -> Result<vapoursynth::Preflight, String> {
    tauri::async_runtime::spawn_blocking(vapoursynth::check)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn inspect_vapoursynth_script(script: String) -> Result<script_check::ScriptCheck, String> {
    tauri::async_runtime::spawn_blocking(move || script_check::inspect_script(script))
        .await
        .map_err(|e| e.to_string())?
}

fn progress_sink(app: tauri::AppHandle) -> encoder::ProgressSink {
    Arc::new(move |event| {
        let _ = app.emit("native-encode-progress", event);
    })
}
fn queue_sink(app: tauri::AppHandle) -> queue::QueueSink {
    Arc::new(move |snapshot| {
        let _ = app.emit("native-queue-changed", snapshot);
    })
}
#[derive(Default)]
struct QueueService(Mutex<Option<Arc<queue::QueueState>>>);
impl QueueService {
    fn get(&self) -> Result<Arc<queue::QueueState>, String> {
        let mut slot = self.0.lock().map_err(|e| e.to_string())?;
        if let Some(queue) = slot.as_ref() {
            return Ok(queue.clone());
        }
        let queue = Arc::new(queue::QueueState::open(
            crate::storage::preview_root()?.join("queue.json"),
        )?);
        *slot = Some(queue.clone());
        Ok(queue)
    }
    fn is_running(&self) -> bool {
        self.0
            .lock()
            .map(|slot| {
                slot.as_ref()
                    .is_some_and(|q| q.snapshot().map(|s| s.running).unwrap_or(true))
            })
            .unwrap_or(true)
    }
}
#[tauri::command]
async fn native_queue_snapshot(
    service: tauri::State<'_, Arc<QueueService>>,
) -> Result<queue::Snapshot, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.get()?.snapshot())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn edit_native_queue(
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<QueueService>>,
    edit: queue::Edit,
) -> Result<queue::Snapshot, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = service.get()?.edit(edit)?;
        queue_sink(app)(snapshot.clone());
        Ok(snapshot)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn run_native_queue(
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<QueueService>>,
    encoder: tauri::State<'_, Arc<encoder::EncoderState>>,
) -> Result<(), String> {
    let service = service.inner().clone();
    let encoder = encoder.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service
            .get()?
            .run(encoder, progress_sink(app.clone()), queue_sink(app))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn stop_native_queue(
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<QueueService>>,
    encoder: tauri::State<'_, Arc<encoder::EncoderState>>,
) -> Result<queue::Snapshot, String> {
    let service = service.inner().clone();
    let encoder = encoder.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = service.get()?.stop(&encoder)?;
        queue_sink(app)(snapshot.clone());
        Ok(snapshot)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn select_native_file(app: tauri::AppHandle, kind: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().file();
        let dialog = match kind.as_str() {
            "video" => dialog.add_filter(
                "Video",
                &["mkv", "mp4", "mov", "avi", "webm", "m4v", "ts", "m2ts"],
            ),
            "script" => dialog.add_filter("VapourSynth script", &["vpy"]),
            _ => return Err("Unsupported file selection".into()),
        };
        dialog
            .blocking_pick_file()
            .map(|p| {
                p.into_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|e| e.to_string())
            })
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn select_native_output(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Video output", &["mkv", "mp4", "mov"])
            .set_file_name("output.mkv")
            .blocking_save_file()
            .map(|p| {
                p.into_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|e| e.to_string())
            })
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn read_native_frame(
    path: String,
    seconds: f64,
    width: u32,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::preview::frame(&path, seconds, width).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn check_native_encoder(encoder: String) -> Result<crate::preview::EncoderCheck, String> {
    tauri::async_runtime::spawn_blocking(move || crate::preview::check_encoder(&encoder))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let encoder = Arc::new(encoder::EncoderState::default());
    let queue = Arc::new(QueueService::default());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(encoder.clone())
        .manage(queue.clone())
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if encoder::is_busy(&encoder) || queue.is_running() {
                    api.prevent_close();
                    let _ = window.emit(
                        "native-close-blocked",
                        "Stop encoding and the batch queue before closing Vapourkit.",
                    );
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            host_status,
            native_processing_status,
            discover_dependency,
            inspect_media,
            encode_sample,
            cancel_sample,
            load_native_settings,
            save_native_settings,
            list_native_profiles,
            save_native_profile,
            delete_native_profile,
            vapoursynth_preflight,
            inspect_vapoursynth_script,
            native_queue_snapshot,
            edit_native_queue,
            run_native_queue,
            stop_native_queue,
            select_native_file,
            select_native_output,
            read_native_frame,
            check_native_encoder
        ])
        .build(tauri::generate_context!())
        .expect("error building Vapourkit Tauri host")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                encoder::shutdown(app.state::<Arc<encoder::EncoderState>>().inner());
            }
        });
}
