//! Read-only VapourSynth runtime preflight. Does not execute user scripts.
use serde::Serialize;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub available: bool,
    pub python: String,
    pub version: String,
    pub detail: String,
}

pub fn check() -> Result<Preflight, String> {
    let python = super::discovery::discover("python")?;
    if !python.available {
        return Ok(Preflight { available: false, python: python.path, version: String::new(),
            detail: format!("Python unavailable: {}", python.detail) });
    }
    // No arbitrary user code. The import/version probe is a fixed expression.
    let mut child = Command::new(&python.path)
        .args(["-c", "import vapoursynth as vs; print(vs.core.version_string())"])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => { let _ = child.kill(); let _ = child.wait(); return Err("VapourSynth preflight timed out".into()); }
        }
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    let available = output.status.success();
    let message = if available { &output.stdout } else { &output.stderr };
    let detail = String::from_utf8_lossy(message).chars().take(600).collect::<String>();
    Ok(Preflight { available, python: python.path,
        version: if available { detail.lines().next().unwrap_or("").to_string() } else { String::new() },
        detail: detail.trim().to_string() })
}
