# File Associations and Startup Performance Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Register R-IDE as a safe alternate editor for common code files on Windows, macOS, and Linux, reliably route open requests into the existing Theia window, and reduce cold start-to-editable time and idle process-tree memory.

**Architecture:** A pure Rust `LaunchIntent` parser and bounded queue normalize every OS activation path. Tauri owns lifecycle, runtime paths, backend readiness, and typed events; a product frontend contribution owns workspace switching and editor opening. Startup is divided into a core editor phase and a deferred plugin phase, with release-build milestone and memory reporting.

**Tech Stack:** Rust 2021, Tauri 2, Tokio, TypeScript 5, Eclipse Theia 1.73, Node 22 test runner, GitHub Actions desktop matrix.

---

## Preconditions

- Work only in the dedicated worktree `C:\Users\10428\.config\superpowers\worktrees\R-IDE\open-with-startup` on branch `codex/file-association-startup`.
- Preserve the dirty files in `D:\Project\R-IDE`; never copy or stage them.
- Use `apply_patch` for source edits.
- Run each RED command and observe the documented failure before implementing that task.
- Keep `.upstream` ownership and patch replay valid whenever a shared upstream file changes.

Before the first Cargo command, provision the generated resources required by `tauri::generate_context!()`:

```powershell
corepack enable
yarn --cwd app --frozen-lockfile --network-timeout 100000
yarn --cwd app build:extensions
yarn --cwd app browser build
npm --prefix app --workspace applications/tauri run copy:frontend
```

**Measurement gate:** execute Tasks 1-6, then implement Task 9's instrumentation and capture Task 11 Step 1's pre-optimization reports. Only after those reports exist should Tasks 7-8 change startup behavior. Then finish Tasks 10-13 and the remaining Task 11 comparisons. This gate prevents fabricated or post-hoc baselines.

## Task 1: Lock the desktop association contract

**Files:**

- Create: `scripts/test/desktop-integration-policy.test.mjs`
- Modify: `app/applications/tauri/src-tauri/tauri.conf.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/test/workflow-policy.test.mjs`

### Step 1: Write the failing association inventory test

Create a Node test that loads `tauri.conf.json`, flattens `bundle.fileAssociations[*].ext`, and compares it with this exact sorted set:

```js
const expectedExtensions = [
  'bash', 'bat', 'c', 'cc', 'cjs', 'cmd', 'code-workspace', 'cpp', 'cs',
  'css', 'cts', 'cxx', 'fish', 'go', 'h', 'hpp', 'htm', 'html', 'ini',
  'java', 'js', 'json', 'jsonc', 'jsx', 'kt', 'kts', 'less', 'mjs', 'md',
  'markdown', 'mts', 'properties', 'ps1', 'psm1', 'py', 'pyw', 'qmd', 'r',
  'rmd', 'rs', 'scss', 'sh', 'sql', 'svelte', 'theia-workspace', 'toml',
  'ts', 'tsx', 'vue', 'xml', 'yaml', 'yml', 'zsh'
];
```

Also assert every association has `role: "Editor"` and `rank: "Alternate"`; no association uses `text/plain`; `txt` and `log` are absent; and the main window has `backgroundThrottling: "suspend"`.

### Step 2: Run the test to verify RED

```powershell
node --test scripts/test/desktop-integration-policy.test.mjs
```

Expected: FAIL because associations and explicit throttling do not exist.

### Step 3: Add grouped file associations

Add `bundle.fileAssociations` entries grouped by specific MIME/content types. Use the approved inventory, `role: "Editor"`, `rank: "Alternate"`, a human-readable name/Windows description, and no generic `text/plain` claim. Add `backgroundThrottling: "suspend"` to the main window.

### Step 4: Put the policy test in CI

First add a failing assertion to `workflow-policy.test.mjs` requiring the quality job to run the new test. Observe RED, then update `ci.yml`.

### Step 5: Verify GREEN

```powershell
node --test scripts/test/desktop-integration-policy.test.mjs scripts/test/workflow-policy.test.mjs
```

Expected: all PASS.

### Step 6: Commit

```powershell
git add app/applications/tauri/src-tauri/tauri.conf.json scripts/test/desktop-integration-policy.test.mjs scripts/test/workflow-policy.test.mjs .github/workflows/ci.yml
git commit -m "feat: register R-IDE as a code file editor"
```

## Task 2: Parse launch intents safely in pure Rust

**Files:**

- Create: `app/applications/tauri/src-tauri/src/launch_intent.rs`
- Create: `app/applications/tauri/src-tauri/tests/launch_intent.rs`
- Modify: `app/applications/tauri/src-tauri/src/lib.rs`

### Step 1: Write failing integration tests

Cover: executable argument ignored; relative file resolved against supplied `cwd`; spaces and Unicode preserved; duplicates collapse without reordering; first file parent selected as workspace; multiple files ordered; missing paths, directories, NUL, flags, and non-`file:` URLs rejected; `file:` URLs accepted; drive/UNC cases under `#[cfg(windows)]`.

Use a UUID-named fixture beneath `std::env::temp_dir()` and remove only that resolved fixture in `Drop`.

### Step 2: Verify RED

```powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test launch_intent
```

Expected: compilation FAIL because `ride_tauri::launch_intent` does not exist.

### Step 3: Implement the pure model

```rust
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchIntent {
    pub id: u64,
    pub source: LaunchSource,
    pub workspace: PathBuf,
    pub files: Vec<PathBuf>,
}

pub fn parse_args(
    args: impl IntoIterator<Item = OsString>,
    cwd: &Path,
    source: LaunchSource,
    next_id: u64,
) -> Option<LaunchIntent>;

pub fn parse_opened_urls(
    urls: &[tauri::Url],
    source: LaunchSource,
    next_id: u64,
) -> Option<LaunchIntent>;
```

Keep parsing free of Tauri handles, locks, process spawning, or frontend emission.

### Step 4: Verify GREEN

```powershell
cargo fmt --manifest-path app/applications/tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test launch_intent
cargo clippy --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test launch_intent -- -D warnings
```

Expected: PASS.

### Step 5: Commit

```powershell
git add app/applications/tauri/src-tauri/src/launch_intent.rs app/applications/tauri/src-tauri/src/lib.rs app/applications/tauri/src-tauri/tests/launch_intent.rs
git commit -m "feat: parse desktop file launch intents"
```

## Task 3: Add a bounded, exactly-once activation queue

**Files:**

- Modify: `app/applications/tauri/src-tauri/src/launch_intent.rs`
- Modify: `app/applications/tauri/src-tauri/tests/launch_intent.rs`
- Modify: `app/applications/tauri/src-tauri/src/lib.rs`

### Step 1: Add failing queue tests

Test requests queued before frontend readiness, ready-state ordered drain, duplicate ID acknowledgement, bounded newest-request retention, and lock release before a delivery callback executes.

### Step 2: Verify RED

Run the focused Cargo test and confirm missing `LaunchIntentQueue` failures.

### Step 3: Implement the queue

Add `LaunchIntentQueue` around `VecDeque`, a consumed-ID `HashSet`, readiness flag, and maximum length. Return owned intents so callers emit after releasing the mutex. Add the queue and `AtomicU64` ID source to `AppState`.

### Step 4: Verify and commit

Run focused/full Cargo tests, fmt, and clippy, then:

```powershell
git commit -am "feat: queue desktop activation requests"
```

## Task 4: Route initial, single-instance, and macOS open events

**Files:**

- Modify: `app/applications/tauri/src-tauri/src/lib.rs`
- Modify: `app/applications/tauri/src-tauri/src/native_chrome.rs`
- Modify: `app/applications/tauri/src-tauri/tests/launch_intent.rs`

### Step 1: Add failing routing tests

Introduce a pure router/delivery seam. Assert initial args queue before setup; forwarded args use callback `cwd`; single-instance enqueue precedes focus; frontend readiness drains; macOS opened URLs share the parser; invalid requests focus but emit nothing.

### Step 2: Verify RED

Run the launch-intent test target and observe missing routing behavior.

### Step 3: Implement Tauri routing

- Parse `std::env::args_os()` before building the application.
- Keep `tauri_plugin_single_instance` first.
- In its callback parse `args` with `cwd`, enqueue, focus/unminimize, and flush when ready.
- Extend `ride_frontend_ready` to mark ready and `emit_to("main", "ride-open-request", payload)`.
- Under `#[cfg(target_os = "macos")]`, handle `RunEvent::Opened { urls }` through the same router.
- Do not use `eval`; use typed Serde payloads.

### Step 4: Verify and commit

Run Cargo tests/fmt/clippy, then:

```powershell
git add app/applications/tauri/src-tauri/src/lib.rs app/applications/tauri/src-tauri/src/native_chrome.rs app/applications/tauri/src-tauri/src/launch_intent.rs app/applications/tauri/src-tauri/tests/launch_intent.rs
git commit -m "feat: route operating system file activations"
```

## Task 5: Open files through the Theia product frontend

**Files:**

- Create: `app/theia-extensions/product/src/browser/ride-open-request.ts`
- Create: `app/theia-extensions/product/test/ride-open-request.test.ts`
- Create: `app/theia-extensions/product/tsconfig.test.json`
- Modify: `app/theia-extensions/product/src/browser/ride-native-chrome.ts`
- Modify: `app/theia-extensions/product/src/browser/theia-ide-frontend-module.ts`
- Modify: `app/theia-extensions/product/package.json`
- Modify: `.upstream/owned-paths.txt`

### Step 1: Write failing frontend tests

Use Node test plus `ts-node/register` and dependency fakes. Test same-workspace open/focus; different-workspace session handoff with `preserveWindow: true`; one-time restored request; duplicate IDs; non-poisoning open failure notification.

Add a separate test compiler config that emits beneath ignored `test/dist`, then add:

```json
"test": "rimraf test/dist && tsc -p tsconfig.test.json && node --test test/dist/test/*.test.js"
```

`tsconfig.test.json` should extend the product config, set `composite: false`, `rootDir: "."`, `outDir: "test/dist"`, disable declarations, and include only the open-request source plus `test/**/*.ts`.

### Step 2: Verify RED

```powershell
npm --prefix app --workspace theia-extensions/product test
```

Expected: FAIL because service/event APIs do not exist.

### Step 3: Implement the native listener

Add `listenForOpenRequests(handler)` to `RideNativeChrome` using `@tauri-apps/api/event.listen`; browser preview remains a no-op.

### Step 4: Implement the frontend contribution

Use `FileUri.create`, `WorkspaceService`, `OpenerService`, `MessageService`, and `ApplicationShell`. Store only the typed request/ID in a namespaced `sessionStorage` key. Register it in the existing frontend module.

### Step 5: Verify GREEN

```powershell
npm --prefix app --workspace theia-extensions/product test
npm --prefix app --workspace theia-extensions/product run build
npm --prefix app --workspace theia-extensions/product run lint
```

### Step 6: Declare ownership and commit

Add new R-IDE-specific product paths to `.upstream/owned-paths.txt`, then:

```powershell
git add app/theia-extensions/product .upstream/owned-paths.txt
git commit -m "feat: open activated files in the Theia workbench"
```

## Task 6: Start the backend in the selected workspace

**Files:**

- Create: `app/applications/tauri/src-tauri/src/startup.rs`
- Create: `app/applications/tauri/src-tauri/tests/startup.rs`
- Modify: `app/applications/tauri/src-tauri/src/lib.rs`
- Modify: `app/applications/tauri/src-tauri/src/sidecar.rs`

### Step 1: Write failing startup-plan tests

Test workspace positional argument, option-looking path safety, and no-workspace recent behavior. Do not optimize resource discovery in this task; the measured baseline needs the existing startup cost.

### Step 2: Verify RED

```powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup
```

Expected: unresolved `startup` APIs.

### Step 3: Implement `BackendLaunchPlan`

Pass `intent.workspace` to Node and compiled backend variants using the existing resource discovery unchanged.

### Step 4: Wire the selected workspace without refactoring startup

Thread the optional workspace from initial `LaunchIntent` through setup into `sidecar`. Preserve the current no-intent recent-workspace behavior and all current process/readiness code so the next benchmark is a valid pre-optimization baseline.

### Step 5: Verify and commit

Run focused/full Cargo tests, fmt, clippy, then:

```powershell
git add app/applications/tauri/src-tauri/src/startup.rs app/applications/tauri/src-tauri/tests/startup.rs app/applications/tauri/src-tauri/src/lib.rs app/applications/tauri/src-tauri/src/sidecar.rs
git commit -m "feat: start Tauri in the activated workspace"
```

## Task 7: Defer bundled plugin deployment until the editor is visible

**Gate:** Do not start this task until Task 9 instrumentation is complete and Task 11 Step 1 baseline artifacts have been captured.

**Files:**

- Modify: `app/applications/tauri/src-tauri/src/commands.rs`
- Modify: `app/applications/tauri/src-tauri/src/lib.rs`
- Modify: `app/applications/tauri/src-tauri/src/sidecar.rs`
- Modify: `app/theia-extensions/product/src/browser/ride-native-chrome.ts`
- Modify: `app/theia-extensions/product/src/browser/ride-open-request.ts`
- Modify: `app/theia-extensions/product/test/ride-open-request.test.ts`
- Modify: `app/theia-extensions/product/package.json`

### Step 1: Add failing scheduler tests

Test that a file opens before plugin installation begins; no-file startup deploys after a bounded delay; plugin-dependent demand deploys immediately; deployment is idempotent; and deployment failure leaves the editor open.

### Step 2: Verify RED

Run the product test and confirm missing scheduler behavior.

### Step 3: Expose plugin locations safely

Add a Tauri command returning existing canonical plugin directories from cached `RuntimePaths`. Accept no frontend path argument.

### Step 4: Remove plugin scanning from backend launch

Stop passing `--plugins=local-dir:...` during initial backend boot. Keep Theia's plugin service available with no startup directory to scan.

### Step 5: Deploy through Theia `PluginServer`

Add direct `@theia/plugin-ext` dependency to the product package. Inject `PluginServer`, then install `local-dir:<canonical path>` as `PluginType.System` after target-file open or the no-file timer. The hosted-plugin watcher performs subsequent loading.

### Step 6: Verify and commit

Run product tests/build/lint and full Cargo checks, then:

```powershell
git add app/applications/tauri/src-tauri app/theia-extensions/product
git commit -m "perf: defer plugin deployment until editor readiness"
```

## Task 8: Remove avoidable backend transport overhead

**Gate:** Do not start this task until Task 9 instrumentation is complete and Task 11 Step 1 baseline artifacts have been captured.

**Files:**

- Modify: `app/applications/tauri/src-tauri/src/startup.rs`
- Modify: `app/applications/tauri/src-tauri/src/sidecar.rs`
- Modify: `app/applications/tauri/src-tauri/src/lib.rs`
- Modify: `app/applications/tauri/src-tauri/Cargo.toml`
- Modify: `app/applications/tauri/src-tauri/Cargo.lock`
- Modify: `app/applications/tauri/src-tauri/tests/startup.rs`

### Step 1: Add failing transport/readiness tests

With injected child/readiness seams, test direct-pipe default, `RIDE_BACKEND_TRANSPORT=pty` fallback, bounded loopback readiness, timeout process-tree termination, log independence, shutdown state cleanup, packaged paths derived from one resource root, explicit development fallback only, and one-time path computation.

### Step 2: Verify RED

Run the startup integration target and observe missing transport/readiness APIs.

### Step 3: Use Tauri's async runtime

Replace `std::thread::spawn` plus `tokio::runtime::Runtime::new()` with `tauri::async_runtime::spawn`. Put remaining blocking process-tree operations behind `spawn_blocking` where needed.

### Step 4: Cache immutable runtime paths

Resolve packaged resources through `app.path().resource_dir()` into one `RuntimePaths`. Retain environment overrides and an explicit debug fallback. Make backend, frontend, plugin, runtime, and config selection consume this value instead of repeating ancestor scans.

### Step 5: Add direct-pipe transport

Use `tokio::process::Command` with independent stdout/stderr log tasks. Probe the configured loopback port with bounded backoff. Keep PTY compatibility mode until all package runners prove direct pipes; remove `portable-pty` and narrow Tokio features only with Windows, Linux, macOS ARM, and macOS Intel evidence.

### Step 6: Verify locally

```powershell
cargo fmt --manifest-path app/applications/tauri/src-tauri/Cargo.toml --check
cargo clippy --manifest-path app/applications/tauri/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml
```

### Step 7: Commit

```powershell
git add app/applications/tauri/src-tauri
git commit -m "perf: streamline Tauri backend startup"
```

## Task 9: Add milestone and process-tree performance reporting

**Execution order:** Implement this task immediately after Task 6, before either performance optimization task.

**Files:**

- Create: `app/applications/tauri/src-tauri/src/startup_metrics.rs`
- Create: `app/applications/tauri/src-tauri/tests/startup_metrics.rs`
- Create: `app/scripts/measure-tauri-startup.mjs`
- Create: `app/scripts/test/measure-tauri-startup.test.mjs`
- Modify: `app/applications/tauri/src-tauri/src/lib.rs`
- Modify: `app/applications/tauri/src-tauri/src/native_chrome.rs`
- Modify: `app/theia-extensions/product/src/browser/ride-open-request.ts`
- Modify: `app/package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/test/workflow-policy.test.mjs`

### Step 1: Write failing Rust milestone tests

Assert strict ordering, monotonic durations, duplicate idempotence, atomic JSON only when `RIDE_STARTUP_REPORT` is set, and no frontend-controlled output path.

### Step 2: Verify Rust RED

Run the new test target; expect the metrics module to be missing.

### Step 3: Implement the recorder

Record `process_started`, `native_window_visible`, `backend_spawned`, `backend_listening`, `frontend_shell_attached`, `target_file_opened`, `plugins_started`, and `plugins_ready`. Frontend callbacks update the recorder. Write via sibling temp file and rename.

### Step 4: Write failing Node harness tests

Test executable discovery, JSON parsing, median calculation, timeout cleanup, POSIX `ps` parsing, and Windows PowerShell process-table parsing with fixture strings.

### Step 5: Verify Node RED

```powershell
node --test app/scripts/test/measure-tauri-startup.test.mjs
```

Expected: module-not-found or missing-function failure.

### Step 6: Implement the harness

Launch a release executable with a temporary code file and `RIDE_STARTUP_REPORT`, wait for `target_file_opened`, sample the verified process tree after 30 idle seconds, repeat five times, and output median JSON. Terminate only the spawned process tree in `finally`.

Add:

```json
"measure:tauri-startup": "node scripts/measure-tauri-startup.mjs"
```

Add a package-matrix step after bundle verification that runs the harness against that platform's packaged executable and includes the JSON in the unsigned artifact. Add the workflow-policy assertion first and observe RED. This is required so the Task 9 commit itself can produce Task 11's pre-optimization reports before Tasks 7-8 begin.

### Step 7: Verify and commit

Run Rust, Node, and workflow-policy tests, then:

```powershell
git add app/applications/tauri/src-tauri app/scripts/measure-tauri-startup.mjs app/scripts/test/measure-tauri-startup.test.mjs app/package.json app/theia-extensions/product/src/browser/ride-open-request.ts .github/workflows/ci.yml scripts/test/workflow-policy.test.mjs
git commit -m "test: measure Tauri startup and idle memory"
```

## Task 10: Verify generated platform metadata and packaged activation

**Files:**

- Create: `app/scripts/verify-tauri-associations.mjs`
- Create: `app/scripts/test/verify-tauri-associations.test.mjs`
- Modify: `app/applications/tauri/package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/test/workflow-policy.test.mjs`

### Step 1: Write failing metadata parser tests

Use inline fixtures for macOS `Info.plist`, Linux `.desktop`, and Windows WiX/NSIS metadata. Assert missing extensions, unsafe command templates, or default claims fail.

### Step 2: Verify RED

Run the test and observe missing verifier module failures.

### Step 3: Implement bundle verification

Discover only under `src-tauri/target/release/bundle`, inspect current-platform metadata, compare the approved inventory, and never install bundles or mutate host associations.

### Step 4: Add package workflow checks

Add policy assertions before editing the workflow. Then add a post-package association verification step and startup JSON artifact upload. Add Linux `xvfb` only if the packaged activation smoke needs it.

### Step 5: Verify and commit

Run metadata and workflow-policy tests plus the verifier against any local release bundle, then:

```powershell
git add app/scripts app/applications/tauri/package.json .github/workflows/ci.yml scripts/test/workflow-policy.test.mjs
git commit -m "ci: verify desktop file activation metadata"
```

## Task 11: Capture baseline, prove gains, and set budgets

**Files:**

- Create after measurement: `app/applications/tauri/perf/baselines/*.json`
- Create: `app/scripts/check-tauri-performance.mjs`
- Create: `app/scripts/test/check-tauri-performance.test.mjs`
- Modify: `.github/workflows/ci.yml`

### Step 1: Capture pre-optimization data

Immediately after Task 9 and before Tasks 7-8, tag the current commit as the functional pre-optimization baseline. Run its release harness on Windows and through the four-runner package workflow, then download the generated JSON. Record the exact commit SHA; do not hand-author timing or memory values.

### Step 2: Capture optimized reports

Run the identical release harness, file fixture, runner image, and five-run median against the feature branch.

### Step 3: Check approved goals

```text
startup_gain = (baseline_start_to_editable - candidate_start_to_editable) / baseline
memory_gain  = (baseline_idle_memory - candidate_idle_memory) / baseline
```

Require at least 30% startup gain and 10% memory gain on the reference run. If either misses, profile Tasks 7-8; do not silently weaken the target.

### Step 4: TDD the budget checker

Write tests for pass, severe regression, wrong platform, missing milestone, and noisy-run tolerance. CI rejects same-platform regressions beyond tolerance and never compares different platforms.

### Step 5: Commit measured evidence

```powershell
git add app/applications/tauri/perf app/scripts/check-tauri-performance.mjs app/scripts/test/check-tauri-performance.test.mjs .github/workflows/ci.yml
git commit -m "perf: enforce Tauri startup regression budgets"
```

## Task 12: Refresh upstream metadata and document behavior

**Files:**

- Modify: `.upstream/owned-paths.txt`
- Modify: `.upstream/patches/*.patch` as generated
- Modify: `README.md`
- Create: `docs/desktop-file-activation.md`
- Modify: `docs/upstream-sync.md` only if ownership guidance changes

### Step 1: Write documentation

Document supported extensions, alternate-handler behavior, first-file workspace and multiple tabs, single-instance routing, deferred syntax timing, diagnostic transport overrides, performance reports, and OS removal of associations.

### Step 2: Refresh patches

```powershell
node scripts/sync-upstream.mjs refresh-patches
node scripts/sync-upstream.mjs check --json
```

Expected: reproducible refresh and zero drift. New R-IDE product files must be owned, not accidental upstream patches.

### Step 3: Run real-tree reconstruction

```powershell
$env:RIDE_PINNED_UPSTREAM='<verified pinned checkout>'
node --test scripts/test/upstream-sync/real-tree.test.mjs
Remove-Item Env:RIDE_PINNED_UPSTREAM
```

Expected: PASS and zero drift.

### Step 4: Commit

```powershell
git add .upstream README.md docs app
git commit -m "docs: explain desktop activation and startup budgets"
```

## Task 13: Final verification and review

### Step 1: Run focused tests

```powershell
node --test scripts/test/desktop-integration-policy.test.mjs scripts/test/workflow-policy.test.mjs
node --test app/scripts/test/*.test.js app/scripts/test/*.test.mjs
npm --prefix app --workspace theia-extensions/product test
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml
```

Expected: all PASS.

### Step 2: Run static checks

```powershell
npm --prefix app --workspace theia-extensions/product run lint
npm --prefix app --workspace theia-extensions/product run build
cargo fmt --manifest-path app/applications/tauri/src-tauri/Cargo.toml --check
cargo clippy --manifest-path app/applications/tauri/src-tauri/Cargo.toml --all-targets -- -D warnings
git diff --check origin/main...HEAD
```

Expected: all exit 0.

### Step 3: Run synchronization checks

```powershell
node --test scripts/test/upstream-sync/*.test.mjs
node scripts/sync-upstream.mjs check --json
```

Expected: all PASS and drift false.

### Step 4: Run packaged smoke tests

On Windows, Linux, macOS ARM, and macOS Intel: build release; inspect associations; cold-open a temporary file; forward a second file; close and confirm no backend descendant; upload five-run performance JSON.

### Step 5: Compare evidence

Confirm at least 30% lower median start-to-editable and 10% lower 30-second idle process-tree memory. Report raw baseline/candidate values and percentages.

### Step 6: Request review

Use `superpowers:requesting-code-review` for independent specification and quality review. Fix findings through focused RED/GREEN tests.

### Step 7: Confirm clean state

```powershell
git status --short --branch
git log --oneline --decorate origin/main..HEAD
```

Expected: clean worktree with only intentional feature commits.
