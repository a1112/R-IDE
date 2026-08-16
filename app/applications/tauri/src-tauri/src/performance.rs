/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageGroup {
    pub cpu_percent: f32,
    pub memory_bytes: u64,
    pub process_count: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceSnapshot {
    pub sampled_at_ms: u64,
    pub total: UsageGroup,
    pub main: UsageGroup,
    pub backend: UsageGroup,
    pub plugin_host: UsageGroup,
    pub other: UsageGroup,
}

#[derive(Clone, Debug)]
struct ProcessSample {
    pid: u32,
    parent_pid: Option<u32>,
    cpu_percent: f32,
    memory_bytes: u64,
    executable: String,
    name: String,
    command_line: String,
}

fn aggregate_snapshot(
    samples: &[ProcessSample],
    root_pid: u32,
    backend_pid: Option<u32>,
    logical_cpu_count: usize,
    sampled_at_ms: u64,
) -> PerformanceSnapshot {
    let mut samples_by_pid = HashMap::new();
    let mut duplicate_pids = HashSet::new();
    for sample in samples {
        if duplicate_pids.contains(&sample.pid) {
            continue;
        }
        if samples_by_pid.insert(sample.pid, sample).is_some() {
            samples_by_pid.remove(&sample.pid);
            duplicate_pids.insert(sample.pid);
        }
    }

    let mut children_by_parent = HashMap::<u32, Vec<u32>>::new();
    for sample in samples_by_pid.values() {
        if let Some(parent_pid) = sample.parent_pid {
            children_by_parent
                .entry(parent_pid)
                .or_default()
                .push(sample.pid);
        }
    }

    let mut snapshot = PerformanceSnapshot {
        sampled_at_ms,
        total: UsageGroup::default(),
        main: UsageGroup::default(),
        backend: UsageGroup::default(),
        plugin_host: UsageGroup::default(),
        other: UsageGroup::default(),
    };
    if !samples_by_pid.contains_key(&root_pid) {
        return snapshot;
    }

    let mut pending = VecDeque::from([root_pid]);
    let mut visited = HashSet::new();
    while let Some(pid) = pending.pop_front() {
        if !visited.insert(pid) {
            continue;
        }
        let Some(sample) = samples_by_pid.get(&pid) else {
            continue;
        };

        add_sample(&mut snapshot.total, sample);
        let group = if pid == root_pid {
            &mut snapshot.main
        } else if Some(pid) == backend_pid {
            &mut snapshot.backend
        } else if is_plugin_host(sample) {
            &mut snapshot.plugin_host
        } else {
            &mut snapshot.other
        };
        add_sample(group, sample);

        if let Some(children) = children_by_parent.get(&pid) {
            pending.extend(children);
        }
    }

    normalize_cpu(&mut snapshot.total, logical_cpu_count);
    normalize_cpu(&mut snapshot.main, logical_cpu_count);
    normalize_cpu(&mut snapshot.backend, logical_cpu_count);
    normalize_cpu(&mut snapshot.plugin_host, logical_cpu_count);
    normalize_cpu(&mut snapshot.other, logical_cpu_count);
    snapshot
}

fn add_sample(group: &mut UsageGroup, sample: &ProcessSample) {
    if sample.cpu_percent.is_finite() && sample.cpu_percent >= 0.0 {
        group.cpu_percent += sample.cpu_percent;
    }
    group.memory_bytes = group.memory_bytes.saturating_add(sample.memory_bytes);
    group.process_count = group.process_count.saturating_add(1);
}

fn normalize_cpu(group: &mut UsageGroup, logical_cpu_count: usize) {
    group.cpu_percent = if logical_cpu_count == 0 {
        0.0
    } else {
        (group.cpu_percent / logical_cpu_count as f32).clamp(0.0, 100.0)
    };
}

fn is_plugin_host(sample: &ProcessSample) -> bool {
    const MARKER: &[u8] = b"plugin-host";
    let contains_marker = |value: &str| {
        value
            .as_bytes()
            .windows(MARKER.len())
            .any(|window| window.eq_ignore_ascii_case(MARKER))
    };
    contains_marker(&sample.executable)
        || contains_marker(&sample.name)
        || contains_marker(&sample.command_line)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(
        pid: u32,
        parent_pid: Option<u32>,
        cpu_percent: f32,
        memory_bytes: u64,
        identity: &str,
    ) -> ProcessSample {
        ProcessSample {
            pid,
            parent_pid,
            cpu_percent,
            memory_bytes,
            executable: identity.to_string(),
            name: identity.to_string(),
            command_line: identity.to_string(),
        }
    }

    #[test]
    fn aggregates_only_the_ride_process_tree_by_role() {
        let rows = vec![
            sample(10, None, 20.0, 100, "ride-tauri"),
            sample(20, Some(10), 10.0, 200, "node main.js"),
            sample(30, Some(20), 5.0, 300, "node plugin-host"),
            sample(40, Some(20), 3.0, 400, "powershell"),
            sample(99, None, 90.0, 900, "unrelated"),
        ];

        let snapshot = aggregate_snapshot(&rows, 10, Some(20), 8, 1_000);

        assert_eq!(snapshot.sampled_at_ms, 1_000);
        assert_eq!(snapshot.total.process_count, 4);
        assert_eq!(snapshot.total.memory_bytes, 1_000);
        assert_eq!(snapshot.main.memory_bytes, 100);
        assert_eq!(snapshot.backend.memory_bytes, 200);
        assert_eq!(snapshot.plugin_host.memory_bytes, 300);
        assert_eq!(snapshot.other.memory_bytes, 400);
    }

    #[test]
    fn normalizes_cpu_to_total_machine_capacity() {
        let rows = vec![sample(10, None, 400.0, 10, "ride-tauri")];

        let snapshot = aggregate_snapshot(&rows, 10, None, 8, 1_000);

        assert_eq!(snapshot.total.cpu_percent, 50.0);
        assert_eq!(snapshot.main.cpu_percent, 50.0);
    }

    #[test]
    fn classifies_plugin_hosts_from_executable_name_or_command_line() {
        let mut executable = sample(20, Some(10), 1.0, 20, "node");
        executable.executable = "helpers/plugin-host.exe".into();
        let mut name = sample(30, Some(10), 1.0, 30, "node");
        name.name = "plugin-host-worker".into();
        let mut command_line = sample(40, Some(10), 1.0, 40, "node");
        command_line.command_line = "node --type=plugin-host".into();
        let rows = vec![
            sample(10, None, 1.0, 10, "ride-tauri"),
            executable,
            name,
            command_line,
        ];

        let snapshot = aggregate_snapshot(&rows, 10, None, 4, 1_000);

        assert_eq!(snapshot.plugin_host.process_count, 3);
        assert_eq!(snapshot.plugin_host.memory_bytes, 90);
        assert_eq!(snapshot.other.process_count, 0);
    }

    #[test]
    fn classifies_plugin_hosts_with_ascii_case_insensitive_matching() {
        let mut executable = sample(20, Some(10), 1.0, 20, "node");
        executable.executable = "helpers/PLUGIN-HOST.exe".into();
        let mut name = sample(30, Some(10), 1.0, 30, "node");
        name.name = "Plugin-Host-Worker".into();
        let mut command_line = sample(40, Some(10), 1.0, 40, "node");
        command_line.command_line = "node --type=PLUGIN-host".into();
        let rows = vec![
            sample(10, None, 1.0, 10, "ride-tauri"),
            executable,
            name,
            command_line,
        ];

        let snapshot = aggregate_snapshot(&rows, 10, None, 4, 1_000);

        assert_eq!(snapshot.plugin_host.process_count, 3);
        assert_eq!(snapshot.plugin_host.memory_bytes, 90);
        assert_eq!(snapshot.other.process_count, 0);
    }

    #[test]
    fn root_and_exact_backend_pid_take_precedence_over_plugin_host_text() {
        let rows = vec![
            sample(10, None, 1.0, 10, "ride-plugin-host"),
            sample(20, Some(10), 1.0, 20, "node plugin-host"),
        ];

        let snapshot = aggregate_snapshot(&rows, 10, Some(20), 2, 1_000);

        assert_eq!(snapshot.main.process_count, 1);
        assert_eq!(snapshot.backend.process_count, 1);
        assert_eq!(snapshot.plugin_host.process_count, 0);
    }

    #[test]
    fn excludes_rows_whose_parent_is_missing_from_the_root_tree() {
        let rows = vec![
            sample(10, None, 1.0, 10, "ride-tauri"),
            sample(30, Some(20), 1.0, 30, "node plugin-host"),
            sample(40, Some(30), 1.0, 40, "powershell"),
        ];

        let snapshot = aggregate_snapshot(&rows, 10, Some(20), 2, 1_000);

        assert_eq!(snapshot.total.process_count, 1);
        assert_eq!(snapshot.total.memory_bytes, 10);
        assert_eq!(snapshot.backend, UsageGroup::default());
        assert_eq!(snapshot.plugin_host, UsageGroup::default());
        assert_eq!(snapshot.other, UsageGroup::default());
    }

    #[test]
    fn rejects_conflicting_duplicate_pids_before_building_parent_links() {
        let rows = vec![
            sample(10, None, 1.0, 10, "ride-tauri"),
            sample(20, Some(10), 1.0, 20, "discarded-child"),
            sample(20, Some(99), 1.0, 200, "foreign-retained-row"),
            sample(30, Some(20), 1.0, 30, "foreign-grandchild"),
        ];
        let mut reversed_duplicates = rows.clone();
        reversed_duplicates.swap(1, 2);

        let snapshot = aggregate_snapshot(&rows, 10, None, 2, 1_000);
        let reversed = aggregate_snapshot(&reversed_duplicates, 10, None, 2, 1_000);

        assert_eq!(snapshot, reversed);
        assert_eq!(snapshot.total.process_count, 1);
        assert_eq!(snapshot.total.memory_bytes, 10);
        assert_eq!(snapshot.other, UsageGroup::default());
    }

    #[test]
    fn ignores_a_backend_process_absent_from_the_sample_set() {
        let rows = vec![
            sample(10, None, 1.0, 10, "ride-tauri"),
            sample(30, Some(10), 1.0, 30, "powershell"),
        ];

        let snapshot = aggregate_snapshot(&rows, 10, Some(20), 2, 1_000);

        assert_eq!(snapshot.total.process_count, 2);
        assert_eq!(snapshot.backend, UsageGroup::default());
        assert_eq!(snapshot.other.process_count, 1);
    }

    #[test]
    fn traversal_tolerates_cycles_and_visits_each_process_once() {
        let rows = vec![
            sample(10, Some(20), 1.0, 10, "ride-tauri"),
            sample(20, Some(10), 1.0, 20, "node"),
            sample(80, Some(90), 1.0, 80, "unrelated-a"),
            sample(90, Some(80), 1.0, 90, "unrelated-b"),
        ];

        let snapshot = aggregate_snapshot(&rows, 10, None, 2, 1_000);

        assert_eq!(snapshot.total.process_count, 2);
        assert_eq!(snapshot.total.memory_bytes, 30);
        assert_eq!(snapshot.main.process_count, 1);
        assert_eq!(snapshot.other.process_count, 1);
    }

    #[test]
    fn zero_logical_cpu_count_contributes_zero_cpu() {
        let rows = vec![sample(10, None, 400.0, 10, "ride-tauri")];

        let snapshot = aggregate_snapshot(&rows, 10, None, 0, 1_000);

        assert_eq!(snapshot.total.cpu_percent, 0.0);
        assert_eq!(snapshot.main.cpu_percent, 0.0);
    }

    #[test]
    fn malformed_cpu_values_contribute_zero_and_results_are_clamped() {
        let rows = vec![
            sample(10, None, f32::NAN, 10, "ride-tauri"),
            sample(20, Some(10), f32::INFINITY, 20, "node main.js"),
            sample(30, Some(10), -20.0, 30, "node plugin-host"),
            sample(40, Some(10), 600.0, 40, "powershell"),
            sample(50, Some(10), 600.0, 50, "powershell"),
        ];

        let snapshot = aggregate_snapshot(&rows, 10, Some(20), 4, 1_000);

        assert_eq!(snapshot.main.cpu_percent, 0.0);
        assert_eq!(snapshot.backend.cpu_percent, 0.0);
        assert_eq!(snapshot.plugin_host.cpu_percent, 0.0);
        assert_eq!(snapshot.other.cpu_percent, 100.0);
        assert_eq!(snapshot.total.cpu_percent, 100.0);
    }

    #[test]
    fn serializes_public_fields_with_camel_case_names() {
        let snapshot = aggregate_snapshot(
            &[sample(10, None, 4.0, 10, "ride-tauri")],
            10,
            None,
            4,
            1_234,
        );

        let json = serde_json::to_value(snapshot).expect("serialize performance snapshot");

        assert_eq!(json["sampledAtMs"], 1_234);
        assert_eq!(json["total"]["cpuPercent"], 1.0);
        assert_eq!(json["total"]["memoryBytes"], 10);
        assert_eq!(json["total"]["processCount"], 1);
        assert!(json.get("sampled_at_ms").is_none());
    }
}
