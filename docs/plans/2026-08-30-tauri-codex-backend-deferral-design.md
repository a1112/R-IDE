# Tauri Codex Backend Deferral Design

## Context

The retained lazy Rust process sampler reduces the same-host Windows startup median to 2338 ms, but the absolute startup gate is 2200 ms. The Tauri backend still evaluates the complete `theia-ide-codex-ext` backend graph before the user activates Codex. The Codex CLI itself is intentionally not shipped in the application and remains an external or managed extension behavior.

Theia resolves and caches `BackendApplicationContribution` instances while the backend application is created. Its existing websocket connection also snapshots root `ConnectionHandler` bindings when the connection opens. Loading the original Codex `ContainerModule` later would therefore miss automatic shutdown hooks and would create duplicate Codex routes on a later websocket reconnect.

## Selected Architecture

The Tauri-critical backend replaces only the exact generated-server import of `theia-ide-codex-ext/lib/node/ride-codex-backend-module` with a lightweight proxy module. Full-profile builds continue to load the original module without aliases.

The proxy registers the four existing Codex JSON-RPC paths and one backend lifecycle owner during normal startup. It imports only Theia messaging primitives, the root-container token, and Codex protocol types and paths. The first Codex RPC connection synchronously requires a separately attested `codex-backend-feature.cjs` file. Synchronous activation preserves `RpcConnectionHandler`'s target-factory contract.

The feature creates a child Inversify container whose parent is the Theia root container, installs only Codex service bindings, and returns a structural runtime facade. It does not install connection handlers or backend contributions. The facade owns client attachment and exposes idempotent shutdown. Shutdown stops auth, conversation, turn, and approval services before stopping the App Server host, then unbinds the child container. No CLI resolution, process spawn, filesystem staging, network request, or SDK evaluation occurs merely by loading the lightweight proxy.

Activation is single-shot. A partial activation failure is retained and reported rather than retried against a potentially partially initialized container. Application shutdown remains safe before activation and after activation. The packaged smoke test remains responsible for proving inactive startup, activation, streaming, approvals, interruption, recovery, idle exit, and application-shutdown cleanup.

## Build Graph Contract

Deferred backend descriptors gain an exact `request` field. A descriptor importer is either a canonical package module or a canonical `src-gen/backend/` module. Package importers may only request the canonical relative edge to their implementation; generated importers may only request the implementation's exact bare module name. This keeps the existing ScanOSS alias strict while permitting the generated Theia server edge used by Codex.

The planner resolves generated importers from the application root and package importers from `node_modules`. Aliasing still requires both the exact request and exact physical importer. Attestation verifies that one matching import record resolves to the proxy, the real implementation is absent from the main graph, the feature output contains it, runtime packages match the reviewed inventory, and the feature output is not statically imported by `main.js`.

## Alternatives Rejected

1. Loading the original backend module into the root container on first use was rejected because cached lifecycle contributions would not stop it and reconnects could see duplicate RPC routes.
2. Returning asynchronous per-method proxies was rejected because Theia's connection handler assigns its RPC target synchronously and method buffering would add a second state machine to every protocol.
3. Refactoring every Codex service into a bespoke factory was rejected because a child container reuses the existing tested service construction with a much smaller change surface.

## Verification and Retention

Tests must first fail for generated-importer descriptor validation, exact alias selection, proxy inactivity, single activation, connection wiring, failure retention, and shutdown ordering. The candidate then has to pass extension tests, profile and attestation tests, backend graph analysis, Codex packaged smoke, critical packaged smoke, and fresh Rust/Node verification.

Performance is evaluated against both the retained historical baseline and a same-period paired control. The candidate is retained only if startup improves without violating the 3% whole-process-tree memory limit or Codex activation and cleanup behavior. Formal reports are written to new paths and never overwrite protected reports.
