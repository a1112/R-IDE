# CI and Upstream Synchronization Design

## Context

R-IDE vendors Eclipse Theia IDE under `app/` and adds a Tauri desktop target, R-IDE branding, runtime changes, and dependency patches. The imported source was based on `eclipse-theia/theia-ide` commit `a868f5b15f2d4f2598125a4f6a98c0d29990b946`, but the R-IDE repository does not share Git ancestry with upstream and moved the upstream root into `app/`. A normal merge therefore cannot reliably distinguish upstream changes from product customizations.

The repository currently has no GitHub Actions workflows. The primary deliverable is an unsigned Tauri installer for Windows, Linux, and macOS. Electron and browser targets remain compatibility checks rather than release artifacts.

## Goals

- Build and validate R-IDE on Windows, Linux, macOS ARM64, and macOS x64.
- Treat Tauri packages as the required CI artifacts.
- Validate compatibility with the Node.js version used by current upstream CI.
- Synchronize `eclipse-theia/theia-ide:master` weekly and on demand.
- Open or update a reviewable synchronization pull request without automatic merging.
- Preserve R-IDE-owned files and replay explicit patches over a clean upstream snapshot.
- Stop safely and provide actionable diagnostics when an upstream change conflicts with an R-IDE patch.

## Non-goals

- Signing installers or publishing a GitHub Release.
- Automatically merging upstream synchronization pull requests.
- Refactoring R-IDE into a submodule-based product composition.
- Adding mobile Tauri targets.
- Making `package-lock.json` authoritative. CI uses `app/yarn.lock`; the existing package lock remains transitional so unrelated local changes are not overwritten.

## Considered Approaches

### 1. Upstream snapshot with owned paths and patches

Fetch an exact upstream commit into a temporary directory, restore declared R-IDE-owned paths, and apply an ordered patch series for changes to upstream-owned files. This is the selected approach because it is deterministic despite the lack of shared history and the `app/` path prefix.

### 2. Git subtree merge

Graft the upstream repository below `app/` and use subtree merges. This preserves upstream history after a large one-time reconciliation, but the current import and roughly 99-file R-IDE delta would create a risky initial merge and continue mixing product and upstream changes.

### 3. Upstream submodule with external composition

Keep upstream untouched in a submodule and compose R-IDE around it. This offers the cleanest long-term separation but requires a major build, branding, extension, and patching refactor. It is outside the scope of this change.

## Repository Layout

The synchronization implementation adds these concepts:

- `.upstream/source.json`: upstream repository URL, tracked branch, and exact baseline commit.
- `.upstream/owned-paths.txt`: paths that are entirely controlled by R-IDE and copied from the current product tree into each new snapshot.
- `.upstream/patches/*.patch`: ordered source patches applied to files that also exist upstream.
- `scripts/sync-upstream.mjs`: cross-platform synchronization, verification, and patch-refresh entry point.
- `scripts/lib/upstream-sync/*.mjs`: small modules for Git operations, path ownership, patch handling, reporting, and transactional replacement.
- `scripts/test/upstream-sync/*.test.mjs`: network-free fixture tests using temporary local Git repositories.
- `.github/workflows/ci.yml`: validation and package matrix.
- `.github/workflows/upstream-sync.yml`: scheduled and manual synchronization orchestration.

The existing `app/patches/` directory remains reserved for patches applied to installed dependency packages by `patch-package`. Source synchronization patches must not be stored there.

## Ownership Model

R-IDE-only directories and files, including `app/applications/tauri/**`, Tauri-specific documentation, and new R-IDE contribution files, belong in `owned-paths.txt`. Files inherited from upstream but edited by R-IDE, such as root package configuration, browser build configuration, and product extension wiring, remain upstream-owned and are represented by patches.

Unknown product files are not silently retained. Verification fails if the current `app/` tree cannot be reproduced exactly from the pinned upstream snapshot, the ownership manifest, and the patch series. This makes every divergence intentional and reviewable.

After a successful synchronization, the patch series is regenerated against the new upstream baseline. This prevents patches from accumulating stale context across releases.

## Synchronization Data Flow

1. Read `.upstream/source.json` and resolve the requested target commit from upstream `master`.
2. Verify that the target commit is a descendant of the recorded baseline. Reject history rewrites, rollbacks, and unresolved refs.
3. Check out the target snapshot in a temporary directory outside the working tree.
4. Copy every declared owned path from the current `app/` tree into the snapshot.
5. Apply the ordered source patch series with a strict preflight check.
6. Run structural verification and regenerate normalized patches relative to the target snapshot.
7. Regenerate the machine-readable source metadata and the human-readable `refs/theia-ide-upstream.txt` note.
8. Replace `app/` transactionally only after all preparation steps succeed.
9. Install dependencies, update `app/yarn.lock` when required, and run synchronization verification plus the fast CI checks.
10. Commit the resulting change on the bot-owned `automation/upstream-sync` branch and create or update one pull request.

The workflow runs weekly and supports `workflow_dispatch` with an optional target commit. If no upstream change exists, it exits successfully without modifying files or opening a pull request.

The initial rollout records the current R-IDE delta against `a868f5b15f2d4f2598125a4f6a98c0d29990b946`, then attempts the first forward synchronization to the upstream commit observed during design, `208ea0ec23bc738801d57c890bf21cd278f77896`. The workflow resolves the branch again at execution time and records the exact commit it actually uses.

## Pull Request Behavior

The synchronization workflow has explicit `contents`, `pull-requests`, and `issues` write permissions; all other workflows remain read-only. It uses the GitHub CLI included on hosted runners instead of a third-party pull-request action.

The pull request body includes:

- old and new upstream commit IDs;
- an upstream compare link;
- counts of added, modified, renamed, and deleted files;
- the owned paths and patches replayed;
- dependency and lockfile changes;
- the required platform checks;
- an explicit notice that automatic merging is forbidden.

The bot-owned branch may be refreshed from the latest `main`, but the workflow never force-pushes `main` or another developer branch. Only one open synchronization pull request is maintained at a time.

## CI Design

### Quality job

The Ubuntu quality job runs:

- synchronization fixture tests;
- reconstruction verification for the pinned real upstream baseline;
- `yarn --frozen-lockfile`;
- lint and extension/browser development builds;
- `cargo fmt --check`;
- `cargo clippy` with warnings denied;
- `cargo test`;
- a final dirty-tree check for generated files.

### Upstream compatibility job

An Ubuntu job uses Node.js 24 to install dependencies and build extensions plus the browser target. Node.js 24 matches the current upstream CI environment, but it is not embedded into R-IDE packages.

### Tauri package matrix

Required package jobs run on:

- `windows-2022` for Windows x64;
- `ubuntu-22.04` for Linux x64;
- `macos-15` for macOS ARM64;
- `macos-15-intel` for macOS x64.

Package jobs use Node.js 22 because `copy-backend.js` embeds the active Node executable as the product backend runtime. They use the stable Rust toolchain and cache Yarn downloads, Cargo registry data, Cargo Git data, and compiled Rust targets.

Linux installs the Tauri WebKitGTK 4.1, AppIndicator, rsvg, OpenSSL, and native build prerequisites before compilation. Each matrix entry builds the Theia backend, assembles the Tauri application, runs package verification, and uploads unsigned native bundles. Pull-request artifacts are retained for seven days; `main` artifacts are retained for fourteen days.

Current environment-variable-prefixed package scripts must be made cross-platform so the Windows job works in a native shell.

### Reproducibility

- `app/yarn.lock` is the JavaScript dependency source of truth.
- Tauri's `Cargo.lock` is committed and explicitly unignored.
- Actions are pinned to full commit SHAs.
- Jobs have explicit timeouts and least-privilege permissions.
- Workflow concurrency cancels obsolete runs for the same branch or synchronization target.

## Failure Handling

The synchronization script stages all work in a temporary directory. A failed clone, ancestry check, owned-path restore, patch preflight, patch application, lockfile update, or verification leaves the checked-out repository unchanged.

When an automated synchronization fails, the workflow:

- does not update the baseline commit;
- does not push a partial synchronization branch;
- uploads patch rejects, failed commands, and an upstream change summary;
- creates or updates one issue labeled `upstream-sync` with reproduction instructions.

A later successful synchronization closes only the failure issue created by the bot. It never closes a user-created issue based solely on labels.

## Test Strategy

Network-free Node.js tests create small temporary Git repositories and cover:

- upstream additions, edits, deletions, renames, and binary files;
- preservation of declared owned paths;
- rejection of undeclared local divergence;
- successful patch replay;
- patch conflicts and reject diagnostics;
- no-op synchronization;
- rejection of a target that is not a descendant of the baseline;
- cleanup after failure;
- exact reconstruction of a product tree from a baseline, owned paths, and patches.

Integration verification reconstructs the real `app/` tree from the pinned Theia IDE baseline and compares its tracked content with the repository. The package matrix then proves that the reconstructed product builds on every supported desktop platform.

## Operational Notes

Repository branch protection should require the quality, upstream compatibility, and four Tauri package checks before merging. Signing secrets and release permissions must not be added to these workflows.

References:

- Theia IDE upstream: <https://github.com/eclipse-theia/theia-ide>
- Theia IDE official build workflow: <https://github.com/eclipse-theia/theia-ide/blob/master/.github/workflows/build.yml>
- Tauri prerequisites: <https://v2.tauri.app/start/prerequisites/>
- Tauri GitHub pipeline guidance: <https://v2.tauri.app/distribute/pipelines/github/>
