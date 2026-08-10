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

The synchronizer stages a clean upstream checkout, restores declared R-IDE-owned paths, and replays source patches before replacing `app/` transactionally.
