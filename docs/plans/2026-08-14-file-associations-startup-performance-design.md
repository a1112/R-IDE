# File Associations and Startup Performance Design

**Date:** 2026-08-14  
**Status:** Approved  
**Target:** R-IDE Tauri desktop application on Windows, macOS, and Linux

## Context

R-IDE currently has a Tauri single-instance plugin, but the callback only focuses the existing window. Paths delivered by an operating-system file-open request are discarded. The packaged application also does not declare itself as an editor for common source-code and configuration formats.

The current cold-start path already includes a lean Theia build, a bounded Node heap, an in-process filesystem watcher, and a lightweight bootstrap page. Remaining avoidable work includes repeated runtime resource discovery, a dedicated full Tokio runtime, unconditional pseudo-terminal setup for the backend, log-regex readiness detection, and plugin deployment competing with the first editor render.

This design adds reliable file activation and optimizes the same critical path. It deliberately avoids a persistent daemon because that would improve later launches at the cost of idle memory and background processes.

## Goals

- Register R-IDE as an alternate editor for common code, configuration, documentation, and workspace files.
- Support initial launch, an already-running single instance, and macOS open-file events.
- Reuse the existing window. A file's parent directory becomes the workspace and the requested file is focused.
- Make the core editor interactive before non-critical plugin and restoration work.
- Reduce the median cold process start-to-editable time by at least 30% on a reference machine.
- Reduce whole-process-tree idle memory, measured 30 seconds after editor readiness, by at least 10%.
- Preserve safe shutdown, current lean language support, and unsigned cross-platform packaging.

## Non-goals

- Forcing R-IDE to become the user's default editor.
- Running a persistent background backend after the window closes.
- Replacing Theia's workspace model or implementing a separate single-file editor.
- Comparing absolute performance numbers between different GitHub-hosted runner types.
- Associating generic `.txt` and `.log` files.

## Chosen Approach

Use a native launch-intent coordinator in Rust, a small Theia frontend bridge, Tauri bundle file-association declarations, and a measured two-phase startup pipeline.

The alternative config-only approach cannot reliably open files in an already-running instance and provides only small startup gains. A resident backend would improve repeat launches but contradicts the resource goal.

## Launch Intent Model

The Rust layer owns a typed request:

```rust
struct LaunchIntent {
    id: u64,
    source: LaunchSource,
    workspace: PathBuf,
    files: Vec<PathBuf>,
}

enum LaunchSource {
    InitialArgs,
    SingleInstance,
    OpenedEvent,
}
```

The model is intentionally narrower than raw command-line arguments. It cannot contain commands, arbitrary URLs, or shell fragments.

### Parsing rules

- Skip the executable argument and recognized application flags.
- Resolve a relative path against the current working directory supplied with that request. The single-instance callback's `cwd` is authoritative for forwarded requests.
- Accept existing regular files and supported workspace files.
- Canonicalize paths once, retaining valid Windows drive and UNC paths.
- Convert `file:` URLs from an OS open event into local paths. Reject all other URL schemes.
- Reject paths containing NUL, paths that cannot be represented as a frontend file URI, and nonexistent targets.
- Deduplicate canonical paths while preserving request order.
- The first file's parent directory determines the workspace. Additional valid files open as tabs, including files outside that directory.
- Assign a monotonically increasing request ID. The frontend records the last consumed ID so retries cannot open duplicate tabs.

## Activation Flow

### First launch

1. Record the process start timestamp before constructing Tauri.
2. Parse initial arguments into an optional `LaunchIntent`.
3. Build the native window and display the lightweight bootstrap immediately.
4. Initialize `AppState`, including a `VecDeque<LaunchIntent>` and frontend readiness state.
5. Start the Theia backend with the intent workspace as its positional workspace argument.
6. Detect backend readiness and navigate the main WebView to the loopback frontend.
7. The product frontend reports that the shell is attached.
8. Rust emits the queued typed `ride-open-request` event.
9. The frontend opens and focuses the requested file through Theia's `OpenerService`.

### Existing instance

The Tauri single-instance plugin remains the first registered plugin. Its callback parses the forwarded `args` with the forwarded `cwd`, enqueues the intent, restores and focuses the main window, then emits the request immediately if the frontend is ready.

If the request targets a different workspace, the frontend stores the request in `sessionStorage`, asks `WorkspaceService` to switch the current window, and consumes the request once after the frontend reload. No second backend or window is created.

### macOS open event

Tauri `RunEvent::Opened` file URLs are normalized into the same queue. The path is therefore handled identically whether Finder starts R-IDE or sends a request to an existing process.

## File Associations

`bundle.fileAssociations` declares R-IDE as an editor with alternate rank where the platform supports ranking. Installers add an available handler without replacing the user's explicit default choice.

Associations are grouped by meaningful MIME/content types instead of registering all extensions as `text/plain`, which would claim unrelated text files on Linux.

Supported extensions:

- R: `r`, `rmd`, `qmd`
- Python: `py`, `pyw`
- JavaScript and TypeScript: `js`, `mjs`, `cjs`, `jsx`, `ts`, `mts`, `cts`, `tsx`
- JVM and systems languages: `java`, `kt`, `kts`, `c`, `h`, `cc`, `cpp`, `cxx`, `hpp`, `cs`, `rs`, `go`
- Web: `html`, `htm`, `css`, `scss`, `less`, `vue`, `svelte`
- Scripts and data: `sh`, `bash`, `zsh`, `fish`, `ps1`, `psm1`, `bat`, `cmd`, `sql`
- Configuration and documentation: `json`, `jsonc`, `yaml`, `yml`, `toml`, `xml`, `ini`, `properties`, `md`, `markdown`
- Workspaces: `theia-workspace`, `code-workspace`

Platform verification inspects generated installer metadata:

- Windows: installer association/ProgID entries use a quoted executable and `%1`, and do not write a `UserChoice` default.
- macOS: `CFBundleDocumentTypes` declares the application as an alternate editor.
- Linux: the generated desktop entry contains recognized MIME types and a multi-file placeholder.

## Component Boundaries

### Rust `launch_intent`

Pure parsing, normalization, deduplication, workspace selection, and queue operations. Most behavior is unit-testable without a WebView or live backend.

### Rust `startup`

Owns immutable runtime paths, startup milestones, backend spawning/readiness, and process lifecycle. It receives a workspace from `LaunchIntent` but does not open editor widgets.

### Existing `AppState`

Adds the pending intent queue, frontend readiness flag, startup recorder, and backend lifecycle state. Locks remain short-lived; filesystem and process work never occurs while a mutex is held.

### Theia product contribution

Listens for `ride-open-request`, switches workspaces when necessary, opens files with `OpenerService`, focuses the editor widget, and acknowledges the consumed request ID. It also restores one pending request from `sessionStorage` after a workspace reload.

### Tauri configuration

Owns only declarative association metadata and the explicit background throttling policy. It does not contain platform-specific scripts that mutate user defaults.

## Cold-start Pipeline

### Critical phase

Only the following work is allowed before the target file is editable:

1. Parse the launch intent.
2. Create and reveal the bootstrap window.
3. Resolve immutable runtime paths once.
4. Spawn the backend.
5. Wait for loopback readiness.
6. Attach the Theia shell and open the requested file.

Runtime paths use `AppHandle::path().resource_dir()` in packaged builds. Ancestor scanning remains available only as an explicit development fallback. The resolved backend, frontend, plugin, runtime, and configuration paths are cached in one `RuntimePaths` value.

The backend uses direct stdout/stderr pipes and the existing Tauri async runtime when cross-platform smoke tests confirm equivalent lifecycle behavior. The current pseudo-terminal implementation remains a platform fallback until Windows, macOS Intel/ARM, and Linux tests prove it unnecessary. Readiness uses a bounded loopback health probe on the configured port instead of compiling and running regular expressions for every log line.

### Deferred phase

Plugin deployment is scheduled after the core editor has rendered the requested file, with a short upper-bound timer so a launch without a file also progresses. The current lean plugin profile remains the default. This changes ordering, not the set of shipped language plugins: text appears first and syntax/plugin contributions may appear shortly afterward.

Layout/demo restoration, update checks, and other product-only tasks start after the same frontend-ready milestone. A plugin-dependent action can request immediate deployment rather than waiting for the timer.

### Resource policy

- Do not create a second Tokio runtime for the backend.
- Avoid a pseudo-terminal, its reader thread, and related native dependency where platform tests allow direct pipes.
- Preserve `--no-cluster` so the filesystem watcher stays in process.
- Keep a bounded Node old-space value. Lower it only if benchmark data shows no GC/startup regression.
- Explicitly suspend the background WebView when minimized/hidden.
- Terminate the Node backend and descendants when the application exits; no daemon survives the window.

## Failure Handling

- Invalid or missing file: focus R-IDE, discard only that target, log a structured warning, and show a non-blocking frontend notification when possible.
- Unreadable file: keep the selected workspace and report that the editor could not open the file.
- Workspace switch failure: retain the current workspace and keep one retryable pending request.
- Backend startup timeout: show a native/bootstrap error state with the diagnostics path rather than navigating to an unavailable port.
- Deferred plugin failure: keep the core text editor usable and record the plugin deployment error.
- Duplicate event: acknowledge the already-consumed request without reopening the file.
- Queue overflow: cap pending requests, preserve newest user actions, and log discarded IDs.

## Performance Instrumentation

Rust records monotonic timestamps for:

- `process_started`
- `native_window_visible`
- `backend_spawned`
- `backend_listening`
- `frontend_shell_attached`
- `target_file_opened`
- `plugins_started`
- `plugins_ready`

The frontend reports its milestones through a narrow Tauri command. A benchmark runner launches a release bundle with a temporary code file, waits for the target-file milestone, samples the whole process tree after 30 idle seconds, and writes JSON containing platform, architecture, commit, per-phase duration, RSS/private working set where available, and child-process counts.

Five launches are recorded and the median is used. CI uploads reports and rejects severe same-platform regressions; it does not compare absolute values across runner images. The implementation target is at least 30% lower median start-to-editable time and 10% lower idle process-tree memory than the pre-change release baseline.

## Test Strategy

### Rust unit tests

- Initial, forwarded, and opened-event argument forms.
- Relative paths with a supplied working directory.
- Unicode, spaces, Windows drive paths, and UNC paths.
- File URL conversion and rejection of non-file schemes.
- Missing files, directories, unsupported values, duplicates, and queue bounds.
- First-file workspace selection and multiple-file ordering.
- Startup milestone ordering and one-time request acknowledgement.

### Frontend unit tests

- Same-workspace open and focus.
- Different-workspace handoff through `sessionStorage`.
- Multiple files and duplicate request IDs.
- Missing/unreadable file notifications.
- Deferred plugin trigger after target-file render and immediate trigger on demand.

### Packaging policy tests

- The association extension inventory is complete and contains no generic `txt`/`log` claim.
- The single-instance plugin remains first.
- Windows/macOS/Linux bundle metadata contains the expected editor registrations.
- Application flags and file paths remain quoted and cannot become command options.

### Cross-platform smoke tests

On each packaging runner:

1. Build the release bundle.
2. Inspect the generated association metadata.
3. Launch R-IDE with a temporary code file and assert the target-file milestone.
4. Send a second file while the first instance is running and assert the same process consumes it.
5. Verify shutdown leaves no backend descendant.
6. Upload the performance report.

## Rollout

The work is split so file activation is correct before performance internals change. Direct-pipe backend startup and deferred plugin deployment each land behind focused regression tests and retain a fallback until the full desktop matrix succeeds. Performance claims are made only after comparing release-build reports against a captured baseline.

## References

- [Tauri v2 bundle file association configuration](https://v2.tauri.app/reference/config/#fileassociation)
- [Tauri v2 single-instance plugin](https://v2.tauri.app/plugin/single-instance/)
- [Tauri v2 frontend event communication](https://v2.tauri.app/develop/calling-frontend/)
