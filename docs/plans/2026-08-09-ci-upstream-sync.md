# CI and Upstream Synchronization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add reproducible multi-platform Tauri CI and a safe weekly workflow that rebuilds `app/` from an exact Theia IDE upstream snapshot plus declared R-IDE ownership and patches.

**Architecture:** A Node.js synchronization tool stages an upstream checkout in a temporary directory, restores R-IDE-owned paths, applies source patches, and only replaces the product tree after verification succeeds. GitHub Actions separates fast quality checks, Node 24 upstream compatibility, four native Tauri package jobs, and a least-privilege scheduled synchronization job that opens but never merges a pull request.

**Tech Stack:** Node.js 22/24 built-in test runner, Git, Yarn 1, Rust stable/Cargo, Tauri 2, GitHub Actions, GitHub CLI.

---

### Task 1: Add synchronization configuration parsing

**Files:**
- Create: `.upstream/source.json`
- Create: `.upstream/owned-paths.txt`
- Create: `scripts/lib/upstream-sync/config.mjs`
- Create: `scripts/test/upstream-sync/config.test.mjs`

**Step 1: Write the failing configuration tests**

Cover valid source metadata, comments and blank lines in the ownership file, path normalization, absolute paths, `..` traversal, duplicate paths, missing fields, and malformed commit IDs.

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOwnedPaths, validateSource } from '../../lib/upstream-sync/config.mjs';

test('normalizes owned paths and removes comments', () => {
  assert.deepEqual(parseOwnedPaths('# product\napplications/tauri/\n'), ['applications/tauri/']);
});

test('rejects ownership outside the app tree', () => {
  assert.throws(() => parseOwnedPaths('../prototype/'), /must stay inside app/);
});

test('accepts a full pinned commit', () => {
  const value = validateSource({
    repository: 'https://github.com/eclipse-theia/theia-ide.git',
    branch: 'master',
    commit: 'a868f5b15f2d4f2598125a4f6a98c0d29990b946',
  });
  assert.equal(value.branch, 'master');
});
```

**Step 2: Run the tests and verify they fail**

Run: `node --test scripts/test/upstream-sync/config.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `config.mjs`.

**Step 3: Implement strict parsing**

Implement `validateSource`, `loadSourceConfig`, and `parseOwnedPaths` with no third-party dependencies. Ownership entries are POSIX-style paths relative to `app/`; a trailing slash represents a directory. Missing owned paths are allowed and mean that an upstream path is intentionally absent from R-IDE.

Use this initial source metadata:

```json
{
  "repository": "https://github.com/eclipse-theia/theia-ide.git",
  "branch": "master",
  "commit": "a868f5b15f2d4f2598125a4f6a98c0d29990b946"
}
```

Seed `owned-paths.txt` with the known R-IDE-only paths, including:

```text
applications/tauri/
applications/browser/pkg.config.js
patches/@theia+terminal+1.72.1.patch
theia-extensions/product/src/browser/ride-terminal-frontend-contribution.ts
theia-extensions/product/src/browser/ride-workbench-contribution.ts
package-lock.json
TAURI-BUILD-GUIDE.md
TAURI-IMPLEMENTATION-STATUS.md
design-qa.md
```

Add every other file that exists only because of the Tauri/R-IDE import after comparing the pinned upstream tree. Do not classify an edited upstream file as owned merely to avoid writing a patch.

**Step 4: Run the tests and verify they pass**

Run: `node --test scripts/test/upstream-sync/config.test.mjs`

Expected: all configuration tests PASS.

**Step 5: Commit**

```powershell
git add .upstream/source.json .upstream/owned-paths.txt scripts/lib/upstream-sync/config.mjs scripts/test/upstream-sync/config.test.mjs
git commit -m "feat: define upstream synchronization metadata"
```

### Task 2: Build the transactional synchronization engine

**Files:**
- Create: `scripts/lib/upstream-sync/command.mjs`
- Create: `scripts/lib/upstream-sync/filesystem.mjs`
- Create: `scripts/lib/upstream-sync/git.mjs`
- Create: `scripts/lib/upstream-sync/engine.mjs`
- Create: `scripts/test/upstream-sync/engine.test.mjs`

**Step 1: Write failing fixture tests**

Each test creates a temporary local upstream Git repository and a product tree. Cover:

- upstream add, modify, delete, and rename;
- binary content;
- an owned directory replacing the upstream version;
- an owned path that is intentionally absent;
- successful patch replay;
- a patch conflict;
- a target that is not a descendant of the baseline;
- cleanup after an injected failure;
- no changes to the destination until staging succeeds.

The atomicity assertion must snapshot the destination before a failing run and compare it byte-for-byte afterwards.

```js
test('does not modify the product when a patch conflicts', async t => {
  const fixture = await createFixture(t);
  const before = await treeDigest(fixture.product);
  await assert.rejects(
    synchronize({ ...fixture.options, patches: [fixture.conflictingPatch] }),
    /patch preflight failed/,
  );
  assert.equal(await treeDigest(fixture.product), before);
});
```

**Step 2: Run the tests and verify they fail**

Run: `node --test scripts/test/upstream-sync/engine.test.mjs`

Expected: FAIL because the engine modules do not exist.

**Step 3: Implement command and Git wrappers**

`command.mjs` must use `execFile`, never shell-built command strings. Capture stdout/stderr and include the executable, arguments, exit code, and stderr in a typed error.

`git.mjs` must implement:

- clone/fetch of an exact repository;
- ref resolution to a 40-character commit;
- `merge-base --is-ancestor` validation;
- detached checkout;
- `git apply --check` followed by `git apply`;
- binary diff generation;
- tracked-tree comparison.

**Step 4: Implement staging and atomic replacement**

`engine.mjs` must:

1. create a temporary directory with `fs.mkdtemp`;
2. clone and check out the requested upstream commit;
3. remove the temporary checkout's `.git` metadata before product comparison;
4. restore owned files from the current product, removing the target when the owned source is intentionally absent;
5. preflight and apply patches in lexical order;
6. run an optional verifier callback;
7. replace the destination only after every prior step passes;
8. restore the old destination if final replacement itself fails;
9. remove temporary data in `finally`.

Use explicit resolved paths and refuse to replace anything other than the caller-provided `app/` directory.

**Step 5: Run the tests and verify they pass**

Run: `node --test scripts/test/upstream-sync/engine.test.mjs`

Expected: all fixture tests PASS.

**Step 6: Commit**

```powershell
git add scripts/lib/upstream-sync scripts/test/upstream-sync/engine.test.mjs
git commit -m "feat: add transactional upstream sync engine"
```

### Task 3: Add the synchronization CLI and reports

**Files:**
- Create: `scripts/sync-upstream.mjs`
- Create: `scripts/lib/upstream-sync/report.mjs`
- Create: `scripts/test/upstream-sync/cli.test.mjs`
- Modify: `README.md`

**Step 1: Write failing CLI tests**

Test these commands against local fixture repositories:

- `check` reconstructs the configured baseline and reports no drift;
- `check` exits non-zero on undeclared product drift;
- `sync --target <sha> --dry-run` prints the prospective change without modifying files;
- `sync --target <sha>` advances the source metadata;
- `refresh-patches` reproduces the same product tree;
- a no-op sync exits zero and reports `changed=false`;
- `--report <path>` writes structured JSON.

Expected report shape:

```json
{
  "changed": true,
  "previousCommit": "<40-char sha>",
  "targetCommit": "<40-char sha>",
  "counts": { "added": 0, "modified": 0, "deleted": 0, "renamed": 0 },
  "ownedPaths": [],
  "patches": [],
  "compareUrl": "https://github.com/eclipse-theia/theia-ide/compare/<old>...<new>"
}
```

**Step 2: Run the CLI tests and verify they fail**

Run: `node --test scripts/test/upstream-sync/cli.test.mjs`

Expected: FAIL because `sync-upstream.mjs` and `report.mjs` do not exist.

**Step 3: Implement the CLI**

Use explicit subcommands and reject unknown flags. The CLI operates on the repository root inferred from its own location, with test-only overrides supplied through command arguments rather than environment variables.

`check` must compare tracked product content, not ignored `node_modules`, logs, plugins, or build outputs. `refresh-patches` must generate normalized binary-capable patches against the pinned clean snapshot while excluding owned paths.

**Step 4: Document local commands**

Add concise root README commands:

```sh
node scripts/sync-upstream.mjs check
node scripts/sync-upstream.mjs sync --target <commit> --dry-run
node scripts/sync-upstream.mjs sync --target <commit>
node scripts/sync-upstream.mjs refresh-patches
```

State that normal development uses `check`; maintainers use `sync` and review the resulting diff.

**Step 5: Run the CLI tests and verify they pass**

Run: `node --test scripts/test/upstream-sync/*.test.mjs`

Expected: all configuration, engine, and CLI tests PASS.

**Step 6: Commit**

```powershell
git add scripts/sync-upstream.mjs scripts/lib/upstream-sync/report.mjs scripts/test/upstream-sync/cli.test.mjs README.md
git commit -m "feat: add upstream synchronization CLI"
```

### Task 4: Bootstrap the real R-IDE ownership manifest and patch series

**Files:**
- Modify: `.upstream/owned-paths.txt`
- Create: `.upstream/patches/0001-workspace-and-build.patch`
- Create: `.upstream/patches/0002-browser-tauri-backend.patch`
- Create: `.upstream/patches/0003-product-branding.patch`
- Create: `.upstream/patches/0004-lockfile.patch`
- Modify: `refs/theia-ide-upstream.txt`
- Test: `scripts/test/upstream-sync/real-tree.test.mjs`

**Step 1: Write the failing real-tree reconstruction test**

The test calls the CLI in `check` mode and expects the pinned upstream snapshot plus manifest and patches to reproduce every tracked `app/` file.

```js
test('reconstructs the tracked R-IDE app from its pinned upstream baseline', async () => {
  const result = await runCli(['check', '--json']);
  assert.equal(result.drift, false, JSON.stringify(result, null, 2));
});
```

**Step 2: Run the test and verify it fails with a drift inventory**

Run: `node --test scripts/test/upstream-sync/real-tree.test.mjs`

Expected: FAIL and list all unclassified differences between upstream `a868f5b` and current `app/`.

**Step 3: Classify every difference**

Use the following rule:

- New R-IDE/Tauri files go into `owned-paths.txt`.
- Deleted upstream files are listed as intentionally absent owned paths.
- Edited upstream files become patches grouped by purpose.
- Generated `app/yarn.lock` differences are kept in the lockfile patch.
- `app/package-lock.json` remains owned and transitional.
- Existing dependency patches under `app/patches/` remain owned product files and are not converted into source patches.

Do not include user-only ignored files such as `node_modules`, `theia-browser.*.log`, generated resources, plugins, or build output.

**Step 4: Generate normalized patches**

Run: `node scripts/sync-upstream.mjs refresh-patches`

Expected: four ordered patch files are created and `git apply --check` succeeds against a clean checkout of the pinned baseline.

If a category has no differences, omit that patch rather than committing an empty file.

**Step 5: Run reconstruction verification**

Run: `node --test scripts/test/upstream-sync/real-tree.test.mjs`

Expected: PASS with zero tracked-tree drift.

Run: `node scripts/sync-upstream.mjs check`

Expected: exit 0 and print the pinned commit plus `drift: false`.

**Step 6: Commit**

```powershell
git add .upstream refs/theia-ide-upstream.txt scripts/test/upstream-sync/real-tree.test.mjs
git commit -m "chore: capture R-IDE upstream patch stack"
```

### Task 5: Make the Tauri build deterministic and cross-platform

**Files:**
- Create: `app/scripts/build-tauri-backend.js`
- Create: `app/scripts/test/build-tauri-backend.test.js`
- Modify: `app/applications/browser/package.json`
- Modify: `app/applications/tauri/copy-plugins.js`
- Modify: `app/applications/tauri/package.json`
- Modify: `app/.gitignore`
- Create: `app/applications/tauri/src-tauri/Cargo.lock`
- Modify: `app/package.json`

**Step 1: Write a failing build-plan test**

The helper exposes a pure `createBuildPlan(platform)` function and uses it from the executable entry point. Assert that Windows uses `.cmd` executables and that `RIDE_TAURI_LEAN=1` is passed through the child environment without shell-prefix syntax.

```js
test('uses native Windows executables and an explicit environment', () => {
  const plan = createBuildPlan('win32');
  assert.equal(plan[0].command, 'yarn.cmd');
  assert.equal(plan[1].env.RIDE_TAURI_LEAN, '1');
});
```

Also test that `copy-plugins.js --bundle` enables bundle mode without relying on `VAR=value command` syntax.

**Step 2: Run the tests and verify they fail**

Run: `node --test app/scripts/test/build-tauri-backend.test.js`

Expected: FAIL because the helper is missing.

**Step 3: Implement cross-platform execution**

Replace the inline `RIDE_TAURI_LEAN=1` browser script with `node ../../scripts/build-tauri-backend.js`. The helper uses `spawnSync` with argument arrays, inherited stdio, the browser working directory, and an explicit environment.

Change the Tauri bundle script to `node copy-plugins.js --bundle`, and let `copy-plugins.js` treat that flag as equivalent to `RIDE_COPY_PLUGINS=1`.

Add these root app scripts:

```json
{
  "test:sync": "node --test ../scripts/test/upstream-sync/*.test.mjs",
  "check:sync": "node ../scripts/sync-upstream.mjs check",
  "check:rust": "cargo fmt --manifest-path applications/tauri/src-tauri/Cargo.toml --check && cargo clippy --manifest-path applications/tauri/src-tauri/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path applications/tauri/src-tauri/Cargo.toml"
}
```

Use a small Node wrapper instead of `&&` if the Rust command must run through Windows without a shell.

**Step 4: Commit the Rust lockfile**

Change `app/.gitignore` so the application lock is included:

```gitignore
**/Cargo.lock
!applications/tauri/src-tauri/Cargo.lock
```

Run: `cargo generate-lockfile --manifest-path app/applications/tauri/src-tauri/Cargo.toml`

Expected: `Cargo.lock` is generated and tracked.

**Step 5: Run focused verification**

Run: `node --test app/scripts/test/build-tauri-backend.test.js`

Expected: PASS.

Run: `npm --prefix app run check:rust`

Expected: formatting, clippy, and Rust tests PASS.

Run: `npm --prefix app run build:tauri -- --help`

If the existing script cannot accept `--help`, run the browser backend helper directly and verify it uses native Windows process invocation.

**Step 6: Refresh and verify the upstream patch stack**

Run: `node scripts/sync-upstream.mjs refresh-patches`

Run: `node scripts/sync-upstream.mjs check`

Expected: PASS after the changed upstream-owned build files are represented in the appropriate patches.

**Step 7: Commit**

```powershell
git add app/scripts app/applications/browser/package.json app/applications/tauri/copy-plugins.js app/applications/tauri/package.json app/applications/tauri/src-tauri/Cargo.lock app/.gitignore app/package.json .upstream/patches
git commit -m "build: make Tauri builds reproducible across platforms"
```

### Task 6: Add the required CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `scripts/test/workflow-policy.test.mjs`

**Step 1: Write failing workflow policy tests**

Read workflow YAML as text and assert:

- `permissions: contents: read` is the default;
- push, pull request, and manual triggers exist;
- concurrency and timeouts exist;
- quality and Node 24 compatibility jobs exist;
- the package matrix contains `windows-2022`, `ubuntu-22.04`, `macos-15`, and `macos-15-intel`;
- package jobs use Node 22;
- all `uses:` references end in a 40-character SHA;
- no release, signing, or automatic merge command exists;
- artifacts come from `app/applications/tauri/src-tauri/target/release/bundle/**`.

**Step 2: Run the policy test and verify it fails**

Run: `node --test scripts/test/workflow-policy.test.mjs`

Expected: FAIL because `.github/workflows/ci.yml` is missing.

**Step 3: Implement `ci.yml`**

Use these pinned official actions:

- `actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd`
- `actions/setup-node@6044e13b5dc448c55e2357c09f80417699197238`
- `actions/cache@caa296126883cff596d87d8935842f9db880ef25`
- `actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f`

Quality job commands:

```sh
node --test scripts/test/upstream-sync/*.test.mjs scripts/test/workflow-policy.test.mjs
cd app
yarn --frozen-lockfile --network-timeout 100000
yarn lint
yarn build:extensions
yarn browser build
cargo fmt --manifest-path applications/tauri/src-tauri/Cargo.toml --check
cargo clippy --manifest-path applications/tauri/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path applications/tauri/src-tauri/Cargo.toml
```

Compatibility job repeats install and the extension/browser build under Node 24.

Package matrix uses Node 22 and Rust stable. On Ubuntu install the packages listed by the current Tauri prerequisite documentation. Run the complete R-IDE Tauri build and `npm --workspace applications/tauri run verify`, then upload the native bundle directory with a platform/architecture-specific artifact name.

Use `shell: bash` only where the command is actually portable; the product build itself must work from each runner's native shell.

**Step 4: Run workflow policy tests**

Run: `node --test scripts/test/workflow-policy.test.mjs`

Expected: PASS.

Run: `git diff --check -- .github/workflows/ci.yml`

Expected: no whitespace errors.

**Step 5: Commit**

```powershell
git add .github/workflows/ci.yml scripts/test/workflow-policy.test.mjs
git commit -m "ci: validate and package R-IDE on desktop platforms"
```

### Task 7: Add the weekly upstream synchronization workflow

**Files:**
- Create: `.github/workflows/upstream-sync.yml`
- Create: `scripts/render-upstream-pr.mjs`
- Create: `scripts/test/upstream-workflow.test.mjs`

**Step 1: Write failing policy and PR-body tests**

Assert that the workflow:

- runs weekly and through `workflow_dispatch`;
- accepts an optional target commit;
- has workflow-level read permissions and job-level `contents`, `pull-requests`, and `issues` write permissions only;
- uses a concurrency group;
- runs the synchronization CLI before any Git push;
- uses the bot-owned `automation/upstream-sync` branch;
- creates or edits a PR through `gh`;
- never invokes merge or enables auto-merge;
- uploads diagnostics on failure;
- creates or updates only a bot-authored failure issue.

Test `render-upstream-pr.mjs` using a fixed report JSON and snapshot the expected Markdown sections.

**Step 2: Run tests and verify they fail**

Run: `node --test scripts/test/upstream-workflow.test.mjs`

Expected: FAIL because the workflow and renderer do not exist.

**Step 3: Implement the PR renderer**

The renderer accepts `--report`, `--output`, and `--mode pr|issue`. PR output includes old/new SHAs, compare URL, change counts, owned paths, patches, required checks, and the no-auto-merge notice. Issue output includes the failed stage, stderr summary, artifact name, and exact reproduction command.

**Step 4: Implement `upstream-sync.yml`**

Workflow outline:

1. checkout full history;
2. set up Node 22;
3. resolve the requested SHA or `origin/master` from the upstream repository;
4. run `sync --target ... --report upstream-sync-report.json`;
5. install dependencies and run fast verification;
6. configure the GitHub Actions bot identity;
7. commit only expected synchronization files;
8. refresh `automation/upstream-sync` from the triggering `main` commit using `--force-with-lease` only for that bot-owned branch;
9. create or edit one pull request with `gh pr create` or `gh pr edit`;
10. on failure, upload diagnostics and create/update the bot-owned issue;
11. on success, close only the matching issue whose body contains the workflow's marker.

Do not run the write-capable job on pull requests or forks.

**Step 5: Run policy tests**

Run: `node --test scripts/test/upstream-workflow.test.mjs scripts/test/workflow-policy.test.mjs`

Expected: PASS.

**Step 6: Commit**

```powershell
git add .github/workflows/upstream-sync.yml scripts/render-upstream-pr.mjs scripts/test/upstream-workflow.test.mjs
git commit -m "ci: automate reviewed upstream synchronization"
```

### Task 8: Perform the first real upstream synchronization

**Files:**
- Modify: `.upstream/source.json`
- Modify: `.upstream/patches/*.patch`
- Modify: `refs/theia-ide-upstream.txt`
- Modify: `app/**` as dictated by upstream and R-IDE patch reconciliation

**Step 1: Confirm a clean implementation worktree**

Run: `git status --short`

Expected: no output. Do not run the destructive sync command in the user's original dirty worktree.

**Step 2: Resolve the current upstream target**

Run: `git ls-remote https://github.com/eclipse-theia/theia-ide.git refs/heads/master`

Expected: one 40-character SHA. During design this was `208ea0ec23bc738801d57c890bf21cd278f77896`; use the newly resolved value and record it in the report.

**Step 3: Dry-run synchronization**

Run: `node scripts/sync-upstream.mjs sync --target <resolved-sha> --dry-run --report upstream-sync-report.json`

Expected: exit 0 with a non-empty change summary, or an explicit patch-conflict report without working-tree changes.

**Step 4: Apply and reconcile the synchronization**

Run: `node scripts/sync-upstream.mjs sync --target <resolved-sha> --report upstream-sync-report.json`

If patches conflict, resolve them by preserving:

- upstream Theia versions and security/dependency fixes;
- the Tauri application and embedded Node backend runtime;
- R-IDE branding and workbench/terminal contributions;
- cross-platform build helpers;
- the distinction between source patches and `patch-package` dependency patches.

Do not retain obsolete upstream version pins merely because they appear in an old R-IDE diff. Rename or regenerate the `@theia/terminal` dependency patch for the installed Theia version, and verify that `patch-package` applies it during a clean Yarn install.

**Step 5: Regenerate dependency state and normalized patches**

Run: `yarn --cwd app install --network-timeout 100000`

Run: `node scripts/sync-upstream.mjs refresh-patches`

Run: `node scripts/sync-upstream.mjs check`

Expected: install succeeds, source patches apply to the new baseline, and reconstruction reports zero drift.

Do not stage the user's pre-existing `package-lock.json`, `yarn.lock`, or `.gitkeep` changes from the original worktree. All changes here must originate in the clean implementation worktree.

**Step 6: Run focused application verification**

Run from `app/`:

```sh
yarn --frozen-lockfile --network-timeout 100000
yarn lint
yarn build:extensions
yarn browser build
npm --workspace applications/tauri run verify
cargo fmt --manifest-path applications/tauri/src-tauri/Cargo.toml --check
cargo clippy --manifest-path applications/tauri/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path applications/tauri/src-tauri/Cargo.toml
```

Expected: every command PASS.

**Step 7: Commit**

```powershell
git add .upstream refs/theia-ide-upstream.txt app
git commit -m "chore: synchronize Eclipse Theia IDE upstream"
```

### Task 9: Document operations and run final verification

**Files:**
- Modify: `README.md`
- Create: `docs/upstream-sync.md`
- Modify: `docs/plans/2026-08-09-ci-upstream-sync.md` only if execution discoveries change commands

**Step 1: Add operational documentation**

Document:

- required CI checks and artifact names;
- how to run fast checks locally;
- how to dry-run and perform an upstream sync;
- ownership versus source-patch rules;
- how to refresh patches after resolving a conflict;
- failure Issue behavior;
- why synchronization PRs cannot auto-merge;
- how to update pinned Action SHAs safely;
- that signing and releasing are separate workflows.

**Step 2: Run all Node tests**

Run:

```powershell
node --test scripts/test/upstream-sync/*.test.mjs scripts/test/workflow-policy.test.mjs scripts/test/upstream-workflow.test.mjs
node --test app/scripts/test/build-tauri-backend.test.js
```

Expected: all tests PASS.

**Step 3: Run reconstruction and repository checks**

Run:

```powershell
node scripts/sync-upstream.mjs check
git diff --check
git status --short
```

Expected: reconstruction PASS, no whitespace errors, and only the intended documentation changes remain.

**Step 4: Run the complete Windows Tauri package build**

Run from `app/`:

```powershell
yarn --frozen-lockfile --network-timeout 100000
yarn build:tauri
npm --workspace applications/tauri run verify
```

Expected: the Windows Tauri bundle is created under `app/applications/tauri/src-tauri/target/release/bundle/` and verification PASS.

The Linux and macOS package jobs cannot be proven from the local Windows host. Their workflow definitions and policy tests are verified locally; actual native builds become required GitHub checks once the branch is pushed.

**Step 5: Commit documentation**

```powershell
git add README.md docs/upstream-sync.md docs/plans/2026-08-09-ci-upstream-sync.md
git commit -m "docs: explain CI and upstream sync operations"
```

**Step 6: Review the complete branch**

Run:

```powershell
git log --oneline --decorate main..HEAD
git diff --stat main...HEAD
git status --short
```

Expected: the branch contains only the design, synchronization tooling, CI workflows, upstream update, tests, and documentation; the worktree is clean.

Before claiming completion, invoke `superpowers:verification-before-completion`. Then invoke `superpowers:requesting-code-review`, address any findings, and use `superpowers:finishing-a-development-branch` to present integration options.
