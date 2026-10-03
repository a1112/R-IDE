# Local decompressor compatibility bridge

This private package preserves the `decompress` CommonJS name and Promise API
expected by Theia. Version `4.2.2` identifies this local bridge only; it is not an
upstream or published release. It contains no legacy `decompress` implementation.
All archive handling delegates to pinned `@xhmikosr/decompress` 11.1.4, the
maintained ESM fork with traversal and link checks. The original dependency
identity checks remain active in the generated Tauri profile.

Audit the fork and its dependencies, and record this bridge as local source with
its content hash. `../test/archive-safety.test.mjs` verifies normal tar/VSIX
extraction and attempts to escape through parent paths, archive links and an
existing output junction using only temporary fixtures.
