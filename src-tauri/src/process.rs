//! Bounded process capture. Both pipes are drained while the child runs.
use std::io::{self, Read};
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct Captured {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub truncated: bool,
}

pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
}

pub fn terminate(child: &mut std::process::Child) -> io::Result<()> {
    #[cfg(unix)]
    {
        // Every workload starts in its own group. Also stop helper processes
        // that inherited the capture pipes, so timeout cleanup can reach EOF.
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
    }
    child.kill()
}

pub fn drain(mut reader: impl Read, limit: usize) -> io::Result<(Vec<u8>, bool)> {
    let mut retained = Vec::new();
    let mut truncated = false;
    let mut buffer = [0; 8192];
    loop {
        let count = match reader.read(&mut buffer) {
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if count == 0 {
            break;
        }
        retained.extend_from_slice(&buffer[..count]);
        if retained.len() > limit {
            retained.drain(..retained.len() - limit);
            truncated = true;
        }
    }
    Ok((retained, truncated))
}

pub fn capture(command: &mut Command, timeout: Duration, limit: usize) -> Result<Captured, String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start process: {e}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let out = std::thread::spawn(move || drain(stdout, limit));
    let err = std::thread::spawn(move || drain(stderr, limit));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            result => {
                let _ = terminate(&mut child);
                let _ = child.wait();
                break Err(match result {
                    Err(e) => format!("Could not wait for process: {e}"),
                    _ => format!("Process timed out after {} seconds", timeout.as_secs()),
                });
            }
        }
    };
    let stdout = out
        .join()
        .map_err(|_| "stdout reader panicked")?
        .map_err(|e| e.to_string())?;
    let stderr = err
        .join()
        .map_err(|_| "stderr reader panicked")?
        .map_err(|e| e.to_string())?;
    Ok(Captured {
        status: status?,
        stdout: stdout.0,
        stderr: stderr.0,
        truncated: stdout.1 || stderr.1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retains_tail_even_without_newlines() {
        let (tail, truncated) = drain(io::Cursor::new(vec![b'x'; 200_000]), 4096).unwrap();
        assert_eq!(tail.len(), 4096);
        assert!(truncated);
    }
    #[test]
    #[cfg(unix)]
    fn drains_both_pipes_before_waiting() {
        let result = capture(
            command("python3").args([
                "-c",
                "import os; os.write(1,b'x'*200000); os.write(2,b'y'*200000)",
            ]),
            Duration::from_secs(5),
            8192,
        )
        .unwrap();
        assert!(result.status.success());
        assert_eq!(result.stdout.len(), 8192);
        assert_eq!(result.stderr.len(), 8192);
        assert!(result.truncated);
    }
    #[test]
    #[cfg(unix)]
    fn timeout_closes_pipes_inherited_by_helpers() {
        let start = Instant::now();
        let result = capture(command("python3").args(["-c", "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)']);time.sleep(10)"]), Duration::from_millis(150), 100);
        assert!(result.is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
    }
    #[test]
    #[cfg(unix)]
    fn kills_and_reaps_on_timeout() {
        let result = capture(
            command("python3").args(["-c", "import time; time.sleep(10)"]),
            Duration::from_millis(100),
            100,
        );
        assert!(result.unwrap_err().contains("timed out"));
    }
}
