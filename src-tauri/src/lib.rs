//! Native host services. Electron remains the production host until parity.

mod discovery;
mod metadata;
mod encoder;
mod settings;
mod profiles;
mod vapoursynth;
mod script_check;

use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

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
        migration_stage: "native-diagnostics",
        platform: std::env::consts::OS,
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DependencyProbe {
    tool: String,
    available: bool,
    detail: String,
}

/// Deliberately allowlisted. Renderer callers cannot supply arbitrary programs,
/// arguments, shell commands or paths. No shell is involved.
fn tool_command(tool: &str) -> Option<(&'static str, &'static [&'static str])> {
    match tool {
        "ffmpeg" => Some(("ffmpeg", &["-version"])),
        "ffprobe" => Some(("ffprobe", &["-version"])),
        "vspipe" => Some(("vspipe", &["--version"])),
        "python" => Some((if cfg!(windows) { "python" } else { "python3" }, &["--version"])),
        _ => None,
    }
}

fn probe(tool: &str) -> Result<DependencyProbe, String> {
    let (program, args) = tool_command(tool).ok_or("Unsupported diagnostic tool")?;
    let mut child = match Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return Ok(DependencyProbe {
                tool: tool.to_string(),
                available: false,
                detail: format!("Could not start {program}: {error}"),
            });
        }
    };

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(DependencyProbe {
                    tool: tool.to_string(),
                    available: false,
                    detail: "Version probe timed out after 5 seconds".into(),
                });
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Failed waiting for {program}: {error}"));
            }
        }
    }

    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    let detail = String::from_utf8_lossy(if output.stdout.is_empty() {
        &output.stderr
    } else {
        &output.stdout
    })
    .lines()
    .next()
    .unwrap_or("No version information")
    .chars()
    .take(300)
    .collect();

    Ok(DependencyProbe {
        tool: tool.to_string(),
        available: output.status.success(),
        detail,
    })
}

#[tauri::command]
async fn probe_dependency(tool: String) -> Result<DependencyProbe, String> {
    // Process probes must not block Tauri's asynchronous runtime.
    tauri::async_runtime::spawn_blocking(move || probe(&tool))
        .await
        .map_err(|error| error.to_string())?
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
async fn encode_sample(app: tauri::AppHandle, state: tauri::State<'_, Arc<encoder::EncoderState>>, input: String, output: String, options: encoder::EncodeOptions) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || encoder::transcode(app, state, input, output, options))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn cancel_sample(state: tauri::State<'_, Arc<encoder::EncoderState>>) -> Result<bool, String> {
    encoder::cancel(state.inner())
}

#[tauri::command]
async fn load_native_settings() -> Result<settings::NativeSettings, String> {
    tauri::async_runtime::spawn_blocking(settings::load)
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_native_settings(settings: settings::NativeSettings) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || settings::save(settings))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_native_profiles() -> Result<Vec<profiles::Profile>, String> {
    tauri::async_runtime::spawn_blocking(profiles::list).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_native_profile(profile: profiles::Profile) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || profiles::save(profile)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_native_profile(name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || profiles::delete(&name)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn vapoursynth_preflight() -> Result<vapoursynth::Preflight, String> {
    tauri::async_runtime::spawn_blocking(vapoursynth::check).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn inspect_vapoursynth_script(script: String) -> Result<script_check::ScriptCheck, String> {
    tauri::async_runtime::spawn_blocking(move || script_check::inspect_script(script))
        .await.map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(encoder::EncoderState::default()))
        .invoke_handler(tauri::generate_handler![host_status, probe_dependency, discover_dependency, inspect_media, encode_sample, cancel_sample, load_native_settings, save_native_settings, list_native_profiles, save_native_profile, delete_native_profile, vapoursynth_preflight, inspect_vapoursynth_script])
        .run(tauri::generate_context!())
        .expect("error while running Vapourkit Tauri host");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_arbitrary_executables() {
        assert!(tool_command("cmd.exe").is_none());
        assert!(tool_command("../ffmpeg").is_none());
        assert!(tool_command("ffmpeg -y").is_none());
    }

    #[test]
    fn allowlists_expected_tools() {
        for name in ["ffmpeg", "ffprobe", "vspipe", "python"] {
            assert!(tool_command(name).is_some());
        }
    }

    #[test]
    fn rejects_unknown_probe_without_execution() {
        assert!(probe("sh").is_err());
    }
}
