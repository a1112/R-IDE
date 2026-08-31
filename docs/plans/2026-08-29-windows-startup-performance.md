# Windows Startup Performance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bring the packaged Windows Tauri application under the existing 800 ms window-visible, 2,200 ms median target-open, and 3,000 ms slowest target-open limits without changing policy or breaking the borderless shell, Codex lazy activation, or full-profile behavior.

**Architecture:** Apply independently measurable optimizations in order: first replace Windows full-window alpha composition with an opaque WebView plus native DWM corners, then make the `tauri-critical` esbuild graph exclude two proven large eager utility surfaces while keeping their features available on demand. Every slice has a focused RED/GREEN test, a separate commit, and a release-measurement checkpoint; if a slice does not improve its owned phase, revert only that slice before continuing.

**Tech Stack:** Rust 2021, Tauri 2, `windows-sys`/DWM, TypeScript 5.9, esbuild metadata, Node test runner, Eclipse Theia contribution APIs, Windows WebView2.

---

### Task 1: Add a deterministic initial-bundle analyzer

**Files:**
- Create: `app/scripts/analyze-tauri-initial-bundle.mjs`
- Create: `app/scripts/test/analyze-tauri-initial-bundle.test.mjs`
- Modify: `app/package.json`

**Step 1: Write the failing analyzer tests**

Create a synthetic esbuild metafile with one initial entry, two static chunks, and one dynamic chunk. Assert that the analyzer:

```js
const report = analyzeInitialBundle(fixture);
assert.deepEqual(report.outputs, ['lib/frontend/bundle.js', 'lib/frontend/chunks/static.js']);
assert.equal(report.outputs.includes('lib/frontend/chunks/deferred.js'), false);
assert.equal(report.packages['date-fns'], 700);
assert.equal(report.packages['highlight.js'], undefined);
assert.equal(report.totalInputBytes, 1_000);
```

Add rejection cases for a missing entry, an import cycle, an output outside `lib/frontend`, unsafe integers, malformed package paths, and duplicate logical inputs.

**Step 2: Run the tests to verify RED**

Run from `app`:

```powershell
node --test scripts/test/analyze-tauri-initial-bundle.test.mjs
```

Expected: FAIL because `analyze-tauri-initial-bundle.mjs` does not exist.

**Step 3: Implement the analyzer**

Export `analyzeInitialBundle(metadata, entry = 'lib/frontend/bundle.js')`. Traverse only `import-statement` edges, count each output and input once, normalize the package after the last `node_modules/` segment, and return a deeply frozen report:

```js
{
  schema: 'ride.tauri-initial-bundle',
  version: 1,
  entry,
  outputs: [...outputs].sort(),
  totalOutputBytes,
  totalInputBytes,
  packages: Object.fromEntries(packageTotals)
}
```

The CLI accepts only `--metadata <path>` and writes JSON to stdout. Add:

```json
"analyze:tauri-startup-bundle": "node scripts/analyze-tauri-initial-bundle.mjs --metadata applications/browser/lib/metadata/frontend-main.json"
```

**Step 4: Run GREEN and capture the current ranking**

```powershell
node --test scripts/test/analyze-tauri-initial-bundle.test.mjs
npm run analyze:tauri-startup-bundle
```

Expected: PASS. The current report must show the statically reachable bundle and expose the existing large `date-fns` and `highlight.js` totals without including Codex or secondary-window dynamic chunks.

**Step 5: Commit**

```powershell
git add app/package.json app/scripts/analyze-tauri-initial-bundle.mjs app/scripts/test/analyze-tauri-initial-bundle.test.mjs
git commit -m "build: report Tauri initial bundle ownership"
```

### Task 2: Make Windows composition opaque while preserving native chrome

**Files:**
- Modify: `app/applications/tauri/src-tauri/Cargo.toml`
- Modify: `app/applications/tauri/src-tauri/src/lib.rs`
- Modify: `app/applications/tauri/src-tauri/src/native_chrome.rs`
- Modify: `app/applications/tauri/src-tauri/tests/startup.rs`
- Create: `app/scripts/test/tauri-window-composition.test.mjs`

**Step 1: Write failing policy tests**

Add a pure composition policy test that proves:

```rust
assert_eq!(main_window_composition(DesktopPlatform::Windows), MainWindowComposition {
    transparent: false,
    background: [30, 30, 30, 255],
    native_corner_preference: true,
});
assert!(main_window_composition(DesktopPlatform::MacOs).transparent);
assert!(main_window_composition(DesktopPlatform::Linux).transparent);
```

Extend the static Node contract to require that the main window remains `decorations: false`, that Windows policy is applied before `WebviewWindowBuilder::from_config`, and that `configure_native_window` is still called before `show`.

**Step 2: Run focused tests to verify RED**

```powershell
$env:CARGO_TARGET_DIR='L:\R-IDE-builds\ride-codex-app-server-target'
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --locked main_window_composition
Set-Location app
node --test scripts/test/tauri-window-composition.test.mjs
```

Expected: FAIL because the policy and Windows DWM path are absent.

**Step 3: Implement the minimal Windows-only policy**

Add `Win32_Graphics_Dwm` and `Win32_UI_WindowsAndMessaging` to the existing Windows `windows-sys` feature list. Before building the main window, mutate only the Windows clone of `WebviewWindowConfig` to disable transparency and use opaque `#1e1e1e`; do not change `tauri.conf.json`, so macOS vibrancy and Linux behavior remain unchanged.

In `native_chrome.rs`, keep `set_decorations(false)` and add a Windows helper that calls `DwmSetWindowAttribute` with `DWMWA_WINDOW_CORNER_PREFERENCE`/`DWMWCP_ROUND`. A failed DWM call logs one bounded warning and leaves the usable opaque undecorated window in place.

**Step 4: Run GREEN and the complete Rust gate**

```powershell
$env:CARGO_TARGET_DIR='L:\R-IDE-builds\ride-codex-app-server-target'
cargo fmt --manifest-path app/applications/tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --locked main_window_composition
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --locked --all-targets
Set-Location app
node --test scripts/test/tauri-window-composition.test.mjs scripts/test/tauri-startup-gateway.test.mjs
```

Expected: PASS with no generated schema changes retained.

**Step 5: Commit**

```powershell
git add app/applications/tauri/src-tauri/Cargo.toml app/applications/tauri/src-tauri/Cargo.lock app/applications/tauri/src-tauri/src/lib.rs app/applications/tauri/src-tauri/src/native_chrome.rs app/applications/tauri/src-tauri/tests/startup.rs app/scripts/test/tauri-window-composition.test.mjs
git commit -m "perf: use opaque Windows Tauri composition"
```

### Task 3: Run the native-window A/B gate

**Files:**
- Generated only: `app/applications/tauri/src-tauri/target/windows-opaque-startup.json`

**Step 1: Build the production package**

```powershell
Set-Location app
npm --workspace theia-ide-browser-app run build:tauri-backend
npm --workspace applications/tauri run build:prod
npm --workspace applications/tauri run verify
```

Expected: EXE, NSIS, and MSI all build and verification exits `0`.

**Step 2: Run both packaged smoke scenarios**

```powershell
node scripts/run-tauri-packaged-smoke.mjs --scenario critical-file --executable applications/tauri/src-tauri/target/release/ride-tauri.exe --output applications/tauri/src-tauri/target/windows-opaque-critical.json
node scripts/run-tauri-packaged-smoke.mjs --scenario codex --executable applications/tauri/src-tauri/target/release/ride-tauri.exe --output applications/tauri/src-tauri/target/windows-opaque-codex.json
```

Expected: both reports have `status: "passed"`; Codex includes all eight canonical actions and cleans the old backend process tree.

**Step 3: Run five fresh measurements and the strict checker**

```powershell
node scripts/measure-tauri-startup.mjs --executable applications/tauri/src-tauri/target/release/ride-tauri.exe --runs 5 --idle-ms 30000 --output applications/tauri/src-tauri/target/windows-opaque-startup.json
node scripts/check-tauri-performance.mjs --baseline applications/tauri/perf/baselines/pre-optimization-windows-x64-d034943.json --candidate applications/tauri/src-tauri/target/windows-opaque-startup.json --policy rust-gateway --min-startup-gain 30 --min-memory-gain 10
```

Expected: the exact checker reports the real result. Keep the composition commit only if window construction improves repeatably, there is no memory regression, and visual inspection passes. Do not change thresholds if the gate is still red.

**Step 4: Visually inspect native chrome**

Use the `computer-use` skill to inspect restored, maximized, resized, minimized/restored, and secondary-window states. Verify rounded corners, shadow, no alpha holes, correct Windows right-side controls, drag, double-click maximize, and edge resize.

**Step 5: Record the decision**

If accepted, leave the commit intact and proceed. If rejected, revert only `perf: use opaque Windows Tauri composition`, rerun the focused tests, and record the measured reason in the next performance commit message.

### Task 4: Replace broad date-fns roots with an exact Tauri-critical bridge

**Files:**
- Create: `app/applications/browser/tauri-src/date-fns-bridge.ts`
- Create: `app/applications/browser/tauri-src/date-fns-locales-bridge.ts`
- Modify: `app/applications/browser/tauri-src/esbuild-deferred.mjs`
- Modify: `app/scripts/test/tauri-frontend-profile.test.mjs`
- Modify: `app/scripts/test/verify-tauri-profile.test.mjs`

**Step 1: Write failing bridge and inventory tests**

Assert that `tauri-critical` has exact aliases for only `date-fns` and `date-fns/locale`, while `full` has none. Build a fixture importing the same symbols used by the pinned Theia sources and assert:

```js
assert.equal(typeof bridge.formatDistance, 'function');
assert.equal(typeof bridge.formatDistanceToNow, 'function');
assert.ok(locales.enUS);
assert.ok(locales.zhCN);
```

Add a source contract that fails if any initial Theia input imports another symbol from either broad root. Add metadata assertions that `date-fns/index.cjs` and `date-fns/locale.cjs` are absent from the initial static graph.

**Step 2: Run RED**

```powershell
Set-Location app
node --test scripts/test/tauri-frontend-profile.test.mjs scripts/test/verify-tauri-profile.test.mjs
```

Expected: FAIL because the bridges and aliases are absent.

**Step 3: Implement the exact bridges**

`date-fns-bridge.ts` re-exports only `formatDistance` and `formatDistanceToNow` from their narrow date-fns entry points. `date-fns-locales-bridge.ts` exports only the English and Simplified Chinese locales plus the exact locale-key aliases observed from R-IDE's supported `en` and `zh-cn` settings.

Extend the exact escaped alias plugin in `esbuild-deferred.mjs`; do not intercept subpaths and do not apply the bridge to `full`. Reject duplicate aliases and keep `preserveSymlinks: true`.

**Step 4: Run GREEN and rebuild metadata**

```powershell
node --test scripts/test/tauri-frontend-profile.test.mjs scripts/test/verify-tauri-profile.test.mjs
npm --workspace theia-ide-browser-app run build:tauri-backend
npm run analyze:tauri-startup-bundle
npm run verify:tauri-profile
```

Expected: PASS; the initial `date-fns` total drops from roughly 1 MB to the two functions and two locales, while full-profile semantics remain unchanged.

**Step 5: Commit**

```powershell
git add app/applications/browser/tauri-src/date-fns-bridge.ts app/applications/browser/tauri-src/date-fns-locales-bridge.ts app/applications/browser/tauri-src/esbuild-deferred.mjs app/scripts/test/tauri-frontend-profile.test.mjs app/scripts/test/verify-tauri-profile.test.mjs
git commit -m "perf: narrow Tauri date formatting imports"
```

### Task 5: Move Markdown highlighting behind preview demand

**Files:**
- Create: `app/applications/browser/tauri-src/preview-proxy-frontend-module.ts`
- Create: `app/applications/browser/tauri-src/preview-markdown-feature.ts`
- Modify: `app/applications/browser/tauri-profile.json`
- Modify: `app/scripts/test/tauri-frontend-profile.test.mjs`
- Modify: `app/scripts/test/verify-tauri-profile.test.mjs`
- Modify: `app/theia-extensions/product/test/ride-deferred-feature-loader.test.ts`

**Step 1: Write failing lazy-preview tests**

Add tests proving that:

- constructing the preview proxy does not evaluate `highlight.js`, create a widget, start a timer, or perform network work;
- repeated Markdown renders share one dynamic feature import;
- `renderContent` awaits the real handler and delegates scroll/fragment methods to the same instance;
- load failure remains retryable and disposal prevents late activation;
- the main esbuild entry excludes `highlight.js`, while the preview feature chunk contains it;
- the full profile still resolves the original Theia preview module.

**Step 2: Run RED**

```powershell
Set-Location app
node --test scripts/test/tauri-frontend-profile.test.mjs scripts/test/verify-tauri-profile.test.mjs
node L:\R-IDE-builds\ride-codex-app-server-deps\root-node_modules\typescript\bin\tsc -p theia-extensions/product/tsconfig.test.json --pretty false
node --test theia-extensions/product/test/dist/test/ride-deferred-feature-loader.test.js
```

Expected: FAIL because no preview proxy or feature chunk exists.

**Step 3: Implement the lazy Markdown handler**

The proxy reproduces the pinned `@theia/preview` container bindings except that `PreviewHandler` is bound to a lightweight `RideLazyMarkdownPreviewHandler`. Its `canHandle` remains synchronous for `.md`/`.markdown`; its first `renderContent` dynamically imports `preview-markdown-feature.ts`, creates one real `MarkdownPreviewHandler` through the existing container so property injection is preserved, and delegates the render. All other preview widget, command, menu, toolbar, preference, resource, and link-normalizer bindings remain available at startup.

Add this exact deferred module entry to `preview-getting-started`:

```json
{
  "package": "@theia/preview",
  "module": "@theia/preview/lib/browser/preview-frontend-module",
  "proxy": "tauri-src/preview-proxy-frontend-module.ts",
  "entry": "tauri-src/preview-markdown-feature.ts",
  "action": "markdown-preview"
}
```

Keep the remaining blocked-root evidence for Getting Started, Mini Browser, and preview backend behavior; only the heavy Markdown renderer leaves the initial entry.

**Step 4: Run GREEN and profile verification**

```powershell
node --test scripts/test/tauri-frontend-profile.test.mjs scripts/test/verify-tauri-profile.test.mjs
node L:\R-IDE-builds\ride-codex-app-server-deps\root-node_modules\typescript\bin\tsc -p theia-extensions/product/tsconfig.test.json --pretty false
node --test theia-extensions/product/test/dist/test/*.test.js
npm --workspace theia-ide-browser-app run build:tauri-backend
npm run analyze:tauri-startup-bundle
npm run verify:tauri-profile
```

Expected: PASS; `highlight.js` is absent from the initial static graph and present in exactly one deferred preview chunk.

**Step 5: Commit**

```powershell
git add app/applications/browser/tauri-src/preview-proxy-frontend-module.ts app/applications/browser/tauri-src/preview-markdown-feature.ts app/applications/browser/tauri-profile.json app/scripts/test/tauri-frontend-profile.test.mjs app/scripts/test/verify-tauri-profile.test.mjs app/theia-extensions/product/test/ride-deferred-feature-loader.test.ts
git commit -m "perf: defer Markdown highlighting in Tauri"
```

### Task 6: Run the complete release and performance gate

**Files:**
- Generated only: `app/applications/tauri/src-tauri/target/windows-startup-optimized.json`
- Modify only if results require documentation: `app/docs/codex-runtime.md`

**Step 1: Run deterministic tests and builds**

```powershell
Set-Location app
node --test scripts/test/*.test.mjs
node L:\R-IDE-builds\ride-codex-app-server-deps\root-node_modules\rimraf\bin.js theia-extensions/codex/test/dist
node L:\R-IDE-builds\ride-codex-app-server-deps\root-node_modules\typescript\bin\tsc -p theia-extensions/codex/tsconfig.test.json --pretty false
node --test theia-extensions/codex/test/dist/test/*.test.js
node L:\R-IDE-builds\ride-codex-app-server-deps\root-node_modules\rimraf\bin.js theia-extensions/product/test/dist
node L:\R-IDE-builds\ride-codex-app-server-deps\root-node_modules\typescript\bin\tsc -p theia-extensions/product/tsconfig.test.json --pretty false
node --test theia-extensions/product/test/dist/test/*.test.js
npm --workspace theia-ide-browser-app run build:tauri-backend
npm run verify:tauri-profile
node scripts/verify-codex-packaging.mjs --root applications/browser/lib
```

Expected: all commands exit `0`; packaging reports `forbidden: []` and `missing: []`.

**Step 2: Run Rust and production package gates**

```powershell
Set-Location ..
$env:CARGO_TARGET_DIR='L:\R-IDE-builds\ride-codex-app-server-target'
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --locked --all-targets
Set-Location app
npm --workspace applications/tauri run build:prod
npm --workspace applications/tauri run verify
```

Expected: Rust has zero failures; EXE, NSIS, and MSI are regenerated.

**Step 3: Run packaged interaction gates**

```powershell
node scripts/run-tauri-packaged-smoke.mjs --scenario critical-file --executable applications/tauri/src-tauri/target/release/ride-tauri.exe --output applications/tauri/src-tauri/target/windows-optimized-critical.json
node scripts/run-tauri-packaged-smoke.mjs --scenario codex --executable applications/tauri/src-tauri/target/release/ride-tauri.exe --output applications/tauri/src-tauri/target/windows-optimized-codex.json
```

Expected: both pass, the Codex eight-step plan completes, and cleanup leaves zero old backend-tree processes.

**Step 4: Run the final five-run performance campaign**

```powershell
node scripts/measure-tauri-startup.mjs --executable applications/tauri/src-tauri/target/release/ride-tauri.exe --runs 5 --idle-ms 30000 --output applications/tauri/src-tauri/target/windows-startup-optimized.json
node scripts/check-tauri-performance.mjs --baseline applications/tauri/perf/baselines/pre-optimization-windows-x64-d034943.json --candidate applications/tauri/src-tauri/target/windows-startup-optimized.json --policy rust-gateway --min-startup-gain 30 --min-memory-gain 10
```

Expected: window median at most 800 ms, target-open median at most 2,200 ms, slowest at most 3,000 ms, and memory within policy.

If any absolute startup limit remains red, stop here. Do not push, relax policy, or claim completion. Use the fresh Rust phases plus Task 1 package report to write the next evidence-selected optimization plan (backend critical graph or the largest remaining optional frontend owner).

**Step 5: Clean generated schemas and verify Git state**

```powershell
Set-Location ..
git restore --source=HEAD --worktree -- app/applications/tauri/src-tauri/gen/schemas/acl-manifests.json app/applications/tauri/src-tauri/gen/schemas/capabilities.json app/applications/tauri/src-tauri/gen/schemas/desktop-schema.json app/applications/tauri/src-tauri/gen/schemas/windows-schema.json
git diff --check
git status --short --branch
```

Expected: clean worktree. Performance and smoke artifacts remain ignored under `target`.

### Task 7: Review, push, and observe CI

**Files:** None unless review finds a defect.

**Step 1: Invoke completion review skills**

Use `@superpowers:requesting-code-review`, address only evidence-backed findings, then invoke `@superpowers:verification-before-completion` and rerun any affected gate.

**Step 2: Inspect branch history and remote state**

```powershell
git log --oneline --decorate -20
git status --short --branch
git remote -v
gh auth status
```

Expected: clean branch and authenticated GitHub CLI.

**Step 3: Push the already-authorized branch**

```powershell
git push -u origin codex/codex-app-server-integration
```

**Step 4: Observe CI and release workflows**

```powershell
gh pr checks --watch
```

Expected: all required CI, packaging inventory, and release jobs pass. Treat manual Windows interaction coverage precisely as manual; do not relabel compile-only jobs as interaction coverage.
