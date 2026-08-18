# R-IDE Tauri Performance Targets Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the packaged Tauri application reach an editable target file at least 30% faster and use at least 10% less idle whole-process-tree RSS than the checked-in same-host Windows baseline, while preserving explicit full-profile fallback and four-platform packaging.

**Architecture:** Add a versioned benchmark/build identity contract, correct hosted-plugin startup ordering, and replace generated-file substring deletion with a generated Tauri application profile whose roots are resolved through Theia's real extension dependency graph. Defer only feature modules that pass a post-start activation contract; keep unsafe modules critical until they have an isolated secondary activation path. Preserve the existing browser application as the explicit `full` profile.

**Tech Stack:** Node.js 22/24, TypeScript, Eclipse Theia 1.73 application generator, Inversify, esbuild, Tauri 2/Rust, Node's built-in test runner, GitHub Actions.

---

## Working agreement and fixed acceptance values

Execute from `C:\Users\10428\.config\superpowers\worktrees\R-IDE\tauri-performance-targets`.

Do not weaken these local same-host gates:

```text
median targetFileOpenedMs <= 3717
median idle rssBytes       <= 1038739046
runs                       == 5
```

The baseline is `app/applications/tauri/perf/baselines/pre-optimization-windows-x64-d034943.json`.

The initial branch baseline has 153 environment-independent tests passing. Four broader checks require setup: one WSL MIME test needs `update-mime-database`, and three backend-bundle tests need installed dependencies and generated output. These are setup requirements, not accepted permanent skips.

## Task 1: Establish the complete local baseline

**Files:** Verify only `app/package.json` and `app/yarn.lock`; no production edits.

**Step 1: Install locked dependencies**

```powershell
Set-Location app
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
$env:PUPPETEER_SKIP_DOWNLOAD = '1'
yarn install --frozen-lockfile --network-timeout 100000
```

Expected: exit 0 and no `app/yarn.lock` change.

**Step 2: Build the existing full graph**

```powershell
npm --workspace theia-extensions/product run build
npm --workspace applications/browser run build:prod
```

Expected: browser frontend and backend bundles exist.

**Step 3: Run pre-change checks**

```powershell
Set-Location ..
node --test scripts/test/workflow-policy.test.mjs scripts/test/tauri-backend-bundle.test.mjs app/scripts/test/measure-tauri-startup.test.mjs app/scripts/test/build-tauri-backend.test.js
Set-Location app
npm --workspace theia-extensions/product test
npm --workspace applications/tauri run verify
npm run test:tauri-rust
```

Expected: all commands exit 0. Record inherited failures before editing.

**Step 4: Confirm tracked output is clean**

```powershell
Set-Location ..
git status --short
```

Do not commit generated `lib`, `src-gen`, Tauri schema, plugin, or backend resource files.

## Task 2: Version the measurement contract and classify memory

**Files:**

- Modify: `app/scripts/measure-tauri-startup.mjs`
- Modify: `app/scripts/test/measure-tauri-startup.test.mjs`
- Create: `app/scripts/check-tauri-performance.mjs`
- Create: `app/scripts/test/check-tauri-performance.test.mjs`
- Modify: `app/applications/tauri/perf/baselines/pre-optimization-windows-x64-d034943.json`
- Modify: `app/package.json`

**Step 1: Write failing process parser and role tests**

Add Windows/POSIX fixtures carrying executable and command line, but assert the final artifact does not persist raw command lines. Test precedence with:

```js
assert.deepEqual(classifyProcessRoles(rows, rootIdentity), {
  main: { processCount: 1, rssBytes: 10 },
  backend: { processCount: 1, rssBytes: 20 },
  pluginHost: { processCount: 2, rssBytes: 70 },
  webviewRenderer: { processCount: 1, rssBytes: 100 },
  webviewGpu: { processCount: 1, rssBytes: 50 },
  webviewUtility: { processCount: 1, rssBytes: 40 },
  terminal: { processCount: 1, rssBytes: 30 },
  other: { processCount: 0, rssBytes: 0 }
});
```

Root identity wins; backend is the verified Node descendant running bundled `main.js`; plugin host wins over generic Node; WebView `--type` selects renderer/GPU/utility; known shells under the backend are terminals.

```powershell
node --test app/scripts/test/measure-tauri-startup.test.mjs
```

Expected: fail before implementation.

**Step 2: Extend bounded process queries and aggregation**

Add `Name`, `ExecutablePath`, and `CommandLine` to the Windows CIM projection and command text to POSIX `ps`. Preserve all current command bounds, PID identity checks, marker checks, and cleanup behavior. Export:

```js
export function classifyProcessRoles(processes, rootIdentity) { /* precedence rules */ }
```

Add per-run role RSS/count and median role values.

**Step 3: Write failing build identity tests**

Require measurement schema v2 metadata:

```js
assert.deepEqual(measurement.build, {
  commit: '0123456789abcdef0123456789abcdef01234567',
  profile: 'tauri-critical',
  profileSha256: '<64 lower-case hex>',
  pluginManifestSha256: '<64 lower-case hex>',
  pluginCount: 69
});
assert.match(measurement.host.fingerprint, /^[0-9a-f]{64}$/);
```

Fingerprint normalized platform, architecture, OS release, CPU model, logical CPU count, and total-memory bucket, storing only the digest and non-sensitive platform facts.

**Step 4: Implement strict schema v2 metadata**

Read the profile manifest from `--profile-manifest` or the executable bundle and the plugin manifest from packaged resources. Reject missing, malformed, or non-canonical metadata. Keep native startup report schema at v1; only the campaign becomes `ride.startup-measurement@2`.

**Step 5: Add a strict comparator**

Test exactly five candidate runs, matching platform/architecture/host, 30% startup gain, 10% RSS gain, unsafe numbers, missing identities, and an explicit one-time migration marker for the historical `d034943` baseline.

```powershell
node app/scripts/check-tauri-performance.mjs --baseline app/applications/tauri/perf/baselines/pre-optimization-windows-x64-d034943.json --candidate <candidate.json> --min-startup-gain 30 --min-memory-gain 10
```

Failure output must show actual, target, and delta for both metrics. Add `check:tauri-performance` to `app/package.json`.

**Step 6: Verify and commit**

```powershell
node --test app/scripts/test/measure-tauri-startup.test.mjs app/scripts/test/check-tauri-performance.test.mjs
git add app/scripts/measure-tauri-startup.mjs app/scripts/check-tauri-performance.mjs app/scripts/test/measure-tauri-startup.test.mjs app/scripts/test/check-tauri-performance.test.mjs app/applications/tauri/perf/baselines/pre-optimization-windows-x64-d034943.json app/package.json
git diff --cached --check
git commit -m "perf: version Tauri startup measurements"
```

## Task 3: Move hosted-plugin resolution after target editability

**Files:**

- Modify: `app/theia-extensions/product/src/browser/ride-open-request.ts`
- Modify: `app/theia-extensions/product/src/browser/ride-open-request-bindings.ts`
- Modify: `app/theia-extensions/product/test/ride-open-request.test.ts`
- Modify: `app/theia-extensions/product/test/ride-open-request-bindings.test.ts`

**Step 1: Add failing order and fallback tests**

Assert:

```js
assert.deepEqual(events, [
  'milestone:frontend_shell_attached',
  'open:/project/startup.R',
  'activate:target-widget',
  'milestone:target_file_opened',
  'yield',
  'resolve:hosted-plugins',
  'resolve:plugin-server',
  'deploy:plugins'
]);
```

Also cover one bounded no-file fallback, immediate demand trigger, shared/idempotent resolution, disposal before yield, open failure, and milestone-report failure.

```powershell
Set-Location app
npm --workspace theia-extensions/product test
```

Expected: new order test fails because hosted-plugin resolution currently starts after `attached_shell`.

**Step 2: Implement one idempotent activation path**

Inject an event-loop scheduler:

```ts
export interface RideDeferredWorkScheduler {
    yield(): Promise<void>;
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}
```

After target activation:

```ts
await this.reportStartupMilestone('target_file_opened');
await this.deferredWork.yield();
if (!this.disposed) {
    this.startPluginObservation();
    void this.pluginDeployment?.activateNow();
}
```

Remove resolution from `initializeAfterShellAttached()`. `requestPluginDeployment()` starts observation and both deferred container resolutions immediately. Preserve the no-file delay.

**Step 3: Verify and commit**

```powershell
npm --workspace theia-extensions/product test
npm --workspace theia-extensions/product run lint
Set-Location ..
git add app/theia-extensions/product/src/browser/ride-open-request.ts app/theia-extensions/product/src/browser/ride-open-request-bindings.ts app/theia-extensions/product/test/ride-open-request.test.ts app/theia-extensions/product/test/ride-open-request-bindings.test.ts
git diff --cached --check
git commit -m "perf: defer hosted plugins until the editor is ready"
```

## Task 4: Generate a dependency-closure-aware Tauri target

**Files:**

- Create: `app/applications/browser/tauri-profile.json`
- Create: `app/scripts/tauri-frontend-profile.mjs`
- Create: `app/scripts/test/tauri-frontend-profile.test.mjs`
- Modify: `app/scripts/build-tauri-backend.js`
- Modify: `app/scripts/test/build-tauri-backend.test.js`
- Modify: `app/applications/browser/esbuild.mjs`
- Modify: `app/.gitignore`

**Step 1: Add failing pure resolver tests**

Use injected in-memory package manifests. Cover stable topological closure, cycles, dependencies and peer dependencies, optional missing peers, unknown roots, required missing dependencies, critical/deferred conflicts, aliases, canonical digest, full selection, and plugin-ext transitive closure.

```js
assert.deepEqual(resolveProfile(profile, packages).extensions, [
  '@theia/core',
  '@theia/filesystem',
  '@theia/workspace',
  '@theia/plugin-ext',
  'theia-ide-product-ext'
]);
```

```powershell
node --test app/scripts/test/tauri-frontend-profile.test.mjs
```

Expected: fail before implementation.

**Step 2: Declare exact roots and deferred groups**

Use exact package names, never prefixes. Critical roots include core, editor, filesystem/workspace, Monaco, navigator, preferences, terminal/process/task, search, SCM, markers/messages/output, user storage/variables, plugin-ext/plugin-ext-vscode, and `theia-ide-product-ext`. Deferred groups enumerate exact AI, collaboration, notebook, preview/getting-started, and auxiliary packages.

Fail when a critical closure pulls in a declared deferred root; resolve the actual dependency conflict instead of filtering generated lines.

**Step 3: Generate an isolated application target**

Create ignored `app/applications/browser/.ride-tauri-profile/` with `package.json`, custom esbuild files, preload/assets, and `ride-tauri-profile.json`. Copy Theia config from the browser app and declare only resolved roots plus build dev dependencies. Validate installed versions and write atomically. Never mutate tracked `package.json` or `src-gen`.

**Step 4: Replace the old lean switch**

`createBuildPlan(platform, profile)` defaults to `tauri-critical`, generates the target, builds inside `.ride-tauri-profile`, then atomically publishes `lib/frontend`, `lib/backend`, and profile metadata to `applications/browser/lib`. `RIDE_TAURI_FRONTEND_PROFILE=full` uses every browser root; unknown values fail.

Delete `RIDE_TAURI_LEAN`, `RIDE_TAURI_ENABLE_PLUGINS`, prefix arrays, and generated-file line mutation. Preserve Theia dedupe and Parcel watcher fixes.

**Step 5: Verify and commit**

```powershell
node --test app/scripts/test/tauri-frontend-profile.test.mjs app/scripts/test/build-tauri-backend.test.js
git add app/applications/browser/tauri-profile.json app/scripts/tauri-frontend-profile.mjs app/scripts/test/tauri-frontend-profile.test.mjs app/scripts/build-tauri-backend.js app/scripts/test/build-tauri-backend.test.js app/applications/browser/esbuild.mjs app/.gitignore
git diff --cached --check
git commit -m "perf: add a dependency-safe Tauri frontend profile"
```

## Task 5: Add deferred chunks with an explicit Theia lifecycle contract

**Files:**

- Create: `app/theia-extensions/product/src/browser/ride-deferred-feature-loader.ts`
- Create: `app/theia-extensions/product/test/ride-deferred-feature-loader.test.ts`
- Modify: `app/theia-extensions/product/src/browser/theia-ide-product-frontend-module.ts`
- Modify: `app/applications/browser/tauri-profile.json`
- Modify: `app/scripts/tauri-frontend-profile.mjs`
- Modify: `app/scripts/test/tauri-frontend-profile.test.mjs`
- Create: `app/applications/browser/tauri-src/`

**Step 1: Write a failing activation-contract harness**

Theia contribution providers cache on first read, so the loader must not rely on late `container.load()` being discovered. Define explicit descriptors:

```ts
export interface RideDeferredFeature {
    readonly id: string;
    readonly load: () => Promise<RideDeferredFeatureModule>;
    readonly activate: (module: RideDeferredFeatureModule) => Promise<void>;
}
```

Test shared concurrent activation, cached success, retryable failure, disposal, rejection of unsupported contribution types, and exactly-once registry/lifecycle calls. Include a regression test proving a cached `ContributionProvider` is not the activation mechanism.

```powershell
Set-Location app
npm --workspace theia-extensions/product test
```

Expected: fail before the loader exists.

**Step 2: Implement explicit adapters only**

Inject command, menu, keybinding, frontend application, and message services. A generated chunk exports concrete adapters rather than only an Inversify module. Supported initial order:

```ts
await module.registerCommands?.(commands);
await module.registerMenus?.(menus);
await module.registerKeybindings?.(keybindings);
await module.initialize?.();
await module.configure?.(application);
await module.onStart?.(application);
```

Track disposables and invoke `onStop`/dispose at shutdown.

**Step 3: Prove one low-risk group end to end**

Start with preview/getting-started or another frontend-only group. Generate a separate esbuild entry and a small critical proxy command. Assert the initial bundle lacks the module path, the chunk contains it, the proxy loads and executes the real feature, and full profile works without the proxy.

**Step 4: Gate every further group**

Move AI, collaboration, notebook, preview/getting-started, and auxiliary groups one at a time only if:

1. every frontend contribution type has an explicit adapter;
2. backend services have tested on-demand or isolated secondary activation;
3. one real delayed smoke action succeeds;
4. inventory proves absence from the initial entry.

If any condition fails, retain the group in critical and record `deferBlockedReason` in profile metadata. Do not silently omit functionality.

**Step 5: Enable validated code splitting**

Use ESM, `splitting: true`, and stable `chunkNames: 'chunks/[name]-[hash]'`; emit a module script in generated `index.html`. Keep worker entries intact.

**Step 6: Verify and commit**

```powershell
npm --workspace theia-extensions/product test
Set-Location ..
node --test app/scripts/test/tauri-frontend-profile.test.mjs
git add app/theia-extensions/product/src/browser/ride-deferred-feature-loader.ts app/theia-extensions/product/test/ride-deferred-feature-loader.test.ts app/theia-extensions/product/src/browser/theia-ide-product-frontend-module.ts app/applications/browser/tauri-profile.json app/scripts/tauri-frontend-profile.mjs app/scripts/test/tauri-frontend-profile.test.mjs app/applications/browser/tauri-src
git diff --cached --check
git commit -m "perf: load noncritical Tauri features on demand"
```

Commit later feature groups separately when they require distinct adapters.

## Task 6: Package chunks and profile identity safely

**Files:**

- Modify: `app/applications/tauri/copy-frontend.js`
- Modify: `app/applications/tauri/copy-backend.js`
- Modify: `app/applications/tauri/verify-build.js`
- Modify: `app/scripts/test/tauri-permissions.test.mjs`
- Modify: `scripts/test/tauri-backend-bundle.test.mjs`
- Modify: `scripts/test/workflow-policy.test.mjs`

**Step 1: Add failing copy policy tests**

Require recursive copying of regular files under `lib/frontend`, including `chunks/**` and `ride-tauri-profile.json`; reject links/reparse points and traversal; keep source maps opt-in. Require the same immutable profile manifest beside backend resources for measurement.

Expected packaged paths include:

```text
browser-frontend/ride-tauri-profile.json
browser-frontend/chunks/<validated-feature>.js
resources/backend/ride-tauri-profile.json
```

**Step 2: Implement bounded atomic copy**

Require `index.html`, `bundle.js`, and `bundle.css`; recursively copy regular files; omit `.map` unless `RIDE_COPY_SOURCEMAPS=1`; preserve relative directories; publish through a temporary sibling rename. Update desktop HTML rewriting to recognize module scripts and retain CSP without inline script.

**Step 3: Verify and commit**

```powershell
node --test app/scripts/test/tauri-permissions.test.mjs scripts/test/tauri-backend-bundle.test.mjs scripts/test/workflow-policy.test.mjs
git add app/applications/tauri/copy-frontend.js app/applications/tauri/copy-backend.js app/applications/tauri/verify-build.js app/scripts/test/tauri-permissions.test.mjs scripts/test/tauri-backend-bundle.test.mjs scripts/test/workflow-policy.test.mjs
git diff --cached --check
git commit -m "build: package Tauri profile chunks and identity"
```

## Task 7: Verify profile inventory and functional fallback

**Files:**

- Create: `app/scripts/verify-tauri-profile.mjs`
- Create: `app/scripts/test/verify-tauri-profile.test.mjs`
- Modify: `app/package.json`
- Modify only evidence-backed profile/loader files if a test exposes a defect.

**Step 1: Write failing inventory tests**

Given profile and esbuild metadata, verify every critical extension, every deferred chunk, plugin worker/host and VS Code initialization, Parcel watcher, editor worker, product extension, no deferred-only backend module in critical backend, and all browser roots in full profile.

**Step 2: Implement verifier and metadata output**

Add `verify:tauri-profile` to `app/package.json`. Emit esbuild metafiles under `lib/metadata/`; never package source maps by default.

**Step 3: Build critical profile**

```powershell
Set-Location app
$env:RIDE_TAURI_FRONTEND_PROFILE = 'tauri-critical'
npm --workspace applications/browser run build:tauri-backend
npm run verify:tauri-profile
npm --workspace applications/tauri run copy:all
npm --workspace applications/tauri run verify
```

Expected: all pass and manifest reports exact profile, digest, and plugin count.

**Step 4: Build full fallback**

```powershell
$env:RIDE_TAURI_FRONTEND_PROFILE = 'full'
npm --workspace applications/browser run build:tauri-backend
npm run verify:tauri-profile
```

Expected: all browser roots present.

**Step 5: Package critical release**

```powershell
$env:RIDE_TAURI_FRONTEND_PROFILE = 'tauri-critical'
npm --workspace applications/browser run build:tauri-backend
npm --workspace applications/tauri run copy:all
npm --workspace applications/tauri run tauri -- build
```

Expected: no `Backend process exited before ready`; a real `.R` target opens and captured stderr has no plugin/feature activation error.

**Step 6: Functional smoke matrix**

Verify edit/save, terminal, search, SCM/Git, one bundled VS Code plugin, one real action from each deferred group, no-file bounded plugin fallback, and launchable full profile.

**Step 7: Commit verifier**

```powershell
Set-Location ..
git add app/scripts/verify-tauri-profile.mjs app/scripts/test/verify-tauri-profile.test.mjs app/package.json
git diff --cached --check
git commit -m "test: verify Tauri profile dependency inventory"
```

## Task 8: Meet both hard performance gates

**Files:** Modify only hotspot files justified by measurement. Keep candidate JSON untracked unless repository policy explicitly accepts it.

**Step 1: Run five fresh packaged samples**

```powershell
Set-Location app
npm run measure:tauri-startup -- --runs 5 --idle-ms 30000 --profile-manifest applications/tauri/src-tauri/target/release/bundle/ride-tauri-profile.json --output applications/tauri/src-tauri/target/release/bundle/startup-metrics-windows-x64.json
```

Expected: schema v2, five complete runs, role medians.

**Step 2: Enforce hard comparison**

```powershell
npm run check:tauri-performance -- --baseline applications/tauri/perf/baselines/pre-optimization-windows-x64-d034943.json --candidate applications/tauri/src-tauri/target/release/bundle/startup-metrics-windows-x64.json --min-startup-gain 30 --min-memory-gain 10
```

Expected: candidate medians at or below 3,717 ms and 1,038,739,046 bytes.

**Step 3: If a target fails, profile before editing**

- Startup: compare phase medians and plugin-resolution timestamps; inspect window/listen regressions first.
- Memory: rank role RSS and defer/isolate only a feature proven to affect the dominant role.
- Never lower thresholds, use fewer than five runs, shorten idle below 30 seconds, or compare hosted CI directly to the local baseline.

Every extra optimization begins with a failing focused test and is committed only after five-run median improvement plus smoke success. Use a hotspot-specific message such as `perf: keep notebook services outside initial Tauri graph`.

## Task 9: Enforce both profiles in four-platform CI

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/tauri.yml`
- Modify: `scripts/test/workflow-policy.test.mjs`
- Modify design document only for a material implementation deviation.

**Step 1: Add failing workflow policy assertions**

Require critical profile in all package jobs, one full-profile fallback smoke, profile/esbuild/startup artifacts, no cross-machine 30%/10% claim, severe-regression schema checks only in hosted CI, pinned action SHAs, and explicit timeouts.

**Step 2: Update workflows**

Set `RIDE_TAURI_FRONTEND_PROFILE=tauri-critical` for Windows, macOS x64, macOS arm64, and Linux package builds. Add full profile build/inventory verification to quality or Tauri verification without a second release package. Upload:

```text
startup-metrics*.json
ride-tauri-profile.json
esbuild-metafile*.json
```

**Step 3: Verify and commit**

```powershell
node --test scripts/test/workflow-policy.test.mjs
Set-Location app
npm run check:sync
Set-Location ..
git add .github/workflows/ci.yml .github/workflows/tauri.yml scripts/test/workflow-policy.test.mjs docs/plans/2026-08-18-tauri-performance-targets-design.md
git diff --cached --check
git commit -m "ci: verify Tauri critical and full profiles"
```

## Task 10: Final verification, review, and branch handoff

**Files:** No new production edits unless a reproduced failure has a test.

**Step 1: Run the full local suite**

```powershell
node --test scripts/test/workflow-policy.test.mjs scripts/test/desktop-integration-policy.test.mjs scripts/test/tauri-backend-bundle.test.mjs app/scripts/test/*.test.mjs app/scripts/test/*.test.js
Set-Location app
npm --workspace theia-extensions/product run lint
npm --workspace theia-extensions/product test
npm run test:tauri-rust
npm --workspace applications/tauri run verify
npm run check:sync
Set-Location ..
git diff --check
git status --short
```

Expected: all available checks pass. The WSL MIME test counts only after its required WSL package is installed.

**Step 2: Repeat packaged smoke and acceptance benchmark**

Repeat Task 7 critical/full smoke and Task 8 five-run comparison. Record exact report path and medians.

**Step 3: Request review**

Use `superpowers:requesting-code-review` with the design, this plan, range `34345be..HEAD`, performance report, and environment notes. Process ambiguous feedback with `superpowers:receiving-code-review`.

**Step 4: Verify GitHub checks**

Push after local verification. Confirm all four package targets and quality/verification jobs are green, then inspect uploaded profile/performance artifacts.

**Step 5: Finish only with evidence**

Use `superpowers:verification-before-completion`, then `superpowers:finishing-a-development-branch`. Report final startup/RSS medians and gains, role changes, deferred and retained groups with reasons, full fallback result, four-platform CI URL/status, and remaining non-blocking follow-up.
