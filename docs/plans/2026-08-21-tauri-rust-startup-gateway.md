# R-IDE Tauri Rust Startup Gateway Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the Tauri window render the real Theia document immediately while Rust starts the Node backend concurrently, with authenticated loopback proxying, deterministic recovery, and measurable startup/RSS improvements.

**Architecture:** A Rust-owned HTTP/1.1 loopback gateway binds an ephemeral public port before the main window is created. It serves an exact inventory of packaged frontend files immediately, proxies backend HTTP and Socket.IO traffic to the private Node listener when ready, and exposes authenticated startup-control endpoints; the WebView loads this one origin for its entire lifetime. Startup report v2 records true parallel frontend/backend milestones with a dependency graph, while explicit legacy and automatic fallback modes preserve recoverability.

**Tech Stack:** Rust 2021, Tauri 2, Tokio, Hyper 1, hyper-util, http-body-util, bytes, existing reqwest/serde/uuid infrastructure, Theia browser TypeScript, Node.js test runner, packaged Tauri smoke scripts, GitHub Actions.

---

## Working agreement and baseline

- Work only in the dedicated worktree:
  C:\Users\10428\.config\superpowers\worktrees\R-IDE\tauri-rust-startup-gateway
- Branch: codex/tauri-rust-startup-gateway
- Design authority: docs/plans/2026-08-21-tauri-rust-startup-gateway-design.md
- Keep Cargo artifacts off the full F: drive:

~~~powershell
$env:CARGO_TARGET_DIR = 'L:\R-IDE-builds\ride-rust-startup-gateway-target'
~~~

- Put final measurement evidence under:
  L:\R-IDE-builds\performance-evidence-2026-08-21
- The generated directories applications/tauri/browser-frontend and applications/tauri/tauri-frontend are ignored build inputs. Generate them with the repository scripts; do not commit them.
- Do not update the historical pre-optimization baseline. Compare new same-host evidence against both the current-main evidence and the fixed historical baseline.
- Baseline already established in this worktree:
  - Node performance tests: 171 passed, 0 failed.
  - Rust library tests: 60 passed, 0 failed, 1 ignored network test.
- Apply @superpowers:test-driven-development for every task, @superpowers:systematic-debugging for unexpected failures, and @superpowers:verification-before-completion before the final claim.

### Task 1: Startup report v2 and parallel milestone causality

**Files:**

- Modify: app/applications/tauri/src-tauri/src/startup_metrics.rs:15-455
- Modify: app/applications/tauri/src-tauri/tests/startup_metrics.rs
- Modify: app/scripts/measure-tauri-startup.mjs:17-85 and report validation functions
- Modify: app/scripts/test/measure-tauri-startup.test.mjs
- Modify: app/scripts/check-tauri-performance.mjs:27-45 and validateStartupReport
- Modify: app/scripts/test/check-tauri-performance.test.mjs

**Step 1: Write failing Rust tests for v2 shape and dependency ordering**

Add tests that construct a rust-gateway report, deliberately record independent frontend/backend events in callback order rather than timestamp order, and verify that timestamps are not rewritten:

~~~rust
#[test]
fn gateway_report_accepts_parallel_branches_without_rewriting_timestamps() {
    let mut report = StartupReport::new(
        "windows",
        "x86_64",
        42,
        StartupMode::RustGateway,
    );
    assert_eq!(report.record(StartupMilestone::ProcessStarted, 0), Ok(RecordOutcome::Recorded));
    assert_eq!(report.record(StartupMilestone::GatewayListening, 5), Ok(RecordOutcome::Recorded));
    assert_eq!(report.record(StartupMilestone::FrontendRequestStarted, 8), Ok(RecordOutcome::Recorded));
    assert_eq!(report.record(StartupMilestone::FrontendBundleLoaded, 40), Ok(RecordOutcome::Recorded));
    assert_eq!(report.record(StartupMilestone::BackendSpawned, 3), Ok(RecordOutcome::Recorded));
    assert_eq!(report.record(StartupMilestone::BackendListening, 30), Ok(RecordOutcome::Recorded));
    assert_eq!(report.record(StartupMilestone::RpcConnected, 45), Ok(RecordOutcome::Recorded));

    let value = serde_json::to_value(report).unwrap();
    assert_eq!(value["version"], 2);
    assert_eq!(value["startupMode"], "rust-gateway");
    assert_eq!(value["milestones"]["backend_spawned"], 3);
    assert_eq!(value["milestones"]["frontend_bundle_loaded"], 40);
}

#[test]
fn gateway_report_rejects_a_milestone_with_a_missing_predecessor() {
    let mut report = StartupReport::new(
        "windows",
        "x86_64",
        42,
        StartupMode::RustGateway,
    );
    report.record(StartupMilestone::ProcessStarted, 0).unwrap();

    assert_eq!(
        report.record(StartupMilestone::FrontendBundleLoaded, 9),
        Err(StartupMetricError::MissingPredecessor {
            attempted: StartupMilestone::FrontendBundleLoaded,
            required: StartupMilestone::FrontendRequestStarted,
        }),
    );
}
~~~

Add a recorder test proving BackendSpawned keeps the clock value observed before NativeWindowVisible. Historical v1 read compatibility belongs in the Node parser tests in Step 4; Rust writes only v2.
Also test that requested RustGateway may change exactly once to LegacyFallback while ProcessStarted is the only recorded milestone, and that any later mode change is rejected. LegacyExplicit is selected before recorder creation from RIDE_STARTUP_MODE=legacy.

**Step 2: Run the focused Rust test and verify failure**

~~~powershell
$env:CARGO_TARGET_DIR = 'L:\R-IDE-builds\ride-rust-startup-gateway-target'
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup_metrics gateway_report -- --nocapture
~~~

Expected: FAIL because StartupMode and the gateway milestones do not exist and StartupReport is still v1.

**Step 3: Implement report v2 as a dependency graph**

Add these exact concepts:

~~~rust
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StartupMode {
    RustGateway,
    LegacyExplicit,
    LegacyFallback,
}

impl StartupMode {
    pub const fn predecessors(
        self,
        milestone: StartupMilestone,
    ) -> &'static [StartupMilestone] {
        match self {
            Self::RustGateway => milestone.gateway_predecessors(),
            Self::LegacyExplicit | Self::LegacyFallback => milestone.legacy_predecessors(),
        }
    }
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
            Self::FrontendShellAttached => {
                &[Self::BackendListening, Self::NativeWindowVisible]
            }
            Self::TargetFileOpened => &[Self::FrontendShellAttached],
            Self::PluginsStarted => &[Self::TargetFileOpened],
            Self::PluginsReady => &[Self::PluginsStarted],
            Self::GatewayListening
            | Self::FrontendRequestStarted
            | Self::FrontendBundleLoaded
            | Self::RpcConnected => &[],
        }
    }
}
~~~

Set STARTUP_REPORT_VERSION to 2, serialize startupMode, add gateway_listening, frontend_request_started, frontend_bundle_loaded, and rpc_connected fields, and replace ORDERED/latest/index validation with predecessor presence and timestamp checks. Duplicate events remain idempotent. Delete v2 use of backend_spawned_before_window and backend_listening_before_window; do not synthesize timestamps.

Keep legacy v1 parsing in Node only. New Rust output is always v2 and carries the effective startup mode. Rust-gateway requires the full gateway graph; fresh legacy v2 reports use the reduced mode-specific graph and omit gateway-only fields. Add an is_applicable check so attempts to record gateway-only milestones in legacy mode return NotApplicable instead of silently accepting a root event.
Change StartupMetrics::from_env to receive the requested StartupMode and add select_effective_mode. The only permitted mutation is RustGateway -> LegacyFallback before any event other than ProcessStarted; publish the corrected snapshot immediately.

**Step 4: Write and run failing Node parser/comparator tests**

Add a fixture where backend_listening is 30ms and frontend_bundle_loaded is 40ms even though the JSON key order is frontend first. Assert:

~~~javascript
assert.equal(report.version, 2);
assert.equal(report.startupMode, 'rust-gateway');
assert.equal(report.milestones.backend_listening, 30);
assert.equal(report.milestones.frontend_bundle_loaded, 40);
~~~

Also test:

- missing predecessor is rejected;
- predecessor timestamp later than dependent timestamp is rejected;
- unknown startupMode is rejected;
- optimized comparison rejects legacy-explicit and legacy-fallback;
- the named historical v1 migration fixture remains accepted only as a baseline.

Run:

~~~powershell
node --test app/scripts/test/measure-tauri-startup.test.mjs app/scripts/test/check-tauri-performance.test.mjs
~~~

Expected: FAIL on version/startupMode/exact-key assumptions.

**Step 5: Implement Node v2 validation and run all focused tests**

Define one mode-aware MILESTONE_PREDECESSORS object in each script (or export one shared helper if that does not create a dependency cycle). Validate exact keys and every edge, not object iteration order. Version the outer measurement schema to v3 because its nested report contract changed. New measurement output must carry startupMode per run and reject mixed effective modes; keep read compatibility for named historical v1 migration data and current v2 baseline data.

~~~powershell
$env:CARGO_TARGET_DIR = 'L:\R-IDE-builds\ride-rust-startup-gateway-target'
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup_metrics
node --test app/scripts/test/measure-tauri-startup.test.mjs app/scripts/test/check-tauri-performance.test.mjs
~~~

Expected: PASS.

**Step 6: Commit**

~~~powershell
git add app/applications/tauri/src-tauri/src/startup_metrics.rs app/applications/tauri/src-tauri/tests/startup_metrics.rs app/scripts/measure-tauri-startup.mjs app/scripts/test/measure-tauri-startup.test.mjs app/scripts/check-tauri-performance.mjs app/scripts/test/check-tauri-performance.test.mjs
git commit -m "feat(tauri): record parallel startup milestones"
~~~

### Task 2: Gateway state machine, routing, and authenticated session model

**Files:**

- Create: app/applications/tauri/src-tauri/src/startup_gateway.rs
- Create: app/applications/tauri/src-tauri/tests/startup_gateway.rs
- Modify: app/applications/tauri/src-tauri/src/lib.rs:10-22
- Modify: app/applications/tauri/src-tauri/Cargo.toml
- Modify: app/applications/tauri/src-tauri/Cargo.lock

**Step 1: Write failing pure-state tests**

Cover:

- rust-gateway is the default; RIDE_STARTUP_MODE=legacy selects LegacyExplicit;
- state transitions Starting -> Ready for the same generation;
- stale generation readiness/failure is rejected;
- only one retry may own the next generation at a time;
- shutdown releases readiness waiters;
- route classification chooses Control, Static, or Backend deterministically.

Use an explicit public API in the test:

~~~rust
#[tokio::test]
async fn stale_backend_generation_cannot_replace_the_active_backend() {
    let state = GatewayState::new(GatewayLimits::test_defaults());
    let first = state.begin_backend_start().await.unwrap();
    state.fail_backend(first, "first failed").await.unwrap();
    let second = state.begin_backend_start().await.unwrap();

    assert_eq!(
        state.backend_ready(first, "127.0.0.1:3000".parse().unwrap()).await,
        Err(GatewayError::StaleGeneration(first)),
    );
    state.backend_ready(second, "127.0.0.1:3000".parse().unwrap()).await.unwrap();
    assert_eq!(state.snapshot().await.phase, BackendPhase::Ready);
}

#[test]
fn routes_are_classified_from_the_inventory_not_the_filesystem() {
    let routes = RouteTable::new(["/", "/bundle.js", "/bundle.css"]);
    assert_eq!(routes.classify("/_ride/startup/status"), RouteKind::Control);
    assert_eq!(routes.classify("/bundle.js"), RouteKind::Static);
    assert_eq!(routes.classify("/services/filesystem"), RouteKind::Backend);
    assert_eq!(routes.classify("/socket.io/"), RouteKind::Backend);
}
~~~

**Step 2: Run and verify failure**

~~~powershell
$env:CARGO_TARGET_DIR = 'L:\R-IDE-builds\ride-rust-startup-gateway-target'
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup_gateway state -- --nocapture
~~~

Expected: FAIL because startup_gateway.rs is absent.

**Step 3: Implement the minimum state and routing API**

The module must define:

~~~rust
pub enum BackendPhase { Starting, Ready, Failed, Stopping }
pub struct BackendGeneration(u64);
pub struct GatewayLimits {
    pub backend_wait: Duration,
    pub max_waiters: usize,
    pub shutdown_drain: Duration,
}
pub struct GatewaySnapshot {
    pub generation: BackendGeneration,
    pub phase: BackendPhase,
    pub diagnostic: Option<String>,
}
pub struct GatewayState { /* Arc-backed watch state plus retry serialization */ }
pub enum RouteKind { Bootstrap, Control, Static, Backend }
pub struct RouteTable { /* exact normalized URL paths */ }
~~~

Use tokio::sync::watch for readiness and shutdown publication, an atomic or mutex-guarded monotonically increasing generation, and a Semaphore for bounded backend waiters. Diagnostics exposed to the browser must be bounded and must not contain command lines, cookies, capability values, environment values, or filesystem paths.

Add direct dependencies already present transitively in Cargo.lock:

~~~toml
bytes = "1"
http-body-util = "0.1"
hyper = { version = "1", features = ["client", "http1", "server"] }
hyper-util = { version = "0.1", features = ["client", "client-legacy", "http1", "server", "tokio"] }
tokio-util = { version = "0.7", features = ["io"] }
~~~

Do not add a framework, templating engine, TLS stack, or generalized reverse-proxy abstraction.

**Step 4: Run module tests**

~~~powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup_gateway -- --nocapture
~~~

Expected: PASS.

**Step 5: Commit**

~~~powershell
git add app/applications/tauri/src-tauri/src/startup_gateway.rs app/applications/tauri/src-tauri/tests/startup_gateway.rs app/applications/tauri/src-tauri/src/lib.rs app/applications/tauri/src-tauri/Cargo.toml app/applications/tauri/src-tauri/Cargo.lock
git commit -m "feat(tauri): add startup gateway state machine"
~~~

### Task 3: One-time bootstrap, session cookie, and exact static asset service

**Files:**

- Modify: app/applications/tauri/src-tauri/src/startup_gateway.rs
- Modify: app/applications/tauri/src-tauri/tests/startup_gateway.rs
- Modify: app/applications/tauri/copy-build-tree.js
- Modify: app/scripts/test/tauri-permissions.test.mjs

**Step 1: Write failing HTTP-level tests**

Start the gateway on 127.0.0.1:0 with a temporary frontend root. Test:

1. GET /_ride/bootstrap/<capability> returns 303, one Set-Cookie, Location: /, Cache-Control: no-store.
2. Reusing the same capability returns 404.
3. GET / without the cookie returns 404.
4. GET / with the cookie returns index bytes before backend readiness.
5. HEAD returns the same Content-Length and no body.
6. Encoded traversal, backslash paths, NUL, unknown files, directories, and a symlink escaping the frontend root never reach the filesystem and return 404.
7. Requests with a foreign Host/Origin, forwarded-host headers, or an absolute-form target are rejected.
8. A large static asset is emitted through fixed-size ReaderStream chunks instead of fs::read or body collection.

The response contract is:

~~~text
Set-Cookie: ride_session=<opaque>; Path=/; HttpOnly; SameSite=Strict
Cache-Control: no-store
Location: /
~~~

The cookie is host-only: do not emit Domain. The listener is plain loopback HTTP, so do not claim the Secure or __Host- cookie guarantees. Security comes from the unguessable one-time capability, exact 127.0.0.1 authority checks, host-only cookie, same-origin mutation checks, and loopback binding. Never put the session token into the stable URL.

**Step 2: Run and verify failure**

~~~powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup_gateway -- --nocapture
~~~

Expected: FAIL because no listener/session/static service exists.

**Step 3: Implement listener bootstrap and inventory construction**

Implement:

~~~rust
pub struct StartupGateway {
    public_addr: SocketAddr,
    bootstrap_capability: String,
    state: GatewayState,
    shutdown: watch::Sender<bool>,
}

impl StartupGateway {
    pub async fn bind(
        frontend_root: PathBuf,
        metrics: StartupMetrics,
        limits: GatewayLimits,
    ) -> Result<Self, GatewayError>;

    pub fn bootstrap_url(&self) -> Url;
    pub fn public_authority(&self) -> String;
    pub async fn shutdown(self);
}
~~~

At bind time:

- bind only TcpListener::bind(("127.0.0.1", 0));
- canonicalize the frontend root once;
- walk only regular files and build an immutable URL-path -> canonical-file inventory;
- reject any canonical target outside the canonical root;
- map / to /index.html without exposing directory browsing;
- generate independent bootstrap and session values with UUID v4 randomness;
- record gateway_listening only after the accept loop is ready.

Use fixed MIME mapping for the packaged extensions actually present (html, js, css, json, svg, png, ico, woff, woff2, map when explicitly enabled). index.html and control responses are no-store; assets are no-cache unless their filename is content-hashed.
Open static files asynchronously and stream them with tokio_util::io::ReaderStream; do not copy bundle.js into one in-memory Vec per request.

**Step 4: Add a build-contract test**

In tauri-permissions.test.mjs, verify generated resources cannot include symlinks and that the Tauri resource scope remains browser-frontend plus tauri-frontend. Run:

~~~powershell
node --test app/scripts/test/tauri-permissions.test.mjs
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup_gateway
~~~

Expected: PASS.

**Step 5: Commit**

~~~powershell
git add app/applications/tauri/src-tauri/src/startup_gateway.rs app/applications/tauri/src-tauri/tests/startup_gateway.rs app/applications/tauri/copy-build-tree.js app/scripts/test/tauri-permissions.test.mjs
git commit -m "feat(tauri): serve authenticated startup assets"
~~~

### Task 4: Bounded readiness and streaming HTTP proxy

**Files:**

- Modify: app/applications/tauri/src-tauri/src/startup_gateway.rs
- Modify: app/applications/tauri/src-tauri/tests/startup_gateway.rs

**Step 1: Write failing delayed-backend integration tests**

Use a real loopback fake backend and the real gateway. Prove:

- /bundle.js completes while the fake backend is still blocked;
- a backend request waits for Ready, then preserves method, query, status, body, and repeated non-hop-by-hop headers;
- timeout returns 503 with Retry-After: 1 and a bounded JSON error;
- exceeding max_waiters returns 503 immediately;
- backend failure wakes all waiters;
- a 32 MiB upload/download is streamed and the gateway never calls collect on either body.

Use a slow stream body rather than a prebuilt 32 MiB Vec:

~~~rust
let body = StreamBody::new(stream::iter((0..512).map(|_| {
    Ok::<_, Infallible>(Frame::data(Bytes::from_static(&[7_u8; 65_536])))
})));
~~~

**Step 2: Run and verify failure**

~~~powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup_gateway http_proxy -- --nocapture
~~~

Expected: FAIL because backend routes are not proxied.

**Step 3: Implement the streaming proxy**

Create an internal BackendProxy with:

~~~rust
struct BackendProxy {
    client: Client<HttpConnector, Incoming>,
    state: GatewayState,
    limits: GatewayLimits,
}
~~~

For each backend request:

- authenticate session before acquiring a waiter;
- acquire an owned Semaphore permit;
- wait on the watch receiver until the current generation is Ready, Failed, Stopping, or timed out;
- rebuild the URI with the private backend authority while preserving path/query;
- replace Host with the private authority;
- remove only the ride_session cookie pair before forwarding and preserve unrelated application cookies;
- drop backend Set-Cookie values that attempt to overwrite ride_session while preserving unrelated Set-Cookie headers;
- remove Connection-nominated headers plus connection, proxy-connection, keep-alive, transfer-encoding, te, trailer, upgrade, proxy-authenticate, and proxy-authorization for ordinary HTTP;
- stream Incoming directly to Hyper and return the backend Incoming body directly;
- return bounded 502 for connect/reset errors and bounded 503 for not-ready/failed state.

Do not buffer arbitrary request or response bodies and do not retry non-idempotent requests automatically.

**Step 4: Run the focused integration tests**

~~~powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup_gateway http_proxy -- --nocapture
~~~

Expected: PASS, including the slow-stream test.

**Step 5: Commit**

~~~powershell
git add app/applications/tauri/src-tauri/src/startup_gateway.rs app/applications/tauri/src-tauri/tests/startup_gateway.rs
git commit -m "feat(tauri): proxy backend HTTP through Rust"
~~~

### Task 5: Socket.IO upgrade tunnel and RPC milestone

**Files:**

- Modify: app/applications/tauri/src-tauri/src/startup_gateway.rs
- Modify: app/applications/tauri/src-tauri/tests/startup_gateway.rs
- Modify: app/applications/tauri/src-tauri/Cargo.toml
- Modify: app/applications/tauri/src-tauri/Cargo.lock

**Step 1: Write a failing real-socket upgrade test**

Run a fake backend that accepts a WebSocket upgrade on /socket.io/?EIO=4&transport=websocket, echoes frames, and records Host and Origin. Connect through the public gateway with the session cookie and assert:

- the 101 response succeeds;
- text and binary frames move in both directions;
- public Origin is preserved;
- private Host is sent to the backend;
- closing either side terminates both copy directions;
- rpc_connected is emitted once after the backend 101, never merely on an upgrade attempt.

Add tokio-tungstenite only as a dev dependency if hand-writing the test handshake would obscure the behavior:

~~~toml
[dev-dependencies]
tokio-tungstenite = "0.28"
~~~

**Step 2: Run and verify failure**

~~~powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup_gateway websocket_proxy -- --nocapture
~~~

Expected: FAIL because Upgrade is currently stripped or unsupported.

**Step 3: Implement upgrade-aware proxying**

Detect a valid HTTP/1.1 Upgrade request only for authenticated backend routes. Forward the handshake with Upgrade and Connection restored, require the backend to return 101, then await both hyper::upgrade::on values and run:

~~~rust
let mut public = TokioIo::new(public_upgraded);
let mut private = TokioIo::new(private_upgraded);
let _ = tokio::io::copy_bidirectional(&mut public, &mut private).await;
~~~

Tie the tunnel task to the shutdown watch channel and the active backend generation. Record RpcConnected only after the first authenticated Socket.IO tunnel for that generation receives backend 101.

**Step 4: Run tests**

~~~powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup_gateway -- --nocapture
~~~

Expected: PASS with no leaked listener/tunnel tasks.

**Step 5: Commit**

~~~powershell
git add app/applications/tauri/src-tauri/src/startup_gateway.rs app/applications/tauri/src-tauri/tests/startup_gateway.rs app/applications/tauri/src-tauri/Cargo.toml app/applications/tauri/src-tauri/Cargo.lock
git commit -m "feat(tauri): tunnel Socket.IO through startup gateway"
~~~

### Task 6: Integrate gateway, sidecar, main window, and secondary windows

**Files:**

- Modify: app/applications/tauri/src-tauri/src/lib.rs:18-370
- Modify: app/applications/tauri/src-tauri/src/startup.rs
- Modify: app/applications/tauri/src-tauri/src/sidecar.rs:30, 240-330, 690-790, 1280-1500
- Modify: app/applications/tauri/src-tauri/src/native_chrome.rs:45-105
- Verify unchanged: app/applications/tauri/src-tauri/capabilities/default.json
- Modify: app/applications/tauri/src-tauri/tests/startup_metrics.rs
- Create: app/applications/tauri/src-tauri/tests/startup_gateway_integration.rs
- Modify: app/scripts/test/tauri-permissions.test.mjs

**Step 1: Write failing orchestration tests**

Extract orchestration decisions behind testable functions. Assert this event sequence without requiring a WebView:

~~~rust
#[tokio::test]
async fn gateway_mode_opens_the_window_before_backend_readiness() {
    let events = run_startup_with_fakes(
        StartupMode::RustGateway,
        FakeBackend::ready_after(Duration::from_millis(250)),
    ).await;

    assert!(events.index_of("gateway_listening") < events.index_of("window_created"));
    assert!(events.index_of("window_created") < events.index_of("backend_listening"));
    assert_eq!(events.navigation_count(), 1);
    assert!(events.first_url().contains("/_ride/bootstrap/"));
}
~~~

Also assert:

- gateway startup failure chooses LegacyFallback once;
- RIDE_STARTUP_MODE=legacy chooses LegacyExplicit without attempting a gateway;
- backend readiness publishes the private address to GatewayState and does not navigate;
- THEIA_HOSTS contains only the gateway public authority in gateway mode;
- the runtime Tauri capability names the exact ephemeral gateway URL and never 127.0.0.1:*;
- trusted secondary-window URLs require the runtime gateway authority and /secondary-window.html;
- shutdown orders gateway stop-accepting before process-tree cleanup completion.

**Step 2: Run and verify failure**

~~~powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup_gateway_integration -- --nocapture
~~~

Expected: FAIL because startup is hard-wired to port 3000 and sidecar readiness navigates the main window.

**Step 3: Implement StartupCoordinator**

Introduce a coordinator result:

~~~rust
pub struct StartupLaunch {
    pub mode: StartupMode,
    pub initial_url: tauri::WebviewUrl,
    pub gateway: Option<StartupGateway>,
    pub backend_generation: BackendGeneration,
}
~~~

In lib.rs setup:

1. Resolve explicit mode.
2. Add RuntimePaths.gateway_frontend_directory() without changing the existing backend static-root accessor. Packaged mode resolves resource_dir/lib/frontend; development mode resolves app/applications/tauri/browser-frontend, the output of copy-frontend.js. Bind the gateway to that generated directory and build the one-time bootstrap URL.
3. If bind/inventory startup fails, log a bounded reason, call startup_metrics.select_effective_mode(LegacyFallback), and switch once to LegacyFallback.
4. Reserve backend ownership and spawn sidecar startup without awaiting readiness.
5. Register an exact runtime Tauri capability for the bound gateway URL.
6. Create the main WebView immediately from config with the chosen initial URL and show it as soon as the gateway document can commit.
7. Store the gateway handle in AppState for readiness, retry, secondary-window validation, and shutdown.

Build the dynamic capability with Tauri's CapabilityBuilder and register it before the WebView is created:

~~~rust
let capability = tauri::ipc::CapabilityBuilder::new(format!("ride-gateway-{}", gateway.port()))
    .local(false)
    .remote(gateway.origin())
    .windows(["main", "theia-secondary-*"])
    .permission("core:event:allow-listen")
    .permission("core:event:allow-unlisten")
    .permission("allow-ride-frontend-ready")
    .permission("allow-ride-performance-snapshot")
    .permission("allow-ride-plugin-directories")
    .permission("allow-ride-record-startup-milestone")
    .permission("allow-ride-show-main-menu")
    .permission("allow-ride-smoke-complete")
    .permission("allow-ride-smoke-plan")
    .permission("allow-ride-smoke-record-step")
    .permission("allow-ride-start-window-drag")
    .permission("allow-ride-window-control");
app.add_capability(capability)?;
~~~

gateway.origin() must return only the exact http://127.0.0.1:<bound-port> origin. Keep capabilities/default.json restricted to http://127.0.0.1:3000 for explicit/fallback legacy mode. Never grant http://127.0.0.1:*.

Change sidecar startup to accept a generation/readiness publisher. On successful owned-loopback verification:

~~~rust
publisher.backend_ready(generation, backend_addr).await?;
~~~

In gateway mode, remove navigate_main_window_to_backend and the v1 before-window canonicalization calls. In either legacy mode, preserve current navigation behavior.

Before spawning Node in gateway mode, set THEIA_HOSTS to the exact public gateway authority through the child Command environment. Do not mutate the process-wide environment for this value. Keep Node on the private loopback port for this change.

Record NativeWindowVisible after the immediate show succeeds. Change ride_frontend_ready so it completes frontend intent delivery/focus without being the first operation that shows the window. Ensure the window is shown no later than 800ms even if Theia has not attached; the initial real document must remain the same document.

**Step 4: Run focused and complete Rust tests**

~~~powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup_gateway_integration -- --nocapture
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --lib
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --tests
~~~

Expected: all non-network tests PASS.

**Step 5: Commit**

~~~powershell
git add app/applications/tauri/src-tauri/src/lib.rs app/applications/tauri/src-tauri/src/startup.rs app/applications/tauri/src-tauri/src/sidecar.rs app/applications/tauri/src-tauri/src/native_chrome.rs app/applications/tauri/src-tauri/tests/startup_metrics.rs app/applications/tauri/src-tauri/tests/startup_gateway_integration.rs app/scripts/test/tauri-permissions.test.mjs
git commit -m "feat(tauri): start frontend and backend concurrently"
~~~

### Task 7: Single-document frontend bridge and no-polling recovery UI

**Files:**

- Modify: app/applications/tauri/copy-frontend.js:20-180
- Modify: app/applications/tauri/copy-build-tree.js
- Create: app/scripts/test/tauri-startup-gateway.test.mjs
- Modify: app/theia-extensions/product/src/browser/ride-open-request.ts:30-45 and reportRideStartupMilestone
- Modify: app/theia-extensions/product/test/ride-open-request.test.ts

**Step 1: Write failing generated-frontend tests**

Build a temporary source frontend, run copy-frontend.js against it using exported helpers, and assert:

- generated index.html imports bundle.js exactly once;
- ride-bootstrap.js appears before bundle.js;
- ride-after-bundle.js appears immediately after bundle.js;
- default gateway output contains no 127.0.0.1:3000 URL, setTimeout polling, or location.replace;
- the bridge opens one authenticated EventSource at /_ride/startup/events;
- bundle completion sends exactly one POST for frontend_bundle_loaded;
- failed state renders one role=alert overlay with Retry;
- Retry sends one POST to /_ride/startup/retry and disables until the generation changes;
- ready state removes the overlay without navigation or reload.

Use a fake DOM/fetch/EventSource adapter rather than a timing-sensitive browser sleep.

**Step 2: Run and verify failure**

~~~powershell
node --test app/scripts/test/tauri-startup-gateway.test.mjs
~~~

Expected: FAIL because copy-frontend.js still generates the polling bootstrap document.

**Step 3: Generate the single-entry bridge**

Keep tauri-frontend as the explicit legacy/fallback resource, but make browser-frontend the gateway document. Generate:

~~~javascript
window.__rideStartup = Object.freeze({
  markBundleLoaded() {
    return once('frontend_bundle_loaded', () => fetch('/_ride/startup/milestones', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ milestone: 'frontend_bundle_loaded' }),
    }));
  },
});
~~~

Generate ride-after-bundle.js containing only:

~~~javascript
window.__rideStartup?.markBundleLoaded();
~~~

The bridge must:

- use same-origin credentials;
- use EventSource state transitions instead of polling;
- cap diagnostic text and render it through textContent;
- make Retry idempotent per generation;
- never store session/capability data in localStorage, sessionStorage, DOM, logs, or query parameters;
- never call location.reload, location.replace, or import bundle.js itself.

Keep existing locale bootstrap behavior and CSP. Add connect-src support only for the same origin already allowed.

Extend RideStartupMilestone with rpc_connected only if the Socket.IO tunnel cannot be the authoritative source. Prefer the Rust tunnel milestone and leave existing frontend milestones on Tauri invoke.

**Step 4: Run frontend and product tests**

~~~powershell
node --test app/scripts/test/tauri-startup-gateway.test.mjs app/scripts/test/tauri-frontend-profile.test.mjs app/scripts/test/tauri-permissions.test.mjs
npm --prefix app --workspace theia-extensions/product test
~~~

Expected: PASS; generated HTML has one real application module/script lifecycle.

**Step 5: Commit**

~~~powershell
git add app/applications/tauri/copy-frontend.js app/applications/tauri/copy-build-tree.js app/scripts/test/tauri-startup-gateway.test.mjs app/theia-extensions/product/src/browser/ride-open-request.ts app/theia-extensions/product/test/ride-open-request.test.ts
git commit -m "feat(tauri): load one recoverable frontend document"
~~~

### Task 8: Backend failure, serialized retry, and bounded shutdown

**Files:**

- Modify: app/applications/tauri/src-tauri/src/startup_gateway.rs
- Modify: app/applications/tauri/src-tauri/src/sidecar.rs
- Modify: app/applications/tauri/src-tauri/src/lib.rs
- Modify: app/applications/tauri/src-tauri/tests/startup_gateway.rs
- Modify: app/applications/tauri/src-tauri/tests/startup_gateway_integration.rs

**Step 1: Write failing lifecycle tests**

Test these exact cases:

- backend exits before ready -> Failed, all waiters released, one bounded SSE event;
- two concurrent retry POSTs -> one Accepted and one Conflict;
- retry creates generation N+1 only after generation N process cleanup completes;
- stale N readiness cannot satisfy N+1 requests;
- backend crashes after Ready -> existing streams close, new requests receive 503, UI stays in the same document;
- shutdown stops accepting, cancels waiters, drains for the configured bound, kills the owned Node tree, and releases the public listener;
- deterministic repeated failures remain Failed and do not automatically restart forever.

**Step 2: Run and verify failure**

~~~powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup_gateway -- --nocapture
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --test startup_gateway_integration -- --nocapture
~~~

Expected: FAIL until sidecar ownership and gateway generation are coordinated.

**Step 3: Implement the lifecycle contract**

Control routes:

~~~text
GET  /_ride/startup/status      -> current bounded JSON snapshot
GET  /_ride/startup/events      -> authenticated SSE; initial snapshot plus changes
POST /_ride/startup/milestones  -> allowlisted one-shot browser milestone
POST /_ride/startup/retry       -> 202 owner, 409 concurrent/stale retry
~~~

Require session cookie, exact Host, same-origin Origin for mutating routes, expected method, content-type, and a small Content-Length. Return 405/413/415 without reading an unbounded body. Set no-store and nosniff on control responses.

Have the retry endpoint signal StartupCoordinator through a bounded mpsc channel; it must not spawn the sidecar directly inside an HTTP request task. Reuse current process ownership verification and cleanup before reserving the next generation.

On shutdown, stop accepts first, publish Stopping, cancel waiters/tunnels, wait up to shutdown_drain, invoke existing owned process-tree cleanup, then abort only remaining gateway tasks.

**Step 4: Run all Rust tests**

~~~powershell
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --lib
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --tests
~~~

Expected: PASS except the existing explicitly ignored network test.

**Step 5: Commit**

~~~powershell
git add app/applications/tauri/src-tauri/src/startup_gateway.rs app/applications/tauri/src-tauri/src/sidecar.rs app/applications/tauri/src-tauri/src/lib.rs app/applications/tauri/src-tauri/tests/startup_gateway.rs app/applications/tauri/src-tauri/tests/startup_gateway_integration.rs
git commit -m "feat(tauri): recover startup backend safely"
~~~

### Task 9: Packaged smoke and performance gate for rust-gateway

**Files:**

- Modify: app/applications/tauri/src-tauri/src/smoke.rs
- Modify: app/applications/tauri/src-tauri/tests/smoke.rs
- Modify: app/scripts/tauri-packaged-smoke-contract.mjs
- Modify: app/scripts/test/tauri-packaged-smoke-contract.test.mjs
- Modify: app/scripts/run-tauri-packaged-smoke.mjs
- Modify: app/scripts/test/run-tauri-packaged-smoke.test.mjs
- Modify: app/scripts/measure-tauri-startup.mjs
- Modify: app/scripts/test/measure-tauri-startup.test.mjs
- Modify: app/scripts/check-tauri-performance.mjs
- Modify: app/scripts/test/check-tauri-performance.test.mjs

**Step 1: Write failing smoke contract tests**

Add native smoke observations:

~~~json
{
  "startupMode": "rust-gateway",
  "documentLifecycleCount": 1,
  "gatewayAuthority": "127.0.0.1:<ephemeral>",
  "backendAuthority": "127.0.0.1:3000"
}
~~~

Validate authority format structurally without making ephemeral ports deterministic. The smoke run must fail if:

- mode is not rust-gateway;
- the main window committed more than one top-level document;
- gateway and backend authority are equal;
- startup report lacks all required v2 milestones;
- retry scenario does not advance exactly one backend generation.

Add a bounded backend-failure/retry smoke scenario without weakening existing critical-file, critical-empty, full-file, terminal, search, SCM, plugin, save, or secondary-window checks.

**Step 2: Run and verify failure**

~~~powershell
node --test app/scripts/test/tauri-packaged-smoke-contract.test.mjs app/scripts/test/run-tauri-packaged-smoke.test.mjs app/scripts/test/measure-tauri-startup.test.mjs app/scripts/test/check-tauri-performance.test.mjs
~~~

Expected: FAIL because smoke and performance schemas do not require rust-gateway or a single document.

**Step 3: Implement schema and target enforcement**

The optimized comparator must require:

- exactly five complete same-host runs;
- every candidate run startupMode = rust-gateway;
- median target_file_opened <= 2200ms;
- slowest target_file_opened <= 3000ms;
- median native_window_visible <= 800ms;
- median RSS <= current-main same-host median * 1.03;
- build commit/profile/profile hash/plugin manifest hash compatibility;
- v2 dependency graph validity.

Report frontend/backend overlap as diagnostic:

~~~text
overlap_ms = max(0, min(frontend_bundle_loaded, backend_listening)
                    - max(frontend_request_started, backend_spawned))
~~~

Do not use overlap as the pass/fail metric. Preserve historical migration support and current process-role accounting.

Add explicit CLI options for the approved absolute gates:

~~~text
--policy rust-gateway
--max-startup-median-ms 2200
--max-startup-slowest-ms 3000
--max-window-median-ms 800
--max-memory-regression-percent 3
~~~

When --policy rust-gateway is present, these absolute/user-observable limits replace the legacy minimum-gain defaults embedded in app/package.json. Without that policy, preserve the existing historical gain behavior.

**Step 4: Run all script tests**

~~~powershell
node --test app/scripts/test/*.test.mjs app/scripts/test/*.test.js
~~~

Expected: PASS.

**Step 5: Commit**

~~~powershell
git add app/applications/tauri/src-tauri/src/smoke.rs app/applications/tauri/src-tauri/tests/smoke.rs app/scripts/tauri-packaged-smoke-contract.mjs app/scripts/test/tauri-packaged-smoke-contract.test.mjs app/scripts/run-tauri-packaged-smoke.mjs app/scripts/test/run-tauri-packaged-smoke.test.mjs app/scripts/measure-tauri-startup.mjs app/scripts/test/measure-tauri-startup.test.mjs app/scripts/check-tauri-performance.mjs app/scripts/test/check-tauri-performance.test.mjs
git commit -m "test(tauri): gate Rust gateway startup"
~~~

### Task 10: Packaging, CI, documentation, and final measured verification

**Files:**

- Verify unchanged unless a failing inventory test proves otherwise: app/applications/tauri/src-tauri/tauri.conf.json
- Modify: app/applications/tauri/verify-build.js
- Modify: app/scripts/verify-tauri-profile.mjs
- Modify: app/scripts/test/verify-tauri-profile.test.mjs
- Modify: app/scripts/test/tauri-frontend-profile.test.mjs
- Modify: .github/workflows/ci.yml
- Modify: .github/workflows/tauri.yml
- Modify: docs/desktop-packaged-smoke.md
- Modify: app/applications/tauri/README.md
- Modify: TAURI-BUILD-GUIDE.md
- Modify: TAURI-IMPLEMENTATION-STATUS.md
- Review/update only if necessary: .upstream/owned-paths.txt and .upstream/patches/*.patch

**Step 1: Write failing package/profile checks**

Require the packaged resource inventory to contain:

- browser-frontend/index.html
- browser-frontend/bundle.js
- browser-frontend/bundle.css
- browser-frontend/ride-bootstrap.js
- browser-frontend/ride-after-bundle.js
- tauri-frontend/index.html and bootstrap.js for legacy fallback

Reject duplicate bundle entry, source maps in the critical profile, symlinks, a missing legacy fallback, or a profile that does not declare rust-gateway as the default.

Run:

~~~powershell
node --test app/scripts/test/verify-tauri-profile.test.mjs app/scripts/test/tauri-frontend-profile.test.mjs app/scripts/test/tauri-permissions.test.mjs
~~~

Expected: FAIL until verifier and generated inventory are updated.

**Step 2: Implement package and CI contracts**

- Keep frontendDist pointed at tauri-frontend because Tauri validates a build-time frontend directory; runtime gateway mode overrides the initial WebView URL.
- Package browser-frontend as a resource exactly once.
- Add no command permission beyond the existing audited WebView/native command set unless a new Tauri command was actually introduced. Verify the gateway capability is registered at runtime for the exact bound origin and that no static or dynamic localhost-port wildcard exists.
- Run gateway Rust integration tests on Windows, Linux, macOS x64, and macOS arm64 jobs already represented by the workflows.
- Keep packaged full smoke manual where it is currently manual.
- Make critical packaged smoke assert rust-gateway and one document lifecycle.
- Keep performance comparisons same-host only; CI schema self-check may compare a report with itself at zero gain.

If any changed product/build path is not already covered by applications/tauri/ or the explicit .upstream ownership list, add the narrow path. Regenerate an upstream patch only when the corresponding upstream-replayed file changed; do not edit patches speculatively.

**Step 3: Run formatting, static checks, and complete tests**

~~~powershell
$env:CARGO_TARGET_DIR = 'L:\R-IDE-builds\ride-rust-startup-gateway-target'
cargo fmt --manifest-path app/applications/tauri/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path app/applications/tauri/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --lib
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --tests
node --test app/scripts/test/*.test.mjs app/scripts/test/*.test.js
npm --prefix app run lint
~~~

Expected: PASS. If npm script names differ, read app/package.json and use the declared equivalent; do not skip the check.

**Step 4: Build the exact production package**

Prepare dependencies and generated frontend in this worktree. Keep caches/temp on L: if space is constrained:

~~~powershell
$env:CARGO_TARGET_DIR = 'L:\R-IDE-builds\ride-rust-startup-gateway-target'
$env:TEMP = 'L:\R-IDE-builds\tmp'
$env:TMP = 'L:\R-IDE-builds\tmp'
npm --prefix app ci
npm --prefix app run build:tauri
npm --prefix app --workspace applications/tauri run verify
npm --prefix app run verify:tauri-profile
~~~

Expected: production executable and bundle succeed; profile verifier reports the critical inventory.

Do not substitute the generated directories copied from another commit for final verification. They were acceptable only for the initial unchanged baseline.

**Step 5: Run packaged smoke**

~~~powershell
npm --prefix app run smoke:tauri-packaged -- --bundle-root L:\R-IDE-builds\ride-rust-startup-gateway-target --scenario critical-file --output L:\R-IDE-builds\performance-evidence-2026-08-21\critical-file.json
npm --prefix app run smoke:tauri-packaged -- --bundle-root L:\R-IDE-builds\ride-rust-startup-gateway-target --scenario critical-empty --output L:\R-IDE-builds\performance-evidence-2026-08-21\critical-empty.json
npm --prefix app run smoke:tauri-packaged -- --bundle-root L:\R-IDE-builds\ride-rust-startup-gateway-target --scenario full-file --output L:\R-IDE-builds\performance-evidence-2026-08-21\full-file.json
npm --prefix app run smoke:tauri-packaged -- --bundle-root L:\R-IDE-builds\ride-rust-startup-gateway-target --scenario backend-retry --output L:\R-IDE-builds\performance-evidence-2026-08-21\backend-retry.json
~~~

Expected: PASS with startupMode rust-gateway, documentLifecycleCount 1, target edit/save, terminal/search/SCM/plugin checks, secondary window, and one-generation retry.

**Step 6: Capture five-run startup/RSS evidence**

First capture current main on the same host if no compatible current-main report already exists. Use the clean main workspace without switching this feature worktree:

~~~powershell
Push-Location D:\Project\R-IDE
git status --short
$env:CARGO_TARGET_DIR = 'L:\R-IDE-builds\ride-current-main-target'
npm --prefix app run build:tauri
npm --prefix app run measure:tauri-startup -- --bundle-root L:\R-IDE-builds\ride-current-main-target --runs 5 --idle-ms 30000 --profile-manifest L:\R-IDE-builds\ride-current-main-target\release\bundle\ride-tauri-profile.json --output L:\R-IDE-builds\performance-evidence-2026-08-21\current-main-windows-x64.json
Pop-Location
~~~

Expected: the tracked main workspace is clean before and after, and the evidence records its exact commit/profile hashes. Stop and inspect rather than building if tracked changes are present.

Then return to this feature worktree and measure the candidate:

~~~powershell
npm --prefix app run measure:tauri-startup -- --bundle-root L:\R-IDE-builds\ride-rust-startup-gateway-target --runs 5 --idle-ms 30000 --profile-manifest L:\R-IDE-builds\ride-rust-startup-gateway-target\release\bundle\ride-tauri-profile.json --output L:\R-IDE-builds\performance-evidence-2026-08-21\rust-gateway-windows-x64.json
npm --prefix app run check:tauri-performance -- --baseline L:\R-IDE-builds\performance-evidence-2026-08-21\current-main-windows-x64.json --candidate L:\R-IDE-builds\performance-evidence-2026-08-21\rust-gateway-windows-x64.json --policy rust-gateway --max-startup-median-ms 2200 --max-startup-slowest-ms 3000 --max-window-median-ms 800 --max-memory-regression-percent 3
~~~

Then inspect the candidate summary and explicitly verify:

- median target_file_opened <= 2200ms;
- slowest target_file_opened <= 3000ms;
- median native_window_visible <= 800ms;
- median RSS <= 1.03 times the compatible current-main median;
- all five reports use rust-gateway and report v2;
- no run navigated the main document twice.

If a target misses, use milestone overlap and process-role RSS to find the cause; do not relax the approved target in code or fixtures.

**Step 7: Update documentation**

Document:

- rust-gateway default and RIDE_STARTUP_MODE=legacy escape hatch;
- private Node/public gateway authority split;
- startup failure/retry behavior;
- exact local build, smoke, and performance commands;
- report v2 and same-host comparison requirement;
- current measured results, machine identity hash, commit, and profile hashes without secrets.

**Step 8: Final diff and verification audit**

~~~powershell
git diff --check
git status --short
git diff --stat main...HEAD
git log --oneline main..HEAD
~~~

Use @superpowers:requesting-code-review, address findings with @superpowers:receiving-code-review, then rerun the affected test layer and the final smoke/performance gates.

**Step 9: Commit**

~~~powershell
git add app/applications/tauri/verify-build.js app/scripts/verify-tauri-profile.mjs app/scripts/test/verify-tauri-profile.test.mjs app/scripts/test/tauri-frontend-profile.test.mjs .github/workflows/ci.yml .github/workflows/tauri.yml docs/desktop-packaged-smoke.md app/applications/tauri/README.md TAURI-BUILD-GUIDE.md TAURI-IMPLEMENTATION-STATUS.md
git add .upstream/owned-paths.txt .upstream/patches
git commit -m "docs(tauri): ship Rust startup gateway"
~~~

Before adding .upstream files, omit unchanged paths from git add. The final commit must not include generated frontend directories, target artifacts, performance evidence, logs, session values, or copied baseline resources.

## Definition of done

- The real Theia page is the first and only main-window document in rust-gateway mode.
- Rust static serving overlaps Node startup, and HTTP plus Socket.IO remain same-origin through the gateway.
- Bootstrap/session/control routes are loopback-only, authenticated, bounded, and do not leak credentials.
- Backend failures are visible and retryable without reload; generation ownership prevents stale readiness.
- Shutdown drains/cancels gateway work and cleans the owned backend process tree.
- Report v2 preserves parallel timestamps and validates causality by dependency edges.
- All focused, full Rust, Node, product, packaging, and packaged smoke tests pass.
- Five same-host runs meet the approved startup and RSS targets.
- Four-platform CI validates compilation and the gateway contract.
