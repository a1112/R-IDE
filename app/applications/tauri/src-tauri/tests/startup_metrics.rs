/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use ride_tauri::initialize_current_startup_metrics;
use ride_tauri::startup_metrics::{
    RecordOutcome, StartupMetricError, StartupMetrics, StartupMilestone, StartupMode,
    StartupReport, StartupReportWriter,
};
use serde_json::Value;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug)]
struct SequenceClock {
    values: Mutex<std::vec::IntoIter<u64>>,
}

impl SequenceClock {
    fn new(values: Vec<u64>) -> Self {
        Self {
            values: Mutex::new(values.into_iter()),
        }
    }
}

impl ride_tauri::startup_metrics::ElapsedClock for SequenceClock {
    fn elapsed_ms(&self) -> u64 {
        self.values
            .lock()
            .expect("clock mutex")
            .next()
            .expect("clock value")
    }
}

fn unique_report_path(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "ride-startup-metrics-{label}-{}-{nonce}.json",
        std::process::id()
    ))
}

fn wait_for_report_milestone(path: &PathBuf, milestone: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(bytes) = fs::read(path) {
            if let Ok(report) = serde_json::from_slice::<Value>(&bytes) {
                if report["milestones"].get(milestone).is_some() {
                    return report;
                }
            }
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {milestone} in {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[derive(Debug)]
struct BlockingWriter {
    started: mpsc::Sender<()>,
    release: mpsc::Receiver<()>,
    written: mpsc::Sender<Value>,
}

impl StartupReportWriter for BlockingWriter {
    fn write(&mut self, report: &StartupReport) -> io::Result<()> {
        self.started.send(()).expect("signal writer start");
        self.release.recv().expect("release blocked writer");
        self.written
            .send(serde_json::to_value(report).expect("serialize observed report"))
            .expect("publish observed report");
        Ok(())
    }
}

#[derive(Debug)]
struct FailOnceWriter {
    attempts: mpsc::Sender<(usize, Value)>,
    attempt: usize,
}

impl StartupReportWriter for FailOnceWriter {
    fn write(&mut self, report: &StartupReport) -> io::Result<()> {
        self.attempt += 1;
        self.attempts
            .send((
                self.attempt,
                serde_json::to_value(report).expect("serialize attempted report"),
            ))
            .expect("publish write attempt");
        if self.attempt == 1 {
            Err(io::Error::other("injected first write failure"))
        } else {
            Ok(())
        }
    }
}

struct FailFinalOnceWriter {
    final_attempts: Arc<AtomicUsize>,
    persisted: mpsc::Sender<Value>,
}

struct CountingWriter {
    writes: mpsc::Sender<Value>,
}

impl StartupReportWriter for CountingWriter {
    fn write(&mut self, report: &StartupReport) -> io::Result<()> {
        self.writes
            .send(serde_json::to_value(report).expect("serialize counted report"))
            .expect("publish counted write");
        Ok(())
    }
}

impl StartupReportWriter for FailFinalOnceWriter {
    fn write(&mut self, report: &StartupReport) -> io::Result<()> {
        let value = serde_json::to_value(report).expect("serialize attempted final report");
        if value["milestones"].get("plugins_ready").is_some()
            && self.final_attempts.fetch_add(1, Ordering::SeqCst) == 0
        {
            return Err(io::Error::other("injected final write failure"));
        }
        self.persisted
            .send(value)
            .expect("publish persisted report snapshot");
        Ok(())
    }
}

#[test]
fn gateway_report_accepts_parallel_branches_without_rewriting_timestamps() {
    let mut report = StartupReport::new("windows", "x86_64", 42, StartupMode::RustGateway);
    assert_eq!(
        report.record(StartupMilestone::ProcessStarted, 0),
        Ok(RecordOutcome::Recorded)
    );
    assert_eq!(
        report.record(StartupMilestone::GatewayListening, 5),
        Ok(RecordOutcome::Recorded)
    );
    assert_eq!(
        report.record(StartupMilestone::FrontendRequestStarted, 8),
        Ok(RecordOutcome::Recorded)
    );
    assert_eq!(
        report.record(StartupMilestone::FrontendBundleLoaded, 40),
        Ok(RecordOutcome::Recorded)
    );
    assert_eq!(
        report.record(StartupMilestone::BackendSpawned, 3),
        Ok(RecordOutcome::Recorded)
    );
    assert_eq!(
        report.record(StartupMilestone::BackendListening, 30),
        Ok(RecordOutcome::Recorded)
    );
    assert_eq!(
        report.record(StartupMilestone::RpcConnected, 45),
        Ok(RecordOutcome::Recorded)
    );

    let value = serde_json::to_value(report).expect("serialize report");
    assert_eq!(value["version"], 2);
    assert_eq!(value["startupMode"], "rust-gateway");
    assert_eq!(value["milestones"]["backend_spawned"], 3);
    assert_eq!(value["milestones"]["frontend_bundle_loaded"], 40);
}

#[test]
fn gateway_report_rejects_a_milestone_with_a_missing_predecessor() {
    let mut report = StartupReport::new("windows", "x86_64", 42, StartupMode::RustGateway);
    report
        .record(StartupMilestone::ProcessStarted, 0)
        .expect("process start");

    assert_eq!(
        report.record(StartupMilestone::FrontendBundleLoaded, 9),
        Err(StartupMetricError::MissingPredecessor {
            attempted: StartupMilestone::FrontendBundleLoaded,
            required: StartupMilestone::FrontendRequestStarted,
        })
    );
}

#[test]
fn gateway_report_rejects_a_timestamp_before_its_predecessor() {
    let mut report = StartupReport::new("windows", "x86_64", 42, StartupMode::RustGateway);
    report
        .record(StartupMilestone::ProcessStarted, 0)
        .expect("process start");
    report
        .record(StartupMilestone::BackendSpawned, 20)
        .expect("backend spawn");

    assert_eq!(
        report.record(StartupMilestone::BackendListening, 19),
        Err(StartupMetricError::PredecessorTimestamp {
            attempted: StartupMilestone::BackendListening,
            predecessor: StartupMilestone::BackendSpawned,
            attempted_ms: 19,
            predecessor_ms: 20,
        })
    );
}

#[test]
fn gateway_report_rejects_gateway_only_milestones_in_legacy_mode() {
    let mut report = StartupReport::new("windows", "x86_64", 42, StartupMode::LegacyExplicit);
    report
        .record(StartupMilestone::ProcessStarted, 0)
        .expect("process start");

    assert_eq!(
        report.record(StartupMilestone::GatewayListening, 1),
        Err(StartupMetricError::NotApplicable {
            milestone: StartupMilestone::GatewayListening,
            mode: StartupMode::LegacyExplicit,
        })
    );
}

#[test]
fn gateway_report_selects_explicit_legacy_mode_before_recorder_construction() {
    assert_eq!(StartupMode::from_env_value(None), StartupMode::RustGateway);
    assert_eq!(
        StartupMode::from_env_value(Some("   \t")),
        StartupMode::RustGateway
    );
    assert_eq!(
        StartupMode::from_env_value(Some("rust-gateway")),
        StartupMode::RustGateway
    );
    assert_eq!(
        StartupMode::from_env_value(Some("legacy")),
        StartupMode::LegacyExplicit
    );
    assert_eq!(
        StartupMode::from_env_value(Some("legacy-explicit")),
        StartupMode::LegacyExplicit
    );
}

#[test]
fn gateway_report_fails_safe_for_unknown_non_empty_startup_mode_without_disclosing_it() {
    let sensitive_value = "unknown-secret-mode";
    let (mode, warning) = StartupMode::from_env_value_with_warning(Some(sensitive_value));

    assert_eq!(mode, StartupMode::LegacyExplicit);
    assert_eq!(
        warning,
        Some("Unsupported RIDE_STARTUP_MODE; using explicit legacy startup mode")
    );
    assert!(!warning.expect("warning").contains(sensitive_value));

    for value in [
        None,
        Some(""),
        Some("  "),
        Some("rust-gateway"),
        Some("legacy"),
        Some("legacy-explicit"),
    ] {
        assert_eq!(
            StartupMode::from_env_value_with_warning(value).1,
            None,
            "unexpected warning for {value:?}"
        );
    }
    assert_eq!(
        StartupMode::from_env_value_with_warning(Some("legacy-fallback")),
        (StartupMode::LegacyExplicit, warning)
    );
}

#[test]
fn gateway_report_allows_one_early_fallback_and_publishes_the_corrected_mode() {
    let (writes_tx, writes_rx) = mpsc::channel();
    let metrics = StartupMetrics::with_clock_and_writer(
        "windows",
        "x86_64",
        42,
        StartupMode::RustGateway,
        Arc::new(SequenceClock::new(vec![0])),
        Box::new(CountingWriter { writes: writes_tx }),
    );
    metrics
        .record(StartupMilestone::ProcessStarted)
        .expect("process start");
    writes_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("initial mode snapshot");

    assert_eq!(
        metrics.select_effective_mode(StartupMode::LegacyFallback),
        Ok(())
    );
    let fallback = writes_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("fallback mode snapshot");
    assert_eq!(fallback["startupMode"], "legacy-fallback");
}

#[test]
fn current_gateway_initialization_waits_for_the_real_bind_outcome() {
    let (writes_tx, writes_rx) = mpsc::channel();
    let metrics = StartupMetrics::with_clock_and_writer(
        "windows",
        "x86_64",
        42,
        StartupMode::RustGateway,
        Arc::new(SequenceClock::new(vec![0])),
        Box::new(CountingWriter { writes: writes_tx }),
    );

    initialize_current_startup_metrics(&metrics, StartupMode::RustGateway)
        .expect("record process start without choosing fallback");

    let initialized = writes_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("initial gateway snapshot");
    assert_eq!(initialized["startupMode"], "rust-gateway");
    assert!(writes_rx.recv_timeout(Duration::from_millis(50)).is_err());
}

#[test]
fn gateway_report_rejects_late_and_invalid_mode_transitions() {
    let (writes_tx, writes_rx) = mpsc::channel();
    let metrics = StartupMetrics::with_clock_and_writer(
        "windows",
        "x86_64",
        42,
        StartupMode::RustGateway,
        Arc::new(SequenceClock::new(vec![0, 3])),
        Box::new(CountingWriter { writes: writes_tx }),
    );
    metrics
        .record(StartupMilestone::ProcessStarted)
        .expect("process start");
    writes_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("process snapshot");
    assert_eq!(
        metrics.select_effective_mode(StartupMode::LegacyExplicit),
        Err(StartupMetricError::InvalidModeTransition {
            current: StartupMode::RustGateway,
            requested: StartupMode::LegacyExplicit,
        })
    );

    metrics
        .record(StartupMilestone::BackendSpawned)
        .expect("parallel backend start");
    writes_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("backend snapshot");
    assert_eq!(
        metrics.select_effective_mode(StartupMode::LegacyFallback),
        Err(StartupMetricError::ModeTransitionTooLate {
            current: StartupMode::RustGateway,
            requested: StartupMode::LegacyFallback,
        })
    );
}

#[test]
fn gateway_report_recorder_preserves_backend_clock_observed_before_window() {
    let (writes_tx, writes_rx) = mpsc::channel();
    let metrics = StartupMetrics::with_clock_and_writer(
        "windows",
        "x86_64",
        42,
        StartupMode::RustGateway,
        Arc::new(SequenceClock::new(vec![0, 5, 3, 700])),
        Box::new(CountingWriter { writes: writes_tx }),
    );
    metrics
        .record(StartupMilestone::ProcessStarted)
        .expect("process start");
    metrics
        .record(StartupMilestone::GatewayListening)
        .expect("gateway listening");
    metrics
        .record_backend_spawned_before_window()
        .expect("backend spawned before window");
    metrics
        .record(StartupMilestone::NativeWindowVisible)
        .expect("window visible");

    let mut final_snapshot = None;
    for _ in 0..4 {
        let snapshot = writes_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("startup snapshot");
        if snapshot["milestones"]
            .get("native_window_visible")
            .is_some()
        {
            final_snapshot = Some(snapshot);
            break;
        }
    }
    let report = final_snapshot.expect("window snapshot");
    assert_eq!(report["milestones"]["backend_spawned"], 3);
    assert_eq!(report["milestones"]["native_window_visible"], 700);
}

#[test]
fn legacy_report_records_milestones_in_its_dependency_order() {
    let mut report = StartupReport::new(
        "test-platform",
        "test-arch",
        42,
        StartupMode::LegacyExplicit,
    );

    assert_eq!(
        report.record(StartupMilestone::ProcessStarted, 0),
        Ok(RecordOutcome::Recorded)
    );
    assert_eq!(
        report.record(StartupMilestone::NativeWindowVisible, 7),
        Ok(RecordOutcome::Recorded)
    );
    assert_eq!(
        report.record(StartupMilestone::BackendSpawned, 12),
        Ok(RecordOutcome::Recorded)
    );
    assert_eq!(
        report.record(StartupMilestone::BackendListening, 19),
        Ok(RecordOutcome::Recorded)
    );
    assert_eq!(
        report.record(StartupMilestone::FrontendShellAttached, 25),
        Ok(RecordOutcome::Recorded)
    );
    assert_eq!(
        report.record(StartupMilestone::TargetFileOpened, 31),
        Ok(RecordOutcome::Recorded)
    );
    assert_eq!(
        report.record(StartupMilestone::PluginsStarted, 40),
        Ok(RecordOutcome::Recorded)
    );
    assert_eq!(
        report.record(StartupMilestone::PluginsReady, 55),
        Ok(RecordOutcome::Recorded)
    );

    let value = serde_json::to_value(&report).expect("serialize report");
    assert_eq!(value["schema"], "ride.startup-report");
    assert_eq!(value["version"], 2);
    assert_eq!(value["startupMode"], "legacy-explicit");
    assert_eq!(value["platform"], "test-platform");
    assert_eq!(value["arch"], "test-arch");
    assert_eq!(value["pid"], 42);
    assert_eq!(value["milestones"]["target_file_opened"], 31);
}

#[test]
fn duplicate_is_idempotent_and_does_not_replace_the_original_duration() {
    let mut report = StartupReport::new("test", "test", 1, StartupMode::LegacyExplicit);
    assert_eq!(
        report.record(StartupMilestone::ProcessStarted, 0),
        Ok(RecordOutcome::Recorded)
    );

    assert_eq!(
        report.record(StartupMilestone::ProcessStarted, 99),
        Ok(RecordOutcome::Duplicate)
    );
    let value = serde_json::to_value(&report).expect("serialize report");
    assert_eq!(value["milestones"]["process_started"], 0);
}

#[test]
fn legacy_report_requires_each_declared_predecessor() {
    let mut report = StartupReport::new("test", "test", 1, StartupMode::LegacyExplicit);
    report
        .record(StartupMilestone::ProcessStarted, 0)
        .expect("process start");
    report
        .record(StartupMilestone::BackendSpawned, 4)
        .expect("skipped native observation remains valid");
    let before = serde_json::to_value(&report).expect("serialize before rejection");
    assert_eq!(
        report.record(StartupMilestone::PluginsStarted, 30),
        Err(StartupMetricError::MissingPredecessor {
            attempted: StartupMilestone::PluginsStarted,
            required: StartupMilestone::TargetFileOpened,
        })
    );
    assert_eq!(
        serde_json::to_value(&report).expect("serialize after rejection"),
        before
    );
}

#[test]
fn non_monotonic_duration_is_rejected_without_polluting_the_report() {
    let mut report = StartupReport::new("test", "test", 1, StartupMode::LegacyExplicit);
    report
        .record(StartupMilestone::ProcessStarted, 10)
        .expect("process start");
    let before = serde_json::to_value(&report).expect("serialize before rejection");

    assert_eq!(
        report.record(StartupMilestone::BackendSpawned, 9),
        Err(StartupMetricError::PredecessorTimestamp {
            attempted: StartupMilestone::BackendSpawned,
            predecessor: StartupMilestone::ProcessStarted,
            attempted_ms: 9,
            predecessor_ms: 10,
        })
    );
    assert_eq!(
        serde_json::to_value(&report).expect("serialize after rejection"),
        before
    );
}

#[test]
fn enabled_recorder_publishes_incrementally_readable_json() {
    let output = unique_report_path("incremental");
    let metrics = StartupMetrics::with_clock(
        Some(output.clone()),
        "test-platform",
        "test-arch",
        77,
        StartupMode::LegacyExplicit,
        Arc::new(SequenceClock::new(vec![0, 15, 22])),
    );

    metrics
        .record(StartupMilestone::ProcessStarted)
        .expect("publish process start");
    let first = wait_for_report_milestone(&output, "process_started");
    assert_eq!(first["milestones"]["process_started"], 0);
    assert_eq!(first["milestones"].get("backend_spawned"), None);

    metrics
        .record(StartupMilestone::BackendSpawned)
        .expect("publish backend spawn");
    let second = wait_for_report_milestone(&output, "backend_spawned");
    assert_eq!(second["milestones"]["process_started"], 0);
    assert_eq!(second["milestones"]["backend_spawned"], 15);

    let output_name = output
        .file_name()
        .expect("report file name")
        .to_string_lossy();
    let temporary_prefix = format!(".{output_name}.");
    assert!(
        fs::read_dir(output.parent().expect("report parent"))
            .expect("read report parent")
            .filter_map(Result::ok)
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .starts_with(&temporary_prefix)),
        "atomic writer must not leave sibling temporary files"
    );
    fs::remove_file(output).expect("remove report");
}

#[test]
fn legacy_backend_spawn_before_window_keeps_its_actual_timestamp() {
    let output = unique_report_path("overlapped-backend");
    let metrics = StartupMetrics::with_clock(
        Some(output.clone()),
        "test-platform",
        "test-arch",
        77,
        StartupMode::LegacyExplicit,
        Arc::new(SequenceClock::new(vec![0, 100, 700])),
    );

    metrics
        .record(StartupMilestone::ProcessStarted)
        .expect("publish process start");
    metrics
        .record_backend_spawned_before_window()
        .expect("publish overlapped backend spawn");
    let before_window = wait_for_report_milestone(&output, "backend_spawned");
    assert_eq!(before_window["milestones"]["backend_spawned"], 100);

    metrics
        .record(StartupMilestone::NativeWindowVisible)
        .expect("publish native window");
    let visible = wait_for_report_milestone(&output, "native_window_visible");
    assert_eq!(visible["milestones"]["native_window_visible"], 700);
    assert_eq!(visible["milestones"]["backend_spawned"], 100);

    fs::remove_file(output).expect("remove report");
}

#[test]
fn legacy_backend_readiness_before_window_keeps_actual_timestamps() {
    let output = unique_report_path("overlapped-listening");
    let metrics = StartupMetrics::with_clock(
        Some(output.clone()),
        "test-platform",
        "test-arch",
        78,
        StartupMode::LegacyExplicit,
        Arc::new(SequenceClock::new(vec![0, 100, 200, 700])),
    );

    metrics
        .record(StartupMilestone::ProcessStarted)
        .expect("publish process start");
    metrics
        .record_backend_spawned_before_window()
        .expect("publish overlapped backend spawn");
    metrics
        .record_backend_listening_before_window()
        .expect("publish overlapped backend readiness");
    let before_window = wait_for_report_milestone(&output, "backend_listening");
    assert_eq!(before_window["milestones"]["backend_spawned"], 100);
    assert_eq!(before_window["milestones"]["backend_listening"], 200);

    metrics
        .record(StartupMilestone::NativeWindowVisible)
        .expect("publish native window");
    let visible = wait_for_report_milestone(&output, "native_window_visible");
    assert_eq!(visible["milestones"]["native_window_visible"], 700);
    assert_eq!(visible["milestones"]["backend_spawned"], 100);
    assert_eq!(visible["milestones"]["backend_listening"], 200);

    fs::remove_file(output).expect("remove report");
}

#[test]
fn blocked_writer_does_not_block_recording_and_preserves_snapshot_order() {
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (written_tx, written_rx) = mpsc::channel();
    let metrics = StartupMetrics::with_clock_and_writer(
        "test-platform",
        "test-arch",
        77,
        StartupMode::LegacyExplicit,
        Arc::new(SequenceClock::new(vec![0, 15])),
        Box::new(BlockingWriter {
            started: started_tx,
            release: release_rx,
            written: written_tx,
        }),
    );

    assert_eq!(
        metrics.record(StartupMilestone::ProcessStarted),
        Ok(RecordOutcome::Recorded)
    );
    started_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("first write starts");

    let second_metrics = metrics.clone();
    let (recorded_tx, recorded_rx) = mpsc::channel();
    std::thread::spawn(move || {
        recorded_tx
            .send(second_metrics.record(StartupMilestone::BackendSpawned))
            .expect("publish record result");
    });
    assert_eq!(
        recorded_rx
            .recv_timeout(Duration::from_millis(200))
            .expect("recording must not wait for blocked I/O"),
        Ok(RecordOutcome::Recorded)
    );

    release_tx.send(()).expect("release first write");
    let first = written_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("first snapshot");
    started_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("second write starts after first");
    release_tx.send(()).expect("release second write");
    let second = written_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("second snapshot");

    assert_eq!(first["milestones"]["process_started"], 0);
    assert_eq!(first["milestones"].get("backend_spawned"), None);
    assert_eq!(second["milestones"]["backend_spawned"], 15);
}

#[test]
fn writer_retries_a_failed_snapshot_without_an_external_duplicate() {
    let (attempts_tx, attempts_rx) = mpsc::channel();
    let metrics = StartupMetrics::with_clock_and_writer(
        "test-platform",
        "test-arch",
        77,
        StartupMode::LegacyExplicit,
        Arc::new(SequenceClock::new(vec![0])),
        Box::new(FailOnceWriter {
            attempts: attempts_tx,
            attempt: 0,
        }),
    );

    assert_eq!(
        metrics.record(StartupMilestone::ProcessStarted),
        Ok(RecordOutcome::Recorded)
    );
    let (first_attempt, _) = attempts_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("failed first write attempt");
    assert_eq!(first_attempt, 1);

    let (retry_attempt, retry) = attempts_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("worker retries latest snapshot");
    assert_eq!(retry_attempt, 2);
    assert_eq!(retry["milestones"]["process_started"], 0);
}

#[test]
fn duplicate_records_do_not_enqueue_additional_writer_calls() {
    let (writes_tx, writes_rx) = mpsc::channel();
    let metrics = StartupMetrics::with_clock_and_writer(
        "test-platform",
        "test-arch",
        77,
        StartupMode::LegacyExplicit,
        Arc::new(SequenceClock::new(vec![0, 1, 2, 3, 4])),
        Box::new(CountingWriter { writes: writes_tx }),
    );

    assert_eq!(
        metrics.record(StartupMilestone::ProcessStarted),
        Ok(RecordOutcome::Recorded)
    );
    writes_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("initial snapshot is written");

    for _ in 0..4 {
        assert_eq!(
            metrics.record(StartupMilestone::ProcessStarted),
            Ok(RecordOutcome::Duplicate)
        );
    }
    assert_eq!(
        writes_rx.recv_timeout(Duration::from_millis(100)),
        Err(mpsc::RecvTimeoutError::Timeout),
        "duplicates must not grow the writer queue"
    );
}

#[test]
fn final_snapshot_is_persisted_after_its_first_write_fails() {
    let final_attempts = Arc::new(AtomicUsize::new(0));
    let (persisted_tx, persisted_rx) = mpsc::channel();
    let metrics = StartupMetrics::with_clock_and_writer(
        "test-platform",
        "test-arch",
        77,
        StartupMode::LegacyExplicit,
        Arc::new(SequenceClock::new(vec![0, 5, 10, 15, 20, 25, 30, 35])),
        Box::new(FailFinalOnceWriter {
            final_attempts: final_attempts.clone(),
            persisted: persisted_tx,
        }),
    );

    for milestone in [
        StartupMilestone::ProcessStarted,
        StartupMilestone::NativeWindowVisible,
        StartupMilestone::BackendSpawned,
        StartupMilestone::BackendListening,
        StartupMilestone::FrontendShellAttached,
        StartupMilestone::TargetFileOpened,
        StartupMilestone::PluginsStarted,
        StartupMilestone::PluginsReady,
    ] {
        assert_eq!(metrics.record(milestone), Ok(RecordOutcome::Recorded));
    }

    let final_report = loop {
        let persisted = persisted_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("worker automatically retries and persists final snapshot");
        if persisted["milestones"].get("plugins_ready").is_some() {
            break persisted;
        }
    };
    assert_eq!(final_attempts.load(Ordering::SeqCst), 2);
    assert_eq!(final_report["milestones"]["plugins_ready"], 35);
}

#[test]
fn backend_listening_is_recorded_before_the_port_is_published() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let record_events = events.clone();
    let publish_events = events.clone();

    ride_tauri::sidecar::publish_backend_listening_in_order(
        3000,
        move |milestone| {
            record_events
                .lock()
                .expect("record events")
                .push(format!("record:{milestone:?}"));
        },
        move |port| {
            publish_events
                .lock()
                .expect("publish events")
                .push(format!("publish:{port}"));
        },
    );

    assert_eq!(
        *events.lock().expect("final events"),
        ["record:BackendListening", "publish:3000"]
    );
}

#[test]
fn disabled_recorder_never_creates_a_report() {
    let output = unique_report_path("disabled");
    let metrics = StartupMetrics::with_clock(
        None,
        "test-platform",
        "test-arch",
        77,
        StartupMode::LegacyExplicit,
        Arc::new(SequenceClock::new(vec![0])),
    );

    assert_eq!(
        metrics
            .record(StartupMilestone::ProcessStarted)
            .expect("disabled recording is a no-op"),
        RecordOutcome::Disabled
    );
    assert!(!output.exists());
}

#[test]
fn frontend_allowlist_excludes_every_native_backend_and_gateway_milestone() {
    for milestone in [
        StartupMilestone::ProcessStarted,
        StartupMilestone::GatewayListening,
        StartupMilestone::NativeWindowVisible,
        StartupMilestone::FrontendRequestStarted,
        StartupMilestone::FrontendBundleLoaded,
        StartupMilestone::BackendSpawned,
        StartupMilestone::BackendListening,
        StartupMilestone::RpcConnected,
        StartupMilestone::FrontendShellAttached,
        StartupMilestone::TargetFileOpened,
        StartupMilestone::PluginsStarted,
        StartupMilestone::PluginsReady,
    ] {
        let expected = match milestone {
            StartupMilestone::FrontendShellAttached
            | StartupMilestone::TargetFileOpened
            | StartupMilestone::PluginsStarted
            | StartupMilestone::PluginsReady => true,
            StartupMilestone::ProcessStarted
            | StartupMilestone::GatewayListening
            | StartupMilestone::NativeWindowVisible
            | StartupMilestone::FrontendRequestStarted
            | StartupMilestone::FrontendBundleLoaded
            | StartupMilestone::BackendSpawned
            | StartupMilestone::BackendListening
            | StartupMilestone::RpcConnected => false,
        };
        assert_eq!(
            milestone.is_frontend_reportable(),
            expected,
            "{milestone:?}"
        );
    }
}
