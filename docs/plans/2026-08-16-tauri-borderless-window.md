# Tauri Borderless Window Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the Tauri main window borderless on Windows, macOS, and Linux with platform-correct custom window controls while preserving dragging, resizing, and existing startup behavior.

**Architecture:** Keep window operations in the existing Rust `native_chrome` IPC layer, set the Tauri main window to `decorations: false`, and render a small platform-aware control group inside the existing Theia top panel. macOS places close/minimize/maximize controls on the left; Windows and Linux place minimize/maximize/close controls on the right. Browser preview and Electron remain unchanged.

**Tech Stack:** Tauri 2 / Rust, Theia frontend extension, TypeScript, CSS, Node.js `node:test`, Cargo tests.

---

### Task 1: Lock down platform window-control layout

**Files:**
- Create: `app/theia-extensions/product/test/ride-native-chrome.test.ts`
- Modify: `app/theia-extensions/product/src/browser/ride-native-chrome.ts`

**Step 1: Write the failing test**

Add a focused Node test for a pure exported layout helper. The helper should return both placement and ordered actions:

```ts
test('uses platform-native window control placement and order', () => {
    assert.deepEqual(getRideWindowControls('macos'), {
        placement: 'left',
        actions: ['close', 'minimize', 'toggleMaximize']
    });
    assert.deepEqual(getRideWindowControls('windows'), {
        placement: 'right',
        actions: ['minimize', 'toggleMaximize', 'close']
    });
    assert.deepEqual(getRideWindowControls('linux'), {
        placement: 'right',
        actions: ['minimize', 'toggleMaximize', 'close']
    });
    assert.deepEqual(getRideWindowControls('unknown'), {
        placement: 'right',
        actions: ['minimize', 'toggleMaximize', 'close']
    });
});
```

Export `RidePlatform`, the window-control action type, and the helper signature needed by the test. Do not add the implementation yet.

**Step 2: Run the test to verify it fails**

Run: `yarn --cwd app/theia-extensions/product test`

Expected: FAIL because `getRideWindowControls` is not exported/implemented.

**Step 3: Commit the red test**

```bash
git add app/theia-extensions/product/test/ride-native-chrome.test.ts
git commit -m "test: define Tauri window control layout"
```

### Task 2: Implement the platform layout model

**Files:**
- Modify: `app/theia-extensions/product/src/browser/ride-native-chrome.ts`

**Step 1: Implement the minimal helper**

Add:

```ts
export type RideWindowControlAction = 'close' | 'minimize' | 'toggleMaximize';
export interface RideWindowControlLayout {
    placement: 'left' | 'right';
    actions: RideWindowControlAction[];
}

export function getRideWindowControls(platform: RidePlatform): RideWindowControlLayout {
    if (platform === 'macos') {
        return { placement: 'left', actions: ['close', 'minimize', 'toggleMaximize'] };
    }
    return { placement: 'right', actions: ['minimize', 'toggleMaximize', 'close'] };
}
```

Add a localized `close` label to both language dictionaries so the generated buttons can use the existing `RideTextKey` type.

**Step 2: Run the focused product tests**

Run: `yarn --cwd app/theia-extensions/product test`

Expected: PASS, including the new platform layout test and all existing product tests.

**Step 3: Commit the green layout model**

```bash
git add app/theia-extensions/product/src/browser/ride-native-chrome.ts app/theia-extensions/product/test/ride-native-chrome.test.ts
git commit -m "feat: add platform window control layout"
```

### Task 3: Add custom controls to the Theia top panel

**Files:**
- Modify: `app/theia-extensions/product/src/browser/ride-workbench-contribution.ts`

**Step 1: Add the control-group construction**

Create a small method that uses `getRideWindowControls(this.nativeChrome.platform)` and builds a `div.ride-window-controls`. Each button must:

- use `button.type = 'button'`;
- use `ride-window-control <action>` classes;
- set `aria-label` and `title` from the localized text;
- set `data-no-drag="true"`;
- invoke `this.nativeChrome.runWindowAction(action)` on click;
- stop propagation so the top-panel drag handler cannot receive the click.

Use Codicon names `codicon-chrome-close`, `codicon-chrome-minimize`, and `codicon-chrome-maximize`.

In `installTopChrome`, insert the group before the brand for macOS and append it after the existing right-side layout actions for Windows/Linux. Remove the obsolete native traffic-light spacer insertion because all platforms now use custom controls. Keep the existing top-panel drag and double-click handlers.

**Step 2: Run the product tests and TypeScript build**

Run: `yarn --cwd app/theia-extensions/product test`

Run: `yarn --cwd app/theia-extensions/product build`

Expected: PASS with no TypeScript errors.

**Step 3: Commit the frontend behavior**

```bash
git add app/theia-extensions/product/src/browser/ride-workbench-contribution.ts app/theia-extensions/product/src/browser/ride-native-chrome.ts
git commit -m "feat: render platform window controls"
```

### Task 4: Define borderless Tauri window policy

**Files:**
- Modify: `scripts/test/desktop-integration-policy.test.mjs`
- Modify: `app/applications/tauri/src-tauri/tauri.conf.json`

**Step 1: Write the failing policy test**

Add a test that reads the main Tauri window and asserts:

```js
assert.equal(mainWindow.decorations, false);
assert.equal(mainWindow.resizable, true);
assert.equal(mainWindow.minWidth, 1024);
assert.equal(mainWindow.minHeight, 768);
```

Run: `node --test scripts/test/desktop-integration-policy.test.mjs`

Expected: FAIL on `mainWindow.decorations` because the current configuration is decorated.

**Step 2: Apply the minimal configuration change**

Set the main window `decorations` value to `false`. Remove the macOS-only `titleBarStyle`, `trafficLightPosition`, and `hiddenTitle` fields because the window no longer uses a native title bar. Keep transparency, shadow, resizability, minimum sizes, and background throttling unchanged.

**Step 3: Run the policy test to verify it passes**

Run: `node --test scripts/test/desktop-integration-policy.test.mjs`

Expected: the new borderless-window test passes. If the Ubuntu MIME test still fails because WSL is unavailable, record that as the existing environment limitation and run the policy test with that test skipped only for local verification; do not change unrelated packaging behavior.

**Step 4: Commit the configuration policy**

```bash
git add scripts/test/desktop-integration-policy.test.mjs app/applications/tauri/src-tauri/tauri.conf.json
git commit -m "feat: enable Tauri borderless window policy"
```

### Task 5: Apply the borderless policy in Rust

**Files:**
- Modify: `app/applications/tauri/src-tauri/src/native_chrome.rs`

**Step 1: Add defensive runtime configuration**

At the start of `configure_native_window`, call `window.set_decorations(false)` and log a warning if it fails. Keep the existing macOS native background/vibrancy setup under its platform gates. Do not change the existing `ride_start_window_drag` or `ride_window_control` action contract.

The runtime call protects packaged builds if a platform-specific Tauri config merge changes later; the JSON configuration remains the source of initial window state.

**Step 2: Run Rust formatting and tests**

Run: `cargo fmt --manifest-path app/applications/tauri/src-tauri/Cargo.toml -- --check`

Run: `cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml`

Expected: formatting passes. Cargo may require the generated `app/applications/tauri/browser-frontend` directory because the existing Tauri build script validates `frontendDist`; if so, report that pre-existing missing-artifact limitation and continue with `cargo check` after the frontend build is available.

**Step 3: Commit the Rust initialization**

```bash
git add app/applications/tauri/src-tauri/src/native_chrome.rs
git commit -m "feat: enforce borderless Tauri window at runtime"
```

### Task 6: Style platform-specific controls and drag behavior

**Files:**
- Modify: `app/theia-extensions/product/src/browser/style/index.css`

**Step 1: Add the common control style**

Make `.ride-window-controls` visible only for `data-ride-runtime="tauri"`, mark it as a non-drag flex group, and keep it aligned within the 36px compact top bar. Keep browser preview controls hidden.

**Step 2: Add platform styles**

- macOS: left-side group, 13px circular controls, red/yellow/green colors, Codicon glyphs visible on hover/focus.
- Windows/Linux: right-side group, rectangular 34px hit targets, neutral minimize/maximize states, and a red close hover state.
- All buttons: `data-no-drag` behavior, visible keyboard focus, `cursor: default`, and no accidental top-panel drag.

Remove obsolete `.ride-native-window-spacer` rules and the old hidden Tauri `.ride-window-controls` override so the new controls are not suppressed.

**Step 3: Run frontend checks**

Run: `yarn --cwd app/theia-extensions/product test`

Run: `yarn --cwd app/theia-extensions/product build`

Expected: PASS with the controls represented in the compiled CSS/extension output.

**Step 4: Commit the visual implementation**

```bash
git add app/theia-extensions/product/src/browser/style/index.css
git commit -m "feat: style platform borderless window controls"
```

### Task 7: Full verification and Windows smoke check

**Files:**
- Modify only if verification exposes an implementation defect.

**Step 1: Run repository policy tests**

Run: `node --test scripts/test/desktop-integration-policy.test.mjs`

Expected: all relevant policy tests pass. The known Ubuntu MIME test may remain blocked when `wsl.exe` is not available on the host.

**Step 2: Run product extension checks**

Run: `yarn --cwd app/theia-extensions/product test`

Run: `yarn --cwd app/theia-extensions/product build`

**Step 3: Run Rust checks**

Run: `cargo fmt --manifest-path app/applications/tauri/src-tauri/Cargo.toml -- --check`

Run: `cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml`

Run: `cargo check --manifest-path app/applications/tauri/src-tauri/Cargo.toml`

**Step 4: Perform the Windows Tauri smoke test**

Build or launch the Tauri Windows app with the generated frontend available and verify:

- no system title bar or border is visible;
- controls are on the right in minimize/maximize/close order;
- top-panel drag moves the window;
- double-clicking empty top-panel space toggles maximize;
- each control performs its action;
- resizing from window edges still works;
- Windows snap/restore behavior remains usable;
- browser preview does not show Tauri controls.

**Step 5: Review and commit final verification changes**

Run: `git diff --check`

Run: `git status --short --branch`

Commit only any final fixes with a focused message, then report the exact verification results and any environment-only limitations.
