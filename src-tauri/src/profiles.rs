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
    Ok(super::storage::preview_root()?.join("profiles"))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn list() -> Result<Vec<Profile>, String> {
    let dir = directory()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Some(profile) = super::storage::read_json::<Profile>(&path, 16384)? else {
            continue;
        };
        if !valid_name(&profile.name) {
            return Err("Invalid stored profile name".into());
        }
        super::encoder::validate_options(&profile.options)?;
        result.push(profile);
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

pub fn save(profile: Profile) -> Result<(), String> {
    if !valid_name(&profile.name) {
        return Err("Profile names must contain only letters, numbers, - and _ (max 64)".into());
    }
    super::encoder::validate_options(&profile.options)?;
    let dir = directory()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", profile.name));
    super::storage::write_json(&path, &profile)
}

pub fn delete(name: &str) -> Result<(), String> {
    if !valid_name(name) {
        return Err("Invalid profile name".into());
    }
    let path = directory()?.join(format!("{name}.json"));
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
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
