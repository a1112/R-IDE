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

pub const STARTUP_REPORT_ENV: &str = "RIDE_STARTUP_REPORT";
pub const STARTUP_REPORT_SCHEMA: &str = "ride.startup-report";
pub const STARTUP_REPORT_VERSION: u32 = 2;
pub const STARTUP_MODE_ENV: &str = "RIDE_STARTUP_MODE";
const STARTUP_REPORT_WRITE_ATTEMPTS: usize = 3;
const STARTUP_REPORT_RETRY_DELAY_MS: u64 = 10;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StartupMode {
    RustGateway,
    LegacyExplicit,
    LegacyFallback,
}

impl StartupMode {
    pub fn from_env() -> Self {
        Self::from_env_value(std::env::var(STARTUP_MODE_ENV).ok().as_deref())
    }

    pub fn from_env_value(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some(value) if value.eq_ignore_ascii_case("legacy") => Self::LegacyExplicit,
            _ => Self::RustGateway,
        }
    }

    pub const fn predecessors(self, milestone: StartupMilestone) -> &'static [StartupMilestone] {
        match self {
            Self::RustGateway => milestone.gateway_predecessors(),
            Self::LegacyExplicit | Self::LegacyFallback => milestone.legacy_predecessors(),
        }
    }

    const fn is_applicable(self, milestone: StartupMilestone) -> bool {
        match self {
            Self::RustGateway => true,
            Self::LegacyExplicit | Self::LegacyFallback => !matches!(
                milestone,
                StartupMilestone::GatewayListening
                    | StartupMilestone::FrontendRequestStarted
                    | StartupMilestone::FrontendBundleLoaded
                    | StartupMilestone::RpcConnected
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupMilestone {
    ProcessStarted,
    GatewayListening,
    NativeWindowVisible,
    FrontendRequestStarted,
    FrontendBundleLoaded,
    BackendSpawned,
    BackendListening,
    RpcConnected,
    FrontendShellAttached,
    TargetFileOpened,
    PluginsStarted,
    PluginsReady,
}

impl StartupMilestone {
    const fn gateway_predecessors(self) -> &'static [Self] {
        match self {
            Self::ProcessStarted => &[],
            Self::GatewayListening | Self::BackendSpawned => &[Self::ProcessStarted],
            Self::NativeWindowVisible | Self::FrontendRequestStarted => &[Self::GatewayListening],
            Self::FrontendBundleLoaded => &[Self::FrontendRequestStarted],
            Self::BackendListening => &[Self::BackendSpawned],
            Self::RpcConnected => &[Self::BackendListening, Self::FrontendRequestStarted],
            Self::FrontendShellAttached => &[Self::RpcConnected, Self::FrontendBundleLoaded],
            Self::TargetFileOpened => &[Self::FrontendShellAttached],
            Self::PluginsStarted => &[Self::TargetFileOpened],
            Self::PluginsReady => &[Self::PluginsStarted],
        }
    }

    const fn legacy_predecessors(self) -> &'static [Self] {
        match self {
            Self::ProcessStarted => &[],
            Self::NativeWindowVisible | Self::BackendSpawned => &[Self::ProcessStarted],
            Self::BackendListening => &[Self::BackendSpawned],
            Self::FrontendShellAttached => &[Self::BackendListening, Self::NativeWindowVisible],
            Self::TargetFileOpened => &[Self::FrontendShellAttached],
            Self::PluginsStarted => &[Self::TargetFileOpened],
            Self::PluginsReady => &[Self::PluginsStarted],
            Self::GatewayListening
            | Self::FrontendRequestStarted
            | Self::FrontendBundleLoaded
            | Self::RpcConnected => &[],
        }
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
    gateway_listening: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_window_visible: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    frontend_request_started: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    frontend_bundle_loaded: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    backend_spawned: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    backend_listening: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rpc_connected: Option<u64>,
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
            StartupMilestone::GatewayListening => self.gateway_listening,
            StartupMilestone::NativeWindowVisible => self.native_window_visible,
            StartupMilestone::FrontendRequestStarted => self.frontend_request_started,
            StartupMilestone::FrontendBundleLoaded => self.frontend_bundle_loaded,
            StartupMilestone::BackendSpawned => self.backend_spawned,
            StartupMilestone::BackendListening => self.backend_listening,
            StartupMilestone::RpcConnected => self.rpc_connected,
            StartupMilestone::FrontendShellAttached => self.frontend_shell_attached,
            StartupMilestone::TargetFileOpened => self.target_file_opened,
            StartupMilestone::PluginsStarted => self.plugins_started,
            StartupMilestone::PluginsReady => self.plugins_ready,
        }
    }

    fn set(&mut self, milestone: StartupMilestone, duration_ms: u64) {
        let slot = match milestone {
            StartupMilestone::ProcessStarted => &mut self.process_started,
            StartupMilestone::GatewayListening => &mut self.gateway_listening,
            StartupMilestone::NativeWindowVisible => &mut self.native_window_visible,
            StartupMilestone::FrontendRequestStarted => &mut self.frontend_request_started,
            StartupMilestone::FrontendBundleLoaded => &mut self.frontend_bundle_loaded,
            StartupMilestone::BackendSpawned => &mut self.backend_spawned,
            StartupMilestone::BackendListening => &mut self.backend_listening,
            StartupMilestone::RpcConnected => &mut self.rpc_connected,
            StartupMilestone::FrontendShellAttached => &mut self.frontend_shell_attached,
            StartupMilestone::TargetFileOpened => &mut self.target_file_opened,
            StartupMilestone::PluginsStarted => &mut self.plugins_started,
            StartupMilestone::PluginsReady => &mut self.plugins_ready,
        };
        *slot = Some(duration_ms);
    }

    fn only_process_started(&self) -> bool {
        self.process_started.is_some()
            && self.gateway_listening.is_none()
            && self.native_window_visible.is_none()
            && self.frontend_request_started.is_none()
            && self.frontend_bundle_loaded.is_none()
            && self.backend_spawned.is_none()
            && self.backend_listening.is_none()
            && self.rpc_connected.is_none()
            && self.frontend_shell_attached.is_none()
            && self.target_file_opened.is_none()
            && self.plugins_started.is_none()
            && self.plugins_ready.is_none()
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct StartupReport {
    schema: &'static str,
    version: u32,
    platform: String,
    arch: String,
    pid: u32,
    #[serde(rename = "startupMode")]
    startup_mode: StartupMode,
    milestones: StartupMilestoneDurations,
}

impl StartupReport {
    pub fn new(
        platform: impl Into<String>,
        arch: impl Into<String>,
        pid: u32,
        startup_mode: StartupMode,
    ) -> Self {
        Self {
            schema: STARTUP_REPORT_SCHEMA,
            version: STARTUP_REPORT_VERSION,
            platform: platform.into(),
            arch: arch.into(),
            pid,
            startup_mode,
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

        if !self.startup_mode.is_applicable(milestone) {
            return Err(StartupMetricError::NotApplicable {
                milestone,
                mode: self.startup_mode,
            });
        }

        for predecessor in self.startup_mode.predecessors(milestone) {
            let Some(predecessor_ms) = self.milestones.get(*predecessor) else {
                return Err(StartupMetricError::MissingPredecessor {
                    attempted: milestone,
                    required: *predecessor,
                });
            };
            if duration_ms < predecessor_ms {
                return Err(StartupMetricError::PredecessorTimestamp {
                    attempted: milestone,
                    predecessor: *predecessor,
                    attempted_ms: duration_ms,
                    predecessor_ms,
                });
            }
        }

        self.milestones.set(milestone, duration_ms);
        Ok(RecordOutcome::Recorded)
    }

    fn select_effective_mode(
        &mut self,
        requested: StartupMode,
    ) -> Result<bool, StartupMetricError> {
        if requested == self.startup_mode {
            return Ok(false);
        }
        if self.startup_mode != StartupMode::RustGateway || requested != StartupMode::LegacyFallback
        {
            return Err(StartupMetricError::InvalidModeTransition {
                current: self.startup_mode,
                requested,
            });
        }
        if !self.milestones.only_process_started() {
            return Err(StartupMetricError::ModeTransitionTooLate {
                current: self.startup_mode,
                requested,
            });
        }
        self.startup_mode = requested;
        Ok(true)
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
    MissingPredecessor {
        attempted: StartupMilestone,
        required: StartupMilestone,
    },
    PredecessorTimestamp {
        attempted: StartupMilestone,
        predecessor: StartupMilestone,
        attempted_ms: u64,
        predecessor_ms: u64,
    },
    NotApplicable {
        milestone: StartupMilestone,
        mode: StartupMode,
    },
    InvalidModeTransition {
        current: StartupMode,
        requested: StartupMode,
    },
    ModeTransitionTooLate {
        current: StartupMode,
        requested: StartupMode,
    },
    ClockOverflow,
    RecorderPoisoned,
    Write(String),
}

impl fmt::Display for StartupMetricError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingPredecessor {
                attempted,
                required,
            } => write!(
                formatter,
                "startup milestone {attempted:?} requires {required:?}"
            ),
            Self::PredecessorTimestamp {
                attempted,
                predecessor,
                attempted_ms,
                predecessor_ms,
            } => write!(
                formatter,
                "startup milestone {attempted:?} at {attempted_ms}ms precedes predecessor {predecessor:?} at {predecessor_ms}ms"
            ),
            Self::NotApplicable { milestone, mode } => write!(
                formatter,
                "startup milestone {milestone:?} is not applicable in {mode:?} mode"
            ),
            Self::InvalidModeTransition { current, requested } => write!(
                formatter,
                "startup mode cannot change from {current:?} to {requested:?}"
            ),
            Self::ModeTransitionTooLate { current, requested } => write!(
                formatter,
                "startup mode change from {current:?} to {requested:?} was requested after startup advanced"
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
struct StartupRecorderState {
    report: StartupReport,
    clock: Arc<dyn ElapsedClock>,
}

#[derive(Debug)]
struct StartupRecorder {
    state: Mutex<StartupRecorderState>,
    snapshots: mpsc::Sender<StartupReport>,
}

#[derive(Clone, Debug)]
pub struct StartupMetrics {
    recorder: Option<Arc<StartupRecorder>>,
}

pub trait StartupReportWriter: Send + 'static {
    fn write(&mut self, report: &StartupReport) -> io::Result<()>;
}

#[derive(Debug)]
struct AtomicStartupReportWriter {
    output_path: PathBuf,
}

impl StartupReportWriter for AtomicStartupReportWriter {
    fn write(&mut self, report: &StartupReport) -> io::Result<()> {
        write_report_atomically(&self.output_path, report)
    }
}

impl StartupMetrics {
    pub fn from_env(requested_mode: StartupMode) -> Self {
        Self::with_clock(
            std::env::var_os(STARTUP_REPORT_ENV).map(PathBuf::from),
            std::env::consts::OS,
            std::env::consts::ARCH,
            std::process::id(),
            requested_mode,
            Arc::new(MonotonicClock::new()),
        )
    }

    pub fn with_clock(
        output_path: Option<PathBuf>,
        platform: impl Into<String>,
        arch: impl Into<String>,
        pid: u32,
        requested_mode: StartupMode,
        clock: Arc<dyn ElapsedClock>,
    ) -> Self {
        let Some(output_path) = output_path else {
            return Self { recorder: None };
        };
        Self::with_clock_and_writer(
            platform,
            arch,
            pid,
            requested_mode,
            clock,
            Box::new(AtomicStartupReportWriter { output_path }),
        )
    }

    pub fn with_clock_and_writer(
        platform: impl Into<String>,
        arch: impl Into<String>,
        pid: u32,
        requested_mode: StartupMode,
        clock: Arc<dyn ElapsedClock>,
        writer: Box<dyn StartupReportWriter>,
    ) -> Self {
        let snapshots = spawn_report_writer(writer);
        Self {
            recorder: Some(Arc::new(StartupRecorder {
                state: Mutex::new(StartupRecorderState {
                    report: StartupReport::new(platform, arch, pid, requested_mode),
                    clock,
                }),
                snapshots,
            })),
        }
    }

    pub fn record(&self, milestone: StartupMilestone) -> Result<RecordOutcome, StartupMetricError> {
        let Some(recorder) = &self.recorder else {
            return Ok(RecordOutcome::Disabled);
        };
        let outcome = {
            let mut state = recorder
                .state
                .lock()
                .map_err(|_| StartupMetricError::RecorderPoisoned)?;
            let elapsed_ms = state.clock.elapsed_ms();
            let outcome = state.report.record(milestone, elapsed_ms)?;
            if outcome == RecordOutcome::Recorded {
                // The unbounded send cannot wait for disk I/O. Keeping it in this
                // critical section preserves mutation order for concurrent callers.
                recorder
                    .snapshots
                    .send(state.report.clone())
                    .map_err(|error| StartupMetricError::Write(error.to_string()))?;
            }
            outcome
        };
        Ok(outcome)
    }

    pub fn select_effective_mode(
        &self,
        requested_mode: StartupMode,
    ) -> Result<(), StartupMetricError> {
        let Some(recorder) = &self.recorder else {
            return Ok(());
        };
        let mut state = recorder
            .state
            .lock()
            .map_err(|_| StartupMetricError::RecorderPoisoned)?;
        if state.report.select_effective_mode(requested_mode)? {
            recorder
                .snapshots
                .send(state.report.clone())
                .map_err(|error| StartupMetricError::Write(error.to_string()))?;
        }
        Ok(())
    }

    pub fn record_backend_spawned_before_window(
        &self,
    ) -> Result<RecordOutcome, StartupMetricError> {
        self.record(StartupMilestone::BackendSpawned)
    }

    pub fn record_backend_listening_before_window(
        &self,
    ) -> Result<RecordOutcome, StartupMetricError> {
        self.record(StartupMilestone::BackendListening)
    }

    pub fn record_or_warn(&self, milestone: StartupMilestone) {
        if let Err(error) = self.record(milestone) {
            log::warn!("Failed to record startup milestone {milestone:?}: {error}");
        }
    }
}

fn spawn_report_writer(mut writer: Box<dyn StartupReportWriter>) -> mpsc::Sender<StartupReport> {
    let (sender, snapshots) = mpsc::channel::<StartupReport>();
    if let Err(error) = std::thread::Builder::new()
        .name("ride-startup-report-writer".to_string())
        .spawn(move || {
            while let Ok(snapshot) = snapshots.recv() {
                write_snapshot_with_retry(writer.as_mut(), &snapshot);
            }
        })
    {
        log::warn!("Failed to start startup report writer: {error}");
    }
    sender
}

fn write_snapshot_with_retry(writer: &mut dyn StartupReportWriter, snapshot: &StartupReport) {
    for attempt in 1..=STARTUP_REPORT_WRITE_ATTEMPTS {
        match writer.write(snapshot) {
            Ok(()) => return,
            Err(error) if attempt < STARTUP_REPORT_WRITE_ATTEMPTS => {
                log::warn!(
                    "Failed to publish startup report snapshot (attempt {attempt}/{}): {error}",
                    STARTUP_REPORT_WRITE_ATTEMPTS
                );
                std::thread::sleep(Duration::from_millis(
                    STARTUP_REPORT_RETRY_DELAY_MS * attempt as u64,
                ));
            }
            Err(error) => {
                log::warn!(
                    "Failed to publish startup report snapshot after {} attempts: {error}",
                    STARTUP_REPORT_WRITE_ATTEMPTS
                );
                return;
            }
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
