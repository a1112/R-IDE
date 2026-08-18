# Tauri Packaged Smoke Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Windows packaged R-IDE smoke test that exercises real application capabilities, second-instance file forwarding, and owned-process cleanup while preserving four-platform static package validation.

**Architecture:** A Node runner launches the real packaged executable and owns temporary files, logs, timeouts, and process cleanup. An opt-in, versioned Rust protocol validates the smoke plan and persists ordered results; a Theia frontend contribution executes only fixed semantic actions through production services. The protocol remains inert in ordinary launches and does not accept arbitrary scripts or executable paths.

**Tech Stack:** Node.js 22/24 built-in test runner, TypeScript 5.9, Eclipse Theia 1.73, Tauri 2/Rust, GitHub Actions.

---

## Working agreement

Execute from:

```text
C:\Users\10428\.config\superpowers\worktrees\R-IDE\tauri-packaged-smoke
```

Use strict red-green-refactor cycles. Do not add a production API before its test has failed for the expected missing behavior. Keep generated `lib`, `test/dist`, `src-gen`, Tauri schema, packaged resources, logs, and smoke workspaces out of commits.

The first interactive CI target is Windows. macOS x64, macOS arm64, and Linux validate the same contract and package inventory but do not claim interactive coverage.

## Task 1: Define the canonical smoke contract

**Files:**

- Create: `app/scripts/tauri-packaged-smoke-contract.mjs`
- Create: `app/scripts/test/tauri-packaged-smoke-contract.test.mjs`

**Step 1: Write failing spec parser tests**

Cover the three exact scenarios, strict keys, relative workspace paths, fixed action ordering, unique action names, 64-character token digest, safe timeout values, and rejection of absolute/traversal paths.

The wished-for API is:

```js
const spec = validateSmokeSpec({
  schema: 'ride.tauri-packaged-smoke-spec',
  version: 1,
  scenario: 'critical-file',
  profile: 'tauri-critical',
  workspace: '.',
  files: ['startup.R', 'forwarded.R'],
  actions: [
    'editor-save',
    'terminal-sentinel',
    'workspace-search',
    'scm-status',
    'packaged-plugin-command',
    'secondary-window',
    'second-file-forwarding'
  ],
  tokenSha256: 'a'.repeat(64),
  actionTimeoutMs: 30_000
});
assert.equal(spec.scenario, 'critical-file');
```

**Step 2: Run the contract test and observe RED**

```powershell
Set-Location app
node --test scripts/test/tauri-packaged-smoke-contract.test.mjs
```

Expected: FAIL because the contract module does not exist.

**Step 3: Implement the minimum strict spec validator**

Export immutable constants for schemas, scenarios, and ordered actions plus `validateSmokeSpec(value)`. Return a normalized copy. Reject unknown keys and values rather than coercing them.

**Step 4: Write failing report validator tests**

Require ordered `started`, `passed`, or `failed` step transitions, safe monotonic durations, one terminal completion state, matching spec digest/profile/scenario, bounded diagnostic codes/messages, and no absolute paths, environment data, command lines, or unknown fields.

```js
const report = validateSmokeReport(candidate, {
  specSha256: 'b'.repeat(64),
  scenario: 'critical-file',
  profile: 'tauri-critical'
});
assert.equal(report.status, 'passed');
```

**Step 5: Run RED, implement report validation, then run GREEN**

```powershell
node --test scripts/test/tauri-packaged-smoke-contract.test.mjs
```

Expected after implementation: all contract tests pass.

**Step 6: Commit**

```powershell
git add app/scripts/tauri-packaged-smoke-contract.mjs app/scripts/test/tauri-packaged-smoke-contract.test.mjs
git diff --cached --check
git commit -m "test: define packaged Tauri smoke contract"
```

## Task 2: Add the disabled-by-default Rust protocol

**Files:**

- Create: `app/applications/tauri/src-tauri/src/smoke.rs`
- Create: `app/applications/tauri/src-tauri/tests/smoke.rs`
- Modify: `app/applications/tauri/src-tauri/src/lib.rs`

**Step 1: Write failing opt-in and path tests**

Test a pure constructor that receives an explicit environment map and current working directory. Require all of:

```text
RIDE_TAURI_SMOKE_SPEC
RIDE_TAURI_SMOKE_REPORT
RIDE_TAURI_SMOKE_TOKEN
```

Assert that no variables means `Disabled`, a partial contract is rejected, symlinks and non-owned paths are rejected, files are size bounded, and the SHA-256 token digest must match the spec.

**Step 2: Run the Rust test and observe RED**

```powershell
Set-Location app
node scripts/run-tauri-tests.js --test smoke
```

Expected: FAIL because `ride_tauri::smoke` does not exist.

**Step 3: Implement the minimum state machine**

Add `SmokeProtocol::{disabled, from_environment, plan, record_step, complete}`. Keep the protocol data-only and expose typed serializable request/response structures. Persist with create-new temporary files plus rename in the report directory; enforce a small maximum file size and canonical step ordering.

**Step 4: Write failing command-boundary tests**

Test token mismatch, updates while disabled, duplicate/out-of-order steps, completion after failure, bounded diagnostics, atomic replacement, and concurrent update serialization.

**Step 5: Register only the typed commands**

Add the protocol to `AppState` and register:

```rust
smoke::ride_smoke_plan,
smoke::ride_smoke_record_step,
smoke::ride_smoke_complete,
```

Commands return a disabled response during ordinary launches and never reveal host environment values or unrestricted paths.

**Step 6: Run GREEN and regression tests**

```powershell
node scripts/run-tauri-tests.js --test smoke
node scripts/run-tauri-tests.js --test launch_intent
```

Expected: smoke and launch-intent Rust tests pass.

**Step 7: Commit**

```powershell
git add app/applications/tauri/src-tauri/src/smoke.rs app/applications/tauri/src-tauri/tests/smoke.rs app/applications/tauri/src-tauri/src/lib.rs
git diff --cached --check
git commit -m "feat: add opt-in Tauri smoke protocol"
```

## Task 3: Add the frontend action sequencer

**Files:**

- Create: `app/theia-extensions/product/src/browser/ride-packaged-smoke.ts`
- Create: `app/theia-extensions/product/src/browser/ride-packaged-smoke-bindings.ts`
- Create: `app/theia-extensions/product/test/ride-packaged-smoke.test.ts`
- Create: `app/theia-extensions/product/test/ride-packaged-smoke-bindings.test.ts`
- Modify: `app/theia-extensions/product/src/browser/theia-ide-frontend-module.ts`

**Step 1: Write failing sequencing tests**

Define an injected adapter boundary:

```ts
export interface RidePackagedSmokeActions {
    editorSave(plan: RideSmokePlan): Promise<void>;
    terminalSentinel(plan: RideSmokePlan): Promise<void>;
    workspaceSearch(plan: RideSmokePlan): Promise<void>;
    scmStatus(plan: RideSmokePlan): Promise<void>;
    packagedPluginCommand(plan: RideSmokePlan): Promise<void>;
    secondaryWindow(plan: RideSmokePlan): Promise<void>;
    waitForSecondFile(plan: RideSmokePlan): Promise<void>;
}
```

Assert that the contribution waits for `attached_shell`, does nothing when the protocol is disabled, executes exact plan order, records start/pass transitions, fails fast, reports one bounded failure, and never completes as passed after an action failure.

**Step 2: Run RED**

```powershell
Set-Location app
npm --workspace theia-extensions/product test -- --test-name-pattern="packaged smoke"
```

Expected: FAIL because the contribution and bindings do not exist.

**Step 3: Implement the minimum contribution and IPC adapter**

Use `@tauri-apps/api/core` `isTauri()` and `invoke()` behind an injected protocol interface. Do not resolve action services until the protocol returns an enabled plan. Bind the contribution as a singleton `FrontendApplicationContribution`.

**Step 4: Run GREEN and existing startup tests**

```powershell
npm --workspace theia-extensions/product test
```

Expected: all product-extension tests pass.

**Step 5: Commit**

```powershell
git add app/theia-extensions/product/src/browser/ride-packaged-smoke.ts app/theia-extensions/product/src/browser/ride-packaged-smoke-bindings.ts app/theia-extensions/product/src/browser/theia-ide-frontend-module.ts app/theia-extensions/product/test/ride-packaged-smoke.test.ts app/theia-extensions/product/test/ride-packaged-smoke-bindings.test.ts
git diff --cached --check
git commit -m "feat: sequence packaged smoke actions"
```

## Task 4: Implement real editor, terminal, search, and SCM adapters

**Files:**

- Create: `app/theia-extensions/product/src/browser/ride-packaged-smoke-actions.ts`
- Create: `app/theia-extensions/product/test/ride-packaged-smoke-actions.test.ts`
- Modify: `app/theia-extensions/product/src/browser/ride-packaged-smoke-bindings.ts`
- Modify: `app/theia-extensions/product/package.json`

**Step 1: Write one failing test per production action**

Use real Theia service-shaped fakes rather than testing mock call counts alone:

- `editor-save` finds the active URI inside the validated workspace, appends the fixed marker through the editor document, invokes save, and rereads the file resource.
- `terminal-sentinel` creates a production terminal and sends only the platform-selected fixed command that creates `.ride-smoke-terminal-ok`.
- `workspace-search` invokes the production search service for a fixed marker and requires a result URI inside the workspace.
- `scm-status` opens the SCM path and requires the temporary Git repository to expose the expected changed resource.

Test path escape, missing widget/service, timeout, wrong result URI, and disposed contribution failures.

**Step 2: Run RED**

```powershell
npm --workspace theia-extensions/product test -- --test-name-pattern="smoke action"
```

**Step 3: Implement the minimum service adapter**

Add explicit Theia package dependencies for every directly imported service. Keep the terminal command constant in code; the spec must not provide command text.

**Step 4: Run GREEN and TypeScript build**

```powershell
npm --workspace theia-extensions/product test
npm --workspace theia-extensions/product run build
```

Expected: tests and TypeScript build pass.

**Step 5: Commit**

```powershell
git add app/theia-extensions/product/src/browser/ride-packaged-smoke-actions.ts app/theia-extensions/product/src/browser/ride-packaged-smoke-bindings.ts app/theia-extensions/product/test/ride-packaged-smoke-actions.test.ts app/theia-extensions/product/package.json app/yarn.lock
git diff --cached --check
git commit -m "test: exercise packaged core workbench actions"
```

## Task 5: Cover packaged plugins, deferred secondary windows, and forwarding

**Files:**

- Modify: `app/theia-extensions/product/src/browser/ride-packaged-smoke-actions.ts`
- Modify: `app/theia-extensions/product/src/browser/ride-packaged-smoke.ts`
- Modify: `app/theia-extensions/product/test/ride-packaged-smoke-actions.test.ts`
- Modify: `app/theia-extensions/product/test/ride-packaged-smoke.test.ts`
- Modify: `app/theia-extensions/product/src/browser/ride-open-request.ts`
- Modify: `app/theia-extensions/product/test/ride-open-request.test.ts`

**Step 1: Write failing plugin and deferred-command tests**

Select one plugin command from the canonical packaged plugin inventory at build time. Require command registration after plugin readiness and successful execution. Execute `extract-widget` with an eligible production widget and verify the deferred proxy has been replaced by the real handler before reporting success.

**Step 2: Write a failing second-file observation test**

Expose a read-only open-request event from `RideOpenRequestContribution` after a request has been validated, opened, and activated. Assert the smoke contribution accepts only the expected second relative file, from `singleInstance`, after the first file action sequence.

**Step 3: Run RED**

```powershell
npm --workspace theia-extensions/product test
```

Expected: new plugin/deferred/forwarding assertions fail for missing behavior.

**Step 4: Implement minimum production behavior**

Do not add test-only command registrations. Use the existing hosted-plugin readiness path, command registry, deferred `extract-widget` proxy, and launch-intent source. The event must not alter normal open ordering or retain absolute path history.

**Step 5: Run GREEN**

```powershell
npm --workspace theia-extensions/product test
npm --workspace theia-extensions/product run build
```

**Step 6: Commit**

```powershell
git add app/theia-extensions/product/src/browser/ride-packaged-smoke-actions.ts app/theia-extensions/product/src/browser/ride-packaged-smoke.ts app/theia-extensions/product/src/browser/ride-open-request.ts app/theia-extensions/product/test/ride-packaged-smoke-actions.test.ts app/theia-extensions/product/test/ride-packaged-smoke.test.ts app/theia-extensions/product/test/ride-open-request.test.ts
git diff --cached --check
git commit -m "test: cover deferred and forwarded desktop actions"
```

## Task 6: Build the external packaged runner

**Files:**

- Create: `app/scripts/run-tauri-packaged-smoke.mjs`
- Create: `app/scripts/test/run-tauri-packaged-smoke.test.mjs`
- Modify: `app/scripts/measure-tauri-startup.mjs`
- Modify: `app/scripts/test/measure-tauri-startup.test.mjs`
- Modify: `app/package.json`

**Step 1: Write failing runner orchestration tests**

Inject filesystem, spawn, clock, report polling, process monitoring, and cleanup dependencies. Assert exact order:

```text
create workspace/spec
launch first instance
wait for first-file actions
launch second instance
wait for forwarding and completion
request graceful close
verify no owned descendants
validate report/logs
```

Cover per-phase timeout, early child exit, malformed/stale report, profile mismatch, sidecar stderr failure, second instance that stays alive, cleanup failure, redaction, and successful temporary cleanup.

**Step 2: Run RED**

```powershell
Set-Location app
node --test scripts/test/run-tauri-packaged-smoke.test.mjs
```

**Step 3: Export only reusable measurement primitives**

If required by the failing tests, export the already-tested executable discovery, bounded log capture, process identity, monitor, cleanup, and diagnostic redaction functions. Do not change their runtime behavior. Add an export-policy regression test before modifying exports.

**Step 4: Implement the minimum runner and CLI**

Support:

```text
--bundle-root
--executable
--scenario critical-file|critical-empty|full-file
--output
--keep-workspace
--timeout-ms
```

Generate the token with a cryptographic RNG, persist only its digest, pass the raw token only through the child environment, and reject inherited smoke variables.

**Step 5: Run GREEN and measurement regressions**

```powershell
node --test scripts/test/run-tauri-packaged-smoke.test.mjs scripts/test/tauri-packaged-smoke-contract.test.mjs scripts/test/measure-tauri-startup.test.mjs
```

**Step 6: Add the package command and commit**

Add:

```json
"smoke:tauri-packaged": "node scripts/run-tauri-packaged-smoke.mjs"
```

```powershell
git add app/scripts/run-tauri-packaged-smoke.mjs app/scripts/tauri-packaged-smoke-contract.mjs app/scripts/test/run-tauri-packaged-smoke.test.mjs app/scripts/test/measure-tauri-startup.test.mjs app/scripts/measure-tauri-startup.mjs app/package.json
git diff --cached --check
git commit -m "test: run packaged Tauri smoke scenarios"
```

## Task 7: Add critical-empty and full-profile scenario checks

**Files:**

- Modify: `app/scripts/run-tauri-packaged-smoke.mjs`
- Modify: `app/scripts/test/run-tauri-packaged-smoke.test.mjs`
- Modify: `app/scripts/tauri-packaged-smoke-contract.mjs`
- Modify: `app/scripts/test/tauri-packaged-smoke-contract.test.mjs`
- Modify: `app/scripts/verify-tauri-profile.mjs`
- Modify: `app/scripts/test/verify-tauri-profile.test.mjs`

**Step 1: Write failing scenario tests**

Assert `critical-empty` has no initial/forwarded files and requires shell usability plus bounded plugin readiness. Assert `full-file` requires packaged profile `full` and the same functional action list as `critical-file`.

**Step 2: Run RED, implement scenario plans, run GREEN**

```powershell
Set-Location app
node --test scripts/test/run-tauri-packaged-smoke.test.mjs scripts/test/tauri-packaged-smoke-contract.test.mjs scripts/test/verify-tauri-profile.test.mjs
```

**Step 3: Commit**

```powershell
git add app/scripts/run-tauri-packaged-smoke.mjs app/scripts/test/run-tauri-packaged-smoke.test.mjs app/scripts/tauri-packaged-smoke-contract.mjs app/scripts/test/tauri-packaged-smoke-contract.test.mjs app/scripts/verify-tauri-profile.mjs app/scripts/test/verify-tauri-profile.test.mjs
git diff --cached --check
git commit -m "test: validate Tauri fallback smoke scenarios"
```

## Task 8: Integrate Windows execution and four-platform policy

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/tauri.yml`
- Modify: `scripts/test/workflow-policy.test.mjs`
- Modify: `scripts/test/desktop-integration-policy.test.mjs`

**Step 1: Write failing workflow policy tests**

Require:

- Windows packaged jobs run `smoke:tauri-packaged -- --scenario critical-file` after package verification.
- Smoke diagnostics upload on failure with a bounded retention period.
- Full profile has a distinct Windows build/launch job or explicit matrix entry.
- Non-Windows jobs validate profile inventory and smoke contract artifacts without using wording that claims interactive success.
- No job compares hosted performance directly to the local historical baseline.

**Step 2: Run RED**

```powershell
node --test scripts/test/workflow-policy.test.mjs scripts/test/desktop-integration-policy.test.mjs
```

**Step 3: Implement minimum workflow changes**

Keep the existing package matrix and artifact uploads. Add Windows interaction only where a desktop session is available; if GitHub-hosted Windows cannot provide a reliable interactive session, make the job explicit/manual rather than marking a static check as an interactive pass.

**Step 4: Run GREEN and YAML parsing checks**

```powershell
node --test scripts/test/workflow-policy.test.mjs scripts/test/desktop-integration-policy.test.mjs
```

Expected: policy tests pass on a host with the documented WSL MIME prerequisite. If `update-mime-database` is absent, run the environment-independent workflow assertions separately and record the single setup blocker.

**Step 5: Commit**

```powershell
git add .github/workflows/ci.yml .github/workflows/tauri.yml scripts/test/workflow-policy.test.mjs scripts/test/desktop-integration-policy.test.mjs
git diff --cached --check
git commit -m "ci: exercise packaged Tauri smoke coverage"
```

## Task 9: Document operation and run final verification

**Files:**

- Create: `docs/desktop-packaged-smoke.md`
- Modify: `app/TAURI-IMPLEMENTATION-STATUS.md`
- Modify: `app/TAURI-BUILD-GUIDE.md`

**Step 1: Write operator documentation**

Document prerequisites, critical/empty/full commands, expected report location, failure artifact handling, security restrictions, Windows-only interactive scope, and the distinction between static package validation and real interaction.

**Step 2: Run the complete environment-independent suite**

```powershell
node --test app/scripts/test/tauri-packaged-smoke-contract.test.mjs app/scripts/test/run-tauri-packaged-smoke.test.mjs app/scripts/test/measure-tauri-startup.test.mjs app/scripts/test/verify-tauri-profile.test.mjs scripts/test/workflow-policy.test.mjs
Set-Location app
npm --workspace theia-extensions/product test
node scripts/run-tauri-tests.js
npm --workspace applications/tauri run verify
Set-Location ..
```

Expected: all environment-independent tests pass; document any external prerequisite separately rather than hiding it.

**Step 3: Build and execute the real Windows critical package**

```powershell
Set-Location app
$env:RIDE_TAURI_FRONTEND_PROFILE = 'tauri-critical'
npm run build:tauri
npm run smoke:tauri-packaged -- --scenario critical-file
```

Expected: report status `passed`, first and second `.R` actions are present, no sidecar startup error appears, and cleanup reports no owned descendants.

**Step 4: Build and execute the explicit full profile**

```powershell
$env:RIDE_TAURI_FRONTEND_PROFILE = 'full'
npm run build:tauri
npm run smoke:tauri-packaged -- --scenario full-file
```

Expected: full profile manifest matches and the same required actions pass.

**Step 5: Review tracked output and commit documentation**

```powershell
Set-Location ..
git status --short
git diff --check
git add docs/desktop-packaged-smoke.md app/TAURI-IMPLEMENTATION-STATUS.md app/TAURI-BUILD-GUIDE.md
git commit -m "docs: document packaged Tauri smoke checks"
```

Do not commit generated package output, smoke reports, temporary workspaces, or logs.

**Step 6: Request code review**

Use `superpowers:requesting-code-review`, address verified findings, rerun the full relevant suite, and only then use `superpowers:finishing-a-development-branch` for merge/PR options.
