# R-IDE Tauri Rust Startup Gateway Design

**Status:** Approved on 2026-08-21

**Base:** `main` at `e013a8c` (`perf(tauri): defer default terminal creation (#6)`)

## Goal

Reduce packaged Tauri time to an editable target file by loading the real Theia frontend once and overlapping frontend evaluation with Node backend startup. Preserve the existing Theia backend, plugin compatibility, native window behavior, and four-platform package contract.

The controlled Windows x64 acceptance targets are:

- Median time to an editable target file: at most **2,200 ms** across five same-host runs.
- Slowest run in that campaign: at most **3,000 ms**.
- Native main window visible: at most **800 ms**.
- Idle whole-process-tree RSS: no more than 3% above the current **1,011,335,168-byte** median.
- The gateway is idle without a busy loop and does not create a new background process.
- Windows x64, Linux x64, macOS x64, and macOS arm64 package jobs remain green.
- Editing, terminal, search, SCM/Git, packaged plugins, secondary windows, and second-instance file forwarding remain functional.

## Measured context

The current exact-build Windows campaign is stored at:

```text
L:\R-IDE-builds\performance-evidence-2026-08-20\startup-metrics-final-windows-x64.json
```

Its median time to an editable target file is 3,107 ms. A representative run records:

| Milestone | Elapsed |
| --- | ---: |
| Native window visible | 771 ms |
| Backend spawned | 771 ms |
| Backend listening | 1,678 ms |
| Frontend shell attached | 2,699 ms |
| Target file opened | 3,101 ms |

The current Tauri frontend is a small bootstrap document. It polls the fixed Node backend URL and replaces the document with the real Theia page only after the backend accepts HTTP connections. Backend readiness therefore precedes all real frontend parsing and initialization.

The backend-listening interval is about 907 ms and the subsequent frontend-shell interval is about 1,021 ms. Running those intervals concurrently makes a roughly 2.2-second target plausible without removing features. The intended change is architectural overlap, not a claim that Rust can eliminate WebView or Node initialization cost.

Current idle role medians are:

| Role | RSS |
| --- | ---: |
| Tauri main | 44,105,728 B |
| Node backend | 155,365,376 B |
| Plugin host | 107,220,992 B |
| WebView renderer | 378,449,920 B |
| WebView GPU | 87,728,128 B |
| WebView utilities | 63,512,576 B |
| Other descendants | 173,842,432 B |

The gateway must remain small enough that startup improvement is not purchased with a material idle-memory regression.

## Chosen architecture

Add an in-process Rust loopback gateway. The gateway starts before the main WebView and serves the packaged real Theia frontend immediately. The existing Node backend starts concurrently on its private loopback endpoint. Requests for backend-owned routes pass through the gateway after backend ownership and readiness have been verified.

The WebView sees one stable HTTP origin for static assets, Socket.IO, file transfer, plugin resources, and secondary-window assets. This preserves Theia's same-origin assumptions and avoids patching every `Endpoint` consumer.

The main window opens a one-time gateway bootstrap URL. The gateway establishes an authenticated process-local session and responds with an HTTP redirect to the final root URL. Redirect handling occurs before a document is initialized, so the real Theia document is still evaluated exactly once.

```text
Rust process starts
  -> resolve packaged paths
  -> bind authenticated loopback gateway
  -> start Node sidecar asynchronously
  -> create main WebView at gateway bootstrap URL

gateway static path
  -> return index, bundle, chunks, CSS, fonts, and static secondary-window assets immediately

gateway backend path
  -> wait within a strict readiness bound
  -> stream HTTP or upgraded connection to the verified Node backend

frontend and Node initialize in parallel
  -> Socket.IO/RPC connects through gateway
  -> restore workspace and open target file
```

## Components

### Startup gateway

Create a Rust `startup_gateway` module with five internal responsibilities:

- `GatewayState`: public loopback authority, session capability, lifecycle state, and shutdown signal.
- `StaticAssetService`: exact packaged-root resolution, MIME selection, caching policy, HEAD/range behavior where required, and traversal/symlink rejection.
- `BackendProxy`: streaming HTTP forwarding, Socket.IO upgrade tunneling, hop-by-hop header filtering, backpressure, and bounded readiness waiting.
- `GatewaySession`: one-time bootstrap capability, session cookie validation, exact-origin checks, and redaction-safe diagnostics.
- `StartupControl`: authenticated status, event stream, retry, and browser milestone endpoints used by the pre-bundle startup bridge.

The module runs on Tauri's existing Tokio runtime and does not start another helper executable.

### Startup coordinator

Extend the existing startup state rather than creating an independent backend lifecycle. The coordinator owns these transitions:

```text
Starting -> Ready -> Stopping
    |          ^
    v          |
  Failed -> Retry
```

Only one backend generation may start at a time. A retry receives a new ownership token and may begin only after cleanup for the previous generation has completed. Stale readiness, exit, and retry events cannot publish a port or replace current state.

### Sidecar integration

Keep the current direct-pipe Node spawn path, process ownership checks, loopback listener ownership verification, bounded startup timeout, and process-tree cleanup. The Node endpoint remains private implementation state. The gateway authority is supplied through `THEIA_HOSTS` so Theia's WebSocket origin validator accepts only the public application origin.

`backend-ready` publication changes from navigating the main window to notifying the gateway readiness channel. Sidecar events publish their actual timestamps into the mode-aware milestone dependency graph.

### Frontend startup bridge

Generate a small, dependency-free module before the main bundle. It:

- lets the gateway record the authenticated frontend request and reports bundle completion to an authenticated gateway endpoint;
- observes backend state through one authenticated event stream without polling;
- displays a native-looking error overlay only after a terminal backend failure;
- offers one retry action that maps to the Rust startup state machine;
- removes its own UI when RPC/frontend readiness is confirmed.

The bridge does not register editor features and is not a second application shell.

## Routing and data flow

The gateway binds an OS-assigned port on `127.0.0.1`. Static resolution uses an inventory rooted at the packaged `lib/frontend` directory:

1. Normalize and percent-decode the request path exactly once.
2. Reject NULs, parent traversal, ambiguous separators, non-regular files, and symlink escapes.
3. Serve a matching static asset with its expected MIME and cache policy.
4. Reserve `/_ride/*` for bounded authenticated startup-control routes.
5. Treat every other valid route as backend-owned and proxy it after readiness.

Static assets never wait for Node. Backend requests wait on a `tokio::sync::watch`-style readiness signal with a strict deadline and waiter bound. A request that cannot safely wait receives `503 Service Unavailable` and `Retry-After`; Socket.IO remains responsible for normal connection retry.

Request and response bodies are streamed. The gateway must not aggregate file upload/download bodies, plugin archives, or WebSocket traffic in memory. Slow clients and backend stalls are bounded by per-phase deadlines and cancellation on shutdown.

Static files, including the main bundle, are also streamed from asynchronous file handles instead of being copied into a new whole-file buffer for each request.

WebSocket and Socket.IO upgrade traffic is tunneled bidirectionally after the backend handshake succeeds. The proxy preserves the public application origin for Theia validation while routing transport to the private backend authority. Hop-by-hop headers and the gateway's own session cookie are not forwarded as ordinary application metadata.

Secondary windows use the same authenticated gateway origin. Trusted-secondary-window validation becomes state-aware and accepts only the current gateway authority and exact packaged secondary-window path.

## Session security

The listener is loopback-only. At startup Rust creates a cryptographically unpredictable process-local capability. The main WebView receives a bootstrap path containing that capability. A valid one-time bootstrap request sets an HttpOnly, SameSite session cookie and redirects to the stable final root URL.

Because the public port is ephemeral, Tauri registers a runtime capability for the exact bound `http://127.0.0.1:<port>` origin before creating the WebView. The static legacy capability remains restricted to port 3000. No localhost-port wildcard is permitted.

The gateway applies the following policy:

- Never persist or log the bootstrap capability or session value.
- Require the current session for static, control, proxy, and upgrade routes after bootstrap.
- Require exact public Origin for control mutations and upgrades; reject a foreign Origin when one is supplied on other requests.
- Permit only the documented method and small body on startup-control routes.
- Strip the gateway session cookie before proxying while preserving unrelated application cookies when required.
- Reject invalid Host, forwarded-host, absolute-form, and ambiguous path inputs.
- Redact public ephemeral ports and session identifiers from persisted performance artifacts unless the schema explicitly stores a non-sensitive normalized fact.

The design does not weaken Node backend origin checks or expose Tauri commands to arbitrary remote origins.

## Failure handling

### Gateway startup failure

If the loopback gateway cannot bind or initialize, the application uses the existing backend-first bootstrap/navigation path. This is an availability fallback, not a valid optimized run. Startup reports record `legacy-fallback` and the performance comparator rejects them for the Rust-gateway target.

### Backend still starting

Static frontend work continues. Backend-owned requests wait only within the configured deadline and global waiter bound. They fail with a retryable 503 rather than accumulating indefinitely. No busy polling is allowed.

### Backend exits before ready or crashes later

The current ownership-aware cleanup runs first. The startup bridge displays a stable diagnostic and retry action without replacing or reloading the document. Retry is serialized through a new backend generation. Repeated deterministic failures remain visible instead of entering an infinite restart loop.

### Gateway or proxy task failure

A failed connection affects only that connection unless listener integrity is lost. Fatal listener failure publishes a gateway error, prevents unsafe backend proxying, and drives the application into an explicit failed state. It must not silently navigate to an unverified endpoint.

### Shutdown

Shutdown stops accepting requests, cancels readiness waiters, closes or drains active proxy streams within a short bound, stops the owned Node process tree, and then releases the listener. The application may force-close remaining streams after the drain deadline.

## Startup measurement contract

Version the campaign schema to v2 and add native/browser milestones:

- `gateway_listening`
- `frontend_request_started`
- `frontend_bundle_loaded`
- `backend_listening`
- `rpc_connected`
- `target_file_opened`

Reports identify the effective startup mode:

- `rust-gateway`
- `legacy-explicit`
- `legacy-fallback`

Schema v2 validates milestone causality as a dependency graph instead of forcing every event into one global order. In `rust-gateway` mode, the frontend and backend branches may therefore finish in either order without rewriting their timestamps:

- `gateway_listening` depends on `process_started`.
- `backend_spawned` depends on `process_started`.
- `native_window_visible` depends on `gateway_listening`.
- `frontend_request_started` depends on `gateway_listening`.
- `frontend_bundle_loaded` depends on `frontend_request_started`.
- `backend_listening` depends on `backend_spawned`.
- `rpc_connected` depends on `backend_listening` and `frontend_request_started`.
- `frontend_shell_attached` depends on `rpc_connected` and `frontend_bundle_loaded`.
- `target_file_opened` depends on `frontend_shell_attached`.
- `plugins_started` depends on `target_file_opened`.
- `plugins_ready` depends on `plugins_started`.

Each one-shot event is accepted only after its declared predecessors and must have a timestamp greater than or equal to every predecessor. Independent events, such as `frontend_bundle_loaded` and `backend_listening`, have no ordering constraint. Fresh `legacy-explicit` and `legacy-fallback` v2 reports use a reduced dependency graph rooted at `process_started` and omit gateway-only milestones; they also preserve actual timestamps. Gateway-mode reports must never publish a delayed surrogate timestamp to make concurrent events appear sequential. The v1 canonicalization remains readable only for historical evidence.

The optimized comparator accepts only `rust-gateway`, exact build/profile identity, five complete runs, and all required milestones. It preserves current same-host/platform/architecture compatibility checks.

In addition to absolute target-file time, diagnostics report frontend/backend overlap. The performance gate remains based on user-observable time and RSS rather than an overlap percentage that could be gamed.

## Testing strategy

### Rust unit tests

- Gateway state transitions, stale generation rejection, single retry, cancellation, and shutdown.
- Session bootstrap, cookie validation, exact Origin, control-route methods, and redaction.
- Path normalization, encoded traversal, separator ambiguity, symlink escape, regular-file checks, MIME, and cache headers.
- Route classification, readiness deadlines, waiter bounds, hop-by-hop header filtering, and retry responses.
- Backend/public authority separation and trusted secondary-window URL policy.

### Rust integration tests

Use a delayed fake backend and real loopback sockets to prove:

- index and bundle responses complete before backend readiness;
- ordinary HTTP bodies stream in both directions;
- Socket.IO-compatible upgrades tunnel bidirectionally;
- upload/download memory remains bounded under slow producers and consumers;
- backend failure releases waiters and retry connects to only the new generation;
- shutdown releases listeners, tasks, streams, and child processes.

### Frontend and build tests

- Generated HTML contains exactly one real application module entry.
- The startup bridge reports one-shot milestones that satisfy the v2 dependency graph.
- Backend failure UI is bounded, accessible, and retryable.
- The real Theia document is initialized once and is not reloaded when backend readiness changes.
- The Tauri critical and explicit full profiles contain the bridge and valid frontend inventory.

### Packaged smoke

Extend packaged smoke to assert `rust-gateway` and one document lifecycle while preserving:

- target-file edit/save;
- empty-window startup;
- terminal sentinel;
- workspace search;
- SCM status;
- packaged plugin command;
- secondary-window extraction;
- second-file forwarding;
- backend failure followed by successful retry.

### Performance and CI

- Build an exact clean Windows x64 artifact and run five same-host campaigns.
- Require median target-file open at or below 2,200 ms and maximum at or below 3,000 ms.
- Require native window visibility at or below 800 ms and RSS no more than 3% above the current median.
- Run gateway protocol/security tests and packaged builds on Windows x64, Linux x64, macOS x64, and macOS arm64.
- Treat hosted performance values as trend evidence, not same-machine absolute proof.

## Rollout

1. Add milestone schema and gateway protocol tests without changing the default startup mode.
2. Implement the authenticated static service and delayed fake-backend integration tests.
3. Add streaming HTTP/Socket.IO proxying and sidecar readiness integration.
4. Add the single-entry frontend bridge and packaged lifecycle assertions.
5. Enable `rust-gateway` explicitly in local packaged smoke and run all four platform jobs.
6. Run the controlled Windows performance campaign.
7. Make `rust-gateway` the Tauri critical default only after all gates pass.
8. Retain an explicit legacy mode and automatic availability fallback, with fallback excluded from optimized performance claims.

## Rejected alternatives

### Tauri custom protocol plus cross-origin Node

Theia derives Socket.IO, upload/download, plugin resource, webview, and other endpoints from the document origin in many packages. Rebinding only the primary WebSocket provider would leave multiple cross-origin paths and create a broad compatibility/security patch surface.

### Optimize only Node startup

Further module deferral and path caching remain useful, but they do not overlap the approximately 907-ms backend-listening interval with the approximately 1,021-ms frontend-shell interval. Expected gains are too small to make the 2.2-second target reliable by themselves.

### Replace the Theia backend with Rust

A full rewrite would break or reimplement Theia service contracts, VS Code plugin hosting, terminals, tasks, search, SCM, and extension assumptions. It is not required to remove the current serialized startup dependency.

### Proxy through a second helper process

A helper would add startup scheduling, process ownership, packaging, memory, and cleanup costs. The gateway belongs in the existing Tauri Rust process and Tokio runtime.

## Non-goals

- Rewriting file search, filesystem watching, Git, terminal, tasks, or plugin hosting in this change.
- Removing Node or the plugin host.
- Changing the frontend feature profile to manufacture startup gains.
- Weakening origin, path, process ownership, or package verification checks.
- Comparing hosted CI performance directly with the controlled Windows baseline.
- Claiming memory reduction from a startup-overlap change; the memory requirement is a regression guard.
