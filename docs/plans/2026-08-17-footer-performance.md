# Footer Performance Indicator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show the CPU and resident memory used by the complete R-IDE process tree in the Theia footer, with a role-based breakdown on hover and a two-second refresh interval.

**Architecture:** A reusable `sysinfo` sampler lives in Tauri `AppState` and exposes a `ride_performance_snapshot` command. A dedicated Theia frontend contribution polls that command without overlap, formats the aggregate into a right-aligned status bar entry, and uses a multiline tooltip for Tauri, backend, plugin-host, and other descendants.

**Tech Stack:** Rust 2021, Tauri 2, `sysinfo` 0.38.4 with only the `system` feature, serde, TypeScript 5.9, Theia `StatusBar`, Node test runner.

---

### Task 1: Define and test native process-tree aggregation

**Files:**
- Create: `app/applications/tauri/src-tauri/src/performance.rs`
- Modify: `app/applications/tauri/src-tauri/src/lib.rs:10-25`
- Modify: `app/applications/tauri/src-tauri/Cargo.toml:15-35`
- Modify: `app/applications/tauri/src-tauri/Cargo.lock`

**Step 1: Add the compatible process library**

Add this dependency. Version 0.38.4 supports the workspace's Rust 1.94.1 toolchain; sysinfo 0.39.x requires Rust 1.95.

```toml
sysinfo = { version = "0.38.4", default-features = false, features = ["system"] }
```

Run: `cargo check --manifest-path app/applications/tauri/src-tauri/Cargo.toml`

Expected: Cargo resolves `sysinfo` 0.38.4 and exits successfully.

**Step 2: Write failing aggregation tests**

Create `performance.rs` with test-only expectations for a small process table:

```rust
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
}
```

Also cover a missing parent, a process that exits between refresh and lookup, and clamping malformed CPU values to `0..=100`.

**Step 3: Run tests to verify they fail**

Run: `npm --prefix app run test:tauri-rust -- performance::tests`

Expected: FAIL because `ProcessSample`, `aggregate_snapshot`, or result types are not defined.

**Step 4: Implement the pure aggregation model**

Define serde-ready output types and an internal process row:

```rust
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
```

Implement descendant discovery using a parent-to-children map. Classify the root as `main`, the exact managed backend PID as `backend`, command lines containing `plugin-host` as `plugin_host`, and every other descendant as `other`. Sum raw per-process CPU first, divide by logical CPU count, then clamp the group and total percentages to `0..=100`.

**Step 5: Run the native unit tests**

Run: `npm --prefix app run test:tauri-rust -- performance::tests`

Expected: all performance aggregation tests PASS.

**Step 6: Commit**

```powershell
git add -- app/applications/tauri/src-tauri/Cargo.toml app/applications/tauri/src-tauri/Cargo.lock app/applications/tauri/src-tauri/src/performance.rs app/applications/tauri/src-tauri/src/lib.rs
git commit -m "feat: aggregate R-IDE process usage"
```

### Task 2: Expose the reusable Tauri performance sampler

**Files:**
- Modify: `app/applications/tauri/src-tauri/src/performance.rs`
- Modify: `app/applications/tauri/src-tauri/src/lib.rs:25-75`
- Modify: `app/applications/tauri/src-tauri/src/lib.rs:240-265`

**Step 1: Write failing sampler tests**

Add tests around an injectable process source to prove:

- Two refreshes reuse the same sampler state, enabling CPU deltas.
- The sampler passes `std::process::id()` as the root PID.
- The backend PID comes from `BackendOwnershipState::pid()`.
- Missing/terminated processes are ignored.

Use a `ProcessSource` trait in tests rather than starting real child processes.

**Step 2: Run tests to verify they fail**

Run: `npm --prefix app run test:tauri-rust -- performance::tests`

Expected: FAIL because the sampler and source abstraction do not exist.

**Step 3: Implement the reusable sampler and command**

Add a production sampler with a single reusable `sysinfo::System`:

```rust
#[derive(Debug)]
pub struct PerformanceSampler {
    system: Mutex<System>,
}

impl Default for PerformanceSampler {
    fn default() -> Self {
        Self { system: Mutex::new(System::new()) }
    }
}
```

On each sample, refresh all processes with CPU and memory data, convert `Pid` and parent `Pid` values into `u32`, join command-line arguments for classification, and call the pure aggregator. Use the logical CPU count from `System::cpus().len().max(1)`.

Add the sampler to `AppState`:

```rust
pub performance: performance::PerformanceSampler,
```

Expose the command:

```rust
#[tauri::command]
fn ride_performance_snapshot(
    state: tauri::State<'_, AppState>,
) -> Result<performance::PerformanceSnapshot, String> {
    let backend_pid = state.backend_ownership.lock()
        .map_err(|_| "backend ownership state is unavailable".to_string())?
        .pid();
    state.performance.snapshot(std::process::id(), backend_pid)
}
```

Register it in `tauri::generate_handler!`.

**Step 4: Run complete Rust verification**

Run: `cargo fmt --manifest-path app/applications/tauri/src-tauri/Cargo.toml --check`

Run: `npm --prefix app run test:tauri-rust`

Run: `cargo clippy --manifest-path app/applications/tauri/src-tauri/Cargo.toml --all-targets --no-deps -- -D warnings`

Expected: all commands exit 0.

**Step 5: Commit**

```powershell
git add -- app/applications/tauri/src-tauri/src/performance.rs app/applications/tauri/src-tauri/src/lib.rs
git commit -m "feat: expose Tauri performance snapshot"
```

### Task 3: Add frontend formatting and non-overlapping polling

**Files:**
- Create: `app/theia-extensions/product/src/browser/ride-performance.ts`
- Create: `app/theia-extensions/product/test/ride-performance.test.ts`
- Modify: `app/theia-extensions/product/tsconfig.test.json:10-18`

**Step 1: Write failing formatter tests**

Test exact compact output and tooltip content:

```ts
test('formats compact totals and role breakdown', () => {
    const view = formatPerformanceSnapshot(snapshot({
        total: usage(2.34, 717_225_984, 6),
        main: usage(0.4, 100_000_000, 1),
        backend: usage(0.8, 200_000_000, 1),
        pluginHost: usage(0.7, 300_000_000, 2),
        other: usage(0.44, 117_225_984, 2)
    }), 'zh-cn');

    assert.equal(view.text, '$(pulse) CPU 2.3%  内存 684 MB');
    assert.match(view.tooltip, /插件宿主.*286 MB.*2 个进程/);
});
```

Add tests for GB formatting, English labels, zero-process groups, and unavailable text after three consecutive failures.

**Step 2: Write failing poller tests**

Use an injected scheduler and fetch function. Prove an immediate first request, a 2,000 ms interval, skipped ticks while a request is pending, reset of the failure count after success, last-value retention for the first two failures, and timer disposal.

**Step 3: Run tests to verify they fail**

Run: `npm --workspace theia-extensions/product test`

Expected: FAIL because `ride-performance.ts` does not exist.

**Step 4: Implement the pure frontend module**

Export camel-case snapshot interfaces matching Rust, `formatBytes`, `formatPerformanceSnapshot`, and a `RidePerformancePoller` that accepts:

```ts
interface PollerOptions {
    fetchSnapshot: () => Promise<RidePerformanceSnapshot>;
    onUpdate: (state: PerformanceViewState) => void;
    setInterval: (handler: () => void, delay: number) => unknown;
    clearInterval: (handle: unknown) => void;
}
```

Keep `requestInFlight`, `lastSuccessfulView`, and `consecutiveFailures` inside the poller. `start()` performs an immediate refresh and installs exactly one 2,000 ms interval. `dispose()` clears it.

**Step 5: Run frontend tests**

Run: `npm --workspace theia-extensions/product test`

Expected: all existing and new product-extension tests PASS.

**Step 6: Commit**

```powershell
git add -- app/theia-extensions/product/src/browser/ride-performance.ts app/theia-extensions/product/test/ride-performance.test.ts app/theia-extensions/product/tsconfig.test.json
git commit -m "feat: format and poll R-IDE performance"
```

### Task 4: Register the Theia footer contribution

**Files:**
- Create: `app/theia-extensions/product/src/browser/ride-performance-contribution.ts`
- Modify: `app/theia-extensions/product/src/browser/ride-native-chrome.ts:350-450`
- Modify: `app/theia-extensions/product/src/browser/theia-ide-frontend-module.ts:20-55`
- Modify: `app/theia-extensions/product/test/ride-native-chrome.test.ts`
- Modify: `app/theia-extensions/product/tsconfig.test.json`

**Step 1: Write failing native bridge tests**

Extend `RideNativeChromeOptions` with an injectable invoke function. Test that browser mode returns `undefined` without invoking native code and Tauri mode validates the snapshot object returned by `ride_performance_snapshot`.

**Step 2: Run tests to verify they fail**

Run: `npm --workspace theia-extensions/product test`

Expected: FAIL because `getPerformanceSnapshot` and invoke injection do not exist.

**Step 3: Implement the bridge and contribution**

Add `RideNativeChrome.getPerformanceSnapshot()`. Validate finite non-negative CPU values, integer non-negative byte/process counts, and all five groups before returning typed data.

Create an injectable contribution implementing `FrontendApplicationContribution` and `Disposable`. Inject `StatusBar` and `FrontendApplicationStateService`. After `ready`, and only when `RideNativeChrome.isTauri` is true, create the poller and update this entry:

```ts
this.statusBar.setElement('ride-performance', {
    text: view.text,
    tooltip: view.tooltip,
    alignment: StatusBarAlignment.RIGHT,
    priority: 5
});
```

Register the singleton as a frontend application contribution in `theia-ide-frontend-module.ts`. Dispose the poller and remove `ride-performance` on shutdown.

**Step 4: Run product build, tests, and lint**

Run: `npm --workspace theia-extensions/product test`

Run: `npm --workspace theia-extensions/product run build`

Run: `npm --workspace theia-extensions/product run lint`

Expected: all commands exit 0 with no TypeScript or ESLint errors.

**Step 5: Commit**

```powershell
git add -- app/theia-extensions/product/src/browser/ride-performance-contribution.ts app/theia-extensions/product/src/browser/ride-native-chrome.ts app/theia-extensions/product/src/browser/theia-ide-frontend-module.ts app/theia-extensions/product/test/ride-native-chrome.test.ts app/theia-extensions/product/tsconfig.test.json
git commit -m "feat: show R-IDE performance in footer"
```

### Task 5: Build and verify the desktop behavior

**Files:**
- Modify only if a defect is found by verification.

**Step 1: Rebuild the browser application**

Run: `yarn --cwd app/applications/browser build:prod`

Expected: browser and node bundles finish with 0 errors.

**Step 2: Build the complete Tauri release**

Run from `app` with an isolated target directory:

```powershell
$env:CARGO_TARGET_DIR = '<worktree>\.tauri-target-fixed'
npm --workspace applications/tauri run build
```

Expected: `ride-tauri.exe`, NSIS, and MSI bundles are produced.

**Step 3: Launch and inspect the release executable**

Capture stdout/stderr, wait for `Frontend ready`, and inspect the actual R-IDE window. Verify:

- The footer shows `CPU` and localized `内存`/`Memory` text.
- Values update at approximately two-second intervals.
- Hovering shows all four role groups and process counts.
- The total includes at least the Tauri and backend processes.
- No `Failed to start`, frontend duplicate-module, watcher, or performance-command errors appear.

**Step 4: Run final automated verification**

Run: `npm --workspace theia-extensions/product test`

Run: `npm --prefix app run test:tauri-rust`

Run: `cargo clippy --manifest-path app/applications/tauri/src-tauri/Cargo.toml --all-targets --no-deps -- -D warnings`

Run: `git diff --check`

Expected: all tests pass, clippy and diff checks exit 0.

**Step 5: Commit any verification-only fixes**

If verification required changes, commit only those explicit files:

```powershell
git commit -m "fix: stabilize footer performance reporting"
```

Do not commit `.tauri-target-fixed/` or generated Tauri schema changes.
