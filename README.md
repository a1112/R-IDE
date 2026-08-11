# R-IDE

This repository keeps the main application under `app/`.

## Layout

- `app/` - the main Theia IDE based application workspace.
- `theia-ide` - compatibility symlink to `app/` for older scripts and docs.
- `prototype/` - standalone Vite prototype used for UI exploration.
- `refs/` - upstream/reference notes.

## Common Commands

Run main application commands from `app/`:

```sh
cd app
yarn install
yarn build
```

Run the prototype from `prototype/`:

```sh
cd prototype
npm install
npm run dev
```

## Upstream synchronization

Normal development runs the reconstruction check:

```sh
node scripts/sync-upstream.mjs check
```

Maintainers can preview or apply a pinned upstream update, then review the resulting diff:

```sh
node scripts/sync-upstream.mjs sync --target <commit> --dry-run
node scripts/sync-upstream.mjs sync --target <commit>
node scripts/sync-upstream.mjs refresh-patches
```

The synchronizer stages a clean upstream checkout, restores declared R-IDE-owned paths, and replays source patches before replacing `app/` transactionally. Add `--dry-run` and/or `--report report.json` when reviewing a prospective update; `--json` prints the same structured report to stdout.

See [docs/upstream-sync.md](docs/upstream-sync.md) for the ownership rules, CI jobs, failure diagnostics, and maintainer procedure.

## CI and release boundaries

`CI` runs on pushes, pull requests, and manual dispatch. It has separate quality, Node 24 compatibility, and unsigned Tauri package jobs. The package matrix covers Windows 2022, Ubuntu 22.04, macOS 15 arm64, and macOS 15 Intel; bundles are uploaded from `app/applications/tauri/src-tauri/target/release/bundle/`.

The weekly upstream workflow opens a review pull request from `automation/upstream-sync`; it never merges or enables auto-merge. Signing and release publication are intentionally separate workflows and are not performed by CI.
