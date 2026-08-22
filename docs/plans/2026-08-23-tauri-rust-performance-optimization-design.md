# Tauri Rust Performance Optimization Design

## Context

R-IDE's Tauri shell already overlaps its Rust startup gateway with the frontend and Node backend. The latest packaged CI evidence shows that the gateway begins listening in roughly 18-31 ms, while the Windows native window becomes visible at roughly 790 ms and the target file opens at roughly 5,057 ms. Static inventory construction is therefore not the dominant startup cost.

The footer performance sampler is a clearer recurring Rust hot path. Every two seconds it refreshes every operating-system process, clones each process name and executable path, joins every command line, and only then filters the samples to the R-IDE process tree. On a busy workstation, most of that identity work is unrelated to R-IDE.

This design uses two coordinated tracks:

1. Reduce the recurring performance sampler cost with a two-phase, tree-selective collection pipeline.
2. Add measured Rust startup phase diagnostics, then optimize only phases proven to be Rust-controlled bottlenecks.

Build artifacts remain on `L:\R-IDE-builds` so the work does not refill the constrained C or E volumes.

## Goals

- Make expensive process identity collection proportional to the R-IDE tree size rather than the total system process count.
- Preserve the existing `ride_performance_snapshot` command payload, grouping rules, two-second polling cadence, and failure behavior.
- Preserve cross-platform behavior through `sysinfo`; do not introduce platform-specific process collectors in this iteration.
- Add enough startup phase evidence to distinguish Rust setup, backend spawn preparation, and native WebView construction.
- Apply startup changes only when the measured phase is controllable from this repository and the change preserves startup security and process ownership.
- Prevent performance regressions with deterministic cost-contract tests and packaged startup measurements.

## Non-goals

- Replacing `sysinfo` with Win32, `/proc`, or macOS-specific implementations.
- Persisting a process graph across samples.
- Changing the footer layout or frontend polling cadence.
- Weakening static asset identity checks, gateway path validation, backend Job Object ownership, or shutdown cleanup.
- Promising that Rust changes can remove operating-system WebView initialization time.
- Adding a heavyweight benchmark framework before deterministic tests demonstrate a need for one.

## Considered Approaches

### 1. Two-phase sampling and measured startup optimization

Refresh lightweight usage and topology for all processes, discover the R-IDE descendants, and fetch executable and command-line identity only for those descendants. Add backward-compatible startup diagnostics and use same-host measurements to select any startup implementation change.

This is the selected approach. It gives a structural reduction in recurring work without stale caches or new platform-specific code, and it keeps startup work evidence-driven.

### 2. Persistent process graph and identity cache

Cache the process graph and identity strings across samples, updating only observed changes. This may reduce work further, but PID reuse, missed parent changes, process churn, and stale classification make correctness substantially harder. `sysinfo` already caches fields requested with `OnlyIfNotSet`, so another long-lived identity cache would duplicate responsibility.

### 3. Native per-platform collectors and launchers

Use Toolhelp/NT APIs on Windows, `/proc` on Linux, and native process APIs on macOS, and move more backend launch work into platform-specific implementations. This offers the highest theoretical performance ceiling but triples the correctness and maintenance surface. It is not justified by the current measurements.

## Runtime Sampling Architecture

### Source contract

Refactor the internal `ProcessSource` contract into explicit stages:

- Refresh CPU, resident memory, PID, parent PID, start data, and process names for all processes without requesting command lines, executable paths, or tasks.
- Expose lightweight topology records without allocating identity strings.
- Refresh identity fields for an explicit PID slice with `ProcessesToUpdate::Some` and `UpdateKind::OnlyIfNotSet`.
- Materialize full `ProcessSample` values only for the selected R-IDE PIDs.

The production `System` implementation continues to use `sysinfo`. The first refresh uses `ProcessRefreshKind::nothing().with_cpu().with_memory().without_tasks()`. Parent PID and process name remain available under the documented `sysinfo` minimum process facts. The second refresh requests only command line and executable path for the selected PIDs.

### Data flow

1. Lock the sampler state so snapshots cannot overlap.
2. Perform the lightweight all-process refresh and reject an empty refresh as today.
3. Build a lightweight parent-to-children relation from unique PID records.
4. Starting at the current Tauri PID, traverse descendants with a visited set. Cycles terminate safely.
5. Reject the sample if the root PID is absent.
6. Selectively refresh identity fields for the discovered PID set.
7. Materialize full samples for only those PIDs.
8. Aggregate CPU, memory, count, and role groups using the existing classification rules.

The backend PID is a classification hint, not a second traversal root. A backend PID that is not a verified descendant remains excluded.

### Allocation control

The first implementation eliminates executable and command-line allocations for unrelated processes. Scratch vectors, sets, and maps are retained inside the mutex-protected sampler state and cleared between samples so their capacities can be reused. No process identity or topology survives as valid data across refreshes.

For a machine with `N` processes and an R-IDE tree containing `K` processes, topology work remains `O(N)`, because a complete parent relation is required, while expensive identity materialization becomes `O(K)` instead of `O(N)`.

### Correctness and errors

- If the all-process refresh returns zero entries, return the existing unavailable error.
- If the root process is missing, return the existing root-absent error.
- If selective identity refresh fails, return an error instead of publishing a stale snapshot.
- If a selected process exits between stages, omit it unless it is the root; if the root disappears, return root-absent.
- Duplicate PID facts are rejected from traversal, and cycles are bounded by the visited set.
- Do not cache a parent relation or PID identity across samples, preventing stale PID-reuse edges.

The serialized frontend contract does not change.

## Startup Diagnostics Architecture

### Report compatibility

Introduce startup report schema version 3 while retaining parsers and validators for versions 1 and 2. Version 3 adds a `rustPhases` object; existing milestone names and semantics remain unchanged.

The diagnostic phase timestamps are elapsed milliseconds from `process_started`:

- `runtime_paths_resolved`
- `gateway_inventory_finished`
- `tauri_setup_entered`
- `backend_spawn_requested`
- `window_build_started`
- `window_built`
- `window_shown`

These are diagnostics rather than user-visible completion milestones. Their validation uses only real ordering constraints. Gateway inventory can overlap Tauri builder initialization, so the report must not impose a false total order across concurrent branches.

Phase recording uses the existing monotonic startup clock and is active only when startup reporting is requested. Duplicate records keep the first value, matching existing milestone behavior.

### Measurement and decision flow

1. Run the packaged Windows startup campaign five times on the same host and configuration.
2. Compare phase medians and the slowest valid run.
3. Attribute time to:
   - pre-Tauri runtime path and gateway preparation;
   - Tauri builder/setup entry;
   - backend command and ownership preparation before process spawn;
   - native window/WebView construction and showing.
4. Select a Rust-controlled phase only if it has material cost and a safe repository-owned implementation path.
5. Implement one bounded optimization and rerun the same campaign.

Candidate changes may include removing duplicate filesystem validation, reusing already-resolved runtime facts, or moving independent noncritical work out of the window-construction path. Pre-spawning an unowned backend, weakening Job Object assignment, skipping static identity checks, or hiding a window before it is ready are excluded.

If the evidence attributes the remaining delay to WebView or operating-system initialization, this track ends with documented evidence rather than a speculative code change.

## Performance Contracts

### Sampler

- A synthetic source with thousands of unrelated processes must request expensive identity fields for exactly the reachable R-IDE tree.
- Snapshot totals and role grouping must match the existing behavior for the same tree.
- Increasing unrelated process count must not increase identity materialization count.
- The command payload remains byte-shape compatible with existing frontend validation.

### Startup

- Version 1 and version 2 reports remain accepted by measurement and performance-check tooling.
- Version 3 reports require the exact diagnostic keys applicable to the measured startup mode.
- Diagnostics must add no more than 10 ms to the same-host native-window median.
- A startup implementation change must reduce a measured Rust-controlled phase median by at least 15 percent, or provide an equivalent end-to-end improvement, without regressing target-file time, memory, gateway use, or cleanup behavior.

CI runner timings are evidence, not stable microbenchmark clocks. Deterministic structural tests gate CI; same-host packaged campaigns validate timing claims.

## Testing Strategy

Development follows test-driven development:

1. Add failing sampler tests for selective identity requests and output equivalence.
2. Add churn tests for root exit, child exit between stages, duplicate facts, cycles, and unrelated PID reuse.
3. Implement the minimum staged source contract and production `sysinfo` adapter.
4. Run focused Rust tests, then the full Tauri Rust suite, formatting, and Clippy.
5. Add failing Rust and JavaScript tests for startup report version 3, phase ordering, exact keys, and v1/v2 compatibility.
6. Instrument the startup path and verify report generation.
7. Run the packaged Windows campaign, select a bounded optimization, add a regression test for it, and repeat the campaign.
8. Run the existing Linux, macOS, and Windows CI/release verification before claiming completion.

## Disk and Build Safety

- Set `CARGO_TARGET_DIR=L:\R-IDE-builds\ride-rust-performance-target` for local Rust builds.
- Keep incremental compilation disabled for large verification builds when disk pressure warrants it.
- Check free space before and after packaged campaigns.
- Clean only the task-specific target directory with `cargo clean --target-dir`; do not recursively delete broad cache or workspace directories.

## Delivery

Deliver the work as small reviewable commits:

1. Sampler cost-contract tests and two-phase implementation.
2. Startup report v3 diagnostics and compatibility tests.
3. Evidence-selected startup optimization, if a Rust-controlled hotspot is proven.
4. Measurement evidence and documentation updates.

Each commit must preserve the existing gateway security model, backend process-tree ownership, and cross-platform build contracts.
