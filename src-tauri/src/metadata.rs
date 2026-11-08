use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub index: u64,
    pub codec_type: String,
    pub codec_name: Option<String>,
    pub language: Option<String>,
    pub title: Option<String>,
    pub width: Option<u64>,
    pub height: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    pub duration_seconds: Option<f64>,
    pub format_name: Option<String>,
    pub streams: Vec<StreamInfo>,
}

pub fn inspect(path: &str) -> Result<MediaInfo, String> {
    let input = PathBuf::from(path);
    if !input.is_file() {
        return Err("Input file does not exist".into());
    }
    let input = input.canonicalize().map_err(|e| e.to_string())?;
    let ffprobe = super::discovery::discover("ffprobe")?;
    if !ffprobe.available {
        return Err(format!("FFprobe unavailable: {}", ffprobe.detail));
    }
    let mut child = Command::new(&ffprobe.path)
        .args(["-v", "error", "-show_format", "-show_streams", "-of", "json", "-i"])
        .arg(&input)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("FFprobe timed out".into());
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).chars().take(500).collect());
    }
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    let streams = json["streams"].as_array().ok_or("FFprobe returned no stream list")?
        .iter().map(|s| StreamInfo {
            index: s["index"].as_u64().unwrap_or(0),
            codec_type: s["codec_type"].as_str().unwrap_or("unknown").to_owned(),
            codec_name: s["codec_name"].as_str().map(str::to_owned),
            language: s["tags"]["language"].as_str().map(str::to_owned),
            title: s["tags"]["title"].as_str().map(str::to_owned),
            width: s["width"].as_u64(),
            height: s["height"].as_u64(),
        }).collect();
    Ok(MediaInfo {
        path: input.display().to_string(),
        duration_seconds: json["format"]["duration"].as_str().and_then(|d| d.parse().ok()),
        format_name: json["format"]["format_name"].as_str().map(str::to_owned),
        streams,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_missing_input() {
        assert!(inspect("this-file-should-not-exist-8b70.mkv").is_err());
    }
}
