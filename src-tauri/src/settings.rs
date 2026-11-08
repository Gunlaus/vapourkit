//! Experimental host-only settings, isolated from Electron's production data.
use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeSettings {
    #[serde(default)]
    pub last_input_directory: String,
    #[serde(default)]
    pub preferred_video_encoder: String,
}

pub fn load() -> Result<NativeSettings, String> {
    super::storage::read_json(
        &super::storage::preview_root()?.join("settings.json"),
        16384,
    )
    .map(|s| s.unwrap_or_default())
}

pub fn save(settings: NativeSettings) -> Result<(), String> {
    if settings.last_input_directory.len() > 4096 || settings.preferred_video_encoder.len() > 80 {
        return Err("Settings exceed allowed size".into());
    }
    super::storage::write_json(
        &super::storage::preview_root()?.join("settings.json"),
        &settings,
    )
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
