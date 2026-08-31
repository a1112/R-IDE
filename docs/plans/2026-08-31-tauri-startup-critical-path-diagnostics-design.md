# Tauri Startup Critical-Path Diagnostics Design

## Context

The current Windows Tauri branch is functionally healthy and reproducible:

- repository script tests pass;
- Product and Codex extension tests pass;
- Rust formatting, Clippy, unit, integration, and documentation tests pass;
- the packaged `critical-file` and eight-step `codex` smoke scenarios pass;
- frontend and backend profile manifests are byte-identical and bind commit `d4f6d00`.

The final three-run SSD measurement remains above the existing absolute startup target:

- target file opened: 2,312 / 2,330 / 2,324 ms, median 2,324 ms;
- native window visible median: 408 ms;
- frontend bundle loaded median: 728 ms;
- backend listening median: 1,346 ms;
- frontend shell attached median: 1,931 ms;
- settled whole-process-tree RSS median: 1,349,664,768 bytes.

The remaining 124 ms policy gap cannot be assigned safely from the coarse milestones. Previous attempts to overlap native open-request setup, defer more backend features, and precompress frontend assets did not improve the end-to-end target and were reverted.

## Goals

1. Attribute the `backend_listening -> frontend_shell_attached -> target_file_opened` critical path without moving existing milestones.
2. Keep diagnostics completely disabled during normal startup.
3. Record only fixed phase identifiers and monotonic durations; never persist paths, commands, environment values, ports, process text, or user content.
4. Add negligible work when enabled and zero synchronous filesystem work on the frontend thread.
5. Use a five-run SSD campaign to select at most one independently reversible optimization.

## Non-goals

- Relaxing the 2,200 ms startup target.
- Treating an earlier diagnostic checkpoint as `target_file_opened`.
- Repeating reverted open-request overlap, Brotli, optional-AI, or Codex-backend experiments unchanged.
- Adding telemetry, network reporting, or ordinary-user diagnostic files.
- Changing Codex CLI packaging, SDK lazy loading, window composition, or process ownership.

## Design

### 1. Separate opt-in diagnostic report

The strict `ride.startup-report@3` schema remains unchanged. A second report,
`ride.startup-critical-path-diagnostics@1`, is enabled only when the native
process receives an explicit harness-owned diagnostic output path.

Rust owns the report path and process-relative monotonic clock. The frontend can
submit only a closed enum of diagnostic phases through a dedicated Tauri
command. The command accepts no path, timestamp, text, numeric duration, or
arbitrary metadata from JavaScript. Rust timestamps the accepted phase on
receipt, rejects duplicates and invalid ordering, and publishes bounded JSON
through the existing asynchronous startup-writer pattern.

When the diagnostic environment variable is absent, recorder construction,
command handling, and frontend calls are no-ops. Normal startup does not create
or inspect a diagnostic path.

### 2. Closed frontend phase graph

The first diagnostic version records checkpoints around the observed gaps:

- `frontend_initialization_started`;
- `attached_shell_resolved`;
- `workspace_ready`;
- `native_listener_installed`;
- `initial_request_selected`;
- `target_open_started`;
- `target_model_resolved`;
- `target_widget_activated`;
- `target_milestone_requested`.

Each phase has explicit predecessors. Optional restore and native-request
branches use the same terminal sequence once a request is selected. Empty
workspace startup may stop after listener installation and remains a valid
partial diagnostic report.

The existing milestones remain authoritative:
`frontend_shell_attached` still follows shell attachment and
`target_file_opened` still follows successful editor activation.

### 3. Harness-owned campaign output

`measure-tauri-startup.mjs` gains an optional companion-output argument. For
each run it creates a private diagnostic destination, passes it only to the
spawned application, waits for a predecessor-closed diagnostic snapshot, and
validates process identity and build identity against the ordinary startup
report.

The ordinary `ride.startup-measurement@4` artifact remains unchanged. The
companion artifact contains per-run phase timestamps, derived adjacent-phase
durations, and medians. It inherits the existing sensitive-path redaction,
process cleanup, timeout, and atomic-output guarantees.

### 4. Evidence-selected optimization

After instrumentation passes all focused tests, build one release runtime and
run five SSD samples. Select the largest stable frontend segment only when its
median is at least 100 ms and its slowest/fastest spread is bounded enough to
distinguish a code change from host noise.

Implement one minimal optimization against that segment, then run interleaved
control/candidate measurements. Retain it only if:

- target-open median improves by at least 100 ms;
- no individual run exceeds 3,000 ms;
- native-window median remains at most 800 ms;
- whole-tree RSS does not regress beyond the existing allowance;
- critical and Codex packaged smoke still pass;
- startup and diagnostic schemas remain strict and path-free.

Otherwise revert the candidate and preserve only the diagnostic capability.

## Error handling and security

- Diagnostic file setup failure disables diagnostics and emits one bounded
  static warning; it never blocks startup.
- Unknown, duplicate, out-of-order, or post-terminal phases are rejected without
  changing recorder state.
- Frontend diagnostic invocation failures are consumed and cannot block shell
  attachment, target opening, plugin startup, or disposal.
- The harness owns cleanup of partial diagnostic files and never follows
  symlinks or reparse points.
- Report contents are bounded by the closed phase set, so repeated calls cannot
  grow memory or disk usage.

## Verification

1. RED-GREEN Rust tests for phase ordering, duplicate handling, disabled
   behavior, bounded asynchronous publication, and strict serialization.
2. RED-GREEN Product extension tests proving phase placement and non-blocking
   failures.
3. RED-GREEN measurement-script tests for companion argument parsing, private
   per-run paths, process/build binding, strict report parsing, cleanup, and
   sensitive-path redaction.
4. Full script, Product, Codex, Rust, profile, and packaging gates.
5. Fresh packaged `critical-file` and `codex` smoke scenarios.
6. Five-run SSD diagnostic campaign, followed by one evidence-selected A/B
   candidate or an explicit no-change conclusion.

