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
