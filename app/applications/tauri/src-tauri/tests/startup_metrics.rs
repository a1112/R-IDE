/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use ride_tauri::startup_metrics::{
    RecordOutcome, StartupMetricError, StartupMetrics, StartupMilestone, StartupReport,
    StartupReportWriter,
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
fn report_records_monotonic_milestones_in_the_declared_order() {
    let mut report = StartupReport::new("test-platform", "test-arch", 42);

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
    assert_eq!(value["version"], 1);
    assert_eq!(value["platform"], "test-platform");
    assert_eq!(value["arch"], "test-arch");
    assert_eq!(value["pid"], 42);
    assert_eq!(value["milestones"]["target_file_opened"], 31);
}

#[test]
fn duplicate_is_idempotent_and_does_not_replace_the_original_duration() {
    let mut report = StartupReport::new("test", "test", 1);
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
fn optional_milestones_can_be_skipped_without_weakening_ordering() {
    let mut report = StartupReport::new("test", "test", 1);
    report
        .record(StartupMilestone::ProcessStarted, 0)
        .expect("process start");
    report
        .record(StartupMilestone::BackendSpawned, 4)
        .expect("skipped native observation remains valid");
    report
        .record(StartupMilestone::PluginsStarted, 30)
        .expect("no-file startup may skip target file");

    let before = serde_json::to_value(&report).expect("serialize before rejection");
    assert_eq!(
        report.record(StartupMilestone::FrontendShellAttached, 31),
        Err(StartupMetricError::OutOfOrder {
            attempted: StartupMilestone::FrontendShellAttached,
            latest: StartupMilestone::PluginsStarted,
        })
    );
    assert_eq!(
        serde_json::to_value(&report).expect("serialize after rejection"),
        before
    );
}

#[test]
fn non_monotonic_duration_is_rejected_without_polluting_the_report() {
    let mut report = StartupReport::new("test", "test", 1);
    report
        .record(StartupMilestone::ProcessStarted, 10)
        .expect("process start");
    let before = serde_json::to_value(&report).expect("serialize before rejection");

    assert_eq!(
        report.record(StartupMilestone::BackendSpawned, 9),
        Err(StartupMetricError::NonMonotonic {
            attempted_ms: 9,
            latest_ms: 10,
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
fn overlapped_backend_spawn_is_published_in_canonical_order_after_window_visibility() {
    let output = unique_report_path("overlapped-backend");
    let metrics = StartupMetrics::with_clock(
        Some(output.clone()),
        "test-platform",
        "test-arch",
        77,
        Arc::new(SequenceClock::new(vec![0, 100, 700])),
    );

    metrics
        .record(StartupMilestone::ProcessStarted)
        .expect("publish process start");
    metrics
        .record_backend_spawned_before_window()
        .expect("hold overlapped backend spawn");
    let before_window = wait_for_report_milestone(&output, "process_started");
    assert_eq!(before_window["milestones"].get("backend_spawned"), None);

    metrics
        .record(StartupMilestone::NativeWindowVisible)
        .expect("publish native window and held backend spawn");
    let visible = wait_for_report_milestone(&output, "backend_spawned");
    assert_eq!(visible["milestones"]["native_window_visible"], 700);
    assert_eq!(visible["milestones"]["backend_spawned"], 700);

    fs::remove_file(output).expect("remove report");
}

#[test]
fn overlapped_backend_readiness_waits_for_window_visibility_without_losing_v1_order() {
    let output = unique_report_path("overlapped-listening");
    let metrics = StartupMetrics::with_clock(
        Some(output.clone()),
        "test-platform",
        "test-arch",
        78,
        Arc::new(SequenceClock::new(vec![0, 100, 200, 700])),
    );

    metrics
        .record(StartupMilestone::ProcessStarted)
        .expect("publish process start");
    metrics
        .record_backend_spawned_before_window()
        .expect("hold overlapped backend spawn");
    metrics
        .record_backend_listening_before_window()
        .expect("hold overlapped backend readiness");
    let before_window = wait_for_report_milestone(&output, "process_started");
    assert_eq!(before_window["milestones"].get("backend_spawned"), None);
    assert_eq!(before_window["milestones"].get("backend_listening"), None);

    metrics
        .record(StartupMilestone::NativeWindowVisible)
        .expect("publish all held backend phases");
    let visible = wait_for_report_milestone(&output, "backend_listening");
    assert_eq!(visible["milestones"]["native_window_visible"], 700);
    assert_eq!(visible["milestones"]["backend_spawned"], 700);
    assert_eq!(visible["milestones"]["backend_listening"], 700);

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
fn frontend_allowlist_excludes_native_and_backend_milestones() {
    for milestone in [
        StartupMilestone::FrontendShellAttached,
        StartupMilestone::TargetFileOpened,
        StartupMilestone::PluginsStarted,
        StartupMilestone::PluginsReady,
    ] {
        assert!(milestone.is_frontend_reportable(), "{milestone:?}");
    }
    for milestone in [
        StartupMilestone::ProcessStarted,
        StartupMilestone::NativeWindowVisible,
        StartupMilestone::BackendSpawned,
        StartupMilestone::BackendListening,
    ] {
        assert!(!milestone.is_frontend_reportable(), "{milestone:?}");
    }
}
