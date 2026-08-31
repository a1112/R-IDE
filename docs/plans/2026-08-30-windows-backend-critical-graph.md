# Windows Backend Critical Graph Optimization Implementation Plan

> **For Codex:** Use `superpowers:test-driven-development`, `superpowers:systematic-debugging`, and `superpowers:verification-before-completion` while executing this plan. Keep each measured slice independently revertible.

**Goal:** Bring the unchanged Windows `rust-gateway` gate below 800 ms for native-window visibility and below 2,200 ms for target-file opening without bundling Codex CLI, weakening smoke coverage, or relaxing the checker.

**Architecture:** First make the backend main-entry ownership and runtime-load cost measurable. Then replace only the Tauri-critical `@theia/ai-ide` browser-automation implementation with a retryable lazy proxy and a separately built backend feature bundle. The ordinary browser/full profile remains upstream-compatible. If the backend slice is retained, test a Windows-only backend process-priority handoff so WebView construction owns the foreground startup interval. Both slices require fresh five-run A/B evidence and are reverted independently when their owned phase does not improve.

**Tech Stack:** Tauri 2/Rust, Windows process APIs, Node.js 22+, esbuild, Theia/Inversify, Node test runner.

---

## Evidence and fixed acceptance criteria

The release build at commit `08030e6ebe56e860cd069ff0410682fee4d5e573` produced five valid `rust-gateway` runs:

- native-window visibility: `799, 863, 879, 861, 804` ms; median `861` ms;
- target-file opening: `2798, 2776, 2795, 2797, 2745` ms; median `2795` ms; slowest `2798` ms;
- backend spawn requested median: `416` ms;
- backend listening median: `1774` ms, so the owned backend interval is about `1358` ms;
- frontend bundle loaded median: `1196` ms;
- frontend shell attached median: `2383` ms;
- RSS median: `1,014,120,448` bytes.

The unchanged strict checker failed only these limits:

- target-file median: `+595` ms over the 2,200 ms limit;
- native-window median: `+61` ms over the 800 ms limit.

The backend main output is `16,425,994` bytes. These heavy packages are reachable through its optional `@theia/ai-ide` browser-automation path:

- `@tootallnate/quickjs-emscripten`: `665,090`;
- `puppeteer-core`: `490,087`;
- `chromium-bidi`: `177,454`;
- `esprima`: `138,686`.

The reachable total is `1,471,317` bytes, but it is not all exclusive ownership: ScanOSS also reaches QuickJS and esprima. The committed edge-cut analyzer removes only the exact `@theia/ai-ide/lib/node/backend-module -> browser-automation-impl` edge and reports `852,417` exclusive bytes across 298 inputs. The exclusive runtime portion includes `puppeteer-core` (`490,087` bytes), Chromium BiDi (`177,454` bytes), and their browser-launch support graph; QuickJS plus esprima remain `803,776` shared runtime bytes in the main bundle. This corrected slice is still safer than pruning i18n or deduplicating incompatible `iconv-lite` versions, but all build and retention assertions must use edge-cut ownership rather than reachable-package totals.

Do not push this branch until all of the following hold in one fresh release campaign:

- native-window visibility median at most `800` ms;
- target-file median at most `2,200` ms;
- slowest target-file run at most `3,000` ms;
- memory remains within the existing `rust-gateway` policy;
- `critical-file` and `codex` packaged smoke both pass with zero old backend-tree processes.

## Task 1: Add backend-main ownership and duplicate reporting

**Files:**

- Create: `app/scripts/analyze-tauri-backend-initial-bundle.mjs`
- Create: `app/scripts/test/analyze-tauri-backend-initial-bundle.test.mjs`
- Modify: `app/package.json`

**Step 1: Write the failing analyzer tests**

Cover these contracts with synthetic metafiles:

- analyze only the output whose entry point is `src-gen/backend/main.js`;
- exclude `ipc-bootstrap`, plugin host, watcher, native binaries, and worker outputs;
- aggregate `bytesInOutput` by logical package;
- report package version identities and duplicate logical copies separately;
- report the shortest importer chain from backend main/server to each selected package;
- reject missing, duplicate, external, cyclic, malformed, or unsafe-integer records;
- never print absolute workspace paths or command lines.

Run:

```powershell
Set-Location app
node --test scripts/test/analyze-tauri-backend-initial-bundle.test.mjs
```

Expected: RED because the analyzer does not exist.

**Step 2: Implement the analyzer and package script**

Add:

```json
"analyze:tauri-backend-bundle": "node scripts/analyze-tauri-backend-initial-bundle.mjs --metadata applications/browser/lib/metadata/backend.json"
```

The report must include exact ownership for the browser-automation chain and must not combine bytes from auxiliary backend outputs.

**Step 3: Run focused and production checks**

```powershell
node --test scripts/test/analyze-tauri-backend-initial-bundle.test.mjs
npm run analyze:tauri-backend-bundle
```

Expected: tests pass; the production report identifies `852,417` edge-cut-exclusive bytes and separately reports the ScanOSS-shared QuickJS/esprima runtime.

**Step 4: Commit**

```powershell
git add app/scripts/analyze-tauri-backend-initial-bundle.mjs app/scripts/test/analyze-tauri-backend-initial-bundle.test.mjs app/package.json
git commit -m "build: report Tauri backend bundle ownership"
```

## Task 2: Build a separate browser-automation backend feature

**Files:**

- Create: `app/applications/browser/tauri-src/backend/ai-ide-browser-automation-proxy.ts`
- Create: `app/applications/browser/tauri-src/backend/ai-ide-browser-automation-feature.ts`
- Create: `app/applications/browser/tauri-src/backend/esbuild-backend-deferred.mjs`
- Modify: `app/applications/browser/esbuild.mjs`
- Modify: `app/applications/browser/tauri-profile.json`
- Modify: `app/scripts/test/tauri-frontend-profile.test.mjs`
- Modify: `app/scripts/test/verify-tauri-profile.test.mjs`

**Step 1: Declare an exact backend deferral contract**

Extend the `ai` feature group with one Tauri-critical backend descriptor:

```json
{
  "package": "@theia/ai-ide",
  "module": "@theia/ai-ide/lib/node/app-tester-agent/browser-automation-impl",
  "proxy": "tauri-src/backend/ai-ide-browser-automation-proxy.ts",
  "entry": "tauri-src/backend/ai-ide-browser-automation-feature.ts",
  "output": "lib/backend/ai-ide-browser-automation-feature.cjs",
  "action": "browser-automation"
}
```

The full profile must not install this alias.

**Step 2: Write RED build-plan tests**

Require that:

- the node main plan aliases only the exact implementation request;
- the separate feature plan does not inherit that alias recursively;
- the main output cannot statically reach the feature output;
- the feature output owns `puppeteer-core`, QuickJS, Chromium BiDi, esprima, and the real browser-automation implementation needed by its isolated graph;
- the backend main output owns neither the real browser-automation implementation nor any input classified as edge-cut-exclusive by the committed analyzer;
- the backend main output may retain only analyzer-proven shared QuickJS/esprima inputs reached independently through ScanOSS; tests must not treat those shared copies as BrowserAutomation ownership;
- both outputs receive profile metadata and output hashes;
- watch and one-shot builds create and dispose both contexts.

Run:

```powershell
node --test scripts/test/tauri-frontend-profile.test.mjs scripts/test/verify-tauri-profile.test.mjs
```

Expected: RED on the missing backend descriptor and build plan.

**Step 3: Implement isolated backend build plans**

Use a variable runtime import in the proxy so esbuild cannot fold the feature back into `main.js`. Build the real upstream implementation as the separate CJS output with the normal node dependency graph. The Tauri copy and profile verifier must publish and attest the additional backend output.

Do not externalize unmanaged `node_modules`, copy a Chromium binary, or add Codex CLI payloads.

**Step 4: Verify bundle ownership**

```powershell
npm --workspace theia-ide-browser-app run build:tauri-backend
npm run verify:tauri-profile
npm run analyze:tauri-backend-bundle
node scripts/verify-codex-packaging.mjs --root applications/browser/lib
```

Expected: the exact implementation and all `852,417` previously edge-cut-exclusive bytes are absent from `lib/backend/main.js`; the isolated feature output is attested and contains its complete runtime graph; analyzer-proven ScanOSS-shared inputs may remain in main; packaging remains `forbidden: []`, `missing: []`.

**Step 5: Commit**

```powershell
git add app/applications/browser app/scripts/test
git commit -m "perf: split Tauri browser automation backend"
```

## Task 3: Implement the retryable browser-automation proxy

**Files:**

- Modify: `app/applications/browser/tauri-src/backend/ai-ide-browser-automation-proxy.ts`
- Modify: `app/applications/browser/tauri-src/backend/ai-ide-browser-automation-feature.ts`
- Modify: `app/theia-extensions/product/test/ride-deferred-feature-loader.test.ts`

**Step 1: Write lifecycle RED tests**

Test the real compiled proxy, not source regex only:

- construction, `setClient`, `getClient`, `isRunning`, and `close` do not load Puppeteer;
- first `launch` or `queryDom` loads one feature and one real delegate;
- concurrent calls share one load and one delegate;
- load and construction failures clear the cache and permit one retry;
- a client set before activation is applied to the real delegate;
- dispose is idempotent, blocks new activation, prevents late resurrection, and disposes a real delegate once;
- the real implementation is created through a child Inversify container;
- thrown upstream errors keep their behavior but never expose local build paths through startup diagnostics.

Run:

```powershell
node L:\R-IDE-builds\ride-codex-app-server-deps\root-node_modules\rimraf\bin.js theia-extensions/product/test/dist
node L:\R-IDE-builds\ride-codex-app-server-deps\root-node_modules\typescript\bin\tsc -p theia-extensions/product/tsconfig.test.json --pretty false
Set-Location theia-extensions/product
node --test test/dist/test/*.test.js
```

Expected: RED before proxy lifecycle implementation, GREEN afterward.

**Step 2: Preserve the upstream binding surface**

The existing `@theia/ai-ide/lib/node/backend-module` must still bind preferences, connection-container modules, GitHub services, and the exact `BrowserAutomation` service. Only `BrowserAutomationImpl` is replaced.

**Step 3: Run product, profile, and packaging tests**

```powershell
Set-Location app
node --test scripts/test/*.test.mjs
npm --workspace theia-ide-browser-app run build:tauri-backend
npm run verify:tauri-profile
npm run analyze:tauri-backend-bundle
```

**Step 4: Commit**

```powershell
git add app/applications/browser/tauri-src/backend app/theia-extensions/product/test app/scripts/test
git commit -m "perf: defer Tauri browser automation runtime"
```

## Task 4: Run the backend-slice A/B retention gate

**Files:** Generated reports only under `app/applications/tauri/src-tauri/target`.

**Step 1: Build and package the candidate**

Run all deterministic Node and Rust tests, regenerate the production EXE/MSI/NSIS, and verify the package inventory exactly as in the 2026-08-29 plan.

**Step 2: Run both packaged smoke scenarios**

```powershell
node scripts/run-tauri-packaged-smoke.mjs --scenario critical-file --executable applications/tauri/src-tauri/target/release/ride-tauri.exe --output applications/tauri/src-tauri/target/backend-deferred-critical.json
node scripts/run-tauri-packaged-smoke.mjs --scenario codex --executable applications/tauri/src-tauri/target/release/ride-tauri.exe --output applications/tauri/src-tauri/target/backend-deferred-codex.json
```

Expected: both pass; Codex completes eight actions; cleanup reports zero old backend-tree processes.

**Step 3: Run five fresh measurements**

```powershell
node scripts/measure-tauri-startup.mjs --executable applications/tauri/src-tauri/target/release/ride-tauri.exe --runs 5 --idle-ms 30000 --output applications/tauri/src-tauri/target/windows-backend-deferred.json
```

Retain this slice only when all are true:

- all five runs use `rust-gateway`;
- backend spawn-to-listening median improves by at least `150` ms;
- target-file median improves by at least `100` ms;
- RSS does not regress by more than the existing policy;
- both smoke scenarios pass on the first formal attempt.

Otherwise revert only Tasks 2 and 3 and select the next analyzer-owned backend candidate. Do not hide a failed first attempt with an unreported retry.

## Task 5: Test Windows backend priority handoff for the window gap

**Files:**

- Modify: `app/applications/tauri/src-tauri/src/sidecar.rs`
- Modify: `app/applications/tauri/src-tauri/src/startup.rs`
- Modify: `app/applications/tauri/src-tauri/src/lib.rs`
- Modify: `app/applications/tauri/src-tauri/Cargo.toml` only if the current Windows bindings lack the required process-priority APIs
- Test: `app/applications/tauri/src-tauri/tests/startup.rs`

**Step 1: Write Windows lifecycle RED tests**

Introduce a narrow injected process-priority adapter. Tests must prove:

- only the owned backend root is lowered to `BELOW_NORMAL_PRIORITY_CLASS`;
- the root is restored to normal exactly once after the main window-created gate resolves;
- startup failure, PID reuse, disposal, and cleanup cannot change another process;
- restore failure is bounded and diagnostic-only;
- non-Windows behavior is a no-op;
- the Windows Job Object remains the lifetime authority.

**Step 2: Implement the handoff**

Keep the backend at below-normal priority only while the WebView window is being constructed. Do not sleep, busy-wait, change WebView process priority, or lower plugin-host priority after the window is visible.

**Step 3: Run Rust gates**

```powershell
$env:CARGO_TARGET_DIR='L:\R-IDE-builds\ride-codex-app-server-tauri-target'
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --locked --all-targets
```

**Step 4: Run a five-run A/B campaign**

Retain this slice only if:

- native-window median improves by at least `61` ms and reaches at most `800` ms;
- no run exceeds the previous `879` ms slowest window value;
- backend listening and target-file medians do not regress versus the retained Task 4 candidate;
- all five runs remain `rust-gateway`.

If any condition fails, revert only Task 5.

**Step 5: Commit only a retained slice**

```powershell
git add app/applications/tauri/src-tauri
git commit -m "perf: prioritize Windows WebView construction"
```

## Task 6: Run the unchanged final release gate

Run the full deterministic tests, Rust all-target tests, production packaging, profile verification, package inventory, both packaged smoke scenarios, and one final five-run campaign.

Then run the unchanged checker:

```powershell
node scripts/check-tauri-performance.mjs --baseline applications/tauri/perf/baselines/pre-optimization-windows-x64-d034943.json --candidate applications/tauri/src-tauri/target/windows-startup-backend-optimized.json --policy rust-gateway --min-startup-gain 30 --min-memory-gain 10
```

Restore generated Tauri schemas, run `git diff --check`, and require a clean worktree.

If any absolute limit remains red, stop and do not push. Use the backend analyzer's next importer-chain owner rather than relaxing thresholds or stacking an unmeasured optimization.
