//! Experimental host-only settings, isolated from Electron's production data.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeSettings {
    #[serde(default)]
    pub last_input_directory: String,
    #[serde(default)]
    pub preferred_video_encoder: String,
}

fn settings_path() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let parent = executable.parent().ok_or("Missing executable directory")?;
    // Never write into Electron's data/config until its schema is migrated.
    #[cfg(windows)]
    let root = parent.join("data").join("tauri-preview");
    #[cfg(not(windows))]
    let root = {
        let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from).unwrap_or_else(|| PathBuf::from(home).join(".config"));
        base.join("vapourkit-tauri-preview")
    };
    Ok(root.join("settings.json"))
}

pub fn load() -> Result<NativeSettings, String> {
    let path = settings_path()?;
    if !path.exists() { return Ok(NativeSettings::default()); }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| format!("Invalid native settings: {e}"))
}

pub fn save(settings: NativeSettings) -> Result<(), String> {
    if settings.last_input_directory.len() > 4096 || settings.preferred_video_encoder.len() > 80 {
        return Err("Settings exceed allowed size".into());
    }
    let path = settings_path()?;
    let parent = path.parent().ok_or("Invalid settings directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    if path.exists() {
        // Windows rename cannot replace an existing destination.
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unrecognized_keys() {
        assert!(serde_json::from_str::<NativeSettings>(r#"{"unknown":true}"#).is_err());
    }
    #[test]
    fn accepts_empty_settings() {
        let value: NativeSettings = serde_json::from_str("{}").unwrap();
        assert!(value.last_input_directory.is_empty());
    }
}
