//! Validate a user-selected VapourSynth script using vspipe --info.
//! This executes the selected script and its imports. Only run trusted scripts.
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptCheck {
    pub valid: bool,
    pub details: String,
    pub script: String,
}

pub fn inspect_script(script: String) -> Result<ScriptCheck, String> {
    let path = PathBuf::from(&script).canonicalize().map_err(|e| e.to_string())?;
    if !path.is_file() || path.extension().and_then(|s| s.to_str()) != Some("vpy") {
        return Err("Select an existing .vpy script".into());
    }
    let vspipe = super::discovery::discover("vspipe")?;
    if !vspipe.available { return Err(format!("VSPipe unavailable: {}", vspipe.detail)); }
    let mut cmd = Command::new(&vspipe.path);
    cmd.args(["--info"]).arg(&path).arg("-");
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take().ok_or("No stderr")?;
    let stdout_thread = std::thread::spawn(move || {
        BufReader::new(stdout).lines().take(256).filter_map(Result::ok).collect::<Vec<_>>().join("\n")
    });
    let stderr_thread = std::thread::spawn(move || {
        BufReader::new(stderr).lines().take(256).filter_map(Result::ok).collect::<Vec<_>>().join("\n")
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(40)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("VapourSynth script check timed out after 30 seconds".into());
            }
        }
    };
    let out = stdout_thread.join().unwrap_or_default();
    let err = stderr_thread.join().unwrap_or_default();
    let details = if status.success() { out } else { err };
    Ok(ScriptCheck { valid: status.success(), details: details.chars().take(4000).collect(), script: path.display().to_string() })
}
