# Windows Startup Performance Design

## Context

The packaged Windows Tauri application is functionally healthy: the critical-file smoke scenario passes, the complete eight-step Codex App Server smoke scenario passes, and Codex remains an optional external CLI rather than an installed payload. A fresh five-run release measurement on the reference Windows host still fails the absolute startup policy:

- target file opened median: 2,965 ms (target: at most 2,200 ms)
- target file opened slowest: 3,029 ms (target: at most 3,000 ms)
- native window visible median: 1,000 ms (target: at most 800 ms)
- initial frontend JavaScript: 12.8 MB
- frontend/backend overlap median: 365 ms

Memory was not reported as a failing policy dimension. The current phase report attributes roughly 500 ms to Tauri runtime setup before the setup callback, roughly 490 ms to Windows WebView window construction, and the remaining critical-path cost to loading and initializing the initial Theia frontend.

## Goals

1. Reach all existing absolute Windows startup limits without relaxing policy thresholds.
2. Preserve the borderless custom title bar, platform-native control placement, Windows rounded corners and shadow, secondary windows, single-instance forwarding, and the Rust startup gateway.
3. Preserve Codex lazy activation, the JavaScript-only SDK compatibility bundle, and the no-bundled-CLI policy.
4. Keep settled whole-process-tree memory within the existing three-percent regression allowance.
5. Make every optimization independently measurable and reversible.

## Non-goals

- Replacing Tauri or WebView2.
- Bundling Codex CLI or downloading it during ordinary startup.
- Removing required editor, filesystem, workspace, terminal, SCM, search, or hosted-plugin behavior.
- Passing the gate by changing thresholds, omitting slow samples, or moving milestones earlier than the completed user-visible operation.

## Design

### 1. Optimize the Windows native window path first

The first experiment changes only Windows composition. The main window remains undecorated and continues to use the existing Rust commands and frontend title bar. Windows uses an opaque WebView surface and an explicit background color instead of full-window transparency. Rust applies the supported DWM corner preference and retains the native shadow so visual shape no longer depends on an alpha-composited full window. macOS transparency and vibrancy remain unchanged, and Linux keeps its current behavior.

The experiment is accepted only when an A/B release measurement shows a repeatable window-creation improvement and visual inspection confirms that restored, maximized, and resized windows still have correct corners, shadows, hit targets, and title-bar controls. If opacity does not materially improve the phase, the change is reverted before frontend work continues.

Existing startup phases remain authoritative. Additional phase detail may be added only as a versioned, strictly validated diagnostic field; instrumentation must not add synchronous disk or process work to startup.

### 2. Reduce the initial Theia frontend graph

The `tauri-critical` profile currently emits a 12.8 MB initial bundle and keeps many optional AI, registry, preview, and getting-started modules in the critical graph. The next optimization isolates non-editor product features behind inert frontend proxies and deferred chunks.

The first candidates are product-owned bindings that directly retain AI Registry, Getting Started, Preview, Mini Browser, and VSX Registry dependencies. Each candidate must satisfy all of these gates before it can leave the initial graph:

- its proxy performs no network, filesystem, SDK, CLI, process, timer, or service-resolution work at module evaluation;
- activation is triggered only by the corresponding command, view, or explicit user demand;
- the real contribution can register after Theia's initial contribution-provider read through the existing dynamic contribution adapter;
- required backend services remain available without starting optional frontend behavior;
- a real packaged smoke action proves activation, and profile metadata proves the implementation is absent from the initial entry;
- browser and full-profile behavior remain unchanged.

Candidates are migrated one at a time. Bundle bytes, bundle-load time, shell-attached time, target-open time, and settled memory are compared after every migration. A candidate that cannot meet the adapter and smoke requirements stays critical with an evidence-backed reason.

### 3. Preserve startup concurrency and ownership

The Rust gateway, backend startup, and WebView loading continue to overlap. No optimization may serialize backend readiness before window creation or defer ownership setup required for safe process-tree cleanup. Startup reporting remains tied to actual checkpoints:

- `native_window_visible` follows a successful `show`;
- `frontend_bundle_loaded` follows module script completion;
- `frontend_shell_attached` follows the attached Theia shell;
- `target_file_opened` follows successful editor open and activation.

Codex resolution, SDK import, App Server spawn, and managed-runtime probing remain outside startup and occur only after explicit Codex activation.

## Error handling and rollback

- Window-composition setup failures log a bounded diagnostic and keep a usable opaque borderless window.
- Deferred feature activation is idempotent, retryable after failure, and disposable during loading or activation.
- A failed experiment is reverted as its own commit; unrelated verified Codex and process-tree work is not rewritten.
- Generated Tauri schemas and performance artifacts are never committed as source changes.

## Verification

Each implementation slice follows RED-GREEN tests and then runs the relevant focused suite. Before completion, run:

1. repository script tests;
2. complete Product and Codex extension tests;
3. all extension builds and the `tauri-critical` backend build;
4. profile and Codex packaging inventory verification;
5. locked Rust tests for all targets;
6. production Tauri EXE, NSIS, and MSI builds;
7. packaged `critical-file` and complete `codex` smoke scenarios;
8. Codex warm activation gate;
9. a fresh five-run Windows startup and whole-tree memory campaign followed by the strict `rust-gateway` performance checker;
10. visual inspection of borderless restored, maximized, resized, and secondary windows.

Completion requires native-window median at most 800 ms, target-open median at most 2,200 ms, slowest target-open at most 3,000 ms, memory within policy, no forbidden Codex runtime payload, and a clean worktree.
