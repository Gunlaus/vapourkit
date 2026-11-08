//! Validate a user-selected VapourSynth script using vspipe --info.
//! This executes the selected script and its imports. Only run trusted scripts.
use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptCheck {
    pub valid: bool,
    pub details: String,
    pub script: String,
}

pub fn inspect_script(script: String) -> Result<ScriptCheck, String> {
    let path = PathBuf::from(&script)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.is_file() || path.extension().and_then(|s| s.to_str()) != Some("vpy") {
        return Err("Select an existing .vpy script".into());
    }
    let vspipe = super::discovery::discover("vspipe")?;
    if !vspipe.available {
        return Err(format!("VSPipe unavailable: {}", vspipe.detail));
    }
    let result = super::process::capture(
        super::process::command(&vspipe.path)
            .arg("--info")
            .arg(&path)
            .arg("-"),
        Duration::from_secs(30),
        16 * 1024,
    )?;
    let status = result.status;
    let details = format!(
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    Ok(ScriptCheck {
        valid: status.success(),
        details: details.chars().take(4000).collect(),
        script: path.display().to_string(),
    })
}
