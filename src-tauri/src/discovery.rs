use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolLocation {
    pub tool: String,
    pub source: &'static str,
    pub path: String,
    pub available: bool,
    pub detail: String,
}

fn relative_tool(tool: &str) -> Option<&'static str> {
    match tool {
        "ffmpeg" => Some(if cfg!(windows) { "ffmpeg/bin/ffmpeg.exe" } else { "ffmpeg/bin/ffmpeg" }),
        "ffprobe" => Some(if cfg!(windows) { "ffmpeg/bin/ffprobe.exe" } else { "ffmpeg/bin/ffprobe" }),
        "python" => Some(if cfg!(windows) { "vapoursynth-portable/python.exe" } else { "vapoursynth-portable/bin/python3" }),
        "vspipe" => Some(if cfg!(windows) { "vapoursynth-portable/Lib/site-packages/vapoursynth/vspipe.exe" } else { "" }),
        _ => None,
    }
}

fn executable(tool: &str) -> Option<&'static str> {
    match tool {
        "ffmpeg" => Some(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" }),
        "ffprobe" => Some(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" }),
        "vspipe" => Some(if cfg!(windows) { "vspipe.exe" } else { "vspipe" }),
        "python" => Some(if cfg!(windows) { "python.exe" } else { "python3" }),
        _ => None,
    }
}

/// Only discover under known Vapourkit data roots; never accept a renderer-supplied root.
fn data_roots(exe: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(parent) = exe.parent() {
        roots.push(parent.join("data"));
        // Development layouts may put the executable under src-tauri/target/release.
        for ancestor in parent.ancestors().take(5) {
            roots.push(ancestor.join("data"));
        }
    }
    if !cfg!(windows) {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            roots.push(PathBuf::from(xdg).join("vapourkit/data"));
        }
        if let Some(home) = std::env::var_os("HOME") {
            roots.push(PathBuf::from(home).join(".local/share/vapourkit/data"));
        }
    }
    roots.dedup();
    roots
}

fn candidates(tool: &str, exe: &Path) -> Result<Vec<(PathBuf, &'static str)>, String> {
    let relative = relative_tool(tool).ok_or("Unsupported diagnostic tool")?;
    let mut result = Vec::new();
    if !relative.is_empty() {
        for root in data_roots(exe) {
            result.push((root.join(relative), "vapourkit-data"));
        }
    }
    // vspipe on Linux may be a venv console script rather than a binary in site-packages.
    if tool == "vspipe" && !cfg!(windows) {
        for root in data_roots(exe) {
            result.push((root.join("vapoursynth-portable/bin/vspipe"), "vapourkit-data"));
        }
    }
    result.push((PathBuf::from(executable(tool).ok_or("Unsupported tool")?), "system-path"));
    Ok(result)
}

fn run_version(path: &Path, tool: &str) -> ToolLocation {
    let args: &[&str] = if tool == "vspipe" || tool == "python" { &["--version"] } else { &["-version"] };
    let source = if path.components().count() == 1 { "system-path" } else { "vapourkit-data" };
    let mut command = Command::new(path);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return ToolLocation {
            tool: tool.into(), source, path: path.display().to_string(),
            available: false, detail: error.to_string(),
        },
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    let timed_out = loop {
        match child.try_wait() {
            Ok(Some(_)) => break false,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => { let _ = child.kill(); break true; }
        }
    };
    let output = child.wait_with_output();
    let (available, detail) = match output {
        Ok(output) if !timed_out => {
            let bytes = if output.stdout.is_empty() { &output.stderr } else { &output.stdout };
            (output.status.success(), String::from_utf8_lossy(bytes).lines().next().unwrap_or("No version output").chars().take(300).collect())
        }
        Ok(_) => (false, "Version probe timed out after 5 seconds".into()),
        Err(error) => (false, error.to_string()),
    };
    ToolLocation { tool: tool.into(), source, path: path.display().to_string(), available, detail }
}

pub fn discover(tool: &str) -> Result<ToolLocation, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let options = candidates(tool, &exe)?;
    let mut fallback = None;
    for (path, _) in options {
        if path.components().count() > 1 && !path.is_file() { continue; }
        let probe = run_version(&path, tool);
        if probe.available { return Ok(probe); }
        fallback = Some(probe);
    }
    Ok(fallback.unwrap_or(ToolLocation {
        tool: tool.into(), source: "not-found", path: String::new(),
        available: false, detail: "Not found in Vapourkit data or system PATH".into(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cannot_discover_arbitrary_commands() {
        assert!(candidates("powershell", Path::new("/tmp/vapourkit")).is_err());
        assert!(candidates("../ffmpeg", Path::new("/tmp/vapourkit")).is_err());
    }
    #[test]
    fn bundled_precedes_system_path() {
        let options = candidates("ffmpeg", Path::new("/test/vapourkit")).unwrap();
        assert_eq!(options.first().unwrap().1, "vapourkit-data");
        assert_eq!(options.last().unwrap().1, "system-path");
    }
}
