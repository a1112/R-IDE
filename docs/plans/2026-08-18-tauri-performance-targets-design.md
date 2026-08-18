# R-IDE Tauri Performance Targets Design

**Status:** Approved on 2026-08-18

**Base:** PR #4 head `34345be` (`codex/tauri-borderless-window`)

## Goal

Reduce packaged Tauri startup latency and idle whole-process-tree memory without removing R-IDE features or weakening the existing four-platform packaging contract.

The acceptance targets are measured on the same Windows x64 host and workload as the pre-optimization baseline:

- Median time to an editable target file: at most **3,717 ms**, a gain of at least 30% from 5,310 ms.
- Median idle whole-process-tree resident memory: at most **1,038,739,046 bytes**, a gain of at least 10% from 1,154,154,496 bytes.
- The complete Windows, macOS x64, macOS arm64, and Linux CI package matrix remains green.
- Core editing and the existing plugin graph continue to work. Deferred features remain available on demand.

## Measured context

The pre-optimization baseline is stored in `app/applications/tauri/perf/baselines/pre-optimization-windows-x64-d034943.json`. A fresh five-run candidate built from `34345be` on the same machine produced:

| Metric | Baseline | PR #4 candidate | Change | Required |
| --- | ---: | ---: | ---: | ---: |
| Median target file opened | 5,310 ms | 4,311 ms | 18.81% faster | at least 30% faster |
| Median idle process-tree RSS | 1,154,154,496 B | 1,179,987,968 B | 2.24% worse | at least 10% lower |
| Process count | 14 | 13 | 1 fewer | diagnostic only |

The median startup phase comparison is:

| Phase | Baseline | PR #4 candidate | Observation |
| --- | ---: | ---: | --- |
| Window | 502 ms | 820 ms | 318 ms regression |
| Backend spawn | 29 ms | 15 ms | improved |
| Backend listen | 855 ms | 967 ms | 112 ms regression |
| Frontend | 849 ms | 579 ms | improved |
| Open target | 3,039 ms | 1,916 ms | improved but remains the largest phase |

The candidate needs about another 594 ms of startup reduction and about 141 MB of RSS reduction. A role sample attributes roughly 733 MiB to the WebView2 process family, including a roughly 409 MiB renderer. Backend heap-only tuning from the current 768 MiB maximum to 512 MiB did not materially improve either target.

The first local candidate measurement failed because the release executable was stale and predated the Windows sidecar path normalization fix. Rebuilding the current source corrected that failure; no new sidecar code change is part of this design.

## Chosen approach

Use a dependency-closure-aware Tauri frontend profile and move noncritical work out of the initial editor path. This combines bundle-graph reduction with lifecycle sequencing because either change by itself is unlikely to satisfy both the startup and memory targets.

The implementation has four connected parts:

1. Strengthen the measurement contract so reports identify the exact build/profile and split memory by process role.
2. Replace the disabled substring-based lean filter with a deterministic, validated Tauri frontend dependency closure.
3. Resolve and deploy hosted plugins only after the requested file is editable, with bounded and demand-triggered fallbacks.
4. Load noncritical feature groups on demand while retaining an explicit complete-graph fallback for diagnosis and cross-platform comparison.

## Measurement contract

The startup benchmark remains a five-run packaged-application campaign. Its JSON report will additionally record:

- Git/build identity.
- Frontend profile name and manifest digest.
- Included critical extensions and deferred feature groups.
- Packaged plugin manifest digest and plugin count.
- Per-role process count and resident memory for the Tauri main process, Node backend, plugin host/plugin children, WebView host/renderer/GPU/utilities, terminals, and other descendants where the platform exposes sufficient process metadata.

Absolute percentage gates are valid only when baseline and candidate have matching platform, architecture, workload, profile contract, and host identifier. CI runner results provide package smoke coverage and severe-regression detection; they are not compared to the local Windows baseline as if the machines were equivalent.

The benchmark must reject incomplete or mismatched metadata rather than silently comparing incompatible reports.

## Deterministic Tauri frontend profile

The current production build forces `RIDE_TAURI_LEAN=0`. The old lean implementation edits generated JavaScript line by line and removes modules by string prefix. It was disabled after removing transitive frontend modules required by retained plugin contributions. Simply turning it back on is unsafe.

The replacement profile is declared as data and resolved before bundling:

- A critical root list describes the editor shell, workspace/filesystem, preferences, menus/commands/keybindings, text editor, terminal, SCM/Git, search, diagnostics, custom R-IDE contributions, and the plugin infrastructure required by packaged VS Code plugins.
- A deferred feature list describes AI, collaboration, notebooks, previews, getting-started, memory inspection, hierarchy/timeline, secondary-window, VSX browsing, and other noncritical feature groups.
- A resolver walks exact workspace package dependency edges from critical roots and records the complete transitive frontend/backend closure required by those roots.
- A validator fails the build if a retained contribution imports a module outside the resolved closure, if a root is unknown, or if critical and deferred declarations conflict.
- Generated Theia files are created from the resolved extension set or transformed structurally from exact module records. Arbitrary line and substring deletion is removed.
- The resolved profile and digest are emitted as a build artifact for startup reports and CI inspection.

The production default is the validated Tauri profile. A complete graph remains available only through an explicit build setting such as `RIDE_TAURI_FRONTEND_PROFILE=full`; it is not an automatic fallback for validation failures.

## Startup sequencing

The current open-request lifecycle calls `startHostedPluginResolution()` immediately after `attached_shell`, before reporting `frontend_shell_attached` and before opening the requested file. Plugin milestones occur only a few milliseconds after `target_file_opened`, showing that plugin work already competes with the critical open phase.

The new sequence is:

```text
attach shell
  -> report frontend_shell_attached
  -> initialize native open-request listener and workspace
  -> open and activate requested target
  -> report target_file_opened
  -> yield to the UI/event loop
  -> resolve hosted plugin support
  -> observe and deploy plugins
```

Startup without a target file schedules the same plugin path after a bounded fallback delay so an empty window still becomes fully functional. A user action that requires plugins cancels that delay and starts resolution immediately. Resolution and deployment are idempotent, and disposal cancels pending work.

The `target_file_opened` milestone continues to mean that the target widget has been opened and activated. Deferred plugin work must not be hidden inside work awaited before that milestone.

## Deferred feature activation

Deferred modules are not deleted. Their commands, menus, file-type handlers, or other activation surfaces use a small registration layer that loads the corresponding feature chunk on first demand. Multiple concurrent requests share one activation promise. Successful activations are cached; failures are surfaced to the user and remain retryable without preventing core editor startup.

If a Theia feature cannot safely be runtime-loaded because its contribution must be registered during container construction, it is moved into an optional secondary frontend entry or an isolated activation package. It must not be reintroduced into the critical bundle merely to bypass the profile validator.

The initial deferred candidates are:

- AI and AI history/chat integrations.
- Collaboration.
- Notebook UI and notebook-specific renderers.
- Editor preview and getting-started content.
- Memory inspector, hierarchy/timeline, ScanOSS, secondary-window, toolbar extensions, and VSX browsing.

Each candidate is retained or deferred based on measured bundle/process impact and a feature smoke test, not name matching alone.

## Failure handling and fallback

- Missing dependency-closure edges fail the build with the requiring and missing package names.
- A malformed or stale profile manifest fails packaging.
- Deferred activation errors do not block the editor; they produce a bounded diagnostic and a retryable user-facing error.
- Hosted-plugin resolution errors preserve the existing plugin error path and do not invalidate an already opened editor.
- The no-file fallback has a maximum delay and can be forced immediately by demand.
- The full frontend graph is selected only by an explicit setting and is covered by a smoke build so it cannot silently rot.
- Startup reports redact environment and run identifiers as they do today.

## Testing strategy

### Unit and policy tests

- Dependency-closure resolution, stable ordering, cycle handling, unknown roots, conflict detection, and manifest digesting.
- Build-plan selection of the Tauri profile and explicit full fallback.
- Removal of the old line-based mutation path.
- Open-request ordering, one-shot plugin resolution, target-file and no-file paths, demand-triggered activation, timeout cancellation, and disposal.
- Startup report schema, role aggregation, compatibility rejection, and comparison thresholds.

### Build and integration tests

- Build the Tauri-profile browser frontend and verify its included/deferred inventory against the emitted manifest.
- Build the full fallback profile and verify plugin infrastructure remains present.
- Package and launch Tauri, open a real target file, and confirm editing before deferred plugin startup.
- Smoke core editing, terminal, SCM/Git, search, packaged VS Code plugin activation, and at least one feature from every deferred group.
- Verify there are no sidecar startup errors and that cleanup leaves no measured descendants.

### Performance and CI

- Run five packaged Windows x64 measurements against the checked-in baseline on the same host.
- Require median startup at or below 3,717 ms and median idle RSS at or below 1,038,739,046 bytes.
- Preserve the Windows, macOS x64, macOS arm64, and Linux package matrix and artifact uploads.
- Treat platform CI measurements as trend artifacts and severe-regression guards until each platform has a controlled same-host baseline.

## Rollout

1. Land report metadata and role-based memory diagnostics without changing the runtime graph.
2. Correct hosted-plugin sequencing and benchmark it independently.
3. Introduce the validated dependency-closure profile behind an explicit build selection while keeping the full profile available.
4. Make the validated Tauri profile the package default after functional smoke tests pass.
5. Run the same-host five-run benchmark and profile remaining renderer/backend costs if either target is missed.
6. Keep the change unmerged until all four platform jobs and the full-profile fallback smoke pass.

## Rejected alternatives

### Lifecycle-only tuning

Delaying plugin deployment should improve time to the first editable file, but the WebView renderer dominates the measured memory tree. It is unlikely to remove the required 141 MB by itself.

### Re-enable the old lean filter

The prefix and line-based filter already broke required transitive plugin modules. It cannot prove dependency completeness and creates source-generation-order sensitivity.

### Backend heap limit only

A 512 MiB backend heap experiment was effectively unchanged from the candidate. The current idle RSS is not driven by committed V8 heap capacity alone.

### Compare local baselines directly with hosted CI

The GitHub Windows artifact used different hardware and reported materially different latency and memory. Cross-machine absolute percentage claims would be invalid.

## Non-goals

- Removing existing user-facing capabilities.
- Replacing Tauri or Theia.
- Treating process count alone as a success metric.
- Changing the footer sampling interval as the primary memory optimization.
- Weakening plugin dependency validation or CI coverage to make the bundle smaller.
