# Codex Lazy Runtime and App Server Integration Design

## Context

R-IDE already depends on Theia's `@theia/ai-codex` integration and the TypeScript `@openai/codex-sdk`, but the current path is not a complete packaged-runtime contract. The backend dynamically imports the SDK only when a request is sent, then constructs a new client for the request and keeps an in-memory thread map. Cancellation is weak, the map is unbounded and non-persistent, the request API key is not forwarded into the SDK path, and most file-change integration is inactive. The SDK package also carries large platform vendor binaries, while current Tauri artifacts do not contain a reliable matching runtime. A packaged build can therefore appear integrated during development but fail when its accidental Node resolution path is absent.

The existing startup deferral framework uses lightweight adapters and proxies. That pattern is required here because some Theia contribution providers cache early reads: registering the original Codex contribution after startup is not a safe late-activation mechanism. The Tauri performance work already owns process-tree containment, shutdown cleanup, and whole-tree CPU and memory sampling, so Codex process ownership should extend that infrastructure instead of introducing a second sampler or lifecycle tree.

OpenAI documents Codex App Server as the protocol intended for rich clients that need authentication, conversation history, approvals, and streamed agent events, while the SDK remains appropriate for programmatic automation and CI. The selected design follows that split. App Server uses local standard-input/standard-output JSONL; remote WebSocket transport and experimental protocol methods are outside the production contract. See the official [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server) and [Codex SDK documentation](https://learn.chatgpt.com/docs/codex-sdk).

## Goals

- Make Codex completely demand-loaded: before explicit activation there is no SDK evaluation, CLI scan, update request, App Server client, or Codex process.
- Use App Server as the primary interactive R-IDE integration for authentication, model discovery, persistent threads, streaming turns, steering, interruption, approvals, command output, and file-change rendering.
- Retain a hardened TypeScript SDK adapter for compatibility and headless automation without maintaining a second CLI installation or authentication system.
- Treat Codex CLI installation and update as an extension behavior. Do not bundle Codex CLI or SDK vendor executables in the R-IDE installer.
- Support both managed ChatGPT authentication and API-key authentication without copying secrets into R-IDE preferences, logs, telemetry, or process arguments.
- Install an optional managed CLI into a private, versioned user-data directory without administrator privileges or `PATH` changes, and preserve one prior version for rollback.
- Reuse Tauri/Rust process-tree containment and metrics so Codex descendants are owned, measured, and terminated with R-IDE.
- Establish versioned protocol compatibility, deterministic tests, packaged-runtime smoke tests, and measurable startup and memory gates.

## Non-goals

- Replacing every Theia AI contribution or provider with a new framework.
- Removing the existing SDK compatibility path in the first release.
- Transparently moving an active conversation between App Server and the SDK after an error.
- Shipping Codex CLI, platform vendor binaries, or a global package manager inside the R-IDE installer.
- Modifying the user's `PATH`, requiring administrator privileges, or overwriting a user-managed CLI.
- Supporting remote App Server WebSocket transport in production.
- Enabling experimental App Server methods or exposing unsandboxed `thread/shellCommand` and experimental `process/*` operations.
- Persisting API keys in ordinary Theia preferences or inventing an R-IDE authentication token format.
- Adding another operating-system process scan, footer polling loop, or independent process supervisor.

## Considered Approaches

### 1. Thin dual-channel shell with one CLI runtime

Install a lightweight frontend activation proxy, use App Server as the rich-client channel, retain a dynamically imported SDK adapter for compatibility, and resolve both channels through one CLI runtime manager. The Theia backend owns protocol and conversation state; Tauri/Rust owns containment and metrics.

This is the selected approach. It supplies the requested deep interface while preserving compatibility, prevents duplicate CLI and authentication behavior, and fits the repository's existing startup and process-management architecture.

### 2. App Server-only rewrite

Remove the SDK integration and implement every Codex workflow directly on App Server. This has the smallest long-term protocol surface, but it breaks existing automation and migration paths and makes the first release unnecessarily broad.

### 3. SDK-first incremental extension

Keep the SDK as the interactive foundation and add selected App Server calls around it. This is initially smaller, but it duplicates thread ownership, authentication, approvals, cancellation, and CLI lifecycle. It also leaves the packaged SDK vendor problem as a primary runtime dependency.

## Architecture

```text
R-IDE startup
  -> lightweight Codex activation proxy
       -> explicit user activation
            -> Theia backend Codex Host
                 - Runtime Manager
                 - Managed CLI Installer
                 - Auth Broker
                 - App Server Client (stdio JSONL)
                 - Legacy SDK Adapter (dynamic import)
                 - Thread/Event Coordinator
            -> Tauri/Rust process-tree supervision and metrics
```

### Frontend activation proxy

The startup bundle registers stable commands, contribution identities, and a lightweight model representing `inactive`, `activating`, `ready`, and actionable error states. It does not import the existing Codex widget, SDK adapter, protocol implementation, or installer. Opening the Codex panel or invoking a Codex command triggers one idempotent activation promise, dynamically loads the real frontend contribution, and delegates all subsequent calls through the proxy.

The proxy is the permanent dependency-injection identity. This avoids replacing contributions after Theia has cached them. The panel shell renders immediately and can show runtime consent, installation progress, login state, and failures while backend activation proceeds asynchronously.

### Theia backend Codex Host

The backend owns one lazy Codex host per Theia backend process:

- **Runtime Manager:** resolves, validates, activates, and reports the selected CLI.
- **Managed CLI Installer:** downloads only after consent, verifies, stages, smoke-tests, atomically activates, and rolls back versions.
- **Auth Broker:** maps App Server account APIs to UI state and supplies an API key ephemerally when selected.
- **App Server Client:** owns one local App Server process, JSONL framing, request correlation, notifications, server-initiated approval requests, timeouts, and restart policy.
- **Thread/Event Coordinator:** maps persistent App Server threads and streamed items into bounded frontend state.
- **Legacy SDK Adapter:** dynamically imports `@openai/codex-sdk` only for explicit compatibility or headless requests and uses the same resolved CLI and authentication selection.

One App Server process serves multiple threads. The host does not spawn one process per message and does not silently switch an interactive thread to the SDK.

### Tauri/Rust boundary

Theia remains the owner of App Server protocol semantics. Tauri/Rust receives only the lifecycle and classification facts required to place Codex processes inside the existing R-IDE process tree, terminate descendants during shutdown, and attribute CPU, resident memory, and process counts. This keeps protocol churn out of the native shell while preserving reliable Windows Job Object and cross-platform cleanup behavior.

## Runtime Resolution and Installation

CLI resolution uses this precedence:

1. Explicit `RIDE_CODEX_PATH` or supported user override.
2. A compatible system-installed Codex CLI.
3. The extension-managed private CLI.

Resolution begins only after explicit Codex activation. Each candidate is normalized to an absolute executable path and validated for supported platform, architecture, version, and App Server capability. Invalid higher-priority candidates produce an actionable diagnostic; the UI may offer the managed runtime but does not silently disregard an explicit override.

On first managed use, the extension presents the source, target version, installation location, expected download size when known, and rollback policy. Consent precedes network access. Installation follows this state machine:

1. Acquire pinned official release metadata and expected integrity information.
2. Download into a unique staging directory under extension-private user data.
3. Reject unsafe archive paths, links, unexpected executable layout, or platform/architecture mismatch.
4. Verify integrity and run `codex --version` plus a bounded App Server capability smoke test.
5. Atomically switch a small active-version manifest to the staged version.
6. Keep the immediately previous valid version and delete only obsolete extension-owned versions under the verified runtime root.
7. Restore the previous active manifest if activation or the first handshake fails.

The runtime directory is versioned and never appended to `PATH`. The installer never writes to global package-manager directories. R-IDE packaging includes only installer logic and metadata; CI scans artifacts to ensure no Codex executable, SDK vendor binary, or populated managed-runtime directory is present.

## Authentication and Secret Handling

The first release supports two explicit modes:

- **Managed ChatGPT login:** R-IDE delegates browser or device login, account status, logout, and rate-limit information to App Server account APIs. It does not parse or duplicate Codex account files.
- **API key:** the frontend passes the key once over the existing local backend channel; the backend supplies it directly to the selected Codex channel and discards its reference after configuration. The value is excluded from preferences, command lines, logs, protocol traces, metrics, crash reports, and telemetry.

If an existing Theia Codex preference contains a plaintext API key, R-IDE shows a one-time migration prompt. Successful migration removes the old preference. Declining migration leaves the integration inactive rather than copying the key automatically.

Log and error sanitization removes authorization headers, environment values with secret-like names, known key formats, URL query credentials, and user-entered key fragments before any bounded diagnostic buffer reaches the frontend.

## App Server Protocol Contract

The production transport is local stdio with one JSON object per line. The client performs the documented initialize handshake before issuing account, model, or thread requests. It supports only the stable methods needed for the approved first release:

- account status, ChatGPT login/logout, API-key configuration, and rate-limit state;
- model discovery and compatible model selection;
- thread list, read, start, resume, archive where stable, and persisted history;
- turn start, streamed events, steer, interrupt, completion, and structured failure;
- server-initiated command execution and file-change approvals;
- command output, file changes, reasoning/status summaries, usage, and relevant agent events.

For every supported CLI version, CI generates TypeScript definitions and JSON Schema with the CLI's schema-generation commands. The repository records a compatibility matrix between R-IDE and accepted CLI protocol versions. Generated schema changes are reviewed rather than consumed unconditionally, and production initialization does not opt into experimental capabilities.

The client implements incremental line framing so split and coalesced chunks are valid. Request IDs are unique for the process lifetime. Pending requests are bounded, timed out, and rejected when the process exits. Unknown notifications are ignored after bounded, redacted diagnostic logging. Malformed messages fail the affected connection rather than being executed as partially validated data.

Frontend updates are reduced into typed thread state. High-frequency text and command deltas are coalesced per animation frame or a bounded cadence, and retained output has explicit item and byte limits. App Server remains the source of truth for thread persistence; R-IDE stores only UI state such as the selected thread and panel layout.

## SDK Compatibility Channel

The SDK adapter is loaded only when a caller explicitly requests the compatibility or headless path. It must:

- dynamically import the SDK after activation rather than through a static frontend or backend dependency edge;
- use the Runtime Manager's exact CLI path instead of relying on packaged vendor discovery;
- forward the selected ephemeral API key when API-key mode is active;
- reuse bounded clients and thread records instead of constructing an unbounded per-request map;
- propagate abort immediately and release listeners and process references on completion;
- report its channel explicitly in diagnostics and process metrics.

An App Server failure never causes automatic continuation through the SDK because the two channels do not share an authoritative live-turn state. The UI can offer a new compatibility run after explaining the boundary.

## End-to-End Data Flow

1. R-IDE starts with only the Codex activation proxy registered.
2. The user opens the Codex panel or invokes a Codex command.
3. The proxy renders the panel shell and asks the backend host to activate once.
4. The Runtime Manager resolves overrides, compatible system CLI, and private managed versions without performing a network check.
5. If no compatible runtime exists, the UI obtains installation consent before the installer accesses the network.
6. The backend asks Tauri/Rust to supervise the selected child process, starts `codex app-server`, and completes initialization.
7. The Auth Broker reads account state. The user chooses managed ChatGPT login or supplies an ephemeral API key.
8. The frontend requests models and threads only after authentication and initialization are ready.
9. A turn streams typed items through the coordinator. Command and file-change requests pause for explicit approval and resume only with the user's decision.
10. Steering sends an in-turn update; cancellation sends `turn/interrupt` and waits for the terminal interrupted event.
11. Closing or switching the active context cancels pending UI approvals. App Server keeps authoritative thread history.
12. After ten minutes with no active turns, approvals, or foreground Codex UI demand, the host gracefully stops App Server. R-IDE shutdown performs graceful termination and then uses Rust process-tree cleanup as the fallback.

## Errors, Recovery, and Safety

Errors are separated into four layers so the UI does not collapse unrelated failures into “Codex failed”:

- **Runtime and installation:** unsupported platform, incompatible version, download, integrity, extraction, smoke-test, activation, and rollback errors.
- **App Server startup:** spawn, early exit, stdio, initialization, schema, and authentication bootstrap errors.
- **Protocol:** malformed JSONL, invalid schema, unknown response ID, request timeout, unsupported stable method, and server-request validation errors.
- **Turn:** context limit, usage limit, unauthorized, HTTP or stream failure, sandbox denial, interrupted state, and internal agent failure.

App Server stderr is drained continuously into a bounded redacted ring buffer so a full pipe cannot stall the child. An unexpected process exit receives one automatic restart and thread resume attempt when no unsafe approval is pending. A second failure opens a circuit breaker and requires explicit user retry. Startup handshake has a five-second hard timeout.

Cancellation first uses `turn/interrupt`. If the terminal event does not arrive within the bounded shutdown interval, the host restarts App Server and resumes the persisted thread without claiming the interrupted turn completed normally. Pending approvals are rejected on interruption, panel disposal, context switch, backend disconnect, or process exit.

The default sandbox is `workspaceWrite` with approvals enabled. Full access is never inferred from an R-IDE workspace or extension setting. Approval cards include the owning thread and turn, exact command or normalized file scope, working directory, network implications when known, and the available protocol decisions. Session-wide acceptance is offered only when App Server declares that decision valid. R-IDE does not expose unsandboxed shell or experimental process methods in this release.

## Performance Contracts

### Before activation

- No Codex process or child process exists.
- No filesystem search for a Codex CLI occurs.
- No update or authentication network request occurs.
- `@openai/codex-sdk` is not evaluated or imported.
- No App Server protocol client, installer, or process watcher is constructed.
- Only the thin proxy is present in the startup chunk.

The existing general startup gates remain unchanged: startup diagnostics add no more than 10 ms to the same-host native-window median; the applicable packaged gateway profile retains a native-window median of at most 800 ms, startup median of at most 2,200 ms, slowest valid startup of at most 3,000 ms, and whole-tree idle-memory regression of at most 3 percent.

### Activation and streaming

With a compatible CLI already installed, the reference Windows release build targets App Server initialized p95 at or below 1,500 ms, with the five-second handshake timeout as the hard failure boundary. Panel-shell rendering is independent of this target. First-time download and interactive login are recorded separately and excluded from warm activation latency.

Streaming deltas are batched at frame or bounded cadence, queues and retained output are bounded, and a slow frontend cannot produce an unbounded backend buffer. No Codex operation may overlap or accelerate the existing two-second footer process sampling cadence.

### Idle and process metrics

After the ten-minute idle timeout and bounded shutdown interval, no Codex descendants may remain. Memory is compared after an explicit settling window rather than requiring immediate JavaScript garbage collection.

The existing process sampler adds a `Codex Agent` role beneath the R-IDE total. Hover details split safely identifiable App Server, SDK runs, and command descendants. CPU, resident memory, and process count come from the existing sample only; classification must not alter aggregate totals or introduce a new OS scan.

## Testing Strategy

Development follows test-driven development with small commits.

### Unit tests

- Runtime precedence, path normalization, platform/architecture detection, semantic version compatibility, and App Server capability checks.
- Installer consent and update state machine, staging, integrity failure, path traversal rejection, atomic activation, rollback, and verified-root cleanup.
- Secret migration, lifetime, and redaction across logs, errors, environment projections, and frontend diagnostics.
- JSONL split/coalesced input, request correlation, unknown IDs, unknown notifications, malformed messages, bounded queues, timeout, exit, and cancellation.
- Authentication, model, thread, event, approval, usage, and structured-error reducers.
- SDK dynamic import, resolved CLI path and API-key forwarding, immediate abort, bounded cache, and disposal.
- Rust role classification and totals proving that `Codex Agent` grouping does not change aggregate CPU, memory, or process count.

### Integration and contract tests

A deterministic fake App Server exercises initialization, authentication, model and thread reads, streamed turns, command and file approvals, malformed lines, delayed responses, interrupt, unexpected exit, one restart, circuit breaker, and persisted thread resume. Fixtures contain no live account credentials and require no network.

Protocol contract tests generate schema for every supported CLI version, compare it with reviewed fixtures, fail incompatible changes, and assert that production initialization excludes experimental capabilities.

### Packaged smoke and performance tests

The release artifact starts in a network-controlled environment and proves that no Codex process, CLI scan, SDK evaluation, update request, or managed-runtime write occurs before activation. A fixture/private runtime then completes initialization, a streamed thread, both approval types, interruption, crash recovery, process attribution, idle exit, and application-shutdown cleanup.

Windows x64 is the primary real packaged and interactive smoke platform. Windows ARM64, macOS x64/ARM64, and Linux x64/ARM64 receive compile, package-inventory, protocol, and deterministic tests where the existing CI matrix supports them. Release notes distinguish real interactive smoke evidence from compile-only coverage.

Performance campaigns use the same host and release configuration, record median and p95 where applicable, preserve the existing gateway budgets, and compare whole-tree memory after a settling window. First download and login are reported but are not mixed with warm activation results.

## CI and Release Gates

The Codex integration cannot be merged or released until all applicable gates are green:

1. Frontend, backend, Rust, and schema-contract unit tests.
2. Fake App Server integration suite and cancellation/leak checks.
3. Cross-platform compilation and supported packaging jobs.
4. Artifact inventory proving zero bundled Codex executables and SDK vendor binaries.
5. Packaged Windows activation and cleanup smoke test.
6. Startup, activation, idle-memory, and process-total performance comparisons.
7. Redaction and approval-safety tests.
8. Documentation of the supported CLI/protocol matrix, managed-runtime behavior, authentication choices, and rollback instructions.

Build artifacts remain on the existing `L:\R-IDE-builds` task-specific targets to avoid pressure on constrained system volumes. Cleanup is limited to verified task-specific build and extension-runtime directories.

## Delivery Sequence

Deliver the design as independently reviewable slices:

1. Activation proxy and zero-work startup contract.
2. Runtime resolution, consented managed installation, integrity checks, and rollback.
3. App Server JSONL client, generated schema contract, lifecycle, and deterministic fake server.
4. Authentication, models, persistent threads, streaming turns, steer, and interrupt.
5. Approval, command, file-change, error, and bounded-rendering UI.
6. Hardened SDK compatibility adapter using the single CLI runtime.
7. Rust process classification, footer details, idle/shutdown cleanup, packaging assertions, and performance gates.

Each slice starts with a failing focused test, implements only the approved stable behavior, runs the relevant package and Rust checks, and commits before the next slice. No performance claim is made without same-host release evidence, and no implementation weakens the existing Tauri gateway security or process-ownership model.
