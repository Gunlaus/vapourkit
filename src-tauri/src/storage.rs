//! App-owned data paths and crash-safe JSON writes. Production data stays read-only.
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub fn preview_root() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        Ok(exe
            .parent()
            .ok_or("Missing executable directory")?
            .join("data/tauri-preview"))
    }
    #[cfg(not(windows))]
    {
        Ok(config_base()?.join("vapourkit-tauri-preview"))
    }
}

pub fn config_base() -> Result<PathBuf, String> {
    if let Some(root) = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
    {
        return Ok(root);
    }
    std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join(".config"))
        .ok_or("HOME is not set".into())
}

pub fn read_json<T: DeserializeOwned>(path: &Path, limit: u64) -> Result<Option<T>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Not a regular JSON file".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(format!("JSON file exceeds {limit} bytes"));
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| format!("Invalid {}: {e}", path.display()))
}

pub fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing JSON directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temporary.write_all(&bytes).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    // persist atomically replaces on Windows too. Never delete the old file first.
    temporary.persist(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replaces_complete_documents_and_preserves_corrupt_input() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        write_json(&path, &vec![1, 2]).unwrap();
        write_json(&path, &vec![3]).unwrap();
        assert_eq!(read_json::<Vec<u8>>(&path, 100).unwrap().unwrap(), [3]);
        fs::write(&path, b"broken").unwrap();
        assert!(read_json::<Vec<u8>>(&path, 100).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"broken");
        assert!(read_json::<Vec<u8>>(&path, 2).is_err());
    }
}
