//! Portable, typed encoding profiles. No arbitrary FFmpeg arguments or shell commands.
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub name: String,
    pub options: super::encoder::EncodeOptions,
}

fn directory() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let parent = exe.parent().ok_or("No executable directory")?;
    #[cfg(windows)]
    { Ok(parent.join("data/tauri-preview/profiles")) }
    #[cfg(not(windows))]
    {
        let home = std::env::var_os("HOME").ok_or("HOME missing")?;
        let root = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(home).join(".config"));
        Ok(root.join("vapourkit-tauri-preview/profiles"))
    }
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 &&
        name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn list() -> Result<Vec<Profile>, String> {
    let dir = directory()?;
    if !dir.exists() { return Ok(Vec::new()); }
    let mut result = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        if bytes.len() > 16384 { return Err("Profile file too large".into()); }
        let profile: Profile = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if !valid_name(&profile.name) { return Err("Invalid stored profile name".into()); }
        result.push(profile);
    }
    result.sort_by(|a,b| a.name.cmp(&b.name));
    Ok(result)
}

pub fn save(profile: Profile) -> Result<(), String> {
    if !valid_name(&profile.name) { return Err("Profile names must contain only letters, numbers, - and _ (max 64)".into()); }
    super::encoder::validate_options(&profile.options)?;
    let dir = directory()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", profile.name));
    let bytes = serde_json::to_vec_pretty(&profile).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{}.tmp", profile.name));
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    if path.exists() { fs::remove_file(&path).map_err(|e| e.to_string())?; }
    fs::rename(tmp, path).map_err(|e| e.to_string())
}

pub fn delete(name: &str) -> Result<(), String> {
    if !valid_name(name) { return Err("Invalid profile name".into()); }
    let path = directory()?.join(format!("{name}.json"));
    if path.exists() { fs::remove_file(path).map_err(|e| e.to_string())?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocks_path_traversal() {
        assert!(!valid_name("../config"));
        assert!(!valid_name("a/b"));
        assert!(valid_name("Anime_HEVC-01"));
    }
}
