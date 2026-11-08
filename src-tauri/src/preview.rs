//! Fixed native frame and encoder probes, with bounded binary responses.
use serde::Serialize;
use std::{path::Path, time::Duration};

pub fn frame(path: &str, seconds: f64, width: u32) -> Result<Vec<u8>, String> {
    if !seconds.is_finite() || !(0.0..=604800.0).contains(&seconds) || !(64..=1920).contains(&width)
    {
        return Err("Invalid preview time or width".into());
    }
    let source = Path::new(path).canonicalize().map_err(|e| e.to_string())?;
    if !source.is_file() {
        return Err("Choose an existing video file".into());
    }
    let ffmpeg = crate::discovery::discover("ffmpeg")?;
    if !ffmpeg.available {
        return Err(format!("FFmpeg unavailable: {}", ffmpeg.detail));
    }
    let output = crate::process::capture(
        crate::process::command(ffmpeg.path)
            .args([
                "-v",
                "error",
                "-nostdin",
                "-ss",
                &format!("{seconds:.6}"),
                "-i",
            ])
            .arg(source)
            .args([
                "-map",
                "0:v:0",
                "-frames:v",
                "1",
                "-vf",
                &format!("scale={width}:-2"),
                "-c:v",
                "mjpeg",
                "-q:v",
                "3",
                "-f",
                "image2pipe",
                "pipe:1",
            ]),
        Duration::from_secs(20),
        8 * 1024 * 1024,
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(2000)
            .collect());
    }
    if output.truncated || !output.stdout.starts_with(&[0xff, 0xd8]) {
        return Err("Preview unavailable at the selected time".into());
    }
    Ok(output.stdout)
}

#[derive(Serialize)]
pub struct EncoderCheck {
    pub encoder: String,
    pub available: bool,
    pub detail: String,
}
pub fn check_encoder(encoder: &str) -> Result<EncoderCheck, String> {
    if ![
        "libx264",
        "libx265",
        "h264_nvenc",
        "hevc_nvenc",
        "av1_nvenc",
    ]
    .contains(&encoder)
    {
        return Err("Unsupported encoder probe".into());
    }
    let ffmpeg = crate::discovery::discover("ffmpeg")?;
    if !ffmpeg.available {
        return Ok(EncoderCheck {
            encoder: encoder.into(),
            available: false,
            detail: ffmpeg.detail,
        });
    }
    let output = crate::process::capture(
        crate::process::command(ffmpeg.path).args([
            "-v",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            "color=size=64x64:rate=1",
            "-frames:v",
            "1",
            "-c:v",
            encoder,
            "-f",
            "null",
            "-",
        ]),
        Duration::from_secs(15),
        8192,
    )?;
    Ok(EncoderCheck {
        encoder: encoder.into(),
        available: output.status.success(),
        detail: if output.status.success() {
            "Test frame encoded successfully".into()
        } else {
            String::from_utf8_lossy(&output.stderr)
                .trim()
                .chars()
                .take(2000)
                .collect()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_preview_parameters_before_launch() {
        assert!(frame("missing", f64::NAN, 1280).is_err());
        assert!(frame("missing", -1.0, 1280).is_err());
        assert!(frame("missing", 0.0, 100_000).is_err());
        assert!(check_encoder("sh").is_err());
    }
}
