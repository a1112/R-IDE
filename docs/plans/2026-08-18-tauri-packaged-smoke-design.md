# R-IDE Tauri Packaged Smoke Design

**Status:** Approved on 2026-08-18

**Base:** `origin/main` at `4104cc1`

## Goal

Add a repeatable Windows packaged-application smoke test that proves the installed R-IDE runtime can start, exercise representative core and deferred capabilities, forward a second file activation to the existing window, and shut down without leaving owned descendants. Preserve the existing four-platform build and static package verification matrix.

The first implementation covers Windows interactive execution. macOS x64, macOS arm64, and Linux continue to build and validate the same smoke protocol, profile inventory, and packaged resources without attempting fragile hosted-runner desktop interaction.

## Chosen approach

Use a hybrid runner:

1. An external Node.js runner owns temporary inputs, launches the real packaged executable, starts the second instance, captures bounded logs, enforces timeouts, and verifies process cleanup.
2. A narrowly scoped, opt-in smoke protocol lets the packaged Tauri and Theia layers execute semantic application actions after normal startup.
3. The application writes a versioned, bounded JSON report whose steps can be validated independently of window focus and WebView2 accessibility behavior.

This retains real executable, sidecar, frontend, plugin, single-instance, and process-lifecycle coverage while avoiding a test that depends entirely on Windows UI Automation selectors and timing.

## Safety boundary

Normal application launches must not expose or initialize the smoke driver. The protocol is enabled only when the external runner provides all required opt-in values, including a versioned spec path, report path, and per-run random token.

The protocol is data driven, not a general-purpose script interface:

- The accepted action names and arguments are fixed by a strict schema.
- All referenced files must resolve inside the runner-created temporary workspace.
- The application never accepts an arbitrary executable or shell command from the spec.
- Terminal coverage uses a fixed platform command selected by the application and writes only a known sentinel file.
- Reports contain action names, bounded diagnostics, durations, and pass/fail state. They do not persist environment variables, raw command lines, authentication data, or absolute paths outside the temporary workspace.
- Spec and report files are handled with the same ownership, symlink, size, atomic-write, and redaction principles as startup measurement artifacts.

## Components

### External packaged smoke runner

Create `app/scripts/run-tauri-packaged-smoke.mjs` with a unit-tested library surface and CLI. The runner will:

- Discover or accept an explicit packaged executable and bundle root.
- Create a unique temporary Git workspace containing two `.R` files and known searchable content.
- Write a canonical `ride.tauri-packaged-smoke-spec@1` file.
- Launch the first executable with the first `.R` file and the smoke opt-in environment.
- Wait for a canonical report to advance through expected steps.
- Launch the same executable with the second `.R` file and verify that activation reaches the first application instance.
- Request graceful application shutdown, then use the existing identity-aware process-tree primitives to verify that no owned descendants remain.
- Capture bounded stdout and stderr and reject known sidecar startup failures or unexpected application errors.
- Preserve a redacted failure directory and remove successful temporary artifacts unless explicitly requested.

The runner will reuse exported discovery, bounded log, process identity, monitoring, cleanup, and redaction helpers from the startup measurement module where their contracts already match. Shared behavior will be extracted only when tests demonstrate duplication; the smoke runner will not weaken measurement cleanup rules.

### Tauri smoke protocol

Add a small Rust module registered with the existing Tauri command set. It will:

- Parse and validate the opt-in environment once during application setup.
- Canonicalize and validate the spec/report paths and random token.
- Expose only commands needed to read the validated action plan, append a typed step result, and mark the run complete.
- Own atomic report persistence and reject repeated, out-of-order, oversized, or token-mismatched updates.
- Remain inert when the complete smoke opt-in contract is absent.

The initial executable remains the report owner. A second instance participates only through the existing launch-intent/single-instance path and does not write directly to the report.

### Theia semantic smoke contribution

Add an opt-in frontend contribution in `theia-extensions/product`. After normal shell attachment and target-file opening, it obtains the validated plan from Tauri and executes fixed semantic actions through production services and commands:

1. Confirm the first `.R` editor is active, append a known marker, save, and verify the workspace file contents.
2. Open a terminal through the production terminal command, run the fixed sentinel operation, and verify its output file.
3. Execute workspace search for known content and verify a matching result.
4. Open the SCM/Git path and verify the temporary repository reports the expected modified file.
5. Invoke one real command contributed by a packaged VS Code extension and verify command registration and successful completion.
6. Execute the deferred `extract-widget` command against an eligible widget and verify that the secondary-window chunk is activated.
7. Observe the second `.R` launch intent and verify that it opens in the existing frontend.

Each action reports start, success, or bounded failure independently. The contribution stops on a required-step failure so later successes cannot hide the first defect.

## Scenarios

The runner supports three explicit scenarios rather than silently changing behavior:

- `critical-file`: the default packaged `tauri-critical` profile with the complete interaction sequence.
- `critical-empty`: startup without a file, proving the no-file fallback reaches a usable shell and starts deferred plugin resolution within its bounded delay.
- `full-file`: an explicitly built `full` profile running the same file and interaction contract.

The profile manifest in the packaged bundle is authoritative. A scenario fails if the actual profile does not match the requested profile.

## Report contract

The output uses `ride.tauri-packaged-smoke@1` and records:

- Platform, architecture, application/profile identity, and a digest of the canonical spec.
- Root process identity without persisting absolute executable paths.
- Scenario and ordered step results.
- Per-step monotonic duration, status, and bounded diagnostic code/message.
- First- and second-file activation identifiers without absolute host paths.
- Cleanup status and captured-log summaries.

The validator rejects unknown fields, duplicate steps, unsafe numbers, impossible ordering, missing required steps, mismatched profiles, and reports that claim completion after a required failure.

## Failure handling

- Startup, action, second-instance, and cleanup phases have separate explicit timeouts.
- Failure artifacts are written atomically to a runner-owned directory and are bounded and redacted.
- A missing optional packaged plugin command is a package failure, not a skip.
- Unsupported secondary-window activation is a failure for `critical-file` and `full-file` because the current profile declares that feature available on demand.
- Cleanup failure fails the complete run even when all functional steps passed.
- Hosted-runner desktop unavailability is handled by workflow selection, not by turning interaction failures into success.

## Testing strategy

Follow test-driven development at each layer:

- Node unit tests for CLI parsing, spec/report schema, scenario construction, report polling, second-instance sequencing, bounded diagnostics, and cleanup integration seams.
- Rust tests for opt-in parsing, canonical paths, token checks, report ordering, atomic persistence, bounds, and disabled-by-default behavior.
- TypeScript tests for action ordering, production service calls, fail-fast behavior, second-launch observation, plugin command verification, and deferred command execution.
- Policy tests proving the Windows CI job runs the packaged smoke command and non-Windows jobs validate the protocol and package inventory.
- A local Windows packaged run for `critical-file` before the first PR. `critical-empty` and `full-file` are added to CI only after their runtime cost and stability are measured.

## CI rollout

1. Land the versioned protocol and unit tests without enabling hosted desktop interaction.
2. Add a Windows packaged `critical-file` smoke step with uploaded redacted diagnostics on failure.
3. Add `critical-empty` after the default path is stable.
4. Build and launch `full-file` in a separate Windows job so its cost is visible and does not hide critical-profile regressions.
5. Keep all four platforms building and statically validating profile manifests, packaged resources, and protocol schemas.
6. Evaluate macOS/Linux interactive jobs only when suitable desktop runners are available; do not emulate a pass with static checks.

## Non-goals

- Pixel-perfect visual regression testing.
- Arbitrary command or script execution supplied by the smoke spec.
- Replacing unit, Rust, or profile inventory tests.
- Comparing hosted-runner performance directly to the checked-in same-host Windows baseline.
- Making dynamic backend ports, auto-update, signing, or notarization part of this first smoke implementation.
