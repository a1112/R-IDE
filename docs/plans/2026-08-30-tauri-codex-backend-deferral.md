# Tauri Codex Backend Deferral Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the inactive Codex backend implementation graph from the Tauri main backend and load it safely on the first Codex RPC connection.

**Architecture:** A strict generated-entry alias replaces the Codex backend module with a lightweight proxy only in `tauri-critical`. The proxy synchronously activates an attested feature bundle in a child container and explicitly owns its shutdown lifecycle.

**Tech Stack:** TypeScript, Node.js, esbuild, Inversify, Theia JSON-RPC, Node test runner, Tauri/Rust performance harness.

---

### Task 1: Extend the Deferred Backend Descriptor Contract

**Files:**
- Modify: `app/scripts/test/tauri-frontend-profile.test.mjs`
- Modify: `app/scripts/tauri-frontend-profile.mjs`
- Modify: `app/scripts/tauri-backend-feature-attestation.mjs`
- Modify: `app/applications/browser/tauri-src/backend/esbuild-backend-deferred.mjs`
- Modify: `app/applications/browser/tauri-profile.json`

**Step 1: Write the failing descriptor tests**

Add `request` to the ScanOSS fixture and add a generated importer fixture with `importer: 'src-gen/backend/server'` and an exact bare request. Assert that traversal, arbitrary requests, relative generated requests, package/request mismatches, and unknown fields are rejected.

**Step 2: Run the focused tests and verify RED**

Run from `app`:

```powershell
node --test --test-name-pattern "deferred backend" scripts/test/tauri-frontend-profile.test.mjs
```

Expected: FAIL because `request` and generated importers are not accepted.

**Step 3: Implement canonical validation**

Add the exact `request` field. Permit only package importers or canonical `src-gen/backend/` importers. Require package importers to use their derived relative implementation request and generated importers to request the exact bare implementation module.

**Step 4: Implement exact physical importer resolution**

Resolve package importers below `node_modules` and generated importers below the application root. Match both request and normalized physical importer in the alias plugin. Update attestation to identify either importer form and verify `descriptor.request`.

**Step 5: Run the focused tests and verify GREEN**

Run the same focused command and expect all selected tests to pass.

**Step 6: Commit**

```powershell
git add app/scripts app/applications/browser/tauri-src/backend/esbuild-backend-deferred.mjs app/applications/browser/tauri-profile.json
git commit -m "build: support generated deferred backend edges"
```

### Task 2: Build the Lazy Codex Backend Runtime

**Files:**
- Create: `app/theia-extensions/codex/src/node/ride-codex-backend-bindings.ts`
- Create: `app/theia-extensions/codex/src/node/ride-codex-deferred-runtime.ts`
- Modify: `app/theia-extensions/codex/src/node/ride-codex-backend-module.ts`
- Create: `app/theia-extensions/codex/test/ride-codex-deferred-runtime.test.ts`
- Modify: `app/theia-extensions/codex/tsconfig.test.json`

**Step 1: Write failing runtime tests**

Test that construction is inactive, the first connection creates one child runtime, subsequent connections reuse it, activation failures are retained, stop-before-activation is a no-op, and activated shutdown stops client-facing services before the host and then disposes the child container.

**Step 2: Run the extension tests and verify RED**

```powershell
npm --workspace theia-ide-codex-ext test
```

Expected: FAIL because the deferred runtime does not exist.

**Step 3: Extract service-only bindings**

Move service construction into a reusable binding function. Keep the original backend module's contribution and connection-handler bindings unchanged for the full profile.

**Step 4: Implement the feature runtime**

Create a child container, load service-only bindings, expose four connection methods, and implement idempotent ordered shutdown with complete error aggregation and child-container cleanup.

**Step 5: Run the extension tests and verify GREEN**

Run the extension test command and expect all tests to pass without a fake App Server process leak.

**Step 6: Commit**

```powershell
git add app/theia-extensions/codex
git commit -m "refactor: isolate Codex backend service runtime"
```

### Task 3: Add the Tauri Codex Proxy and Feature Bundle

**Files:**
- Create: `app/applications/browser/tauri-src/backend/codex-backend-proxy.ts`
- Create: `app/applications/browser/tauri-src/backend/codex-backend-feature.ts`
- Modify: `app/scripts/test/tauri-frontend-profile.test.mjs`
- Modify: `app/applications/browser/tauri-profile.json`

**Step 1: Write failing real-esbuild tests**

Build a fixture generated server. Assert that main contains the proxy and protocol but not the real Codex backend marker; the feature contains the real implementation; unrelated importers and requests remain unaliased; requiring main does not evaluate the feature; first Codex connection evaluates it once; and shutdown is idempotent.

**Step 2: Run the focused tests and verify RED**

```powershell
node --test --test-name-pattern "Codex backend|generated deferred backend" scripts/test/tauri-frontend-profile.test.mjs
```

Expected: FAIL because the proxy, feature entry, and profile descriptor are absent.

**Step 3: Implement the proxy and feature entry**

Register four JSON-RPC handlers and one `BackendApplicationContribution`. Load `codex-backend-feature.cjs` through a non-static synchronous request on first connection. Delegate client wiring and shutdown to the feature runtime.

**Step 4: Build once and record graph inventory**

```powershell
npm --workspace theia-ide-codex-ext run build
npm --workspace theia-ide-browser-app run build:tauri-backend
npm run analyze:tauri-backend-bundle
```

Set the reviewed `runtimePackages` and `exclusiveInputCount` from the generated metadata, then rerun the build and attestation tests.

**Step 5: Verify GREEN and commit**

Run the focused tests, extension tests, profile verification, and backend build. Commit only after all are green.

### Task 4: Product and Performance Retention Gates

**Files:**
- Create new diagnostic and performance reports below `app/applications/tauri/src-tauri/target/`; never overwrite protected reports.

**Step 1: Rebuild the release executable**

```powershell
$env:CARGO_TARGET_DIR = 'L:\R-IDE-builds\ride-codex-app-server-tauri-target'
cargo build --release --manifest-path applications/tauri/src-tauri/Cargo.toml
```

**Step 2: Run critical and Codex packaged smoke**

Use new report paths. Require inactive checks, activation, streaming, approvals, interruption, recovery, idle exit, process cleanup, and second-file forwarding.

**Step 3: Measure candidate and paired control**

Collect at least three stable candidate runs and a same-period exact-source control. Compare startup median/slowest, native-window median, and whole-tree RSS. Reject and exactly revert the candidate if it fails behavior or memory retention gates.

**Step 4: Run fresh formal verification**

```powershell
git diff --check
node --test scripts/test/*.test.mjs
npm --workspace theia-ide-codex-ext test
npm --workspace theia-ide-product-ext test
npm run build:extensions
npm --workspace theia-ide-browser-app run build:tauri-backend
cargo test --manifest-path applications/tauri/src-tauri/Cargo.toml --locked --all-targets
git status --short --branch
```

Expected: all deterministic gates pass, no owned process remains, startup meets the approved absolute gates, and RSS regression is at most 3%.

**Step 5: Push and observe CI only after the gates pass**

Push the existing feature branch under the user's standing authorization, then monitor CI and release validation. Do not claim completion from historical or partial evidence.
