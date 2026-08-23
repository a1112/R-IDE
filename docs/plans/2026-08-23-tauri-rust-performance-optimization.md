# Tauri Rust Performance Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce recurring Rust process-sampling work to the R-IDE process tree and add backward-compatible startup phase diagnostics that drive one evidence-based startup optimization decision.

**Architecture:** Keep `sysinfo` as the cross-platform process source, but split collection into a lightweight all-process topology/usage refresh followed by an identity refresh for only reachable R-IDE PIDs. Extend startup report version 3 with a partially ordered `rustPhases` object, instrument the existing launch path, and use a same-host packaged campaign to decide whether a safe Rust-controlled startup change exists.

**Tech Stack:** Rust 2021, Tauri 2, Tokio, sysinfo 0.38.4, serde/serde_json, Node.js 24 test runner, PowerShell, GitHub Actions.

---

## Preparation

Use @superpowers:test-driven-development for every behavior change and @superpowers:verification-before-completion before any completion or push claim.

Run all local Rust commands with the task-specific target directory:

```powershell
$env:CARGO_TARGET_DIR = 'L:\R-IDE-builds\ride-rust-performance-target'
$env:CARGO_PROFILE_DEV_DEBUG = '0'
$env:CARGO_INCREMENTAL = '0'
Get-PSDrive C,E,L | Select-Object Name,@{n='FreeGiB';e={[math]::Round($_.Free/1GB,2)}}
```

Expected: C and E retain multiple GiB free; L has enough space for a complete Tauri target. Do not use a target under `%TEMP%`, C, or E.

### Task 1: Specify selective process identity collection

**Files:**
- Modify: `app/applications/tauri/src-tauri/src/performance.rs:34-166`
- Test: `app/applications/tauri/src-tauri/src/performance.rs:292-668`

**Step 1: Write the failing cost-contract test**

Replace the test-only source shape with a staged fake that stores lightweight topology separately from full samples and records identity requests:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ProcessTopology {
    pid: u32,
    parent_pid: Option<u32>,
}

struct SelectiveProcessSource {
    topology: Vec<ProcessTopology>,
    samples: HashMap<u32, ProcessSample>,
    identity_requests: Arc<Mutex<Vec<Vec<u32>>>>,
}

#[test]
fn expensive_identity_is_requested_only_for_the_ride_tree() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut topology = (1_000..6_000)
        .map(|pid| ProcessTopology { pid, parent_pid: None })
        .collect::<Vec<_>>();
    topology.extend([
        ProcessTopology { pid: 10, parent_pid: None },
        ProcessTopology { pid: 20, parent_pid: Some(10) },
        ProcessTopology { pid: 30, parent_pid: Some(20) },
    ]);
    let source = sampler_state(SelectiveProcessSource::new(topology, Arc::clone(&requests)));

    let snapshot = snapshot_from_source(&source, 10, Some(20)).expect("snapshot");

    assert_eq!(snapshot.total.process_count, 3);
    assert_eq!(&*requests.lock().unwrap(), &[vec![10, 20, 30]]);
}
```

The fake's `refresh_identities` method must sort the captured PID list before recording it so the assertion does not depend on hash-map iteration order.

**Step 2: Run the focused test and verify RED**

Run:

```powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --lib performance::tests::expensive_identity_is_requested_only_for_the_ride_tree -- --exact
```

Expected: FAIL to compile because `ProcessTopology`, the staged `ProcessSource` methods, and `sampler_state` do not exist.

**Step 3: Introduce the staged source contract**

Change the internal trait to make expensive work explicit:

```rust
trait ProcessSource {
    fn refresh_usage(&mut self) -> Result<usize, String>;
    fn collect_topology(&self, output: &mut Vec<ProcessTopology>);
    fn refresh_identities(&mut self, pids: &[u32]) -> Result<(), String>;
    fn process_sample(&self, pid: u32) -> Option<ProcessSample>;
    fn logical_cpu_count(&self) -> usize;
    fn sampled_at_ms(&self) -> Result<u64, String>;
}
```

Add mutex-owned reusable scratch state:

```rust
#[derive(Default)]
struct SamplerScratch {
    topology: Vec<ProcessTopology>,
    selected_pids: Vec<u32>,
    samples: Vec<ProcessSample>,
}

struct ProcessSamplerState<S> {
    source: S,
    scratch: SamplerScratch,
}

pub struct PerformanceSampler {
    state: Mutex<ProcessSamplerState<System>>,
}
```

Clear scratch lengths between snapshots but retain capacities. Do not retain topology or PID validity across snapshots.

**Step 4: Implement the production two-stage sysinfo adapter**

Use a lightweight first refresh:

```rust
self.refresh_processes_specifics(
    ProcessesToUpdate::All,
    true,
    ProcessRefreshKind::nothing()
        .with_cpu()
        .with_memory()
        .without_tasks(),
)
```

For selected identities, convert the PID slice to `Vec<Pid>` and call:

```rust
self.refresh_processes_specifics(
    ProcessesToUpdate::Some(&selected),
    false,
    ProcessRefreshKind::nothing()
        .with_cmd(UpdateKind::OnlyIfNotSet)
        .with_exe(UpdateKind::OnlyIfNotSet)
        .without_tasks(),
);
```

Only `process_sample` may clone executable, name, and command-line strings.

**Step 5: Implement fresh-tree selection**

Add a helper that:

- rejects conflicting duplicate PIDs;
- builds parent-to-children edges from the current lightweight topology;
- verifies the root exists;
- traverses with `VecDeque` plus a visited set;
- sorts selected PIDs before identity refresh for deterministic tests.

Call `refresh_identities` with only this list, materialize only selected samples, verify the root still exists, and then reuse `aggregate_snapshot` for grouping.

**Step 6: Run the focused test and existing performance tests**

Run:

```powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --lib performance::tests -- --nocapture
```

Expected: all performance module tests PASS, including current-process sampling and public camel-case serialization.

**Step 7: Commit**

```powershell
git add -- app/applications/tauri/src-tauri/src/performance.rs
git commit -m "perf(tauri): scope process identity sampling to R-IDE tree"
```

### Task 2: Harden process churn and failure behavior

**Files:**
- Modify: `app/applications/tauri/src-tauri/src/performance.rs:110-235`
- Test: `app/applications/tauri/src-tauri/src/performance.rs:292-720`

**Step 1: Write failing edge-case tests**

Add focused tests for the staged pipeline:

```rust
#[test]
fn identity_refresh_failure_is_returned_without_a_stale_snapshot() {
    let source = sampler_state(SelectiveProcessSource::failing_identity("identity refresh failed"));
    assert_eq!(
        snapshot_from_source(&source, 10, None).unwrap_err(),
        "identity refresh failed"
    );
}

#[test]
fn root_exit_between_topology_and_identity_returns_root_absent() {
    let source = sampler_state(SelectiveProcessSource::dropping_sample_after_identity(10));
    assert_eq!(
        snapshot_from_source(&source, 10, None).unwrap_err(),
        "root process 10 is absent after process refresh"
    );
}

#[test]
fn selected_tree_tolerates_cycles_and_rejects_conflicting_duplicates() {
    // Root 10 <-> child 20 is visited once; duplicate PID 30 is excluded.
}
```

Also assert that a selected child which exits between stages is omitted and that an unrelated backend PID is never requested or classified.

**Step 2: Run and verify RED**

Run:

```powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --lib performance::tests::identity_refresh_failure_is_returned_without_a_stale_snapshot -- --exact
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --lib performance::tests::root_exit_between_topology_and_identity_returns_root_absent -- --exact
```

Expected: FAIL until staged errors and post-identity root validation are implemented.

**Step 3: Implement minimum churn handling**

- Propagate `refresh_identities` errors unchanged.
- Recheck that the materialized sample set contains the root.
- Omit non-root selected PIDs that disappear.
- Keep duplicate removal and cycle protection local to the current refresh.
- Preserve the exact existing zero-refresh and root-absent error strings.

**Step 4: Run the module and full library tests**

Run:

```powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --lib performance::tests
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --lib
```

Expected: PASS with no changes to serialized snapshot fixtures.

**Step 5: Commit**

```powershell
git add -- app/applications/tauri/src-tauri/src/performance.rs
git commit -m "test(tauri): cover selective sampler process churn"
```

### Task 3: Add startup report version 3 Rust phase model

**Files:**
- Modify: `app/applications/tauri/src-tauri/src/startup_metrics.rs:17-320`
- Modify: `app/applications/tauri/src-tauri/tests/startup_metrics.rs:430-920`

**Step 1: Write failing serialization and ordering tests**

Add tests that require:

```rust
assert_eq!(value["version"], 3);
assert_eq!(value["rustPhases"]["runtime_paths_resolved"], 1);
assert_eq!(value["rustPhases"]["tauri_setup_entered"], 2);
assert_eq!(value["rustPhases"]["window_shown"], 8);
```

Test these rules separately:

- duplicate phase recording returns `RecordOutcome::Duplicate` and preserves the first timestamp;
- `WindowBuilt` requires `WindowBuildStarted`;
- `BackendSpawnRequested` requires `TauriSetupEntered` and, in rust-gateway/fallback mode, `GatewayInventoryFinished`;
- explicit legacy mode does not require or accept `GatewayInventoryFinished`;
- fallback mode retains a gateway inventory phase recorded before mode selection;
- disabled metrics return `RecordOutcome::Disabled`.

**Step 2: Run and verify RED**

Run:

```powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup_metrics rust_phase -- --nocapture
```

Expected: FAIL because report version 3, `StartupRustPhase`, and `rustPhases` are absent.

**Step 3: Implement the Rust phase model**

Add:

```rust
pub const STARTUP_REPORT_VERSION: u32 = 3;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupRustPhase {
    RuntimePathsResolved,
    GatewayInventoryFinished,
    TauriSetupEntered,
    BackendSpawnRequested,
    WindowBuildStarted,
    WindowBuilt,
    WindowShown,
}
```

Add `StartupRustPhaseDurations` with optional snake-case fields and serialize it as `rustPhases`. Implement `get`, `set`, mode applicability, and the approved partial predecessor graph. Add:

```rust
pub fn record_rust_phase(
    &self,
    phase: StartupRustPhase,
) -> Result<RecordOutcome, StartupMetricError>
```

Use the same recorder lock, monotonic clock, asynchronous snapshot writer, duplicate semantics, and write errors as milestone recording. Do not create a second clock or writer thread.

**Step 4: Run the startup metrics suite**

Run:

```powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup_metrics
```

Expected: PASS, including existing milestone and writer retry tests.

**Step 5: Commit**

```powershell
git add -- app/applications/tauri/src-tauri/src/startup_metrics.rs app/applications/tauri/src-tauri/tests/startup_metrics.rs
git commit -m "feat(tauri): add Rust startup phase diagnostics"
```

### Task 4: Keep startup report tooling backward compatible

**Files:**
- Modify: `app/scripts/measure-tauri-startup.mjs:17-110,460-545,3500-3585`
- Modify: `app/scripts/check-tauri-performance.mjs:20-90,220-280`
- Modify: `app/scripts/test/measure-tauri-startup.test.mjs:220-535`
- Modify: `app/scripts/test/check-tauri-performance.test.mjs:40-160`

**Step 1: Write failing parser tests**

Create fixtures for:

- a historical version 1 final report without `startupMode` or `rustPhases`;
- a version 2 report with the existing exact root keys;
- a version 3 rust-gateway report with all seven Rust phases;
- a version 3 legacy-explicit report without `gateway_inventory_finished`;
- incremental version 3 reports containing only a valid predecessor-closed phase subset.

Assert rejection of unknown phase keys, negative/non-integer timestamps, missing predecessors, a gateway phase in explicit legacy mode, and version 3 without `rustPhases` at final validation.

**Step 2: Run and verify RED**

Run from `app`:

```powershell
node --test scripts/test/measure-tauri-startup.test.mjs scripts/test/check-tauri-performance.test.mjs
```

Expected: FAIL because the measurement parser only accepts version 2 and the checker only accepts versions 1 and 2.

**Step 3: Implement version-aware validation**

Define a mode-specific Rust phase predecessor map:

```javascript
const RUST_PHASE_PREDECESSORS = Object.freeze({
  'rust-gateway': Object.freeze({
    runtime_paths_resolved: [],
    gateway_inventory_finished: ['runtime_paths_resolved'],
    tauri_setup_entered: [],
    backend_spawn_requested: ['tauri_setup_entered', 'gateway_inventory_finished'],
    window_build_started: ['backend_spawn_requested'],
    window_built: ['window_build_started'],
    window_shown: ['window_built'],
  }),
  // legacy-fallback includes the attempted gateway inventory;
  // legacy-explicit omits it and removes that predecessor.
});
```

For version 1, preserve historical milestone validation. For version 2, preserve the exact existing contract. For version 3, require `rustPhases`, validate only known/applicable keys during incremental polling, and require the complete applicable set for target/final reports. Keep existing milestone semantics unchanged.

Add per-phase median values to the generated measurement summary so the packaged report exposes evidence without scraping raw runs.

**Step 4: Run parser tests and lint the changed scripts**

Run:

```powershell
node --test scripts/test/measure-tauri-startup.test.mjs scripts/test/check-tauri-performance.test.mjs
npx eslint scripts/measure-tauri-startup.mjs scripts/check-tauri-performance.mjs scripts/test/measure-tauri-startup.test.mjs scripts/test/check-tauri-performance.test.mjs
```

Expected: PASS with version 1, 2, and 3 fixtures covered.

**Step 5: Commit**

```powershell
git add -- app/scripts/measure-tauri-startup.mjs app/scripts/check-tauri-performance.mjs app/scripts/test/measure-tauri-startup.test.mjs app/scripts/test/check-tauri-performance.test.mjs
git commit -m "feat(perf): validate Rust startup phase reports"
```

### Task 5: Instrument the existing Rust startup path

**Files:**
- Modify: `app/applications/tauri/src-tauri/src/lib.rs:550-815`
- Modify: `app/applications/tauri/src-tauri/src/startup.rs:330-430`
- Modify: `app/applications/tauri/src-tauri/tests/startup_gateway_integration.rs:120-245`
- Modify: `app/applications/tauri/src-tauri/src/lib.rs:1050-1315` (unit tests)

**Step 1: Write failing integration and source-order tests**

Add a gateway integration test with a channel-backed report writer that waits for and asserts `rustPhases.gateway_inventory_finished` after `begin_launch(...).complete()`.

Add a `lib.rs` unit test that inspects a captured final report from helper-driven phase recording and requires this ordering:

```text
runtime_paths_resolved
tauri_setup_entered
backend_spawn_requested
window_build_started
window_built
window_shown
```

The test must also assert that `window_shown <= native_window_visible` when both are recorded.

**Step 2: Run and verify RED**

Run:

```powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup_gateway_integration gateway_inventory_phase
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --lib rust_startup_phases
```

Expected: FAIL because the startup path does not record Rust phases.

**Step 3: Record the approved phases**

- In `run`, record `RuntimePathsResolved` immediately after `resolve_runtime_paths_before_app` succeeds.
- In `StartupCoordinator::begin_launch`, clone metrics into the bind observer and record `GatewayInventoryFinished` on `GatewayBindStage::InventoryFinished` while retaining the existing one-shot `InventoryStarted` behavior.
- At the first line of the Tauri setup closure, record `TauriSetupEntered`.
- Immediately before scheduling `sidecar::start_backend`, record `BackendSpawnRequested`.
- Immediately before `WebviewWindowBuilder::from_config`, record `WindowBuildStarted`.
- Immediately after `.build()?`, record `WindowBuilt`.
- Immediately after `present_startup_window` returns successfully and before `NativeWindowVisible`, record `WindowShown`.

Use `record_or_warn`-style behavior so diagnostics never turn a recoverable write failure into an application startup failure.

**Step 4: Run focused and full Rust tests**

Run:

```powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup_gateway_integration
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup_metrics
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --lib
```

Expected: PASS with gateway fallback and legacy mode tests unchanged.

**Step 5: Commit**

```powershell
git add -- app/applications/tauri/src-tauri/src/lib.rs app/applications/tauri/src-tauri/src/startup.rs app/applications/tauri/src-tauri/tests/startup_gateway_integration.rs
git commit -m "feat(tauri): instrument Rust-controlled startup phases"
```

### Task 6: Run repository-level verification

**Files:**
- Modify only files required to fix failures caused by Tasks 1-5.

**Step 1: Verify formatting**

```powershell
cargo fmt --manifest-path app/applications/tauri/src-tauri/Cargo.toml -- --check
```

Expected: PASS. If it fails, run the same command without `--check`, inspect the diff, then rerun.

**Step 2: Verify Clippy**

```powershell
cargo clippy --manifest-path app/applications/tauri/src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: PASS with no warnings.

**Step 3: Run the complete Rust suite**

```powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --all-targets
```

Expected: all unit and integration tests PASS.

**Step 4: Run startup JavaScript contracts**

From `app`:

```powershell
node --test scripts/test/measure-tauri-startup.test.mjs scripts/test/check-tauri-performance.test.mjs scripts/test/workflow-policy.test.mjs
```

Expected: PASS.

**Step 5: Check disk state and worktree scope**

```powershell
Get-PSDrive C,E,L | Select-Object Name,@{n='FreeGiB';e={[math]::Round($_.Free/1GB,2)}}
git status --short
git diff --check
```

Expected: only intentional task files are changed; C and E remain healthy.

**Step 6: Commit any verification-only corrections**

```powershell
git add -- <exact corrected files>
git commit -m "fix(tauri): satisfy Rust performance verification"
```

Skip this commit if no correction was necessary.

### Task 7: Measure startup phases and make the optimization decision

**Files:**
- Create: `docs/performance/2026-08-23-tauri-rust-phase-evidence.md`
- Modify: implementation files only if the measured decision below selects a safe hotspot.

**Step 1: Build the release bundle into L**

Use the repository's existing Tauri release preparation/build path with:

```powershell
$env:CARGO_TARGET_DIR = 'L:\R-IDE-builds\ride-rust-performance-target'
npm --prefix app run tauri:build
```

Expected: release bundle and `ride-tauri-profile.json` exist under the task target. If the workspace script resolves a different target path, pass the same `CARGO_TARGET_DIR` through that script and record the resolved bundle root.

**Step 2: Run a five-sample packaged campaign**

```powershell
npm --prefix app run measure:tauri-startup -- --bundle-root L:\R-IDE-builds\ride-rust-performance-target --runs 5 --idle-ms 30000 --profile-manifest L:\R-IDE-builds\ride-rust-performance-target\release\bundle\ride-tauri-profile.json --output L:\R-IDE-builds\performance-evidence-2026-08-23\rust-phases-windows-x64.json
```

Expected: five valid version 3 rust-gateway reports, no fallback, and phase medians in the summary.

**Step 3: Apply the evidence gate**

Calculate these deltas from medians:

- process start to runtime paths resolved;
- runtime paths resolved to gateway inventory finished;
- process start to Tauri setup entered;
- backend spawn requested to existing `backend_spawned` milestone;
- window build started to window built;
- window built to window shown.

Select an implementation change only when one Rust-controlled delta is at least 50 ms or at least 10 percent of native-window time and has a safe repository-owned cause. The selected patch must have its own failing regression test and must improve that phase by at least 15 percent on the repeated campaign.

If no phase meets the gate, do not make a speculative startup code change. Record that the remaining startup delay is dominated by Tauri/WebView or external backend/frontend work; the sampler optimization and diagnostics remain the completed Rust work.

**Step 4: Write the evidence report**

Document:

- commit and host fingerprint;
- free-space before/after;
- all phase medians and slowest values;
- sampler structural cost result (`N` topology facts versus `K` identity requests);
- selected startup optimization and before/after evidence, or the explicit no-safe-hotspot decision;
- gateway mode, fallback count, target-file time, RSS, and cleanup status.

**Step 5: Verify the candidate against existing policy**

```powershell
npm --prefix app run check:tauri-performance -- --baseline L:\R-IDE-builds\performance-evidence-2026-08-23\rust-phases-windows-x64.json --candidate L:\R-IDE-builds\performance-evidence-2026-08-23\rust-phases-windows-x64.json --policy rust-gateway --max-window-median-ms 800 --max-memory-regression-percent 3
```

When an evidence-selected startup patch exists, preserve the pre-patch report as `rust-phases-baseline-windows-x64.json`, rerun the candidate, and use baseline/candidate as separate files.

Expected: policy PASS, rust-gateway used in every run, no cleanup failures.

**Step 6: Commit evidence and any proven bounded optimization**

```powershell
git add -- docs/performance/2026-08-23-tauri-rust-phase-evidence.md <exact proven optimization files and tests, if any>
git commit -m "perf(tauri): document measured Rust startup phases"
```

### Task 8: Final verification and CI handoff

**Files:**
- Modify only if final verification exposes a task-caused defect.

**Step 1: Re-run all required checks from Task 6**

Expected: formatting, Clippy, all Rust tests, JavaScript contracts, and `git diff --check` PASS on the final commit.

**Step 2: Inspect the final history and scope**

```powershell
git status --short --branch
git log --oneline --decorate -8
git diff origin/main...HEAD --stat
```

Expected: clean worktree and only the approved sampler, diagnostics, evidence, tests, and documentation changes.

**Step 3: Request code review**

Use @superpowers:requesting-code-review. Address findings with @superpowers:receiving-code-review and rerun the affected tests.

**Step 4: Push and verify CI only after authorization remains in scope**

```powershell
git push origin main
```

Watch CI, Tauri verification, and CodeQL. Do not claim completion until all required jobs finish successfully and the packaged performance report still uses `rust-gateway` without fallback or cleanup errors.
