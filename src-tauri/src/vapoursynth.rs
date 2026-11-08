//! Read-only VapourSynth runtime preflight. Does not execute user scripts.
use serde::Serialize;
use std::time::Duration;

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
        return Ok(Preflight {
            available: false,
            python: python.path,
            version: String::new(),
            detail: format!("Python unavailable: {}", python.detail),
        });
    }
    // No arbitrary user code. The import/version probe is a fixed expression.
    let output = super::process::capture(
        super::process::command(&python.path).args([
            "-c",
            "import vapoursynth as vs; print(vs.__version__); print(str(vs.core))",
        ]),
        Duration::from_secs(10),
        8192,
    )?;
    let available = output.status.success();
    let message = if available {
        &output.stdout
    } else {
        &output.stderr
    };
    let detail = String::from_utf8_lossy(message)
        .chars()
        .take(600)
        .collect::<String>();
    Ok(Preflight {
        available,
        python: python.path,
        version: if available {
            detail.lines().next().unwrap_or("").to_string()
        } else {
            String::new()
        },
        detail: detail.trim().to_string(),
    })
}
