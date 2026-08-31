# Tauri Startup Critical-Path Diagnostics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a default-disabled, path-free companion diagnostic report that attributes the remaining Windows Tauri startup critical path and supports one evidence-selected optimization.

**Architecture:** Rust owns a second monotonic recorder enabled only by a harness-provided output path. The frontend reports a closed phase enum through a no-payload Tauri command, while the existing strict startup report and milestones remain unchanged. The measurement harness validates and aggregates companion reports separately from ride.startup-measurement@4.

**Tech Stack:** Rust, Tauri 2 commands and permissions, TypeScript/Theia frontend contributions, Node.js test runner, Windows packaged startup harness.

---

### Task 1: Implement the strict Rust diagnostic model and recorder

**Files:**
- Create: app/applications/tauri/src-tauri/src/startup_diagnostics.rs
- Modify: app/applications/tauri/src-tauri/src/lib.rs:18-25
- Test: app/applications/tauri/src-tauri/src/startup_diagnostics.rs

**Step 1: Write the failing tests**

Add inline tests for the closed predecessor graph, duplicate idempotency,
non-monotonic timestamps, disabled behavior, enqueue failure rollback, writer
retry, poisoned mutex handling, and exact path-free serialization.

The model tests begin with:

~~~rust
#[test]
fn diagnostic_report_accepts_only_the_closed_predecessor_graph() {
    let mut report = StartupDiagnosticReport::new("windows", "x86_64", 42);
    assert_eq!(
        report.record(StartupDiagnosticPhase::FrontendInitializationStarted, 10),
        Ok(DiagnosticRecordOutcome::Recorded)
    );
    assert!(matches!(
        report.record(StartupDiagnosticPhase::WorkspaceReady, 11),
        Err(StartupDiagnosticError::MissingPredecessor { .. })
    ));
}

#[test]
fn disabled_diagnostics_do_not_create_a_writer_or_record() {
    let diagnostics =
        StartupDiagnostics::with_clock(None, "windows", "x86_64", 7, fake_clock());
    assert_eq!(
        diagnostics.record(StartupDiagnosticPhase::FrontendInitializationStarted),
        Ok(DiagnosticRecordOutcome::Disabled)
    );
}
~~~

Use this closed enum:

~~~rust
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
~~~

FrontendInitializationStarted has no predecessor. Every later phase requires the
immediately preceding phase. Partial prefixes are valid.

**Step 2: Run the test to verify RED**

Run:

~~~powershell
$env:CARGO_TARGET_DIR='L:\R-IDE-builds\ride-codex-app-server-tauri-target'
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml startup_diagnostics::tests --no-run
~~~

Expected: FAIL because startup_diagnostics is not declared.

**Step 3: Implement the minimal model and recorder**

Implement:

- STARTUP_DIAGNOSTIC_REPORT_ENV = RIDE_STARTUP_DIAGNOSTIC_REPORT;
- schema ride.startup-critical-path-diagnostics, version 1;
- one optional u64 field per typed phase;
- record returning Recorded, Duplicate, or Disabled;
- static missing-predecessor, non-monotonic, poison, and write errors;
- StartupDiagnostics::from_env and StartupDiagnostics::record;
- a named asynchronous writer thread with three bounded atomic-write attempts.

The recorder must clone, enqueue, then commit state so enqueue failure remains
retryable. No frontend command may perform synchronous file I/O.

Declare pub mod startup_diagnostics in lib.rs.

**Step 4: Run focused tests to verify GREEN**

~~~powershell
$env:CARGO_TARGET_DIR='L:\R-IDE-builds\ride-codex-app-server-tauri-target'
npm --prefix app run test:tauri-rust -- startup_diagnostics::tests
~~~

Expected: all matching tests pass; unrelated binaries may report zero filtered
tests.

**Step 5: Commit**

~~~powershell
git add app/applications/tauri/src-tauri/src/startup_diagnostics.rs app/applications/tauri/src-tauri/src/lib.rs
git commit -m "feat: record startup critical-path diagnostics"
~~~

### Task 2: Wire the Tauri command and permission

**Files:**
- Modify: app/applications/tauri/src-tauri/src/lib.rs:282-335,603-690,886-910
- Modify: app/applications/tauri/src-tauri/src/native_chrome.rs:10-95
- Modify: app/applications/tauri/src-tauri/permissions/ride-frontend.toml
- Modify: app/scripts/test/tauri-permissions.test.mjs

**Step 1: Write failing command and permission tests**

Add Rust tests proving the command accepts only StartupDiagnosticPhase, returns
success when disabled, records through AppState, and does not mutate ordinary
StartupMetrics.

Add a Node policy test:

~~~js
assert.match(permissionSource, /allow-ride-record-startup-diagnostic/);
assert.match(permissionSource, /ride_record_startup_diagnostic/);
~~~

**Step 2: Run to verify RED**

~~~powershell
node --test app/scripts/test/tauri-permissions.test.mjs
$env:CARGO_TARGET_DIR='L:\R-IDE-builds\ride-codex-app-server-tauri-target'
npm --prefix app run test:tauri-rust -- startup_diagnostic
~~~

Expected: FAIL because the command and permission are absent.

**Step 3: Implement minimal wiring**

- Add startup_diagnostics: StartupDiagnostics to AppState.
- Construct it once in run before Tauri setup.
- Register ride_record_startup_diagnostic in generate_handler.
- Add allow-ride-record-startup-diagnostic to ride-frontend.toml.

The command is:

~~~rust
#[tauri::command]
pub fn ride_record_startup_diagnostic(
    app: AppHandle,
    phase: StartupDiagnosticPhase,
) -> Result<(), String> {
    app.state::<AppState>()
        .startup_diagnostics
        .record_or_warn(phase);
    Ok(())
}
~~~

Do not let the diagnostic environment variable request the Windows measurement
Job Object; only the existing startup report controls containment.

**Step 4: Run focused Node and Rust tests**

Expected: both commands exit 0.

**Step 5: Commit**

~~~powershell
git add app/applications/tauri/src-tauri/src/lib.rs app/applications/tauri/src-tauri/src/native_chrome.rs app/applications/tauri/src-tauri/permissions/ride-frontend.toml app/scripts/test/tauri-permissions.test.mjs
git commit -m "feat: expose startup diagnostic checkpoints"
~~~

### Task 3: Place non-blocking frontend checkpoints

**Files:**
- Modify: app/theia-extensions/product/src/browser/ride-open-request.ts:30-55,160-220,330-410,505-511,840-845
- Modify: app/theia-extensions/product/test/ride-open-request.test.ts

**Step 1: Write failing Product tests**

Extend the test context with a diagnostic reporter and assert this exact legal
sequence for initial native and restored requests:

~~~ts
assert.deepEqual(context.diagnostics, [
    'frontend_initialization_started',
    'attached_shell_resolved',
    'workspace_ready',
    'native_listener_installed',
    'initial_request_selected',
    'target_open_started',
    'target_model_resolved',
    'target_widget_activated',
    'target_milestone_requested'
]);
~~~

Add tests proving browser mode invokes nothing, reporter rejection cannot block
opening, disposal suppresses later checkpoints, empty workspace stops after
listener installation, and target_file_opened remains after widget activation.

**Step 2: Run to verify RED**

~~~powershell
npm --prefix app --workspace theia-extensions/product test
~~~

Expected: FAIL because no diagnostic reporter or calls exist.

**Step 3: Implement minimal frontend reporting**

Add the phase string union and adapter:

~~~ts
export async function reportRideStartupDiagnostic(
    phase: RideStartupDiagnosticPhase
): Promise<void> {
    if (typeof window !== 'object' || !isTauriRuntime()) {
        return;
    }
    await invoke('ride_record_startup_diagnostic', { phase });
}
~~~

Inject a reporter into RideOpenRequestContribution. The protected helper catches
failures like milestone reporting. Start operations immediately; diagnostic
calls must be serialized only inside a detached reporting chain so they cannot
delay user-visible work.

**Step 4: Run Product tests and build**

~~~powershell
npm --prefix app --workspace theia-extensions/product test
npm --prefix app --workspace theia-extensions/product run build
~~~

Expected: 0 failures and build exit 0.

**Step 5: Commit**

~~~powershell
git add app/theia-extensions/product/src/browser/ride-open-request.ts app/theia-extensions/product/test/ride-open-request.test.ts
git commit -m "perf: trace frontend startup critical path"
~~~

### Task 4: Parse and bind companion reports in the measurement harness

**Files:**
- Modify: app/scripts/measure-tauri-startup.mjs:217-268,500-670,3000-3133
- Modify: app/scripts/test/measure-tauri-startup.test.mjs

**Step 1: Write failing parser and environment tests**

Add exact-schema fixtures and reject unknown or missing top-level keys, unknown
phase keys, missing predecessors, decreasing timestamps, wrong platform,
architecture or PID, and arbitrary metadata.

Add a test that filterSpawnEnvironment strips an inherited
RIDE_STARTUP_DIAGNOSTIC_REPORT and installs only the harness-owned path.

**Step 2: Run to verify RED**

~~~powershell
node --test --test-name-pattern="startup critical-path diagnostic" app/scripts/test/measure-tauri-startup.test.mjs
~~~

Expected: FAIL because parser, export, and environment support are absent.

**Step 3: Implement strict parsing and per-run binding**

- Export parseStartupDiagnosticReport.
- Extend filterSpawnEnvironment with an optional harness diagnostic path.
- Pass diagnosticPath through measureOnce and launch.
- After the final startup report, wait for a valid diagnostic prefix.
- Require matching PID, platform, and architecture.
- Return startupDiagnostics only when the companion path was requested.

The ordinary startup report and measurement schemas remain unchanged.

**Step 4: Run focused and full measurement tests**

~~~powershell
node --test --test-name-pattern="startup critical-path diagnostic" app/scripts/test/measure-tauri-startup.test.mjs
node --test app/scripts/test/measure-tauri-startup.test.mjs
~~~

Expected: all tests pass.

**Step 5: Commit**

~~~powershell
git add app/scripts/measure-tauri-startup.mjs app/scripts/test/measure-tauri-startup.test.mjs
git commit -m "test: capture startup diagnostic companions"
~~~

### Task 5: Aggregate a separate campaign artifact

**Files:**
- Modify: app/scripts/measure-tauri-startup.mjs:3093-3133,3373-3725
- Modify: app/scripts/test/measure-tauri-startup.test.mjs

**Step 1: Write failing campaign tests**

Add CLI and campaign tests for --diagnostics-output. Assert every run gets a
distinct private path, the ordinary measurement shape is unchanged, and the
companion artifact is ride.startup-critical-path-diagnostic-campaign@1 with
build/host identity, per-run phases, adjacent derived segments, and medians.

Also test atomic replacement, stale success/failure cleanup, and redaction of
private temporary paths on failure.

**Step 2: Run to verify RED**

Run the focused diagnostic pattern command.

Expected: FAIL because the option and campaign writer are absent.

**Step 3: Implement companion aggregation**

Write this independent shape:

~~~js
{
  schema: 'ride.startup-critical-path-diagnostic-campaign',
  version: 1,
  platform,
  arch,
  build,
  host,
  runs: [{ phases, segments }],
  median: { phases, segments }
}
~~~

Derive segments from adjacent fixed phases; never accept segment durations from
the application. Publish only after all ordinary runs pass.

**Step 4: Run measurement and all script tests**

~~~powershell
node --test app/scripts/test/measure-tauri-startup.test.mjs
node --test app/scripts/test/*.test.mjs
~~~

Expected: all tests pass.

**Step 5: Commit**

~~~powershell
git add app/scripts/measure-tauri-startup.mjs app/scripts/test/measure-tauri-startup.test.mjs
git commit -m "feat: aggregate startup critical-path diagnostics"
~~~

### Task 6: Build, measure, and select one optimization

**Files:**
- Create ignored unique artifacts under app/applications/tauri/src-tauri/target
- Create: docs/performance/2026-08-31-tauri-startup-critical-path-evidence.md
- Modify only if evidence qualifies: the smallest source/test pair responsible for the selected segment

**Step 1: Run complete pre-campaign gates**

Run full script, Product, Codex, extension build, profile, packaging, copy,
Rust, and release-build gates. Use
L:\R-IDE-builds\ride-codex-app-server-tauri-target for Cargo.

Expected: every command exits 0. Restore only the four known generated Tauri
schema files if Cargo rewrites them.

**Step 2: Run packaged smoke**

Create a fresh uniquely named SSD runtime, then run new critical-file and codex
reports.

Expected: both passed, rust-gateway mode, one backend generation, zero old-tree
survivors.

**Step 3: Run five diagnostic samples**

~~~powershell
node app/scripts/measure-tauri-startup.mjs --executable <runtime>\ride-tauri.exe --runs 5 --idle-ms 3000 --timeout-ms 30000 --poll-ms 25 --output app/applications/tauri/src-tauri/target/<unique>-startup.json --diagnostics-output app/applications/tauri/src-tauri/target/<unique>-diagnostics.json --profile-manifest <runtime>\resources\backend\ride-tauri-profile.json
~~~

Expected: both artifacts have five runs, matching build/host identity, and no
failure companion.

**Step 4: Select or reject one optimization**

If no segment has median at least 100 ms with bounded spread, document a
no-change conclusion.

If one qualifies, follow a fresh RED-GREEN cycle, rebuild, and run interleaved
control/candidate samples. Retain only when target-open median improves at least
100 ms, slowest is at most 3,000 ms, window median remains at most 800 ms, RSS
stays within policy, and both packaged smoke scenarios pass. Otherwise revert
the candidate commit and retain diagnostics only.

**Step 5: Commit evidence documentation**

Record exact commands, unique artifact paths, medians, spreads, and the
selected/rejected conclusion without overstating evidence.

~~~powershell
git diff --check
git status --short
git add docs/performance/2026-08-31-tauri-startup-critical-path-evidence.md
git commit -m "docs: record startup critical-path evidence"
~~~

Do not push until every required gate passes or the user explicitly authorizes
push with a disclosed performance failure.

