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
};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

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
    let first: Value = serde_json::from_slice(&fs::read(&output).expect("read first report"))
        .expect("parse first report");
    assert_eq!(first["milestones"]["process_started"], 0);
    assert_eq!(first["milestones"].get("backend_spawned"), None);

    metrics
        .record(StartupMilestone::BackendSpawned)
        .expect("publish backend spawn");
    let second: Value = serde_json::from_slice(&fs::read(&output).expect("read second report"))
        .expect("parse second report");
    assert_eq!(second["milestones"]["process_started"], 0);
    assert_eq!(second["milestones"]["backend_spawned"], 15);

    assert!(
        fs::read_dir(output.parent().expect("report parent"))
            .expect("read report parent")
            .filter_map(Result::ok)
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .contains("ride-startup-metrics-incremental")
                || entry.path() == output),
        "atomic writer must not leave sibling temporary files"
    );
    fs::remove_file(output).expect("remove report");
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
