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
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::{CpuRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

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
    pub codex_agent: UsageGroup,
    pub codex_app_server: UsageGroup,
    pub codex_sdk: UsageGroup,
    pub codex_commands: UsageGroup,
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

enum ProcessSampleState {
    Live(ProcessSample),
    Nonexistent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ProcessTopology {
    pid: u32,
    parent_pid: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CodexChannel {
    AppServer,
    Sdk,
}

trait ProcessSource {
    fn refresh_usage(&mut self) -> Result<usize, String>;
    fn collect_topology(&self, output: &mut Vec<ProcessTopology>);
    fn refresh_identities(&mut self, pids: &[u32]) -> Result<(), String>;
    fn process_sample(&self, pid: u32) -> Option<ProcessSampleState>;
    fn logical_cpu_count(&self) -> usize;
    fn sampled_at_ms(&self) -> Result<u64, String>;
}

impl ProcessSource for System {
    fn refresh_usage(&mut self) -> Result<usize, String> {
        Ok(self.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory()
                .without_tasks(),
        ))
    }

    fn collect_topology(&self, output: &mut Vec<ProcessTopology>) {
        output.extend(self.processes().values().map(|process| ProcessTopology {
            pid: process.pid().as_u32(),
            parent_pid: process.parent().map(Pid::as_u32),
        }));
    }

    fn refresh_identities(&mut self, pids: &[u32]) -> Result<(), String> {
        let pids = pids.iter().copied().map(Pid::from_u32).collect::<Vec<_>>();
        self.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            false,
            ProcessRefreshKind::nothing()
                .with_cmd(UpdateKind::OnlyIfNotSet)
                .with_exe(UpdateKind::OnlyIfNotSet)
                .without_tasks(),
        );
        Ok(())
    }

    fn process_sample(&self, pid: u32) -> Option<ProcessSampleState> {
        let process = self.process(Pid::from_u32(pid))?;
        if !process.exists() {
            return Some(ProcessSampleState::Nonexistent);
        }
        Some(ProcessSampleState::Live(ProcessSample {
            pid: process.pid().as_u32(),
            parent_pid: process.parent().map(Pid::as_u32),
            cpu_percent: process.cpu_usage(),
            memory_bytes: process.memory(),
            executable: process
                .exe()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default(),
            name: process.name().to_string_lossy().into_owned(),
            command_line: process
                .cmd()
                .iter()
                .map(|part| part.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" "),
        }))
    }

    fn logical_cpu_count(&self) -> usize {
        self.cpus().len()
    }

    fn sampled_at_ms(&self) -> Result<u64, String> {
        let duration = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("system clock is before UNIX epoch: {error}"))?;
        Ok(u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
    }
}

#[derive(Default)]
struct SnapshotScratch {
    topology: Vec<ProcessTopology>,
    selected_pids: Vec<u32>,
    samples: Vec<ProcessSample>,
    topology_by_pid: HashMap<u32, Option<u32>>,
    conflicting_pids: HashSet<u32>,
    children_by_parent: HashMap<u32, Vec<u32>>,
    pending: VecDeque<u32>,
    visited: HashSet<u32>,
}

impl SnapshotScratch {
    fn clear(&mut self) {
        self.topology.clear();
        self.selected_pids.clear();
        self.samples.clear();
        self.topology_by_pid.clear();
        self.conflicting_pids.clear();
        self.children_by_parent.clear();
        self.pending.clear();
        self.visited.clear();
    }
}

struct SamplerState<S> {
    source: S,
    scratch: SnapshotScratch,
}

impl<S> SamplerState<S> {
    fn new(source: S) -> Self {
        Self {
            source,
            scratch: SnapshotScratch::default(),
        }
    }
}

pub struct PerformanceSampler {
    state: Mutex<Option<SamplerState<System>>>,
}

impl Default for PerformanceSampler {
    fn default() -> Self {
        Self {
            state: Mutex::new(None),
        }
    }
}

impl PerformanceSampler {
    pub fn snapshot(
        &self,
        root_pid: u32,
        backend_pid: Option<u32>,
    ) -> Result<PerformanceSnapshot, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "performance sampler mutex is poisoned".to_string())?;
        let state = state.get_or_insert_with(|| {
            let mut system = System::new();
            system.refresh_cpu_list(CpuRefreshKind::nothing());
            SamplerState::new(system)
        });
        snapshot_from_state(state, root_pid, backend_pid)
    }
}

#[tauri::command(async)]
pub fn ride_performance_snapshot(
    state: tauri::State<'_, crate::AppState>,
) -> Result<PerformanceSnapshot, String> {
    crate::performance_snapshot_for_current_process(
        &state.backend_ownership,
        |root_pid, backend_pid| state.performance.snapshot(root_pid, backend_pid),
    )
}

#[cfg(test)]
fn snapshot_from_source<S: ProcessSource>(
    state: &Mutex<SamplerState<S>>,
    root_pid: u32,
    backend_pid: Option<u32>,
) -> Result<PerformanceSnapshot, String> {
    let mut state = state
        .lock()
        .map_err(|_| "performance sampler mutex is poisoned".to_string())?;
    snapshot_from_state(&mut state, root_pid, backend_pid)
}

fn snapshot_from_state<S: ProcessSource>(
    state: &mut SamplerState<S>,
    root_pid: u32,
    backend_pid: Option<u32>,
) -> Result<PerformanceSnapshot, String> {
    let SamplerState { source, scratch } = &mut *state;
    scratch.clear();

    let refreshed_processes = source.refresh_usage()?;
    if refreshed_processes == 0 {
        return Err("process refresh returned no processes".to_string());
    }
    source.collect_topology(&mut scratch.topology);
    if !select_ride_tree(root_pid, scratch) {
        return Err(format!(
            "root process {root_pid} is absent after process refresh"
        ));
    }
    source.refresh_identities(&scratch.selected_pids)?;
    for &pid in &scratch.selected_pids {
        if let Some(ProcessSampleState::Live(sample)) = source.process_sample(pid) {
            scratch.samples.push(sample);
        }
    }
    if !scratch.samples.iter().any(|sample| sample.pid == root_pid) {
        return Err(format!(
            "root process {root_pid} is absent after process refresh"
        ));
    }
    let logical_cpu_count = source.logical_cpu_count().max(1);
    let sampled_at_ms = source.sampled_at_ms()?;
    Ok(aggregate_snapshot(
        &scratch.samples,
        root_pid,
        backend_pid,
        logical_cpu_count,
        sampled_at_ms,
    ))
}

fn select_ride_tree(root_pid: u32, scratch: &mut SnapshotScratch) -> bool {
    let SnapshotScratch {
        topology,
        selected_pids,
        topology_by_pid,
        conflicting_pids,
        children_by_parent,
        pending,
        visited,
        ..
    } = scratch;

    for process in topology.iter() {
        if conflicting_pids.contains(&process.pid) {
            continue;
        }
        match topology_by_pid.get(&process.pid).copied() {
            None => {
                topology_by_pid.insert(process.pid, process.parent_pid);
            }
            Some(parent_pid) if parent_pid == process.parent_pid => {}
            Some(_) => {
                topology_by_pid.remove(&process.pid);
                conflicting_pids.insert(process.pid);
            }
        }
    }

    for (&pid, &parent_pid) in topology_by_pid.iter() {
        if let Some(parent_pid) = parent_pid {
            children_by_parent.entry(parent_pid).or_default().push(pid);
        }
    }

    if !topology_by_pid.contains_key(&root_pid) {
        return false;
    }

    pending.push_back(root_pid);
    while let Some(pid) = pending.pop_front() {
        if !visited.insert(pid) || !topology_by_pid.contains_key(&pid) {
            continue;
        }
        selected_pids.push(pid);
        if let Some(children) = children_by_parent.get(&pid) {
            pending.extend(children.iter().copied());
        }
    }
    selected_pids.sort_unstable();
    true
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
        codex_agent: UsageGroup::default(),
        codex_app_server: UsageGroup::default(),
        codex_sdk: UsageGroup::default(),
        codex_commands: UsageGroup::default(),
        other: UsageGroup::default(),
    };
    if !samples_by_pid.contains_key(&root_pid) {
        return snapshot;
    }

    let codex_roots = samples_by_pid
        .values()
        .filter_map(|sample| codex_channel(sample).map(|channel| (sample.pid, channel)))
        .collect::<HashMap<_, _>>();
    let mut pending = VecDeque::from([(root_pid, None)]);
    let mut visited = HashSet::new();
    while let Some((pid, inherited_codex_channel)) = pending.pop_front() {
        if !visited.insert(pid) {
            continue;
        }
        let Some(sample) = samples_by_pid.get(&pid) else {
            continue;
        };
        let codex_channel = codex_roots.get(&pid).copied().or(inherited_codex_channel);

        add_sample(&mut snapshot.total, sample);
        if pid == root_pid {
            add_sample(&mut snapshot.main, sample);
        } else if Some(pid) == backend_pid {
            add_sample(&mut snapshot.backend, sample);
        } else if is_plugin_host(sample) {
            add_sample(&mut snapshot.plugin_host, sample);
        } else if let Some(channel) = codex_channel {
            add_sample(&mut snapshot.codex_agent, sample);
            if codex_roots.contains_key(&pid) || is_codex_resource_helper(sample) {
                match channel {
                    CodexChannel::AppServer => add_sample(&mut snapshot.codex_app_server, sample),
                    CodexChannel::Sdk => add_sample(&mut snapshot.codex_sdk, sample),
                }
            } else {
                add_sample(&mut snapshot.codex_commands, sample);
            }
        } else {
            add_sample(&mut snapshot.other, sample);
        }

        if let Some(children) = children_by_parent.get(&pid) {
            pending.extend(
                children
                    .iter()
                    .copied()
                    .map(|child_pid| (child_pid, codex_channel)),
            );
        }
    }

    normalize_cpu(&mut snapshot.total, logical_cpu_count);
    normalize_cpu(&mut snapshot.main, logical_cpu_count);
    normalize_cpu(&mut snapshot.backend, logical_cpu_count);
    normalize_cpu(&mut snapshot.plugin_host, logical_cpu_count);
    normalize_cpu(&mut snapshot.codex_agent, logical_cpu_count);
    normalize_cpu(&mut snapshot.codex_app_server, logical_cpu_count);
    normalize_cpu(&mut snapshot.codex_sdk, logical_cpu_count);
    normalize_cpu(&mut snapshot.codex_commands, logical_cpu_count);
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

fn executable_basename(value: &str) -> &str {
    value.rsplit(['\\', '/']).next().unwrap_or(value)
}

fn has_exact_executable_name(sample: &ProcessSample, expected: &str) -> bool {
    [sample.executable.as_str(), sample.name.as_str()]
        .iter()
        .any(|value| executable_basename(value).eq_ignore_ascii_case(expected))
}

fn has_command_token(command_line: &str, expected: &str) -> bool {
    command_line
        .split(|character: char| {
            character.is_ascii_whitespace() || character == '"' || character == '\''
        })
        .any(|token| token.eq_ignore_ascii_case(expected))
}

fn codex_channel(sample: &ProcessSample) -> Option<CodexChannel> {
    if !has_exact_executable_name(sample, "codex")
        && !has_exact_executable_name(sample, "codex.exe")
    {
        return None;
    }
    if has_command_token(&sample.command_line, "app-server") {
        Some(CodexChannel::AppServer)
    } else if has_command_token(&sample.command_line, "exec") {
        Some(CodexChannel::Sdk)
    } else {
        None
    }
}

fn is_codex_resource_helper(sample: &ProcessSample) -> bool {
    [
        "codex-sandbox",
        "codex-sandbox.exe",
        "codex-linux-sandbox",
        "codex-linux-sandbox.exe",
        "codex-macos-sandbox",
        "codex-macos-sandbox.exe",
        "codex-windows-sandbox",
        "codex-windows-sandbox.exe",
        "codex-resource-helper",
        "codex-resource-helper.exe",
    ]
    .iter()
    .any(|name| has_exact_executable_name(sample, name))
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

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

    struct StatefulProcessSource {
        refresh_count: Arc<AtomicUsize>,
        refreshed_processes: usize,
    }

    impl ProcessSource for StatefulProcessSource {
        fn refresh_usage(&mut self) -> Result<usize, String> {
            self.refresh_count.fetch_add(1, Ordering::SeqCst);
            Ok(self.refreshed_processes)
        }

        fn collect_topology(&self, output: &mut Vec<ProcessTopology>) {
            output.extend([topology(10, None), topology(99, Some(10))]);
        }

        fn refresh_identities(&mut self, _pids: &[u32]) -> Result<(), String> {
            Ok(())
        }

        fn process_sample(&self, pid: u32) -> Option<ProcessSampleState> {
            (pid == 10)
                .then(|| {
                    sample(
                        10,
                        None,
                        self.refresh_count.load(Ordering::SeqCst) as f32 * 10.0,
                        10,
                        "ride-tauri",
                    )
                })
                .map(ProcessSampleState::Live)
        }

        fn logical_cpu_count(&self) -> usize {
            1
        }

        fn sampled_at_ms(&self) -> Result<u64, String> {
            Ok(self.refresh_count.load(Ordering::SeqCst) as u64)
        }
    }

    struct MissingRootProcessSource;

    impl ProcessSource for MissingRootProcessSource {
        fn refresh_usage(&mut self) -> Result<usize, String> {
            Ok(1)
        }

        fn collect_topology(&self, output: &mut Vec<ProcessTopology>) {
            output.push(topology(99, None));
        }

        fn refresh_identities(&mut self, _pids: &[u32]) -> Result<(), String> {
            Ok(())
        }

        fn process_sample(&self, pid: u32) -> Option<ProcessSampleState> {
            (pid == 99)
                .then(|| sample(99, None, 1.0, 99, "unrelated"))
                .map(ProcessSampleState::Live)
        }

        fn logical_cpu_count(&self) -> usize {
            1
        }

        fn sampled_at_ms(&self) -> Result<u64, String> {
            Ok(1)
        }
    }

    fn topology(pid: u32, parent_pid: Option<u32>) -> ProcessTopology {
        ProcessTopology { pid, parent_pid }
    }

    fn codex_root(
        pid: u32,
        parent_pid: Option<u32>,
        mode: &str,
        memory_bytes: u64,
    ) -> ProcessSample {
        let mut process = sample(pid, parent_pid, 1.0, memory_bytes, "codex.exe");
        process.executable = r"C:\Program Files\Codex\codex.exe".into();
        process.name = "codex.exe".into();
        process.command_line = format!("codex.exe {mode} --stdio");
        process
    }

    fn codex_resource_helper(
        pid: u32,
        parent_pid: Option<u32>,
        memory_bytes: u64,
    ) -> ProcessSample {
        let mut process = sample(pid, parent_pid, 1.0, memory_bytes, "codex-sandbox.exe");
        process.executable = r"C:\Program Files\Codex\codex-sandbox.exe".into();
        process.name = "codex-sandbox.exe".into();
        process.command_line = "codex-sandbox.exe --resource-root C:\\codex".into();
        process
    }

    fn codex_tree() -> Vec<ProcessSample> {
        vec![
            sample(10, None, 1.0, 10, "ride-tauri"),
            sample(20, Some(10), 1.0, 20, "node backend"),
            sample(30, Some(20), 1.0, 30, "node plugin-host"),
            codex_root(40, Some(20), "app-server", 40),
            sample(41, Some(40), 1.0, 41, "bash -lc command"),
            codex_resource_helper(42, Some(40), 42),
            codex_root(50, Some(20), "exec", 50),
            sample(51, Some(50), 1.0, 51, "powershell command"),
            sample(60, Some(10), 1.0, 60, "C:\\tools\\codex-helper.exe"),
        ]
    }

    struct StagedProcessSource {
        topology: Vec<ProcessTopology>,
        samples: HashMap<u32, ProcessSample>,
        identity_calls: Arc<Mutex<Vec<Vec<u32>>>>,
        sample_calls: Arc<Mutex<Vec<u32>>>,
        identity_error: Option<String>,
        nonexistent_pids: HashSet<u32>,
    }

    impl StagedProcessSource {
        fn new(
            topology: Vec<ProcessTopology>,
            samples: Vec<ProcessSample>,
            identity_calls: Arc<Mutex<Vec<Vec<u32>>>>,
        ) -> Self {
            Self {
                topology,
                samples: samples
                    .into_iter()
                    .map(|sample| (sample.pid, sample))
                    .collect(),
                identity_calls,
                sample_calls: Arc::new(Mutex::new(Vec::new())),
                identity_error: None,
                nonexistent_pids: HashSet::new(),
            }
        }
    }

    impl ProcessSource for StagedProcessSource {
        fn refresh_usage(&mut self) -> Result<usize, String> {
            Ok(self.topology.len())
        }

        fn collect_topology(&self, output: &mut Vec<ProcessTopology>) {
            output.extend_from_slice(&self.topology);
        }

        fn refresh_identities(&mut self, pids: &[u32]) -> Result<(), String> {
            self.identity_calls
                .lock()
                .expect("identity calls mutex")
                .push(pids.to_vec());
            if let Some(error) = &self.identity_error {
                return Err(error.clone());
            }
            Ok(())
        }

        fn process_sample(&self, pid: u32) -> Option<ProcessSampleState> {
            self.sample_calls
                .lock()
                .expect("sample calls mutex")
                .push(pid);
            let sample = self.samples.get(&pid)?;
            if self.nonexistent_pids.contains(&pid) {
                return Some(ProcessSampleState::Nonexistent);
            }
            Some(ProcessSampleState::Live(sample.clone()))
        }

        fn logical_cpu_count(&self) -> usize {
            1
        }

        fn sampled_at_ms(&self) -> Result<u64, String> {
            Ok(1)
        }
    }

    #[test]
    fn repeated_samples_reuse_the_same_process_source_state() {
        let refresh_count = Arc::new(AtomicUsize::new(0));
        let source = Mutex::new(SamplerState::new(StatefulProcessSource {
            refresh_count: Arc::clone(&refresh_count),
            refreshed_processes: 1,
        }));

        let first = snapshot_from_source(&source, 10, None).expect("first snapshot");
        let second = snapshot_from_source(&source, 10, None).expect("second snapshot");

        assert_eq!(refresh_count.load(Ordering::SeqCst), 2);
        assert_eq!(first.total.cpu_percent, 10.0);
        assert_eq!(second.total.cpu_percent, 20.0);
    }

    #[test]
    fn ignores_processes_that_terminate_between_refresh_and_collection() {
        let source = Mutex::new(SamplerState::new(StatefulProcessSource {
            refresh_count: Arc::new(AtomicUsize::new(0)),
            refreshed_processes: 1,
        }));

        let snapshot = snapshot_from_source(&source, 10, None).expect("snapshot");

        assert_eq!(snapshot.total.process_count, 1);
        assert_eq!(snapshot.total.memory_bytes, 10);
    }

    #[test]
    fn expensive_identity_is_requested_only_for_the_ride_tree() {
        let identity_calls = Arc::new(Mutex::new(Vec::new()));
        let mut process_topology = (1_000..5_000)
            .map(|pid| topology(pid, None))
            .collect::<Vec<_>>();
        process_topology.extend([
            topology(10, None),
            topology(20, Some(10)),
            topology(30, Some(20)),
        ]);
        let samples = vec![
            sample(10, None, 1.0, 10, "ride-tauri"),
            sample(20, Some(10), 1.0, 20, "node main.js"),
            sample(30, Some(20), 1.0, 30, "node plugin-host"),
        ];
        let source = Mutex::new(SamplerState::new(StagedProcessSource::new(
            process_topology,
            samples,
            Arc::clone(&identity_calls),
        )));

        let snapshot = snapshot_from_source(&source, 10, Some(20)).expect("snapshot");
        let identity_calls = identity_calls.lock().expect("identity calls mutex").clone();

        assert_eq!(identity_calls, vec![vec![10, 20, 30]]);
        assert_eq!(snapshot.total.process_count, 3);
    }

    #[test]
    fn identity_refresh_receives_one_sorted_batch_for_branching_topology() {
        let identity_calls = Arc::new(Mutex::new(Vec::new()));
        let topology = vec![
            topology(10, None),
            topology(30, Some(10)),
            topology(20, Some(10)),
            topology(50, Some(30)),
            topology(40, Some(20)),
        ];
        let samples = vec![
            sample(10, None, 1.0, 10, "ride-tauri"),
            sample(20, Some(10), 1.0, 20, "node main.js"),
            sample(30, Some(10), 1.0, 30, "node worker.js"),
            sample(40, Some(20), 1.0, 40, "powershell"),
            sample(50, Some(30), 1.0, 50, "node plugin-host"),
        ];
        let source = Mutex::new(SamplerState::new(StagedProcessSource::new(
            topology,
            samples,
            Arc::clone(&identity_calls),
        )));

        snapshot_from_source(&source, 10, Some(20)).expect("snapshot");
        let identity_calls = identity_calls.lock().expect("identity calls mutex").clone();

        assert_eq!(identity_calls, vec![vec![10, 20, 30, 40, 50]]);
    }

    #[test]
    fn identity_refresh_failure_is_returned_without_a_stale_snapshot() {
        let identity_calls = Arc::new(Mutex::new(Vec::new()));
        let mut staged_source = StagedProcessSource::new(
            vec![topology(10, None)],
            vec![sample(10, None, 1.0, 10, "stale-ride-tauri")],
            Arc::clone(&identity_calls),
        );
        staged_source.identity_error = Some("identity refresh failed".to_string());
        let sample_calls = Arc::clone(&staged_source.sample_calls);
        let source = Mutex::new(SamplerState::new(staged_source));

        let error = snapshot_from_source(&source, 10, None)
            .expect_err("failed identity refresh must not return a stale snapshot");

        assert_eq!(error, "identity refresh failed");
        assert_eq!(
            identity_calls.lock().expect("identity calls mutex").clone(),
            vec![vec![10]]
        );
        assert!(sample_calls.lock().expect("sample calls mutex").is_empty());
    }

    #[test]
    fn retained_nonexistent_root_returns_root_absent() {
        let identity_calls = Arc::new(Mutex::new(Vec::new()));
        let mut staged_source = StagedProcessSource::new(
            vec![topology(10, None), topology(20, Some(10))],
            vec![
                sample(10, None, 1.0, 10, "ride-tauri"),
                sample(20, Some(10), 1.0, 20, "node main.js"),
            ],
            Arc::clone(&identity_calls),
        );
        staged_source.nonexistent_pids = HashSet::from([10]);
        let source = Mutex::new(SamplerState::new(staged_source));

        let error = snapshot_from_source(&source, 10, Some(20))
            .expect_err("root exiting after topology collection must fail");

        assert_eq!(error, "root process 10 is absent after process refresh");
        assert_eq!(
            identity_calls.lock().expect("identity calls mutex").clone(),
            vec![vec![10, 20]]
        );
    }

    #[test]
    fn retained_nonexistent_child_is_omitted() {
        let identity_calls = Arc::new(Mutex::new(Vec::new()));
        let mut staged_source = StagedProcessSource::new(
            vec![topology(10, None), topology(20, Some(10))],
            vec![
                sample(10, None, 1.0, 10, "ride-tauri"),
                sample(20, Some(10), 1.0, 20, "node main.js"),
            ],
            Arc::clone(&identity_calls),
        );
        staged_source.nonexistent_pids = HashSet::from([20]);
        let source = Mutex::new(SamplerState::new(staged_source));

        let snapshot = snapshot_from_source(&source, 10, Some(20)).expect("snapshot");

        assert_eq!(
            identity_calls.lock().expect("identity calls mutex").clone(),
            vec![vec![10, 20]]
        );
        assert_eq!(snapshot.total.process_count, 1);
        assert_eq!(snapshot.total.memory_bytes, 10);
        assert_eq!(snapshot.main.process_count, 1);
        assert_eq!(snapshot.backend, UsageGroup::default());
    }

    #[test]
    fn root_child_cycle_refreshes_each_selected_pid_once() {
        let identity_calls = Arc::new(Mutex::new(Vec::new()));
        let staged_source = StagedProcessSource::new(
            vec![topology(20, Some(10)), topology(10, Some(20))],
            vec![
                sample(10, Some(20), 1.0, 10, "ride-tauri"),
                sample(20, Some(10), 1.0, 20, "node main.js"),
            ],
            Arc::clone(&identity_calls),
        );
        let source = Mutex::new(SamplerState::new(staged_source));

        let snapshot = snapshot_from_source(&source, 10, Some(20)).expect("snapshot");

        assert_eq!(
            identity_calls.lock().expect("identity calls mutex").clone(),
            vec![vec![10, 20]]
        );
        assert_eq!(snapshot.total.process_count, 2);
        assert_eq!(snapshot.total.memory_bytes, 30);
    }

    #[test]
    fn conflicting_duplicate_and_descendants_are_not_identity_refreshed() {
        let identity_calls = Arc::new(Mutex::new(Vec::new()));
        let staged_source = StagedProcessSource::new(
            vec![
                topology(10, None),
                topology(20, Some(10)),
                topology(20, Some(99)),
                topology(30, Some(20)),
                topology(40, Some(10)),
            ],
            vec![
                sample(10, None, 1.0, 10, "ride-tauri"),
                sample(20, Some(10), 1.0, 20, "conflicting-child"),
                sample(30, Some(20), 1.0, 30, "conflicting-descendant"),
                sample(40, Some(10), 1.0, 40, "selected-child"),
            ],
            Arc::clone(&identity_calls),
        );
        let source = Mutex::new(SamplerState::new(staged_source));

        let snapshot = snapshot_from_source(&source, 10, None).expect("snapshot");

        assert_eq!(
            identity_calls.lock().expect("identity calls mutex").clone(),
            vec![vec![10, 40]]
        );
        assert_eq!(snapshot.total.process_count, 2);
        assert_eq!(snapshot.total.memory_bytes, 50);
    }

    #[test]
    fn unrelated_backend_is_not_identity_refreshed_or_aggregated() {
        let identity_calls = Arc::new(Mutex::new(Vec::new()));
        let staged_source = StagedProcessSource::new(
            vec![
                topology(10, None),
                topology(20, Some(10)),
                topology(99, None),
            ],
            vec![
                sample(10, None, 1.0, 10, "ride-tauri"),
                sample(20, Some(10), 1.0, 20, "selected-child"),
                sample(99, None, 1.0, 99, "unrelated-backend"),
            ],
            Arc::clone(&identity_calls),
        );
        let sample_calls = Arc::clone(&staged_source.sample_calls);
        let source = Mutex::new(SamplerState::new(staged_source));

        let snapshot = snapshot_from_source(&source, 10, Some(99)).expect("snapshot");

        assert_eq!(
            identity_calls.lock().expect("identity calls mutex").clone(),
            vec![vec![10, 20]]
        );
        assert_eq!(
            sample_calls.lock().expect("sample calls mutex").as_slice(),
            &[10, 20]
        );
        assert_eq!(snapshot.total.process_count, 2);
        assert_eq!(snapshot.total.memory_bytes, 30);
        assert_eq!(snapshot.backend, UsageGroup::default());
    }

    #[test]
    fn zero_refreshed_processes_returns_an_error() {
        let source = Mutex::new(SamplerState::new(StatefulProcessSource {
            refresh_count: Arc::new(AtomicUsize::new(0)),
            refreshed_processes: 0,
        }));

        let error = snapshot_from_source(&source, 10, None)
            .expect_err("zero refreshed processes must fail");

        assert_eq!(error, "process refresh returned no processes");
    }

    #[test]
    fn missing_root_after_a_nonzero_refresh_returns_an_error() {
        let source = Mutex::new(SamplerState::new(MissingRootProcessSource));

        let error =
            snapshot_from_source(&source, 10, None).expect_err("missing root process must fail");

        assert_eq!(error, "root process 10 is absent after process refresh");
    }

    #[test]
    fn default_sampler_collects_the_current_process_with_an_epoch_timestamp() {
        let before = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after UNIX epoch")
            .as_millis() as u64;
        let sampler = PerformanceSampler::default();

        let snapshot = sampler
            .snapshot(std::process::id(), None)
            .expect("sysinfo snapshot");

        let after = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after UNIX epoch")
            .as_millis() as u64;
        assert!((before..=after).contains(&snapshot.sampled_at_ms));
        assert_eq!(snapshot.main.process_count, 1);
        assert!(snapshot.total.process_count >= 1);
    }

    #[test]
    fn default_sampler_defers_sysinfo_initialization_until_the_first_snapshot() {
        let sampler = PerformanceSampler::default();
        assert!(
            sampler.state.lock().expect("sampler mutex").is_none(),
            "AppState construction must not refresh the host process inventory"
        );

        sampler
            .snapshot(std::process::id(), None)
            .expect("first lazy snapshot");
        assert!(sampler.state.lock().expect("sampler mutex").is_some());
    }

    #[test]
    fn poisoned_sampler_mutex_returns_a_clear_error() {
        let sampler = PerformanceSampler::default();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = sampler.state.lock().expect("sampler mutex");
            panic!("poison sampler mutex");
        }));

        let error = sampler
            .snapshot(std::process::id(), None)
            .expect_err("poisoned sampler must fail");

        assert_eq!(error, "performance sampler mutex is poisoned");
    }

    #[test]
    fn performance_command_uses_the_tauri_async_threadpool_path() {
        let source = include_str!("performance.rs");

        assert!(source
            .lines()
            .zip(source.lines().skip(1))
            .any(|(attribute, declaration)| {
                attribute.trim() == "#[tauri::command(async)]"
                    && declaration
                        .trim_start()
                        .starts_with("pub fn ride_performance_snapshot")
            }));
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
    fn codex_groups_partition_agent_usage_without_changing_total() {
        let snapshot = aggregate_snapshot(&codex_tree(), 10, Some(20), 1, 1);

        assert_eq!(snapshot.codex_agent.process_count, 5);
        assert_eq!(snapshot.codex_app_server.process_count, 2);
        assert_eq!(snapshot.codex_sdk.process_count, 1);
        assert_eq!(snapshot.codex_commands.process_count, 2);
        assert_eq!(snapshot.codex_agent.memory_bytes, 40 + 41 + 42 + 50 + 51);
        assert_eq!(
            snapshot.codex_agent.memory_bytes,
            snapshot.codex_app_server.memory_bytes
                + snapshot.codex_sdk.memory_bytes
                + snapshot.codex_commands.memory_bytes
        );
        assert_eq!(
            snapshot.total.memory_bytes,
            snapshot.main.memory_bytes
                + snapshot.backend.memory_bytes
                + snapshot.plugin_host.memory_bytes
                + snapshot.codex_agent.memory_bytes
                + snapshot.other.memory_bytes
        );
        assert_eq!(snapshot.total.process_count, 9);
    }

    #[test]
    fn codex_matching_requires_exact_root_identity_and_preserves_role_precedence() {
        let mut backend = codex_root(20, Some(10), "exec", 20);
        backend.command_line = "codex.exe exec".into();
        let mut plugin_host = codex_root(30, Some(10), "app-server", 30);
        plugin_host.name = "plugin-host-worker".into();
        let mut prefixed_binary = sample(40, Some(10), 1.0, 40, "my-codex.exe");
        prefixed_binary.executable = r"C:\tools\my-codex.exe".into();
        prefixed_binary.command_line = "my-codex.exe app-server".into();
        let mut helper_like_binary = sample(50, Some(10), 1.0, 50, "codex-helper.exe");
        helper_like_binary.executable = r"C:\tools\codex-helper.exe".into();
        helper_like_binary.command_line = "codex-helper.exe exec".into();

        let snapshot = aggregate_snapshot(
            &[
                sample(10, None, 1.0, 10, "ride-tauri"),
                backend,
                plugin_host,
                prefixed_binary,
                helper_like_binary,
            ],
            10,
            Some(20),
            1,
            1,
        );

        assert_eq!(snapshot.codex_agent, UsageGroup::default());
        assert_eq!(snapshot.backend.process_count, 1);
        assert_eq!(snapshot.plugin_host.process_count, 1);
        assert_eq!(snapshot.other.process_count, 2);
        assert_eq!(snapshot.total.process_count, 5);
    }

    #[test]
    fn conflicting_codex_root_pid_and_descendants_are_excluded_before_attribution() {
        let mut conflicting = codex_root(40, Some(10), "app-server", 40);
        conflicting.parent_pid = Some(99);
        let rows = vec![
            sample(10, None, 1.0, 10, "ride-tauri"),
            codex_root(40, Some(10), "app-server", 20),
            conflicting,
            sample(41, Some(40), 1.0, 41, "bash command"),
        ];

        let snapshot = aggregate_snapshot(&rows, 10, None, 1, 1);

        assert_eq!(snapshot.codex_agent, UsageGroup::default());
        assert_eq!(snapshot.total.process_count, 1);
        assert_eq!(snapshot.total.memory_bytes, 10);
    }

    #[test]
    fn saturated_codex_cpu_is_clamped_without_double_counting_totals() {
        let mut root = codex_root(20, Some(10), "exec", 20);
        root.cpu_percent = 400.0;
        let mut command = sample(21, Some(20), 1.0, 21, "bash command");
        command.cpu_percent = 400.0;
        let snapshot = aggregate_snapshot(
            &[sample(10, None, 400.0, 10, "ride-tauri"), root, command],
            10,
            None,
            1,
            1,
        );

        assert_eq!(snapshot.total.cpu_percent, 100.0);
        assert_eq!(snapshot.codex_agent.cpu_percent, 100.0);
        assert_eq!(snapshot.codex_sdk.cpu_percent, 100.0);
        assert_eq!(snapshot.codex_commands.cpu_percent, 100.0);
        assert_eq!(snapshot.total.memory_bytes, 51);
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
        assert_eq!(json["codexAgent"]["processCount"], 0);
        assert_eq!(json["codexAppServer"]["processCount"], 0);
        assert_eq!(json["codexSdk"]["processCount"], 0);
        assert_eq!(json["codexCommands"]["processCount"], 0);
        assert!(json.get("sampled_at_ms").is_none());
        assert!(json.get("codex_agent").is_none());
    }
}
