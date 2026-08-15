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
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub const STARTUP_REPORT_ENV: &str = "RIDE_STARTUP_REPORT";
pub const STARTUP_REPORT_SCHEMA: &str = "ride.startup-report";
pub const STARTUP_REPORT_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupMilestone {
    ProcessStarted,
    NativeWindowVisible,
    BackendSpawned,
    BackendListening,
    FrontendShellAttached,
    TargetFileOpened,
    PluginsStarted,
    PluginsReady,
}

impl StartupMilestone {
    const ORDERED: [Self; 8] = [
        Self::ProcessStarted,
        Self::NativeWindowVisible,
        Self::BackendSpawned,
        Self::BackendListening,
        Self::FrontendShellAttached,
        Self::TargetFileOpened,
        Self::PluginsStarted,
        Self::PluginsReady,
    ];

    fn index(self) -> usize {
        Self::ORDERED
            .iter()
            .position(|candidate| *candidate == self)
            .expect("all startup milestones have a declared order")
    }

    pub fn is_frontend_reportable(self) -> bool {
        matches!(
            self,
            Self::FrontendShellAttached
                | Self::TargetFileOpened
                | Self::PluginsStarted
                | Self::PluginsReady
        )
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct StartupMilestoneDurations {
    #[serde(skip_serializing_if = "Option::is_none")]
    process_started: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_window_visible: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    backend_spawned: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    backend_listening: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    frontend_shell_attached: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_file_opened: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    plugins_started: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    plugins_ready: Option<u64>,
}

impl StartupMilestoneDurations {
    fn get(&self, milestone: StartupMilestone) -> Option<u64> {
        match milestone {
            StartupMilestone::ProcessStarted => self.process_started,
            StartupMilestone::NativeWindowVisible => self.native_window_visible,
            StartupMilestone::BackendSpawned => self.backend_spawned,
            StartupMilestone::BackendListening => self.backend_listening,
            StartupMilestone::FrontendShellAttached => self.frontend_shell_attached,
            StartupMilestone::TargetFileOpened => self.target_file_opened,
            StartupMilestone::PluginsStarted => self.plugins_started,
            StartupMilestone::PluginsReady => self.plugins_ready,
        }
    }

    fn set(&mut self, milestone: StartupMilestone, duration_ms: u64) {
        let slot = match milestone {
            StartupMilestone::ProcessStarted => &mut self.process_started,
            StartupMilestone::NativeWindowVisible => &mut self.native_window_visible,
            StartupMilestone::BackendSpawned => &mut self.backend_spawned,
            StartupMilestone::BackendListening => &mut self.backend_listening,
            StartupMilestone::FrontendShellAttached => &mut self.frontend_shell_attached,
            StartupMilestone::TargetFileOpened => &mut self.target_file_opened,
            StartupMilestone::PluginsStarted => &mut self.plugins_started,
            StartupMilestone::PluginsReady => &mut self.plugins_ready,
        };
        *slot = Some(duration_ms);
    }

    fn latest(&self) -> Option<(StartupMilestone, u64)> {
        StartupMilestone::ORDERED
            .iter()
            .rev()
            .find_map(|milestone| self.get(*milestone).map(|value| (*milestone, value)))
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct StartupReport {
    schema: &'static str,
    version: u32,
    platform: String,
    arch: String,
    pid: u32,
    milestones: StartupMilestoneDurations,
}

impl StartupReport {
    pub fn new(platform: impl Into<String>, arch: impl Into<String>, pid: u32) -> Self {
        Self {
            schema: STARTUP_REPORT_SCHEMA,
            version: STARTUP_REPORT_VERSION,
            platform: platform.into(),
            arch: arch.into(),
            pid,
            milestones: StartupMilestoneDurations::default(),
        }
    }

    pub fn record(
        &mut self,
        milestone: StartupMilestone,
        duration_ms: u64,
    ) -> Result<RecordOutcome, StartupMetricError> {
        if self.milestones.get(milestone).is_some() {
            return Ok(RecordOutcome::Duplicate);
        }

        if let Some((latest, latest_ms)) = self.milestones.latest() {
            if milestone.index() < latest.index() {
                return Err(StartupMetricError::OutOfOrder {
                    attempted: milestone,
                    latest,
                });
            }
            if duration_ms < latest_ms {
                return Err(StartupMetricError::NonMonotonic {
                    attempted_ms: duration_ms,
                    latest_ms,
                });
            }
        }

        self.milestones.set(milestone, duration_ms);
        Ok(RecordOutcome::Recorded)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecordOutcome {
    Recorded,
    Duplicate,
    Disabled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StartupMetricError {
    OutOfOrder {
        attempted: StartupMilestone,
        latest: StartupMilestone,
    },
    NonMonotonic {
        attempted_ms: u64,
        latest_ms: u64,
    },
    ClockOverflow,
    RecorderPoisoned,
    Write(String),
}

impl fmt::Display for StartupMetricError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OutOfOrder { attempted, latest } => write!(
                formatter,
                "startup milestone {attempted:?} follows already-recorded {latest:?}"
            ),
            Self::NonMonotonic {
                attempted_ms,
                latest_ms,
            } => write!(
                formatter,
                "startup elapsed time {attempted_ms}ms precedes {latest_ms}ms"
            ),
            Self::ClockOverflow => formatter.write_str("startup elapsed time exceeds u64"),
            Self::RecorderPoisoned => formatter.write_str("startup recorder mutex is poisoned"),
            Self::Write(error) => write!(formatter, "failed to publish startup report: {error}"),
        }
    }
}

impl std::error::Error for StartupMetricError {}

pub trait ElapsedClock: Send + Sync + fmt::Debug {
    fn elapsed_ms(&self) -> u64;
}

#[derive(Debug)]
struct MonotonicClock {
    started_at: Instant,
}

impl MonotonicClock {
    fn new() -> Self {
        Self {
            started_at: Instant::now(),
        }
    }
}

impl ElapsedClock for MonotonicClock {
    fn elapsed_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis().min(u64::MAX as u128) as u64
    }
}

#[derive(Debug)]
struct StartupRecorder {
    output_path: PathBuf,
    report: StartupReport,
    clock: Arc<dyn ElapsedClock>,
}

#[derive(Clone, Debug)]
pub struct StartupMetrics {
    recorder: Option<Arc<Mutex<StartupRecorder>>>,
}

impl StartupMetrics {
    pub fn from_env() -> Self {
        Self::with_clock(
            std::env::var_os(STARTUP_REPORT_ENV).map(PathBuf::from),
            std::env::consts::OS,
            std::env::consts::ARCH,
            std::process::id(),
            Arc::new(MonotonicClock::new()),
        )
    }

    pub fn with_clock(
        output_path: Option<PathBuf>,
        platform: impl Into<String>,
        arch: impl Into<String>,
        pid: u32,
        clock: Arc<dyn ElapsedClock>,
    ) -> Self {
        Self {
            recorder: output_path.map(|output_path| {
                Arc::new(Mutex::new(StartupRecorder {
                    output_path,
                    report: StartupReport::new(platform, arch, pid),
                    clock,
                }))
            }),
        }
    }

    pub fn record(&self, milestone: StartupMilestone) -> Result<RecordOutcome, StartupMetricError> {
        let Some(recorder) = &self.recorder else {
            return Ok(RecordOutcome::Disabled);
        };
        let mut recorder = recorder
            .lock()
            .map_err(|_| StartupMetricError::RecorderPoisoned)?;
        let elapsed_ms = recorder.clock.elapsed_ms();
        let previous = recorder.report.clone();
        let outcome = recorder.report.record(milestone, elapsed_ms)?;
        if outcome == RecordOutcome::Recorded {
            if let Err(error) = write_report_atomically(&recorder.output_path, &recorder.report) {
                recorder.report = previous;
                return Err(StartupMetricError::Write(error.to_string()));
            }
        }
        Ok(outcome)
    }

    pub fn record_or_warn(&self, milestone: StartupMilestone) {
        if let Err(error) = self.record(milestone) {
            log::warn!("Failed to record startup milestone {milestone:?}: {error}");
        }
    }
}

fn write_report_atomically(path: &Path, report: &StartupReport) -> io::Result<()> {
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
