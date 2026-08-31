/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

pub const STARTUP_DIAGNOSTIC_REPORT_ENV: &str = "RIDE_STARTUP_DIAGNOSTIC_REPORT";
pub const STARTUP_DIAGNOSTIC_REPORT_SCHEMA: &str = "ride.startup-critical-path-diagnostics";
pub const STARTUP_DIAGNOSTIC_REPORT_VERSION: u32 = 1;
const STARTUP_DIAGNOSTIC_WRITE_ATTEMPTS: usize = 3;
const STARTUP_DIAGNOSTIC_RETRY_DELAY_MS: u64 = 10;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupDiagnosticPhase {
    FrontendInitializationStarted,
    AttachedShellResolved,
    WorkspaceReady,
    NativeListenerInstalled,
    InitialRequestSelected,
    TargetOpenStarted,
    TargetModelResolved,
    TargetWidgetActivated,
    TargetMilestoneRequested,
}

impl StartupDiagnosticPhase {
    const fn predecessor(self) -> Option<Self> {
        match self {
            Self::FrontendInitializationStarted => None,
            Self::AttachedShellResolved => Some(Self::FrontendInitializationStarted),
            Self::WorkspaceReady => Some(Self::AttachedShellResolved),
            Self::NativeListenerInstalled => Some(Self::WorkspaceReady),
            Self::InitialRequestSelected => Some(Self::NativeListenerInstalled),
            Self::TargetOpenStarted => Some(Self::InitialRequestSelected),
            Self::TargetModelResolved => Some(Self::TargetOpenStarted),
            Self::TargetWidgetActivated => Some(Self::TargetModelResolved),
            Self::TargetMilestoneRequested => Some(Self::TargetWidgetActivated),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
struct StartupDiagnosticPhaseDurations {
    #[serde(skip_serializing_if = "Option::is_none")]
    frontend_initialization_started: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attached_shell_resolved: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_ready: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_listener_installed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    initial_request_selected: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_open_started: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_model_resolved: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_widget_activated: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_milestone_requested: Option<u64>,
}

impl StartupDiagnosticPhaseDurations {
    fn get(&self, phase: StartupDiagnosticPhase) -> Option<u64> {
        match phase {
            StartupDiagnosticPhase::FrontendInitializationStarted => {
                self.frontend_initialization_started
            }
            StartupDiagnosticPhase::AttachedShellResolved => self.attached_shell_resolved,
            StartupDiagnosticPhase::WorkspaceReady => self.workspace_ready,
            StartupDiagnosticPhase::NativeListenerInstalled => self.native_listener_installed,
            StartupDiagnosticPhase::InitialRequestSelected => self.initial_request_selected,
            StartupDiagnosticPhase::TargetOpenStarted => self.target_open_started,
            StartupDiagnosticPhase::TargetModelResolved => self.target_model_resolved,
            StartupDiagnosticPhase::TargetWidgetActivated => self.target_widget_activated,
            StartupDiagnosticPhase::TargetMilestoneRequested => self.target_milestone_requested,
        }
    }

    fn set(&mut self, phase: StartupDiagnosticPhase, elapsed_ms: u64) {
        let slot = match phase {
            StartupDiagnosticPhase::FrontendInitializationStarted => {
                &mut self.frontend_initialization_started
            }
            StartupDiagnosticPhase::AttachedShellResolved => &mut self.attached_shell_resolved,
            StartupDiagnosticPhase::WorkspaceReady => &mut self.workspace_ready,
            StartupDiagnosticPhase::NativeListenerInstalled => &mut self.native_listener_installed,
            StartupDiagnosticPhase::InitialRequestSelected => &mut self.initial_request_selected,
            StartupDiagnosticPhase::TargetOpenStarted => &mut self.target_open_started,
            StartupDiagnosticPhase::TargetModelResolved => &mut self.target_model_resolved,
            StartupDiagnosticPhase::TargetWidgetActivated => &mut self.target_widget_activated,
            StartupDiagnosticPhase::TargetMilestoneRequested => {
                &mut self.target_milestone_requested
            }
        };
        *slot = Some(elapsed_ms);
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct StartupDiagnosticReport {
    schema: &'static str,
    version: u32,
    platform: String,
    arch: String,
    pid: u32,
    phases: StartupDiagnosticPhaseDurations,
}

impl StartupDiagnosticReport {
    pub fn new(platform: impl Into<String>, arch: impl Into<String>, pid: u32) -> Self {
        Self {
            schema: STARTUP_DIAGNOSTIC_REPORT_SCHEMA,
            version: STARTUP_DIAGNOSTIC_REPORT_VERSION,
            platform: platform.into(),
            arch: arch.into(),
            pid,
            phases: StartupDiagnosticPhaseDurations::default(),
        }
    }

    pub fn record(
        &mut self,
        phase: StartupDiagnosticPhase,
        elapsed_ms: u64,
    ) -> Result<DiagnosticRecordOutcome, StartupDiagnosticError> {
        if self.phases.get(phase).is_some() {
            return Ok(DiagnosticRecordOutcome::Duplicate);
        }
        if let Some(predecessor) = phase.predecessor() {
            let Some(predecessor_ms) = self.phases.get(predecessor) else {
                return Err(StartupDiagnosticError::MissingPredecessor {
                    attempted: phase,
                    required: predecessor,
                });
            };
            if elapsed_ms < predecessor_ms {
                return Err(StartupDiagnosticError::PredecessorTimestamp {
                    attempted: phase,
                    predecessor,
                    attempted_ms: elapsed_ms,
                    predecessor_ms,
                });
            }
        }
        self.phases.set(phase, elapsed_ms);
        Ok(DiagnosticRecordOutcome::Recorded)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticRecordOutcome {
    Recorded,
    Duplicate,
    Disabled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StartupDiagnosticError {
    MissingPredecessor {
        attempted: StartupDiagnosticPhase,
        required: StartupDiagnosticPhase,
    },
    PredecessorTimestamp {
        attempted: StartupDiagnosticPhase,
        predecessor: StartupDiagnosticPhase,
        attempted_ms: u64,
        predecessor_ms: u64,
    },
    RecorderPoisoned,
    Write(String),
}

impl fmt::Display for StartupDiagnosticError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingPredecessor {
                attempted,
                required,
            } => write!(
                formatter,
                "startup diagnostic phase {attempted:?} requires {required:?}"
            ),
            Self::PredecessorTimestamp {
                attempted,
                predecessor,
                attempted_ms,
                predecessor_ms,
            } => write!(
                formatter,
                "startup diagnostic phase {attempted:?} at {attempted_ms}ms precedes {predecessor:?} at {predecessor_ms}ms"
            ),
            Self::RecorderPoisoned => {
                formatter.write_str("startup diagnostic recorder mutex is poisoned")
            }
            Self::Write(error) => write!(
                formatter,
                "failed to publish startup diagnostic report: {error}"
            ),
        }
    }
}

impl std::error::Error for StartupDiagnosticError {}

pub trait DiagnosticElapsedClock: Send + Sync + fmt::Debug {
    fn elapsed_ms(&self) -> u64;
}

#[derive(Debug)]
struct MonotonicDiagnosticClock {
    started_at: Instant,
}

impl MonotonicDiagnosticClock {
    fn new() -> Self {
        Self {
            started_at: Instant::now(),
        }
    }
}

impl DiagnosticElapsedClock for MonotonicDiagnosticClock {
    fn elapsed_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis().min(u64::MAX as u128) as u64
    }
}

#[derive(Debug)]
struct StartupDiagnosticRecorderState {
    report: StartupDiagnosticReport,
    clock: Arc<dyn DiagnosticElapsedClock>,
}

#[derive(Debug)]
struct StartupDiagnosticRecorder {
    state: Mutex<StartupDiagnosticRecorderState>,
    snapshots: mpsc::Sender<StartupDiagnosticReport>,
}

#[derive(Clone, Debug)]
pub struct StartupDiagnostics {
    recorder: Option<Arc<StartupDiagnosticRecorder>>,
}

pub trait StartupDiagnosticReportWriter: Send + 'static {
    fn write(&mut self, report: &StartupDiagnosticReport) -> io::Result<()>;
}

#[derive(Debug)]
struct AtomicStartupDiagnosticReportWriter {
    output_path: PathBuf,
}

impl StartupDiagnosticReportWriter for AtomicStartupDiagnosticReportWriter {
    fn write(&mut self, report: &StartupDiagnosticReport) -> io::Result<()> {
        write_report_atomically(&self.output_path, report)
    }
}

impl StartupDiagnostics {
    pub fn from_env() -> Self {
        Self::with_clock(
            std::env::var_os(STARTUP_DIAGNOSTIC_REPORT_ENV).map(PathBuf::from),
            std::env::consts::OS,
            std::env::consts::ARCH,
            std::process::id(),
            Arc::new(MonotonicDiagnosticClock::new()),
        )
    }

    pub fn with_clock(
        output_path: Option<PathBuf>,
        platform: impl Into<String>,
        arch: impl Into<String>,
        pid: u32,
        clock: Arc<dyn DiagnosticElapsedClock>,
    ) -> Self {
        let Some(output_path) = output_path else {
            return Self { recorder: None };
        };
        Self::with_clock_and_writer(
            platform,
            arch,
            pid,
            clock,
            Box::new(AtomicStartupDiagnosticReportWriter { output_path }),
        )
    }

    pub fn with_clock_and_writer(
        platform: impl Into<String>,
        arch: impl Into<String>,
        pid: u32,
        clock: Arc<dyn DiagnosticElapsedClock>,
        writer: Box<dyn StartupDiagnosticReportWriter>,
    ) -> Self {
        Self {
            recorder: Some(Arc::new(StartupDiagnosticRecorder {
                state: Mutex::new(StartupDiagnosticRecorderState {
                    report: StartupDiagnosticReport::new(platform, arch, pid),
                    clock,
                }),
                snapshots: spawn_report_writer(writer),
            })),
        }
    }

    pub fn record(
        &self,
        phase: StartupDiagnosticPhase,
    ) -> Result<DiagnosticRecordOutcome, StartupDiagnosticError> {
        let Some(recorder) = &self.recorder else {
            return Ok(DiagnosticRecordOutcome::Disabled);
        };
        let mut state = recorder
            .state
            .lock()
            .map_err(|_| StartupDiagnosticError::RecorderPoisoned)?;
        let elapsed_ms = state.clock.elapsed_ms();
        let mut candidate = state.report.clone();
        let outcome = candidate.record(phase, elapsed_ms)?;
        if outcome == DiagnosticRecordOutcome::Recorded {
            recorder
                .snapshots
                .send(candidate.clone())
                .map_err(|error| StartupDiagnosticError::Write(error.to_string()))?;
            state.report = candidate;
        }
        Ok(outcome)
    }

    pub fn record_or_warn(&self, phase: StartupDiagnosticPhase) {
        if let Err(error) = self.record(phase) {
            log::warn!("Failed to record startup diagnostic phase {phase:?}: {error}");
        }
    }
}

fn spawn_report_writer(
    mut writer: Box<dyn StartupDiagnosticReportWriter>,
) -> mpsc::Sender<StartupDiagnosticReport> {
    let (sender, snapshots) = mpsc::channel::<StartupDiagnosticReport>();
    if let Err(error) = std::thread::Builder::new()
        .name("ride-startup-diagnostic-writer".to_string())
        .spawn(move || {
            while let Ok(snapshot) = snapshots.recv() {
                write_snapshot_with_retry(writer.as_mut(), &snapshot);
            }
        })
    {
        log::warn!("Failed to start startup diagnostic report writer: {error}");
    }
    sender
}

fn write_snapshot_with_retry(
    writer: &mut dyn StartupDiagnosticReportWriter,
    snapshot: &StartupDiagnosticReport,
) {
    for attempt in 1..=STARTUP_DIAGNOSTIC_WRITE_ATTEMPTS {
        match writer.write(snapshot) {
            Ok(()) => return,
            Err(error) if attempt < STARTUP_DIAGNOSTIC_WRITE_ATTEMPTS => {
                log::warn!(
                    "Failed to publish startup diagnostic snapshot (attempt {attempt}/{}): {error}",
                    STARTUP_DIAGNOSTIC_WRITE_ATTEMPTS
                );
                std::thread::sleep(Duration::from_millis(
                    STARTUP_DIAGNOSTIC_RETRY_DELAY_MS * attempt as u64,
                ));
            }
            Err(error) => {
                log::warn!(
                    "Failed to publish startup diagnostic snapshot after {} attempts: {error}",
                    STARTUP_DIAGNOSTIC_WRITE_ATTEMPTS
                );
                return;
            }
        }
    }
}

fn write_report_atomically(path: &Path, report: &StartupDiagnosticReport) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "report path has no file name")
    })?;
    let temporary_path = parent.join(format!(
        ".{}.{}.tmp",
        file_name.to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)?;
        serde_json::to_writer_pretty(&mut file, report).map_err(io::Error::other)?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_all()?;
        replace_file(&temporary_path, path)?;
        sync_parent(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

    let existing = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replacement = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        MoveFileExW(
            existing.as_ptr(),
            replacement.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent(parent: &Path) -> io::Result<()> {
    fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent(_parent: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io;
    use std::sync::{mpsc, Arc, Mutex};

    #[derive(Debug)]
    struct FixedClock(u64);

    impl DiagnosticElapsedClock for FixedClock {
        fn elapsed_ms(&self) -> u64 {
            self.0
        }
    }

    fn fake_clock(elapsed_ms: u64) -> Arc<dyn DiagnosticElapsedClock> {
        Arc::new(FixedClock(elapsed_ms))
    }

    #[test]
    fn diagnostic_report_accepts_only_the_closed_predecessor_graph() {
        let mut report = StartupDiagnosticReport::new("windows", "x86_64", 42);
        assert_eq!(
            report.record(StartupDiagnosticPhase::FrontendInitializationStarted, 10),
            Ok(DiagnosticRecordOutcome::Recorded)
        );
        assert!(matches!(
            report.record(StartupDiagnosticPhase::WorkspaceReady, 11),
            Err(StartupDiagnosticError::MissingPredecessor {
                attempted: StartupDiagnosticPhase::WorkspaceReady,
                required: StartupDiagnosticPhase::AttachedShellResolved,
            })
        ));

        for (phase, elapsed_ms) in [
            (StartupDiagnosticPhase::AttachedShellResolved, 11),
            (StartupDiagnosticPhase::WorkspaceReady, 12),
            (StartupDiagnosticPhase::NativeListenerInstalled, 13),
            (StartupDiagnosticPhase::InitialRequestSelected, 14),
            (StartupDiagnosticPhase::TargetOpenStarted, 15),
            (StartupDiagnosticPhase::TargetModelResolved, 16),
            (StartupDiagnosticPhase::TargetWidgetActivated, 17),
            (StartupDiagnosticPhase::TargetMilestoneRequested, 18),
        ] {
            assert_eq!(
                report.record(phase, elapsed_ms),
                Ok(DiagnosticRecordOutcome::Recorded)
            );
        }
    }

    #[test]
    fn duplicate_preserves_first_timestamp_and_serialization_is_path_free() {
        let mut report = StartupDiagnosticReport::new("windows", "x86_64", 42);
        assert_eq!(
            report.record(StartupDiagnosticPhase::FrontendInitializationStarted, 10),
            Ok(DiagnosticRecordOutcome::Recorded)
        );
        assert_eq!(
            report.record(StartupDiagnosticPhase::FrontendInitializationStarted, 99),
            Ok(DiagnosticRecordOutcome::Duplicate)
        );
        assert_eq!(
            serde_json::to_value(&report).expect("serialize report"),
            json!({
                "schema": "ride.startup-critical-path-diagnostics",
                "version": 1,
                "platform": "windows",
                "arch": "x86_64",
                "pid": 42,
                "phases": {
                    "frontend_initialization_started": 10
                }
            })
        );
    }

    #[test]
    fn predecessor_timestamp_must_be_monotonic() {
        let mut report = StartupDiagnosticReport::new("windows", "x86_64", 42);
        report
            .record(StartupDiagnosticPhase::FrontendInitializationStarted, 10)
            .expect("first phase");
        assert!(matches!(
            report.record(StartupDiagnosticPhase::AttachedShellResolved, 9),
            Err(StartupDiagnosticError::PredecessorTimestamp {
                attempted: StartupDiagnosticPhase::AttachedShellResolved,
                predecessor: StartupDiagnosticPhase::FrontendInitializationStarted,
                attempted_ms: 9,
                predecessor_ms: 10,
            })
        ));
    }

    #[test]
    fn disabled_diagnostics_do_not_create_a_writer_or_record() {
        let diagnostics =
            StartupDiagnostics::with_clock(None, "windows", "x86_64", 7, fake_clock(3));
        assert_eq!(
            diagnostics.record(StartupDiagnosticPhase::FrontendInitializationStarted),
            Ok(DiagnosticRecordOutcome::Disabled)
        );
        assert!(diagnostics.recorder.is_none());
    }

    #[test]
    fn enqueue_failure_does_not_commit_and_retry_records() {
        let (failed_sender, failed_receiver) = mpsc::channel();
        drop(failed_receiver);
        let mut diagnostics = diagnostics_with_sender(failed_sender, fake_clock(7));

        assert!(matches!(
            diagnostics.record(StartupDiagnosticPhase::FrontendInitializationStarted),
            Err(StartupDiagnosticError::Write(_))
        ));
        assert_eq!(current_report(&diagnostics)["phases"], json!({}));

        let (recovered_sender, recovered_receiver) = mpsc::channel();
        replace_snapshot_sender(&mut diagnostics, recovered_sender);
        assert_eq!(
            diagnostics.record(StartupDiagnosticPhase::FrontendInitializationStarted),
            Ok(DiagnosticRecordOutcome::Recorded)
        );
        assert_eq!(
            serde_json::to_value(recovered_receiver.recv().expect("snapshot"))
                .expect("serialize snapshot")["phases"]["frontend_initialization_started"],
            7
        );
    }

    #[test]
    fn writer_retries_twice_before_success() {
        #[derive(Clone)]
        struct FlakyWriter {
            attempts: Arc<Mutex<usize>>,
        }

        impl StartupDiagnosticReportWriter for FlakyWriter {
            fn write(&mut self, _report: &StartupDiagnosticReport) -> io::Result<()> {
                let mut attempts = self.attempts.lock().expect("attempt count");
                *attempts += 1;
                if *attempts < 3 {
                    Err(io::Error::other("transient"))
                } else {
                    Ok(())
                }
            }
        }

        let attempts = Arc::new(Mutex::new(0));
        let mut writer = FlakyWriter {
            attempts: Arc::clone(&attempts),
        };
        write_snapshot_with_retry(
            &mut writer,
            &StartupDiagnosticReport::new("windows", "x86_64", 42),
        );
        assert_eq!(*attempts.lock().expect("attempt count"), 3);
    }

    #[test]
    fn poisoned_recorder_is_reported_without_panicking() {
        let diagnostics = diagnostics_with_sender(mpsc::channel().0, fake_clock(7));
        let recorder = Arc::clone(diagnostics.recorder.as_ref().expect("enabled recorder"));
        let _ = std::panic::catch_unwind(move || {
            let _guard = recorder.state.lock().expect("lock recorder");
            panic!("poison recorder");
        });
        assert_eq!(
            diagnostics.record(StartupDiagnosticPhase::FrontendInitializationStarted),
            Err(StartupDiagnosticError::RecorderPoisoned)
        );
    }

    fn diagnostics_with_sender(
        snapshots: mpsc::Sender<StartupDiagnosticReport>,
        clock: Arc<dyn DiagnosticElapsedClock>,
    ) -> StartupDiagnostics {
        StartupDiagnostics {
            recorder: Some(Arc::new(StartupDiagnosticRecorder {
                state: Mutex::new(StartupDiagnosticRecorderState {
                    report: StartupDiagnosticReport::new("windows", "x86_64", 42),
                    clock,
                }),
                snapshots,
            })),
        }
    }

    fn replace_snapshot_sender(
        diagnostics: &mut StartupDiagnostics,
        snapshots: mpsc::Sender<StartupDiagnosticReport>,
    ) {
        Arc::get_mut(diagnostics.recorder.as_mut().expect("enabled recorder"))
            .expect("test owns the only recorder reference")
            .snapshots = snapshots;
    }

    fn current_report(diagnostics: &StartupDiagnostics) -> serde_json::Value {
        let recorder = diagnostics.recorder.as_ref().expect("enabled recorder");
        let state = recorder.state.lock().expect("recorder state");
        serde_json::to_value(&state.report).expect("serialize current report")
    }
}
