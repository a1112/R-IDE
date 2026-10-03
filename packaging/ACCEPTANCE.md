# Windows preview acceptance — incomplete

The payload is an internal acceptance build, not an approved public release.

Verified on the current Windows x64 machine with an isolated `RIDE_CONFIG_DIR`,
isolated WebView2 data, temporary working directory and a PATH without Node:

- Production Theia frontend/backend and four product extensions compile.
- Real native R-IDE window, bundled Node listener on port 3000 and 70 plugins.
- Existing `critical-empty` and `critical-file` packaged smoke pass: PTY terminal,
  actual `vscode.git` command, file save, workspace search, SCM, secondary window
  and second-file forwarding.
- Normal WM_CLOSE returns 0; forced owned-main termination leaves no observed
  owned backend or WebView2 descendants.
- Missing Node, missing backend entry and a port owned by the test fixture are
  rejected with concrete errors; no backend is started or foreign process killed.
- Node script suite: 542 passed. Rust suite: 381 passed, 1 ignored.

Unresolved acceptance failures:

1. The existing `backend-retry` packaged smoke times out waiting for its final
   report after 120 seconds. Logs show the old owned Node root exiting, cleanup,
   a new bundled Node root listening and the frontend becoming ready again.
   This evidence does not satisfy the complete retry protocol. The timeout and
   redacted logs are retained under `artifacts/backend-retry*`.
2. `yarn audit --groups dependencies --registry https://registry.npmjs.org --json`
   reports 83 unique advisories in the full workspace dependency tree. Matching
   actual positive `bytesInOutput` contributions in the production esbuild
   metadata still finds 39 high/critical advisories. This includes the critical
   [tar parse/decompression issue](https://github.com/advisories/GHSA-23hp-3jrh-7fpw)
   and two critical decompress archive traversal issues:
   [archive links](https://github.com/advisories/GHSA-mp2f-45pm-3cg9) and
   [symlink chains](https://github.com/advisories/GHSA-hrh2-vp3x-79xf).
   The unmaintained `decompress` package has no patched release; its maintained
   fork fixes these in 10.2.2 / 11.1.4. Replacing it and upgrading the affected
   dependency tree require another source build and full packaged verification.
   Advisory matching proves included dependency code, not exploit reachability.

Clean-machine Windows, macOS/Linux, enterprise custom CA/proxy, external AI,
language toolchains and remote integrations remain unverified. Dependencies of
optional plugins may need user-configured runtimes. All app data is outside the
managed installation version directory.
