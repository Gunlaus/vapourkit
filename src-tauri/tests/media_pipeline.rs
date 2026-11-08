//! Run explicitly with FFmpeg on PATH; VSPipe test additionally requires VS R79.
use std::{path::Path, sync::Arc, time::Duration};
use vapourkit_lib::{
    encoder::{self, EncodeOptions, EncoderState, Outcome},
    metadata, preview, process,
};

fn source(dir: &Path) -> String {
    let path = dir.join("source space ü.mkv");
    let output = process::capture(
        process::command("ffmpeg")
            .args([
                "-v",
                "error",
                "-nostdin",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=160x120:rate=24",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-metadata:s:a:0",
                "language=eng",
                "-y",
            ])
            .arg(&path),
        Duration::from_secs(20),
        16_384,
    )
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    path.to_str().unwrap().into()
}
fn options() -> EncodeOptions {
    EncodeOptions {
        audio_tracks: vec![1],
        ..Default::default()
    }
}
fn no_progress() -> encoder::ProgressSink {
    Arc::new(|_| {})
}
fn no_temporaries(dir: &Path) {
    assert!(std::fs::read_dir(dir).unwrap().all(|e| !e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".vapourkit-")));
}

#[test]
#[ignore = "requires FFmpeg"]
fn encodes_unicode_paths_selected_tracks_and_binary_preview() {
    let dir = tempfile::tempdir().unwrap();
    let input = source(dir.path());
    let output = dir
        .path()
        .join("output ; ü.mkv")
        .to_str()
        .unwrap()
        .to_owned();
    let result = encoder::transcode(
        Arc::new(EncoderState::default()),
        input,
        output.clone(),
        options(),
        None,
        no_progress(),
    )
    .unwrap();
    assert_eq!(result, Outcome::Completed);
    let media = metadata::inspect(&output).unwrap();
    assert_eq!(media.streams.len(), 2);
    assert_eq!(media.streams[0].width, Some(160));
    assert_eq!(media.streams[1].codec_type, "audio");
    assert_eq!(media.streams[1].language.as_deref(), Some("eng"));
    assert!(preview::frame(&output, 0.0, 320)
        .unwrap()
        .starts_with(&[0xff, 0xd8]));
    no_temporaries(dir.path());
}
#[test]
#[ignore = "requires FFmpeg"]
fn cancellation_reaps_encoder_removes_partial_and_releases_slot() {
    let dir = tempfile::tempdir().unwrap();
    let input = source(dir.path());
    let output = dir
        .path()
        .join("cancelled.mkv")
        .to_str()
        .unwrap()
        .to_owned();
    let state = Arc::new(EncoderState::default());
    let cancel_state = state.clone();
    let result = encoder::transcode(
        state.clone(),
        input.clone(),
        output.clone(),
        options(),
        None,
        Arc::new(move |event| {
            if event.status == "running" {
                encoder::cancel(&cancel_state).unwrap();
            }
        }),
    )
    .unwrap();
    assert_eq!(result, Outcome::Cancelled);
    assert!(!Path::new(&output).exists());
    assert!(!encoder::is_busy(&state));
    assert_eq!(
        encoder::transcode(state, input, output, options(), None, no_progress()).unwrap(),
        Outcome::Completed
    );
    no_temporaries(dir.path());
}
#[test]
#[ignore = "requires FFmpeg"]
fn late_output_conflict_never_clobbers_another_file() {
    let dir = tempfile::tempdir().unwrap();
    let input = source(dir.path());
    let output = dir.path().join("conflict.mkv").to_str().unwrap().to_owned();
    let conflict = output.clone();
    let result = encoder::transcode(
        Arc::new(EncoderState::default()),
        input,
        output.clone(),
        options(),
        None,
        Arc::new(move |event| {
            if event.status == "running" {
                std::fs::write(&conflict, b"other application owns this").unwrap();
            }
        }),
    );
    assert!(result.unwrap_err().contains("without overwrite"));
    assert_eq!(
        std::fs::read(output).unwrap(),
        b"other application owns this"
    );
    no_temporaries(dir.path());
}
#[test]
#[ignore = "requires FFmpeg and VSPipe with VapourSynth R79"]
fn renders_vapoursynth_video_and_muxes_source_audio() {
    let dir = tempfile::tempdir().unwrap();
    let input = source(dir.path());
    let script = dir.path().join("trusted ü.vpy");
    std::fs::write(&script, "import vapoursynth as vs\nvs.core.std.BlankClip(width=128, height=96, length=24, fpsnum=24, format=vs.YUV420P8).set_output()\n").unwrap();
    let output = dir.path().join("rendered.mkv").to_str().unwrap().to_owned();
    let preflight = vapourkit_lib::vapoursynth::check().unwrap();
    assert!(preflight.available, "{}", preflight.detail);
    assert_eq!(preflight.version, "R79");
    let check =
        vapourkit_lib::script_check::inspect_script(script.to_str().unwrap().into()).unwrap();
    assert!(check.valid, "{}", check.details);
    let result = encoder::transcode(
        Arc::new(EncoderState::default()),
        input,
        output.clone(),
        options(),
        Some(script.to_str().unwrap().into()),
        no_progress(),
    )
    .unwrap();
    assert_eq!(result, Outcome::Completed);
    let media = metadata::inspect(&output).unwrap();
    assert_eq!(media.streams[0].width, Some(128));
    assert_eq!(media.streams[0].height, Some(96));
    assert_eq!(media.streams[1].codec_type, "audio");
    no_temporaries(dir.path());
}
