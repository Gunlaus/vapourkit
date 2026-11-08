//! Experimental single-job FFmpeg transcode service. Does not run VapourSynth filters.
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodeOptions {
    pub encoder: String,
    pub quality: u8,
    pub preset: String,
    pub audio_tracks: Vec<u64>,
    pub subtitle_tracks: Vec<u64>,
    pub copy_audio: bool,
}

impl Default for EncodeOptions {
    fn default() -> Self {
        Self { encoder: "libx264".into(), quality: 20, preset: "medium".into(),
            audio_tracks: Vec::new(), subtitle_tracks: Vec::new(), copy_audio: false }
    }
}

fn encoding_args(options: &EncodeOptions, streams: &[super::metadata::StreamInfo]) -> Result<Vec<String>, String> {
    let (quality_arg, presets): (&str, &[&str]) = match options.encoder.as_str() {
        "libx264" | "libx265" => ("-crf", &["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"]),
        "h264_nvenc" | "hevc_nvenc" | "av1_nvenc" => ("-cq", &["p1", "p2", "p3", "p4", "p5", "p6", "p7"]),
        _ => return Err("Unsupported video encoder".into()),
    };
    if options.quality > 51 || !presets.contains(&options.preset.as_str()) {
        return Err("Invalid quality or encoder preset".into());
    }
    let mut args = vec!["-map".into(), "0:v:0".into()];
    for (tracks, kind) in [(&options.audio_tracks, "audio"), (&options.subtitle_tracks, "subtitle")] {
        for &index in tracks {
            if !streams.iter().any(|s| s.index == index && s.codec_type == kind) {
                return Err(format!("Invalid {kind} stream index {index}"));
            }
            args.extend(["-map".into(), format!("0:{index}")]);
        }
    }
    args.extend(["-c:v".into(), options.encoder.clone(), "-preset".into(), options.preset.clone(),
        quality_arg.into(), options.quality.to_string()]);
    if options.encoder.ends_with("_nvenc") {
        args.extend(["-rc".into(), "vbr".into(), "-b:v".into(), "0".into()]);
    }
    args.extend(["-c:a".into(), if options.copy_audio { "copy" } else { "aac" }.into()]);
    if !options.copy_audio { args.extend(["-b:a".into(), "192k".into()]); }
    args.extend(["-c:s".into(), "copy".into(), "-dn".into()]);
    // MP4 cannot mux many subtitle codecs; fail early rather than producing
    // a cryptic FFmpeg muxer error. Container checks happen at the call site.
    Ok(args)
}

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

pub fn transcode(app: AppHandle, state: Arc<EncoderState>, input: String, output: String, options: EncodeOptions) -> Result<(), String> {
    let (source, destination) = validate(&input, &output)?;
    let media = super::metadata::inspect(&input)?;
    let args = encoding_args(&options, &media.streams)?;
    let is_mp4 = destination.extension().and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("mp4")).unwrap_or(false);
    if is_mp4 && !options.subtitle_tracks.is_empty() {
        return Err("Subtitle stream copy to MP4 is unsupported in this preview; use MKV or deselect subtitles".into());
    }
    let ffmpeg = super::discovery::discover("ffmpeg")?;
    if !ffmpeg.available { return Err(format!("FFmpeg unavailable: {}", ffmpeg.detail)); }

    // Reserve the slot before spawning so simultaneous requests cannot start two jobs.
    let mut slot = state.child.lock().map_err(|e| e.to_string())?;
    if slot.is_some() { return Err("An encode is already running".into()); }
    state.cancelled.store(false, Ordering::SeqCst);
    let mut command = Command::new(ffmpeg.path);
    command.args(["-hide_banner", "-nostdin", "-n", "-i"])
        .arg(&source)
        .args(args)
        .args(["-progress", "pipe:1", "-nostats"])
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
    fn rejects_unknown_encoders() {
        let mut options = EncodeOptions::default();
        options.encoder = "arbitrary_command".into();
        assert!(encoding_args(&options, &[]).is_err());
    }
    #[test]
    fn rejects_invalid_track_selection() {
        let mut options = EncodeOptions::default();
        options.audio_tracks.push(100);
        assert!(encoding_args(&options, &[]).is_err());
    }
    #[test]
    fn allows_nvenc_preset() {
        let options = EncodeOptions { encoder: "hevc_nvenc".into(), preset: "p5".into(), ..Default::default() };
        assert!(encoding_args(&options, &[]).unwrap().contains(&"hevc_nvenc".to_string()));
    }
    #[test]
    fn rejects_nonexistent_input() {
        assert!(validate("missing-video-27b8.mkv", "output.mkv").is_err());
    }
}
