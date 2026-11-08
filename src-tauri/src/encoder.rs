//! Experimental single-job FFmpeg transcode service. Does not run VapourSynth filters.
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct EncoderState {
    child: Mutex<Option<Arc<Mutex<Child>>>>,
    cancelled: AtomicBool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodeEvent {
    pub status: String,
    pub detail: String,
    pub out_time_ms: Option<u64>,
    pub speed: Option<String>,
}

fn emit(app: &AppHandle, status: &str, detail: impl Into<String>, out_time_ms: Option<u64>, speed: Option<String>) {
    let _ = app.emit("native-encode-progress", EncodeEvent {
        status: status.to_owned(), detail: detail.into(), out_time_ms, speed,
    });
}

fn validate(input: &str, output: &str) -> Result<(PathBuf, PathBuf), String> {
    let source = PathBuf::from(input).canonicalize().map_err(|e| format!("Input: {e}"))?;
    if !source.is_file() { return Err("Input is not a regular file".into()); }
    let destination = PathBuf::from(output);
    let parent = destination.parent().filter(|p| !p.as_os_str().is_empty())
        .ok_or("Output must include a parent directory")?;
    let parent = parent.canonicalize().map_err(|e| format!("Output directory: {e}"))?;
    if !parent.is_dir() { return Err("Output directory does not exist".into()); }
    let filename = destination.file_name().ok_or("Invalid output filename")?;
    let destination = parent.join(filename);
    if source == destination { return Err("Input and output must differ".into()); }
    if destination.exists() { return Err("Output already exists; refusing to overwrite".into()); }
    let ext = destination.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    if !["mp4", "mkv", "mov"].contains(&ext.as_str()) {
        return Err("Experimental encoder supports .mp4, .mkv, and .mov only".into());
    }
    Ok((source, destination))
}

pub fn transcode(app: AppHandle, state: Arc<EncoderState>, input: String, output: String) -> Result<(), String> {
    let (source, destination) = validate(&input, &output)?;
    let ffmpeg = super::discovery::discover("ffmpeg")?;
    if !ffmpeg.available { return Err(format!("FFmpeg unavailable: {}", ffmpeg.detail)); }

    // Reserve the slot before spawning so simultaneous requests cannot start two jobs.
    let mut slot = state.child.lock().map_err(|e| e.to_string())?;
    if slot.is_some() { return Err("An encode is already running".into()); }
    state.cancelled.store(false, Ordering::SeqCst);
    let mut command = Command::new(ffmpeg.path);
    command.args(["-hide_banner", "-nostdin", "-n", "-i"])
        .arg(&source)
        .args(["-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264",
            "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "192k",
            "-sn", "-dn", "-progress", "pipe:1", "-nostats"])
        .arg(&destination)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|e| format!("Failed to start FFmpeg: {e}"))?;
    let stdout = child.stdout.take().ok_or("FFmpeg stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("FFmpeg stderr unavailable")?;
    let child = Arc::new(Mutex::new(child));
    *slot = Some(Arc::clone(&child));
    drop(slot);
    emit(&app, "running", "FFmpeg encoding started", None, None);

    // Drain stderr until EOF, retaining only its tail. A bounded read that stops
    // draining can fill FFmpeg's stderr pipe and deadlock the encoder.
    let error_reader = std::thread::spawn(move || {
        let mut tail = String::new();
        for line in BufReader::new(stderr).lines() {
            match line {
                Ok(line) => {
                    tail.push_str(&line);
                    tail.push('\n');
                    if tail.len() > 8192 {
                        let mut cut = tail.len() - 4096;
                        while !tail.is_char_boundary(cut) { cut += 1; }
                        tail.drain(..cut);
                    }
                }
                Err(_) => break,
            }
        }
        tail
    });
    let mut out_time_ms = None;
    let mut speed = None;
    for line in BufReader::new(stdout).lines() {
        let line = match line { Ok(line) => line, Err(_) => break };
        if let Some(v) = line.strip_prefix("out_time_ms=") {
            // FFmpeg's out_time_ms is actually microseconds.
            out_time_ms = v.parse::<u64>().ok().map(|n| n / 1000);
        } else if let Some(v) = line.strip_prefix("speed=") {
            speed = Some(v.to_owned());
        } else if line.starts_with("progress=") {
            emit(&app, "running", "Encoding", out_time_ms, speed.clone());
        }
    }
    let status = loop {
        let result = child.lock().map_err(|e| e.to_string())?.try_wait();
        match result {
            Ok(Some(exit)) => break Ok(exit),
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(30)),
            Err(error) => break Err(error),
        }
    };
    let errors = error_reader.join().unwrap_or_default();
    let cancelled = state.cancelled.swap(false, Ordering::SeqCst);
    *state.child.lock().map_err(|e| e.to_string())? = None;
    if cancelled {
        // A cancelled encode may leave an incomplete file. Remove only the
        // destination validated for this job, never an existing user file.
        let _ = std::fs::remove_file(&destination);
        emit(&app, "cancelled", "Encoding cancelled", out_time_ms, speed);
        return Ok(());
    }
    match status {
        Ok(exit) if exit.success() => {
            emit(&app, "completed", "Encoding completed", out_time_ms, speed);
            Ok(())
        }
        Ok(exit) => {
            let message = format!("FFmpeg exited with {exit}: {}", errors.chars().rev().take(1200).collect::<String>().chars().rev().collect::<String>());
            emit(&app, "failed", &message, out_time_ms, speed);
            Err(message)
        }
        Err(e) => {
            emit(&app, "failed", e.to_string(), out_time_ms, speed);
            Err(e.to_string())
        }
    }
}

pub fn cancel(state: &EncoderState) -> Result<bool, String> {
    let slot = state.child.lock().map_err(|e| e.to_string())?;
    if let Some(child) = slot.as_ref() {
        child.lock().map_err(|e| e.to_string())?.kill().map_err(|e| e.to_string())?;
        state.cancelled.store(true, Ordering::SeqCst);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_nonexistent_input() {
        assert!(validate("missing-video-27b8.mkv", "output.mkv").is_err());
    }
}
