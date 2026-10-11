# Dependency alert exceptions

The security update keeps all dependencies with an available compatible fix at
or above the first patched release. The following alerts cannot currently be
resolved by a registry version without changing the build architecture:

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

## Resolved archive extraction exception

`decompress@4.2.1` has been replaced by a
[CommonJS compatibility adapter](../app/vendor/decompress-compat/README.md)
backed by the maintained `@xhmikosr/decompress@11.1.4`. The previous local patch
only fixed path-prefix containment and did not address the symlink-chain bypass
in [GHSA-hrh2-vp3x-79xf](https://github.com/advisories/GHSA-hrh2-vp3x-79xf).
The affected Theia consumers include runtime plugin deployment and remote
dependency extraction as well as development tooling.
