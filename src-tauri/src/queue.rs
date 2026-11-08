//! Rust owns queue execution and saves each transition before notifying the UI.
use crate::encoder::{self, EncodeOptions, EncoderState, Outcome, ProgressSink};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobRequest {
    pub input: String,
    pub output: String,
    pub options: EncodeOptions,
    #[serde(default)]
    pub script: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Job {
    pub id: u64,
    #[serde(flatten)]
    pub request: JobRequest,
    pub status: JobStatus,
    pub error: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    next_id: u64,
    jobs: Vec<Job>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub jobs: Vec<Job>,
    pub running: bool,
    pub stop_requested: bool,
    pub revision: u64,
}
struct Inner {
    document: Document,
    running: bool,
    active_id: Option<u64>,
    revision: u64,
}
pub struct QueueState {
    path: PathBuf,
    inner: Mutex<Inner>,
    stop: Arc<AtomicBool>,
}
pub type QueueSink = Arc<dyn Fn(Snapshot) + Send + Sync>;
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Edit {
    Add { request: JobRequest },
    Remove { id: u64 },
    Retry { id: u64 },
    ClearFinished,
    ApplyOptions { options: EncodeOptions },
}

impl QueueState {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        let mut document =
            crate::storage::read_json::<Document>(&path, 4 * 1024 * 1024)?.unwrap_or_default();
        if document.jobs.len() > 200 {
            return Err("Queue exceeds 200 jobs".into());
        }
        let mut ids = std::collections::HashSet::new();
        for job in &mut document.jobs {
            if !ids.insert(job.id) || job.id == 0 {
                return Err("Invalid duplicate queue job ID".into());
            }
            encoder::validate_options(&job.request.options)?;
            if job.status == JobStatus::Running {
                job.status = JobStatus::Failed;
                job.error = Some(
                    "Interrupted by application shutdown. Check the output before retrying.".into(),
                );
            }
        }
        document.next_id = document
            .jobs
            .iter()
            .map(|j| j.id)
            .max()
            .unwrap_or(0)
            .max(document.next_id);
        if path.exists() {
            crate::storage::write_json(&path, &document)?;
        }
        Ok(Self {
            path,
            inner: Mutex::new(Inner {
                document,
                running: false,
                active_id: None,
                revision: 0,
            }),
            stop: Arc::new(AtomicBool::new(false)),
        })
    }
    fn view(&self, inner: &Inner) -> Snapshot {
        Snapshot {
            jobs: inner.document.jobs.clone(),
            running: inner.running,
            stop_requested: self.stop.load(Ordering::SeqCst),
            revision: inner.revision,
        }
    }
    pub fn snapshot(&self) -> Result<Snapshot, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(self.view(&inner))
    }
    pub fn edit(&self, edit: Edit) -> Result<Snapshot, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let mut next = inner.document.clone();
        match edit {
            Edit::Add { mut request } => {
                if next.jobs.len() >= 200 {
                    return Err("Queue is limited to 200 jobs".into());
                }
                encoder::validate_options(&request.options)?;
                let (source, output) = encoder::validate_paths(&request.input, &request.output)?;
                request.input = source.to_string_lossy().into_owned();
                request.output = output.to_string_lossy().into_owned();
                if next
                    .jobs
                    .iter()
                    .any(|j| paths_equal(&j.request.output, &request.output))
                {
                    return Err("Another job already targets this output".into());
                }
                if let Some(script) = &request.script {
                    let path = encoder::script_path(script)?;
                    request.script = Some(path.to_string_lossy().into_owned());
                }
                for path in [&request.input, &request.output]
                    .into_iter()
                    .chain(request.script.iter())
                {
                    if path.len() > 4096 {
                        return Err("Path exceeds 4096 bytes".into());
                    }
                }
                next.next_id = next
                    .next_id
                    .checked_add(1)
                    .filter(|id| *id < 9_007_199_254_740_991)
                    .ok_or("Queue ID limit reached")?;
                next.jobs.push(Job {
                    id: next.next_id,
                    request,
                    status: JobStatus::Queued,
                    error: None,
                });
            }
            Edit::Remove { id } => {
                let job = next
                    .jobs
                    .iter()
                    .find(|j| j.id == id)
                    .ok_or("Job not found")?;
                if job.status == JobStatus::Running {
                    return Err("Stop a running job before removing it".into());
                }
                next.jobs.retain(|j| j.id != id);
            }
            Edit::Retry { id } => {
                let job = next
                    .jobs
                    .iter_mut()
                    .find(|j| j.id == id)
                    .ok_or("Job not found")?;
                if !matches!(job.status, JobStatus::Failed | JobStatus::Cancelled) {
                    return Err("Only failed or cancelled jobs can be retried".into());
                }
                job.status = JobStatus::Queued;
                job.error = None;
            }
            Edit::ClearFinished => next
                .jobs
                .retain(|j| matches!(j.status, JobStatus::Queued | JobStatus::Running)),
            Edit::ApplyOptions { options } => {
                encoder::validate_options(&options)?;
                for job in &mut next.jobs {
                    if job.status == JobStatus::Queued {
                        job.request.options = options.clone();
                    }
                }
            }
        }
        crate::storage::write_json(&self.path, &next)?;
        inner.document = next;
        inner.revision += 1;
        Ok(self.view(&inner))
    }
    pub fn stop(&self, encoder: &EncoderState) -> Result<Snapshot, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if inner.running {
            inner.revision += 1;
            self.stop.store(true, Ordering::SeqCst);
            if let Some(id) = inner.active_id {
                encoder::cancel_owned(encoder, Some(&format!("queue:{id}")))?;
            }
        }
        Ok(self.view(&inner))
    }
    pub fn run(
        &self,
        encoder: Arc<EncoderState>,
        progress: ProgressSink,
        sink: QueueSink,
    ) -> Result<(), String> {
        self.run_with(sink, |job, stop| {
            encoder::transcode_owned(
                encoder.clone(),
                job.request.input.clone(),
                job.request.output.clone(),
                job.request.options.clone(),
                job.request.script.clone(),
                progress.clone(),
                encoder::JobControl {
                    owner: Some(format!("queue:{}", job.id)),
                    stop: Some(stop),
                },
            )
        })
    }
    fn run_with(
        &self,
        sink: QueueSink,
        execute: impl Fn(&Job, Arc<AtomicBool>) -> Result<Outcome, String>,
    ) -> Result<(), String> {
        {
            let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
            if inner.running {
                return Err("Queue is already running".into());
            }
            self.stop.store(false, Ordering::SeqCst);
            inner.running = true;
            inner.revision += 1;
        }
        let result = (|| {
            loop {
                let job = {
                    let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
                    if self.stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let mut document = inner.document.clone();
                    let Some(job) = document
                        .jobs
                        .iter_mut()
                        .find(|j| j.status == JobStatus::Queued)
                    else {
                        break;
                    };
                    job.status = JobStatus::Running;
                    job.error = None;
                    let job = job.clone();
                    crate::storage::write_json(&self.path, &document)?;
                    inner.document = document;
                    inner.revision += 1;
                    inner.active_id = Some(job.id);
                    job
                };
                sink(self.snapshot()?);
                let result = execute(&job, self.stop.clone());
                {
                    let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
                    let mut document = inner.document.clone();
                    let stored = document
                        .jobs
                        .iter_mut()
                        .find(|j| j.id == job.id)
                        .ok_or("Running job disappeared")?;
                    match result {
                        Ok(Outcome::Completed) => stored.status = JobStatus::Completed,
                        Ok(Outcome::Cancelled) => stored.status = JobStatus::Cancelled,
                        Err(error) => {
                            stored.status = JobStatus::Failed;
                            stored.error = Some(error.chars().take(4000).collect());
                        }
                    }
                    crate::storage::write_json(&self.path, &document)?;
                    inner.document = document;
                    inner.revision += 1;
                    inner.active_id = None;
                }
                sink(self.snapshot()?);
            }
            Ok(())
        })();
        {
            let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
            inner.running = false;
            inner.revision += 1;
            inner.active_id = None;
            // If persistence failed after execution, do not rerun automatically.
            for job in &mut inner.document.jobs {
                if job.status == JobStatus::Running {
                    job.status = JobStatus::Failed;
                    job.error = Some(
                        "Queue stopped after a persistence error. Inspect output before retrying."
                            .into(),
                    );
                }
            }
        }
        sink(self.snapshot()?);
        result
    }
}
fn paths_equal(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn add(state: &QueueState, dir: &std::path::Path, name: &str) {
        let source = dir.join("source.mkv");
        std::fs::write(&source, b"source").unwrap();
        state
            .edit(Edit::Add {
                request: JobRequest {
                    input: source.to_str().unwrap().into(),
                    output: dir.join(name).to_str().unwrap().into(),
                    options: EncodeOptions::default(),
                    script: None,
                },
            })
            .unwrap();
    }
    #[test]
    fn sequential_jobs_survive_reload_and_keep_option_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("queue.json");
        let state = QueueState::open(path.clone()).unwrap();
        add(&state, dir.path(), "one.mkv");
        add(&state, dir.path(), "two.mkv");
        let sink = Arc::new(|_: Snapshot| {});
        state
            .run_with(sink, |job, _| {
                let saved = crate::storage::read_json::<Document>(&path, 100_000)
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    saved
                        .jobs
                        .iter()
                        .filter(|j| j.status == JobStatus::Running)
                        .count(),
                    1
                );
                assert_eq!(job.request.options.quality, 20);
                if job.id == 1 {
                    Err("test failure".into())
                } else {
                    Ok(Outcome::Completed)
                }
            })
            .unwrap();
        let loaded = QueueState::open(path).unwrap().snapshot().unwrap();
        assert_eq!(loaded.jobs[0].status, JobStatus::Failed);
        assert_eq!(loaded.jobs[1].status, JobStatus::Completed);
        assert!(!loaded.running);
    }
    #[test]
    fn interrupted_job_is_never_automatically_requeued() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("queue.json");
        let state = QueueState::open(path.clone()).unwrap();
        add(&state, dir.path(), "one.mkv");
        let mut doc = state.inner.lock().unwrap().document.clone();
        doc.jobs[0].status = JobStatus::Running;
        crate::storage::write_json(&path, &doc).unwrap();
        assert_eq!(
            QueueState::open(path).unwrap().snapshot().unwrap().jobs[0].status,
            JobStatus::Failed
        );
    }
    #[test]
    fn stopping_preserves_pending_jobs_and_does_not_cancel_completed_work() {
        let dir = tempfile::tempdir().unwrap();
        let state = QueueState::open(dir.path().join("queue.json")).unwrap();
        add(&state, dir.path(), "one.mkv");
        add(&state, dir.path(), "two.mkv");
        state
            .run_with(Arc::new(|_| {}), |_, stop| {
                stop.store(true, Ordering::SeqCst);
                Ok(Outcome::Completed)
            })
            .unwrap();
        let snapshot = state.snapshot().unwrap();
        assert_eq!(snapshot.jobs[0].status, JobStatus::Completed);
        assert_eq!(snapshot.jobs[1].status, JobStatus::Queued);
    }
    #[test]
    fn stores_canonical_script_path_for_reload() {
        let cwd = std::env::current_dir().unwrap();
        let dir = tempfile::tempdir_in(&cwd).unwrap();
        let script = dir.path().join("trusted.VPY");
        let source = dir.path().join("source.mkv");
        std::fs::write(&script, b"# trusted test script").unwrap();
        std::fs::write(&source, b"source").unwrap();
        let state = QueueState::open(dir.path().join("queue.json")).unwrap();
        state
            .edit(Edit::Add {
                request: JobRequest {
                    input: source.to_string_lossy().into_owned(),
                    output: dir.path().join("out.mkv").to_string_lossy().into_owned(),
                    options: EncodeOptions::default(),
                    script: Some(
                        script
                            .strip_prefix(cwd)
                            .unwrap()
                            .to_string_lossy()
                            .into_owned(),
                    ),
                },
            })
            .unwrap();
        let snapshot = state.snapshot().unwrap();
        assert_eq!(
            snapshot.jobs[0].request.script.as_deref(),
            script.canonicalize().unwrap().to_str()
        );
    }
    #[test]
    fn failed_write_does_not_mutate_queue() {
        let dir = tempfile::tempdir().unwrap();
        let state = QueueState::open(dir.path().join("queue.json")).unwrap();
        std::fs::create_dir(&state.path).unwrap();
        let source = dir.path().join("source.mkv");
        std::fs::write(&source, b"source").unwrap();
        assert!(state
            .edit(Edit::Add {
                request: JobRequest {
                    input: source.to_str().unwrap().into(),
                    output: dir.path().join("out.mkv").to_str().unwrap().into(),
                    options: EncodeOptions::default(),
                    script: None
                }
            })
            .is_err());
        assert!(state.snapshot().unwrap().jobs.is_empty());
    }
}
