# Dependency alert exceptions

The security update keeps all dependencies with an available compatible fix at
or above the first patched release. The following alerts cannot currently be
resolved by a registry version without changing the build architecture:

- `decompress@4.2.1` is a development-only transitive dependency of the Theia
  tooling. The repository already applies
  [`app/patches/decompress+4.2.1.patch`](../app/patches/decompress+4.2.1.patch),
  which rejects archive paths that escape the extraction directory. There is
  no upstream fixed release, so the Dependabot alerts are tracked as a local
  patch until `decompress` publishes one.
- `image-size@0.5.5` has no patched npm release. It is pulled by upstream
  tooling and is not used by the application request/runtime paths.
- `pkg@5.8.1` has no patched npm release. It is a build-time backend bundler,
  not an installed application runtime dependency.
- `glib@0.18.5` is required by Tauri 2.11.5 through `gtk@0.18`. Forcing
  `glib@0.20` is rejected by Cargo because that GTK release requires the
  `0.18` API; this remains pending a Tauri/GTK release that moves the graph.
- `ai@4.3.19` and `@ai-sdk/provider-utils@2.2.8` are selected by the Theia
  AI extensions shipped with this baseline. Their available security fixes
  require the next major AI SDK line, which is not API-compatible with the
  pinned Theia 1.74 extension set. They remain isolated to the optional AI
  integration and should be revisited together with the next Theia AI upgrade.

These exceptions should be revisited whenever the upstream package or Tauri
dependency graph publishes a compatible fixed release.
