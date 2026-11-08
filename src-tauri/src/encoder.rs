//! Supervised FFmpeg/VSPipe jobs. No shell, arbitrary arguments, or output overwrite.
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
        Self {
            encoder: "libx264".into(),
            quality: 20,
            preset: "medium".into(),
            audio_tracks: Vec::new(),
            subtitle_tracks: Vec::new(),
            copy_audio: false,
        }
    }
}

pub fn validate_options(options: &EncodeOptions) -> Result<(), String> {
    let presets: &[&str] = match options.encoder.as_str() {
        "libx264" | "libx265" => &[
            "ultrafast",
            "superfast",
            "veryfast",
            "faster",
            "fast",
            "medium",
            "slow",
            "slower",
            "veryslow",
        ],
        "h264_nvenc" | "hevc_nvenc" | "av1_nvenc" => &["p1", "p2", "p3", "p4", "p5", "p6", "p7"],
        _ => return Err("Unsupported video encoder".into()),
    };
    if options.quality > 51 || !presets.contains(&options.preset.as_str()) {
        return Err("Invalid quality or encoder preset".into());
    }
    for tracks in [&options.audio_tracks, &options.subtitle_tracks] {
        let unique: std::collections::HashSet<_> = tracks.iter().collect();
        if tracks.len() > 64 || unique.len() != tracks.len() {
            return Err("Select at most 64 distinct tracks of each type".into());
        }
    }
    Ok(())
}

fn encoding_args(
    options: &EncodeOptions,
    streams: &[super::metadata::StreamInfo],
    source_index: u8,
) -> Result<Vec<String>, String> {
    validate_options(options)?;
    if !streams.iter().any(|s| s.codec_type == "video") {
        return Err("Input has no video stream".into());
    }
    let mut args = vec!["-map".into(), "0:v:0".into()];
    for (tracks, kind) in [
        (&options.audio_tracks, "audio"),
        (&options.subtitle_tracks, "subtitle"),
    ] {
        for &index in tracks {
            if !streams
                .iter()
                .any(|s| s.index == index && s.codec_type == kind)
            {
                return Err(format!("Invalid {kind} stream index {index}"));
            }
            args.extend(["-map".into(), format!("{source_index}:{index}")]);
        }
    }
    args.extend([
        "-map_metadata".into(),
        source_index.to_string(),
        "-c:v".into(),
        options.encoder.clone(),
        "-preset".into(),
        options.preset.clone(),
        if options.encoder.ends_with("_nvenc") {
            "-cq"
        } else {
            "-crf"
        }
        .into(),
        options.quality.to_string(),
    ]);
    if options.encoder.ends_with("_nvenc") {
        args.extend(["-rc".into(), "vbr".into(), "-b:v".into(), "0".into()]);
    }
    args.extend([
        "-c:a".into(),
        if options.copy_audio { "copy" } else { "aac" }.into(),
    ]);
    if !options.copy_audio {
        args.extend(["-b:a".into(), "192k".into()]);
    }
    args.extend(["-c:s".into(), "copy".into(), "-dn".into()]);
    Ok(args)
}

#[derive(Default)]
pub struct EncoderState {
    active: Mutex<Option<Arc<Mutex<ActiveJob>>>>,
    shutting_down: AtomicBool,
}
#[derive(Default)]
struct ActiveJob {
    children: Vec<Child>,
    cancelled: bool,
    owner: Option<String>,
    finished: bool,
}
impl Drop for ActiveJob {
    fn drop(&mut self) {
        for child in &mut self.children {
            let _ = super::process::terminate(child);
            let _ = child.wait();
        }
    }
}
struct Lease {
    state: Arc<EncoderState>,
    job: Arc<Mutex<ActiveJob>>,
}
impl Lease {
    fn reserve(state: Arc<EncoderState>, owner: Option<String>) -> Result<Self, String> {
        let job = Arc::new(Mutex::new(ActiveJob {
            owner,
            children: Vec::new(),
            cancelled: false,
            finished: false,
        }));
        {
            let mut slot = state.active.lock().map_err(|e| e.to_string())?;
            if state.shutting_down.load(Ordering::SeqCst) {
                return Err("Application is shutting down".into());
            }
            if slot.is_some() {
                return Err("An encode is already running".into());
            }
            *slot = Some(Arc::clone(&job));
        }
        Ok(Self { state, job })
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        // Kill/reap before releasing the slot, including every error path.
        if let Ok(mut job) = self.job.lock() {
            for child in &mut job.children {
                let _ = super::process::terminate(child);
                let _ = child.wait();
            }
        }
        if let Ok(mut slot) = self.state.active.lock() {
            *slot = None;
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodeEvent {
    pub status: String,
    pub detail: String,
    pub out_time_ms: Option<u64>,
    pub speed: Option<String>,
}
pub type ProgressSink = Arc<dyn Fn(EncodeEvent) + Send + Sync>;
#[derive(Debug, PartialEq)]
pub enum Outcome {
    Completed,
    Cancelled,
}

fn emit(sink: &ProgressSink, status: &str, detail: impl Into<String>) {
    sink(EncodeEvent {
        status: status.into(),
        detail: detail.into(),
        out_time_ms: None,
        speed: None,
    });
}

pub fn validate_paths(input: &str, output: &str) -> Result<(PathBuf, PathBuf), String> {
    let source = PathBuf::from(input)
        .canonicalize()
        .map_err(|e| format!("Input: {e}"))?;
    if !source.is_file() {
        return Err("Input is not a regular file".into());
    }
    let destination = PathBuf::from(output);
    if !destination.is_absolute() {
        return Err("Output must be an absolute path".into());
    }
    let parent = destination
        .parent()
        .ok_or("Output must include a parent directory")?
        .canonicalize()
        .map_err(|e| format!("Output directory: {e}"))?;
    if !parent.is_dir() {
        return Err("Output directory does not exist".into());
    }
    let filename = destination.file_name().ok_or("Invalid output filename")?;
    let destination = parent.join(filename);
    if source == destination {
        return Err("Input and output must differ".into());
    }
    // symlink_metadata also rejects dangling symlinks; exists() does not.
    match destination.symlink_metadata() {
        Ok(_) => return Err("Output already exists; refusing to overwrite".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    let ext = destination
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["mp4", "mkv", "mov"].contains(&ext.as_str()) {
        return Err("Choose .mp4, .mkv, or .mov output".into());
    }
    Ok((source, destination))
}

pub(crate) fn script_path(script: &str) -> Result<PathBuf, String> {
    let path = Path::new(script)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.is_file()
        || !path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("vpy"))
    {
        return Err("Select an existing trusted .vpy script".into());
    }
    Ok(path)
}

pub fn transcode(
    state: Arc<EncoderState>,
    input: String,
    output: String,
    options: EncodeOptions,
    script: Option<String>,
    sink: ProgressSink,
) -> Result<Outcome, String> {
    transcode_owned(
        state,
        input,
        output,
        options,
        script,
        sink,
        JobControl::default(),
    )
}

#[derive(Default)]
pub(crate) struct JobControl {
    pub owner: Option<String>,
    pub stop: Option<Arc<AtomicBool>>,
}

pub(crate) fn transcode_owned(
    state: Arc<EncoderState>,
    input: String,
    output: String,
    options: EncodeOptions,
    script: Option<String>,
    sink: ProgressSink,
    control: JobControl,
) -> Result<Outcome, String> {
    let lease = Lease::reserve(state, control.owner)?;
    emit(
        &sink,
        "preparing",
        "Inspecting source and validating encoding options",
    );
    let result = execute(
        &lease,
        input,
        output,
        options,
        script,
        &sink,
        control.stop.as_deref(),
    );
    match &result {
        Ok(Outcome::Completed) => emit(&sink, "completed", "Encoding completed"),
        Ok(Outcome::Cancelled) => emit(&sink, "cancelled", "Encoding cancelled"),
        Err(error) => emit(&sink, "failed", error),
    }
    result
}

fn execute(
    lease: &Lease,
    input: String,
    output: String,
    options: EncodeOptions,
    script: Option<String>,
    sink: &ProgressSink,
    stop: Option<&AtomicBool>,
) -> Result<Outcome, String> {
    let (source, destination) = validate_paths(&input, &output)?;
    validate_options(&options)?;
    let script = script.as_deref().map(script_path).transpose()?;
    let media = super::metadata::inspect(&input)?;
    let args = encoding_args(
        &options,
        &media.streams,
        if script.is_some() { 1 } else { 0 },
    )?;
    let extension = destination
        .extension()
        .unwrap()
        .to_str()
        .unwrap()
        .to_ascii_lowercase();
    if extension != "mkv" && !options.subtitle_tracks.is_empty() {
        return Err("Subtitle stream copy requires MKV; use MKV or deselect subtitles".into());
    }
    let ffmpeg = super::discovery::discover("ffmpeg")?;
    if !ffmpeg.available {
        return Err(format!("FFmpeg unavailable: {}", ffmpeg.detail));
    }
    let vspipe = if script.is_some() {
        let tool = super::discovery::discover("vspipe")?;
        if !tool.available {
            return Err(format!("VSPipe unavailable: {}", tool.detail));
        }
        Some(tool)
    } else {
        None
    };
    // Encode into a file owned by this job. The destination is published only on
    // success, with an atomic no-clobber operation, even if another app creates it.
    let temporary = tempfile::Builder::new()
        .prefix(".vapourkit-")
        .suffix(&format!(".{extension}"))
        .tempfile_in(destination.parent().unwrap())
        .map_err(|e| e.to_string())?;
    let producer_errors;
    let stdout;
    let stderr;
    {
        let mut job = lease.job.lock().map_err(|e| e.to_string())?;
        if job.cancelled || stop.is_some_and(|s| s.load(Ordering::SeqCst)) {
            return Ok(Outcome::Cancelled);
        }
        let mut command = super::process::command(ffmpeg.path);
        command.args(["-hide_banner", "-nostdin", "-y"]);
        if let (Some(script), Some(vspipe)) = (script, vspipe) {
            let mut producer = super::process::command(vspipe.path)
                .args(["-c", "mkv", "--outputindex", "0"])
                .arg(script)
                .arg("-")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("VSPipe: {e}"))?;
            let pipe = producer.stdout.take().expect("piped VSPipe stdout");
            let errors = producer.stderr.take().expect("piped VSPipe stderr");
            job.children.push(producer);
            producer_errors = Some(std::thread::spawn(move || {
                super::process::drain(errors, 16384)
            }));
            command
                .args(["-f", "matroska", "-i", "pipe:0", "-i"])
                .arg(&source)
                .stdin(Stdio::from(pipe));
            command.args(["-fps_mode:v:0", "passthrough"]);
        } else {
            producer_errors = None;
            command.arg("-i").arg(&source).stdin(Stdio::null());
        }
        command
            .args(args)
            .args(["-progress", "pipe:1", "-nostats"])
            .arg(temporary.path())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|e| format!("FFmpeg: {e}"))?;
        stdout = child.stdout.take().expect("piped FFmpeg stdout");
        stderr = child.stderr.take().expect("piped FFmpeg stderr");
        job.children.push(child);
    }
    emit(sink, "running", "Encoding started");
    let error_reader = std::thread::spawn(move || super::process::drain(stderr, 16384));
    let progress_sink = Arc::clone(sink);
    let progress_reader = std::thread::spawn(move || {
        // FFmpeg emits short key=value lines; cap each line to prevent unbounded
        // allocation even if a broken executable writes a huge unterminated line.
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        let mut out_time_ms = None;
        let mut speed = None;
        loop {
            let buffer = match reader.fill_buf() {
                Ok(b) if !b.is_empty() => b,
                _ => break,
            };
            let end = buffer.iter().position(|b| *b == b'\n');
            let count = end.map_or(buffer.len(), |i| i + 1);
            let keep = count.min(4096usize.saturating_sub(line.len()));
            line.extend_from_slice(&buffer[..keep]);
            reader.consume(count);
            if end.is_none() {
                continue;
            }
            let text = String::from_utf8_lossy(&line);
            let text = text.trim();
            if let Some(value) = text.strip_prefix("out_time_us=") {
                out_time_ms = value.parse::<u64>().ok().map(|v| v / 1000);
            } else if let Some(value) = text.strip_prefix("speed=") {
                speed = Some(value.to_owned());
            } else if text.starts_with("progress=") {
                progress_sink(EncodeEvent {
                    status: "running".into(),
                    detail: "Encoding".into(),
                    out_time_ms,
                    speed: speed.clone(),
                });
            }
            line.clear();
        }
    });
    let result = loop {
        let mut job = lease.job.lock().map_err(|e| e.to_string())?;
        if job.cancelled || stop.is_some_and(|s| s.load(Ordering::SeqCst)) {
            for child in &mut job.children {
                let _ = super::process::terminate(child);
                let _ = child.wait();
            }
            break Ok(Outcome::Cancelled);
        }
        let statuses: Result<Vec<_>, _> = job.children.iter_mut().map(Child::try_wait).collect();
        match statuses {
            Ok(statuses) => {
                if statuses.iter().flatten().any(|s| !s.success()) {
                    for child in &mut job.children {
                        let _ = super::process::terminate(child);
                        let _ = child.wait();
                    }
                    break Err("Encoding pipeline failed".to_owned());
                }
                if statuses.iter().all(Option::is_some) {
                    break Ok(Outcome::Completed);
                }
                // A consumer that exits before its producer cannot drain the pipe.
                if statuses.len() == 2 && statuses[1].is_some() && statuses[0].is_none() {
                    let _ = super::process::terminate(&mut job.children[0]);
                    let _ = job.children[0].wait();
                    break Err("FFmpeg exited before VSPipe finished".into());
                }
            }
            Err(e) => {
                for child in &mut job.children {
                    let _ = super::process::terminate(child);
                    let _ = child.wait();
                }
                break Err(e.to_string());
            }
        }
        drop(job);
        std::thread::sleep(Duration::from_millis(25));
    };
    let _ = progress_reader.join();
    let errors = error_reader
        .join()
        .ok()
        .and_then(Result::ok)
        .map(|r| r.0)
        .unwrap_or_default();
    let producer_errors = producer_errors
        .and_then(|t| t.join().ok())
        .and_then(Result::ok)
        .map(|r| r.0)
        .unwrap_or_default();
    match result {
        Ok(Outcome::Completed) => {
            // Serialize publication with cancellation: a completed file never gets
            // reported as cancelled, and cancel never removes someone else's file.
            let mut job = lease.job.lock().map_err(|e| e.to_string())?;
            if job.cancelled || stop.is_some_and(|s| s.load(Ordering::SeqCst)) {
                return Ok(Outcome::Cancelled);
            }
            temporary.as_file().sync_all().map_err(|e| e.to_string())?;
            temporary
                .persist_noclobber(&destination)
                .map_err(|e| format!("Could not publish output without overwrite: {e}"))?;
            job.finished = true;
            Ok(Outcome::Completed)
        }
        Ok(outcome) => Ok(outcome),
        Err(error) => Err(format!(
            "{error}\n{}\n{}",
            String::from_utf8_lossy(&producer_errors),
            String::from_utf8_lossy(&errors)
        )),
    }
}

pub fn is_busy(state: &EncoderState) -> bool {
    state.active.lock().map(|s| s.is_some()).unwrap_or(true)
}
pub fn shutdown(state: &EncoderState) {
    state.shutting_down.store(true, Ordering::SeqCst);
    let _ = cancel(state);
}

pub fn cancel(state: &EncoderState) -> Result<bool, String> {
    cancel_owned(state, None)
}
pub fn cancel_owned(state: &EncoderState, owner: Option<&str>) -> Result<bool, String> {
    let slot = state.active.lock().map_err(|e| e.to_string())?;
    let Some(job) = slot.as_ref() else {
        return Ok(false);
    };
    let mut job = job.lock().map_err(|e| e.to_string())?;
    if owner.is_some() && job.owner.as_deref() != owner {
        return Ok(false);
    }
    if job.finished {
        return Ok(false);
    }
    job.cancelled = true;
    for child in &mut job.children {
        let _ = super::process::terminate(child);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_encoder_preset_and_distinct_tracks() {
        let mut options = EncodeOptions {
            encoder: "hevc_nvenc".into(),
            preset: "p5".into(),
            ..Default::default()
        };
        assert!(validate_options(&options).is_ok());
        options.preset = "medium".into();
        assert!(validate_options(&options).is_err());
        options = EncodeOptions::default();
        options.audio_tracks = vec![1, 1];
        assert!(validate_options(&options).is_err());
        options.encoder = "sh".into();
        assert!(validate_options(&options).is_err());
    }
    #[test]
    fn excludes_overlapping_jobs_and_releases_on_failure() {
        let state = Arc::new(EncoderState::default());
        let lease = Lease::reserve(state.clone(), None).unwrap();
        assert!(Lease::reserve(state.clone(), None).is_err());
        assert!(cancel(&state).unwrap());
        drop(lease);
        assert!(Lease::reserve(state, None).is_ok());
    }
    #[test]
    fn cannot_cancel_a_different_owner() {
        let state = Arc::new(EncoderState::default());
        let _lease = Lease::reserve(state.clone(), Some("queue:1".into())).unwrap();
        assert!(!cancel_owned(&state, Some("queue:2")).unwrap());
        assert!(cancel_owned(&state, Some("queue:1")).unwrap());
    }
    #[test]
    fn refuses_overwrite_and_leaves_original_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("input.mkv");
        let output = dir.path().join("output.mkv");
        std::fs::write(&input, b"source").unwrap();
        std::fs::write(&output, b"keep").unwrap();
        assert!(validate_paths(input.to_str().unwrap(), output.to_str().unwrap()).is_err());
        assert_eq!(std::fs::read(output).unwrap(), b"keep");
    }
}
