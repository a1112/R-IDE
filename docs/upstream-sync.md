# Upstream synchronization and CI operations

This repository reconstructs `app/` from the pinned Eclipse Theia IDE snapshot in `.upstream/source.json`. The current baseline is `208ea0ec23bc738801d57c890bf21cd278f77896`. The reconstruction is deliberately transactional: a temporary checkout is cloned, R-IDE-owned paths are restored, source patches are replayed, and only a verified tree is moved into `app/`.

## Local checks

Run the fast reconstruction check from the repository root during normal development:

```sh
node scripts/sync-upstream.mjs check
node scripts/sync-upstream.mjs check --json
```

The check compares tracked product content and exits non-zero when drift is found. It does not replace `app/`. A local fixture can pass an explicit root with `--root <fixture-root>`; the production command infers the repository root from the script location.

Run the complete JavaScript policy suite before pushing workflow or synchronization changes:

```sh
node --test scripts/test/upstream-sync/*.test.mjs scripts/test/workflow-policy.test.mjs scripts/test/upstream-workflow.test.mjs
node --test app/scripts/test/build-tauri-backend.test.js
```

For application checks, use the scripts in `app/`:

```sh
cd app
yarn --frozen-lockfile --network-timeout 100000
yarn lint
yarn build:extensions
yarn browser build
yarn check:rust
```

The local Windows host can validate the Windows Tauri build. Linux and macOS packaging are verified by their corresponding CI matrix jobs.

## Reviewing an upstream update

Resolve a 40-character upstream commit and preview it without changing the product or source metadata:

```sh
node scripts/sync-upstream.mjs sync \
  --target <commit> \
  --dry-run \
  --report upstream-sync-report.json
```

Review the report (`changed`, old/new commits, counts, owned paths, patches, and compare URL) and the prospective change. Apply an approved update from a clean worktree:

```sh
node scripts/sync-upstream.mjs sync \
  --target <commit> \
  --report upstream-sync-report.json
node scripts/sync-upstream.mjs check
```

The successful sync updates `.upstream/source.json` to the resolved target commit. A target equal to the pinned commit is a no-op (`changed: false`). Do not run a destructive sync in a worktree containing unrelated user edits.

After resolving a source conflict, regenerate the ordered patch stack and verify it:

```sh
node scripts/sync-upstream.mjs refresh-patches
node scripts/sync-upstream.mjs check
```

When `.upstream/patches/` already contains patches, `refresh-patches` preserves their lexical names and order, regenerates each patch from the paths declared by its `diff --git` records, and removes empty or stale files. With no existing stack it creates the fixture-compatible `0001-upstream.patch` fallback.

## Ownership versus source patches

`.upstream/owned-paths.txt` contains POSIX-style paths relative to `app/`. Use an owned entry for a file or directory that exists only because of R-IDE/Tauri, including intentionally absent upstream paths. Missing owned sources are removed from the reconstructed product.

If an upstream file exists in both trees but its content is edited, keep it out of the ownership manifest and represent the edit in an ordered `.upstream/patches/*.patch` source patch. Source patches are applied lexically after owned paths are restored. Existing dependency patches under `app/patches/` are product files and are not interchangeable with the source patch stack.

When adding or removing ownership, run the full upstream test suite and inspect the generated patch diff. Never classify an edited upstream file as owned merely to hide a source change.

## CI jobs and artifacts

`.github/workflows/ci.yml` has least-privilege read permissions, concurrency cancellation, and explicit timeouts:

- `quality` runs synchronization/workflow policy tests, Yarn install, lint, extension/browser builds, and Rust fmt, clippy, and tests on Node 22.
- `upstream-compatibility` repeats the extension/browser build on Node 24.
- `package` builds and verifies unsigned Tauri bundles on Windows 2022 x64, Ubuntu 22.04 x64, macOS 15 arm64, and macOS 15 Intel x64.

Package artifacts are named `tauri-<platform>-<arch>` and come from:

```text
app/applications/tauri/src-tauri/target/release/bundle/**
```

The workflow is validation and packaging only. It does not sign, publish, or release an installer.

## Weekly synchronization workflow

`.github/workflows/upstream-sync.yml` runs weekly and supports `workflow_dispatch` with an optional `target_commit`. It resolves the requested SHA (or upstream `master`), runs the synchronization CLI before any push, executes fast application checks, and publishes only the bot-owned `automation/upstream-sync` branch.

The workflow creates or edits one pull request for review. It never invokes merge, enables auto-merge, or runs on pull requests/forks. A maintainer must review the source diff, patch stack, generated report, and required CI checks before merging.

On failure, the workflow captures status and `git diff --check` output, uploads an `upstream-sync-diagnostics` artifact, and creates or updates only the GitHub Actions bot-authored issue carrying the `<!-- upstream-sync-failure -->` marker. A successful run closes the matching open bot issue. The issue body includes the failed stage, a stderr summary, the artifact name, and the exact local reproduction command.

## Updating pinned GitHub Actions

All third-party `uses:` references are pinned to full 40-character commit SHAs. To update one safely:

1. Resolve the desired release commit from the action's official repository and review its changelog.
2. Change the SHA in every workflow that uses the action; do not replace it with a moving tag.
3. Run the workflow policy and upstream workflow tests, then `git diff --check`.
4. Open a normal review pull request and inspect the resulting permissions, inputs, and artifact paths.

Action pin updates do not grant release, signing, package publishing, or automatic merge permissions.

## Signing and release separation

CI produces unsigned bundles solely for verification and review. Code signing, notarization, installer publication, and release tagging belong in separately reviewed workflows with their own credentials and approvals. Do not add signing keys, release tokens, `gh release`, or auto-merge commands to either CI or upstream synchronization workflows.
