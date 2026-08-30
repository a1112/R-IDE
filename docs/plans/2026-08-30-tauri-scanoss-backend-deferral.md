# Tauri ScanOSS Backend Deferral Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the analyzer-proven 1,640,399-byte ScanOSS service-implementation slice from the Tauri initial backend bundle without changing the ScanOSS RPC contract, full-profile behavior, packaged inventory, or release safety gates.

**Architecture:** Keep the upstream `@theia/scanoss` backend module eager, but alias its exact relative service-implementation import to a lightweight proxy only in the `tauri-critical` backend build. The proxy obtains Theia's root container through function-form Inversify metadata, dynamically imports an attested sibling CommonJS feature on first `scanContent`, and resolves the untouched upstream implementation in a child container. Analyzer evidence and build metadata prove the ownership boundary; a five-run packaged A/B campaign decides whether implementation commits are retained or reverted.

**Tech Stack:** Node.js 22+, TypeScript, esbuild, Theia/Inversify, Tauri 2/Rust, Node test runner, PowerShell.

---

## Fixed invariants and baseline

- Work only in `D:\Project\R-IDE\.worktrees\codex-app-server` on `codex/codex-app-server-integration`.
- Keep `app\applications\tauri\src-tauri\target` as a junction to `L:\R-IDE-builds\ride-codex-app-server-tauri-target`.
- Never bundle Codex CLI, Chromium, an unmanaged external `node_modules` tree, API keys, source content, or local absolute paths.
- Keep `@theia/scanoss`, its preferences, `ScanOSSService`, and `/services/scanoss/service` eager and unchanged.
- Alias only the edge from `@theia/scanoss/lib/node/scanoss-backend-module.js` to `./scanoss-service-impl` in `tauri-critical`; the `full` profile and every other importer remain eager.
- Do not use raw TypeScript decorator syntax in backend proxy sources. Register `injectable`, `inject(RootContainer)`, and `preDestroy` through function-form metadata.
- Production backend generation requires a clean Git tree. Commit each GREEN slice before running `build:tauri-backend`.
- Baseline report: `app/applications/tauri/src-tauri/target/windows-startup-optimized.json`, commit `08030e6ebe56e860cd069ff0410682fee4d5e573`.
- Baseline medians: spawn-to-listening `1,341 ms`, target-file `2,795 ms`, native window `861 ms`, RSS `1,014,120,448 bytes`.
- Retain only if all five candidate runs use `rust-gateway`, spawn-to-listening improves by at least `150 ms`, target-file improves by at least `100 ms`, RSS stays within policy, and both formal packaged smoke scenarios pass on their first attempt.

## Task 1: Generalize edge-cut evidence and add ScanOSS ownership

**Files:**

- Modify: `app/scripts/analyze-tauri-backend-initial-bundle.mjs`
- Modify: `app/scripts/test/analyze-tauri-backend-initial-bundle.test.mjs`

**Step 1: Add failing analyzer tests**

Extend the synthetic metafile fixtures to require a reusable edge-cut analysis for:

- the existing browser-automation source/target edge;
- `node_modules/@theia/scanoss/lib/node/scanoss-backend-module.js` to `node_modules/@theia/scanoss/lib/node/scanoss-service-impl.js`;
- a target that is also reachable from another importer, so only truly unreachable inputs count as exclusive;
- an absent exact edge, which reports `present: false`, zero bytes, zero inputs, and no exclusive packages;
- malformed, external, duplicate, cyclic, unsafe-integer, and path-escaping records, preserving all current rejection behavior.

The report contract must expose `evidence.scanoss` with exact logical `source`, `target`, `present`, `exclusiveBytes`, `exclusiveInputCount`, and deterministic per-package ownership. It must preserve `evidence.browserAutomation` byte-for-byte for an unchanged fixture.

Run from `app`:

```powershell
node --test scripts/test/analyze-tauri-backend-initial-bundle.test.mjs
```

Expected: RED because `evidence.scanoss` and the generalized helper do not exist.

**Step 2: Extract one reusable edge-cut helper**

Implement one helper that:

1. validates the exact source and target as normalized logical input paths;
2. verifies that the exact source-to-target edge exists;
3. computes all inputs reachable from `src-gen/backend/main.js` with only that edge removed;
4. reports only inputs no longer reachable after the cut;
5. aggregates bytes by package and package copy using safe-integer addition;
6. returns deterministic, deeply frozen output without absolute paths.

Use it to produce both browser-automation and ScanOSS evidence. Do not special-case package names in the graph traversal.

**Step 3: Prove the production ownership number**

Run:

```powershell
node --test scripts/test/analyze-tauri-backend-initial-bundle.test.mjs
npm run analyze:tauri-backend-bundle
```

Expected on the unchanged restored backend:

- `evidence.scanoss.present` is `true`;
- `exclusiveBytes` is `1,640,399`;
- `exclusiveInputCount` is `318`;
- browser-automation evidence remains `852,417` bytes;
- the report contains no workspace path or command line.

If the production number differs, stop and inspect the exact metafile edge before changing expected evidence.

**Step 4: Commit the evidence slice**

```powershell
git add -- app/scripts/analyze-tauri-backend-initial-bundle.mjs app/scripts/test/analyze-tauri-backend-initial-bundle.test.mjs
git commit -m "build: report ScanOSS backend ownership"
```

This commit is retained even if the implementation experiment later fails.

## Task 2: Add an isolated ScanOSS backend feature build

**Files:**

- Create: `app/applications/browser/tauri-src/backend/esbuild-backend-deferred.mjs`
- Create: `app/applications/browser/tauri-src/backend/scanoss-service-proxy.ts`
- Create: `app/applications/browser/tauri-src/backend/scanoss-service-feature.ts`
- Modify: `app/applications/browser/esbuild.mjs`
- Modify: `app/applications/browser/tauri-profile.json`
- Modify: `app/scripts/tauri-frontend-profile.mjs`
- Modify: `app/scripts/verify-tauri-profile.mjs`
- Modify: `app/scripts/test/tauri-frontend-profile.test.mjs`
- Modify: `app/scripts/test/verify-tauri-profile.test.mjs`

**Step 1: Declare the backend descriptor in a RED profile test**

Add this `tauri-critical` backend descriptor under the ScanOSS-owning feature group:

```json
{
  "package": "@theia/scanoss",
  "module": "@theia/scanoss/lib/node/scanoss-service-impl",
  "proxy": "tauri-src/backend/scanoss-service-proxy.ts",
  "entry": "tauri-src/backend/scanoss-service-feature.ts",
  "output": "lib/backend/scanoss-service-feature.cjs",
  "action": "scanoss"
}
```

The tests must reject duplicate package/module/output/action values, unsafe paths, non-CJS backend outputs, missing proxy/entry files, and any descriptor installed in `full`.

Run:

```powershell
node --test scripts/test/tauri-frontend-profile.test.mjs scripts/test/verify-tauri-profile.test.mjs
```

Expected: RED on the missing backend descriptor/build plan.

**Step 2: Add RED synthetic esbuild boundary tests**

Use a temporary synthetic package graph and actually execute esbuild. Require that:

- only `./scanoss-service-impl` from the exact installed ScanOSS backend module resolves to the proxy;
- an identical relative request from any other importer is untouched;
- a bare request to the implementation is untouched unless it is the descriptor's exact resolved edge;
- `full` builds contain the real eager implementation and create no ScanOSS feature output;
- `tauri-critical` main output excludes the real implementation and every analyzer-proven exclusive input;
- the sibling feature output contains the real implementation plus its complete `scanoss`, gRPC, protobuf, archive, and encoding runtime graph;
- the proxy's variable runtime import does not create a static main-to-feature edge;
- main and feature outputs share one build ID and each receive metadata and output hashes;
- watch and one-shot paths create, rebuild/watch, and dispose every context exactly once;
- loading the emitted CommonJS proxy with Node does not produce decorator syntax errors.

Expected: RED before backend build-plan support exists.

**Step 3: Implement the split build plan**

Create `esbuild-backend-deferred.mjs` as a small backend-specific planner:

- resolve descriptor paths relative to the generated profile application;
- scope the alias by both exact importer and exact request/resolved module;
- apply the alias only to the main `tauri-critical` backend context;
- build the feature entry without recursively applying the alias;
- inherit production Node platform, format, target, loaders, externals, and metadata auditing;
- filter only main-entry orchestration/copy/patch plugins that cannot safely run for a sibling feature;
- retain security and profile-audit plugins for both outputs;
- reject output collisions and any path outside the generated application.

The proxy and feature may initially expose the minimal compilable class/factory shape needed for bundle tests. Do not implement final lifecycle behavior until Task 3 tests are RED.

**Step 4: Extend publication and inventory verification**

Teach profile preparation/publication and verification to treat `lib/backend/scanoss-service-feature.cjs` as a required `backend-scanoss` output for `tauri-critical` only. Verify its output hash, metafile build identity, logical entry point, browser publication, Tauri resource copy, and package inventory.

Run focused tests again and require GREEN:

```powershell
node --test scripts/test/tauri-frontend-profile.test.mjs scripts/test/verify-tauri-profile.test.mjs
```

**Step 5: Commit the build slice before production generation**

```powershell
git add -- app/applications/browser/esbuild.mjs app/applications/browser/tauri-profile.json app/applications/browser/tauri-src/backend app/scripts/tauri-frontend-profile.mjs app/scripts/verify-tauri-profile.mjs app/scripts/test/tauri-frontend-profile.test.mjs app/scripts/test/verify-tauri-profile.test.mjs
git commit -m "perf: split Tauri ScanOSS backend"
git status --short
```

Expected: clean worktree.

**Step 6: Build and prove the production boundary**

From `app`:

```powershell
npm --workspace theia-ide-browser-app run build:tauri-backend
npm run verify:tauri-profile
npm run analyze:tauri-backend-bundle
node scripts/verify-codex-packaging.mjs --root applications/browser/lib
node --check applications/browser/lib/backend/main.js
node --check applications/browser/lib/backend/scanoss-service-feature.cjs
```

Expected:

- backend main has no exact ScanOSS implementation or ScanOSS-exclusive graph;
- the sibling feature is present, hashed, metadata-attested, and self-contained;
- `evidence.scanoss.present` becomes `false` in main after the alias;
- Codex packaging remains `forbidden: []`, `missing: []`;
- both CommonJS outputs parse under the packaged Node runtime.

## Task 3: Implement the retryable, shutdown-safe service proxy

**Files:**

- Modify: `app/applications/browser/tauri-src/backend/scanoss-service-proxy.ts`
- Modify: `app/applications/browser/tauri-src/backend/scanoss-service-feature.ts`
- Modify: `app/theia-extensions/product/test/ride-deferred-feature-loader.test.ts`

**Step 1: Add lifecycle RED tests against compiled code**

Compile and execute the real proxy rather than matching source text. Add tests for:

- constructing the proxy does not import `scanoss`, gRPC, protobuf, or the real implementation;
- function-form `injectable()` and `inject(RootContainer)` metadata let a real Inversify container construct the proxy;
- the first `scanContent(content, apiKey)` creates exactly one child container and one real singleton delegate;
- concurrent first requests share one activation promise and one delegate;
- after activation, the untouched upstream delegate preserves sequential request execution and forwards both arguments exactly;
- a dynamic-import failure returns `{ type: 'error', message: 'ScanOSS runtime is unavailable.' }`, clears the activation promise, and permits a later retry;
- a child-container binding or construction failure has the same fixed result and retry behavior;
- no loader error, stack, source content, API key, environment value, or local path enters the returned result or log output;
- `preDestroy` is function-form, idempotent, blocks new activation, drops an existing delegate, and prevents a late import from constructing or publishing a delegate;
- callers already sharing a failed activation receive the same safe result, while later callers perform one fresh activation.

Run from `app/theia-extensions/product`:

```powershell
node L:\R-IDE-builds\ride-codex-app-server-deps\root-node_modules\rimraf\bin.js test/dist
node L:\R-IDE-builds\ride-codex-app-server-deps\root-node_modules\typescript\bin\tsc -p tsconfig.test.json --pretty false
node --test test/dist/test/ride-deferred-feature-loader.test.js
```

Expected: RED on missing lifecycle behavior.

**Step 2: Implement the proxy state machine**

Use these states without exporting internal errors:

- `delegate`: resolved real `ScanOSSService` after successful activation;
- `activation`: one shared in-flight promise, cleared on failure;
- `disposed`: terminal flag checked before import, before child creation, before construction, and before publication.

Register metadata after the class declaration with function calls. Use a non-literal runtime import request for `./scanoss-service-feature.cjs` so main esbuild cannot fold the feature into `main.js`. Catch only activation/load/construction failures in the proxy; once the real delegate is active, return its unchanged `ScanOSSResult` behavior.

Do not log activation details. Do not call an invented disposal method on the upstream class, which has no disposal contract.

**Step 3: Implement real feature construction**

The feature entry must import the real upstream `ScanOSSServiceImpl` without the main-build alias and export a narrow factory. The factory:

1. accepts the injected root container;
2. creates one child container;
3. binds the real implementation to itself in singleton scope;
4. resolves and returns it as `ScanOSSService`;
5. does not read content, API keys, or environment values before `scanContent` reaches the upstream delegate.

Do not copy or reimplement `SequentialProcessor`, result conversion, API-key selection, Windows result-key fallback, or upstream ScanOSS errors.

**Step 4: Make lifecycle tests GREEN and commit**

```powershell
node L:\R-IDE-builds\ride-codex-app-server-deps\root-node_modules\rimraf\bin.js test/dist
node L:\R-IDE-builds\ride-codex-app-server-deps\root-node_modules\typescript\bin\tsc -p tsconfig.test.json --pretty false
node --test test/dist/test/ride-deferred-feature-loader.test.js
```

Then:

```powershell
git add -- app/applications/browser/tauri-src/backend/scanoss-service-proxy.ts app/applications/browser/tauri-src/backend/scanoss-service-feature.ts app/theia-extensions/product/test/ride-deferred-feature-loader.test.ts
git commit -m "perf: defer ScanOSS runtime until first scan"
git status --short
```

Expected: focused tests GREEN and worktree clean.

## Task 4: Run deterministic gates and independent review

**Files:** Modify only when a test or review exposes a real defect. Keep any implementation fix in a separate commit so it can be included in the A/B revert set.

**Step 1: Run all script tests**

From `app`:

```powershell
node --test scripts/test/*.test.mjs scripts/test/*.test.js
```

Expected: all tests pass with no skip added for ScanOSS.

**Step 2: Run Product and Codex TypeScript suites**

From `app/theia-extensions/product`:

```powershell
node L:\R-IDE-builds\ride-codex-app-server-deps\root-node_modules\rimraf\bin.js test/dist
node L:\R-IDE-builds\ride-codex-app-server-deps\root-node_modules\typescript\bin\tsc -p tsconfig.test.json --pretty false
node --test test/dist/test/*.test.js
```

From `app/theia-extensions/codex`:

```powershell
node L:\R-IDE-builds\ride-codex-app-server-deps\root-node_modules\rimraf\bin.js test/dist
node L:\R-IDE-builds\ride-codex-app-server-deps\root-node_modules\typescript\bin\tsc -p tsconfig.test.json --pretty false
node --test test/dist/test/*.test.js
```

Expected: all Product and Codex tests pass.

**Step 3: Run Rust all-target tests without changing the target junction**

```powershell
$env:CARGO_TARGET_DIR='L:\R-IDE-builds\ride-codex-app-server-tauri-target'
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --locked --all-targets
```

Expected: all Rust unit and integration suites pass; only already-documented ignores remain.

**Step 4: Rebuild and inspect release inputs**

Require a clean tree first, then from `app` run:

```powershell
git status --short
npm --workspace theia-ide-browser-app run build:tauri-backend
npm run verify:tauri-profile
npm run analyze:tauri-backend-bundle
node scripts/verify-codex-packaging.mjs --root applications/browser/lib
node --check applications/browser/lib/backend/main.js
node --check applications/browser/lib/backend/scanoss-service-feature.cjs
```

Inspect the metadata rather than relying on output filename alone. Require the main output to exclude all inputs from the pre-split ScanOSS edge cut and the sibling feature to own the complete real graph.

**Step 5: Request code review and apply only verified findings**

Review these boundaries independently:

- exact alias scope and full-profile fallback;
- emitted CommonJS parseability;
- Inversify root-container injection and child-container resolution;
- activation concurrency, retry, and shutdown race behavior;
- fixed RPC-safe failure result and privacy constraints;
- metadata/output-hash/package inventory coverage.

For each actionable finding, first add a failing test, then fix it and rerun the focused plus affected full suite. Commit review fixes separately:

```powershell
git commit -m "fix: harden deferred ScanOSS lifecycle"
```

Record every implementation-affecting commit SHA as part of the potential revert set.

## Task 5: Build the packaged candidate and run the formal retention gate

**Files:** Generated artifacts only under `app/applications/tauri/src-tauri/target`; do not add them to Git.

**Step 1: Verify the release tree and package production artifacts**

Before packaging:

```powershell
git status --short
Get-Item app/applications/tauri/src-tauri/target | Format-List FullName,LinkType,Target
```

Expected: clean tree; target remains a junction to `L:\R-IDE-builds\ride-codex-app-server-tauri-target`.

From `app`:

```powershell
npm --workspace applications/tauri run build:prod
npm --workspace applications/tauri run verify
npm run verify:tauri-profile
node scripts/verify-codex-packaging.mjs --root applications/tauri/src-tauri/resources/backend
```

Require the release EXE, NSIS installer, and MSI installer. Verify that packaged backend resources contain the attested sibling feature and no Codex CLI payload.

**Step 2: Run each formal smoke scenario once**

```powershell
node scripts/run-tauri-packaged-smoke.mjs --scenario critical-file --executable applications/tauri/src-tauri/target/release/ride-tauri.exe --output applications/tauri/src-tauri/target/scanoss-deferred-critical.json
node scripts/run-tauri-packaged-smoke.mjs --scenario codex --executable applications/tauri/src-tauri/target/release/ride-tauri.exe --output applications/tauri/src-tauri/target/scanoss-deferred-codex.json
```

Expected:

- both pass on their first formal attempt;
- `critical-file` completes seven actions;
- `codex` completes eight actions;
- startup mode is `rust-gateway`;
- cleanup reports zero old backend-tree processes.

Do not contact the real ScanOSS service during smoke.

**Step 3: Run five fresh same-host measurements**

```powershell
node scripts/measure-tauri-startup.mjs --executable applications/tauri/src-tauri/target/release/ride-tauri.exe --runs 5 --idle-ms 30000 --output applications/tauri/src-tauri/target/windows-scanoss-deferred.json
```

Compare medians directly with `windows-startup-optimized.json` and record every raw run. Do not discard outliers, rerun a failed first formal smoke invisibly, shorten idle time, or mix startup modes.

**Step 4: Apply the retention decision exactly**

Retain the implementation only if all are true:

- five of five runs use `rust-gateway`;
- spawn-to-listening median is at most `1,191 ms`;
- target-file median is at most `2,695 ms`;
- RSS satisfies the existing policy;
- both first formal smoke runs passed;
- package/profile/inventory and all deterministic gates remain GREEN.

If any condition fails:

1. preserve and report `windows-scanoss-deferred.json` plus both smoke reports under ignored `target` storage;
2. revert Task 2, Task 3, and implementation-affecting review-fix commits in reverse order with `git revert`;
3. retain the design, implementation plan, and Task 1 analyzer evidence commits;
4. rebuild the restored backend and prove it matches the pre-experiment graph;
5. do not present the failed slice as retained optimization.

If all conditions pass, keep the implementation commits and proceed to the separate Windows process-priority experiment from `2026-08-30-windows-backend-critical-graph.md`.

## Task 6: Final hygiene and handoff

**Step 1: Restore generated source changes only**

Production packaging may rewrite generated Tauri schemas or manifests. Inspect each tracked change and restore only generated files known to be build output. Never discard user-authored or unrelated changes.

**Step 2: Run final evidence checks**

```powershell
git diff --check
git status --short
git log --oneline -8
Get-Item app/applications/tauri/src-tauri/target | Format-List FullName,LinkType,Target
```

Expected: no whitespace errors, clean worktree, target junction intact, and commit history clearly separates retained evidence from the measured implementation.

**Step 3: Report the outcome**

Report:

- retained or reverted status;
- exact implementation/evidence commit SHAs;
- analyzer bytes and input counts before/after;
- deterministic test totals;
- EXE/NSIS/MSI paths and inventory result;
- first formal smoke results;
- all five raw startup runs plus baseline/candidate medians and deltas;
- next optimization only after the retention decision is closed.
