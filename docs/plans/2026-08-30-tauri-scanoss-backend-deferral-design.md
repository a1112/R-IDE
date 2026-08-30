# Tauri ScanOSS Backend Deferral Design

**Status:** Approved on 2026-08-30

## Context

The first backend experiment isolated browser automation from the Tauri initial bundle. It removed about 0.88 MB from `main.js`, but its first formal five-run campaign regressed backend spawn-to-listening by 22 ms and target-file opening by 90 ms. That implementation was therefore reverted in full. The analyzer and corrected ownership evidence remain.

The restored Tauri backend is 16,425,994 bytes. Removing only the generated-server edge to `@theia/scanoss/lib/node/scanoss-backend-module.js` makes 1,641,883 bytes across 322 inputs unreachable. The largest exclusive owners are:

- `iconv-lite`: 492,294 bytes;
- `@grpc/grpc-js`: 272,368 bytes;
- `tr46`: 264,988 bytes;
- `scanoss`: 133,954 bytes;
- `protobufjs`: 108,271 bytes.

This is a larger and more coherent optional runtime slice than browser automation. ScanOSS is used only when a user explicitly requests source scanning, while its preference schema and RPC route must remain available from application startup.

## Goals

- Keep the public ScanOSS preference schema, RPC path, service symbol, result types, and on-demand scanning behavior unchanged.
- Keep the upstream `@theia/scanoss` backend module in the initial graph while replacing only its heavy service implementation.
- Move the complete upstream ScanOSS implementation and SDK graph into one attested sibling CommonJS feature file.
- Load and construct the real upstream implementation only on the first `scanContent` request.
- Share concurrent activation, preserve sequential upstream scanning after activation, allow retry after activation failure, and prevent shutdown-time resurrection.
- Prove bundle ownership and retain the slice only if its first formal packaged A/B campaign meets the existing startup and memory policy.

## Non-goals

- Do not remove or disable ScanOSS in the Tauri critical profile.
- Do not rewrite the ScanOSS scanner, result mapping, API-key selection, or upstream error handling.
- Do not combine this experiment with the rejected browser-automation split.
- Do not add the Windows process-priority experiment until this slice has independently passed its retention gate.
- Do not contact the real ScanOSS network service during deterministic tests or packaged smoke.

## Considered approaches

### 1. Service proxy plus sibling feature bundle — selected

Alias only `./scanoss-service-impl` when it is imported by the exact upstream ScanOSS backend module. The alias exports a lightweight class with the same `ScanOSSServiceImpl` name and `scanContent` surface. The first request dynamically imports an attested sibling CJS feature, which creates the real upstream implementation through a child of Theia's root container.

This preserves the upstream module's preference, service, and connection-handler bindings while removing the heavy SDK graph from initial evaluation.

### 2. Reimplement the upstream service with a lazy SDK import

This would avoid constructing the upstream class but would duplicate its sequential queue, API-key selection, Windows result-key workaround, user-facing error mapping, and match-result conversion. That duplicated behavior would drift when Theia or `scanoss` changes, so it is rejected.

### 3. Remove ScanOSS from the Tauri critical profile

This has the simplest startup graph but removes an existing desktop capability and breaks the AI ScanOSS frontend. It is rejected.

## Architecture

### Exact import substitution

The Tauri profile gains one deferred backend descriptor for:

- package: `@theia/scanoss`;
- module: `@theia/scanoss/lib/node/scanoss-service-impl`;
- proxy: `tauri-src/backend/scanoss-service-proxy.ts`;
- feature entry: `tauri-src/backend/scanoss-service-feature.ts`;
- output: `lib/backend/scanoss-service-feature.cjs`;
- action: `scanoss`.

The backend alias plugin resolves the relative `./scanoss-service-impl` request only when the importer is the exact installed `@theia/scanoss/lib/node/scanoss-backend-module.js`. Every other importer and the full profile remain unaliased.

The feature build inherits the production Node bundle options but excludes main-only copy, patch, and Theia orchestration plugins. Metadata audit plugins remain active. The main build and feature build are published under one build identity.

### Proxy lifecycle

The proxy exports `ScanOSSServiceImpl` so the unchanged upstream backend module retains its binding shape. It uses function-form Inversify metadata registration rather than decorator syntax, because the generated Node esbuild configuration preserves unsupported decorator syntax when no target transform is configured.

The root container is obtained through Theia's `RootContainer` binding. On the first `scanContent` request:

1. create or join one in-flight activation promise;
2. dynamically import `./scanoss-service-feature.cjs` through a non-statically bundled request;
3. create one child container from the real root container;
4. bind and resolve the real upstream `ScanOSSServiceImpl` in singleton scope;
5. publish the delegate and call its unchanged `scanContent` implementation.

Successful activation is cached. Load or construction failure clears the activation cache so the next request can retry. Every caller sharing one failed activation receives the fixed `ScanOSS runtime is unavailable.` error result; no stack, local path, API key, environment value, or raw loader error crosses the RPC boundary.

The proxy registers a function-form `preDestroy` hook. Disposal is idempotent, blocks new work, drops a resolved delegate, and prevents a late feature load from constructing or publishing a delegate. The upstream implementation has no disposal contract, so no invented shutdown method is called.

### Analyzer evidence

The backend analyzer will use one reusable edge-cut helper and publish a `scanoss` evidence record alongside `browserAutomation`. The ScanOSS record identifies the exact backend-module-to-service edge and reports presence, exclusive input count, exclusive bytes, and exclusive packages. This evidence remains even if the implementation experiment is later reverted.

After the split, the verifier must prove:

- the exact upstream ScanOSS implementation and its exclusive graph are absent from `lib/backend/main.js`;
- the feature output is metadata-attested and contains the real implementation and SDK graph;
- the feature output is included in browser and packaged Tauri inventories;
- the full profile still contains the unchanged eager implementation.

## Error and privacy behavior

- Activation failures become the fixed ScanOSS error result and remain retryable.
- Errors produced after the real delegate is active retain the upstream ScanOSS behavior and result mapping.
- The proxy never logs content, API keys, local paths, dynamic-import failures, or scanner diagnostics.
- Build metadata and analyzer reports continue to use logical paths only.

## Verification and retention

Deterministic tests will execute compiled proxy code and an actual synthetic esbuild main/feature pair. They must prove cold construction, one shared activation, sequential real delegation, retry, root-container child construction, function-form Inversify metadata, shutdown without resurrection, safe failure results, exact alias scope, full-profile behavior, metadata attestation, and packaged inventory.

The release gate then runs all script, Product, Codex, and Rust tests; builds production EXE, NSIS, and MSI artifacts; verifies both browser and packaged inventories; and runs the `critical-file` and `codex` packaged smoke scenarios once formally.

The five-run baseline remains `windows-startup-optimized.json` from commit `08030e6ebe56e860cd069ff0410682fee4d5e573`:

- backend spawn-to-listening median: 1,341 ms;
- target-file median: 2,795 ms;
- native-window median: 861 ms;
- RSS median: 1,014,120,448 bytes.

Retain the ScanOSS implementation only when all five runs use `rust-gateway`, backend spawn-to-listening improves by at least 150 ms, target-file opening improves by at least 100 ms, RSS remains within the existing policy, and both packaged smoke scenarios pass on their first formal attempt. If any condition fails, revert only the ScanOSS build/proxy implementation commits and retain the analyzer evidence and design record.
