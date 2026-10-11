# Theia archive extraction compatibility

The application resolves every `decompress` dependency to this local CommonJS
adapter. All archive parsing and extraction is performed by the maintained
`@xhmikosr/decompress@11.1.4` package. No extraction implementation is vendored.

Theia 1.73.0-next.2 and 1.74.0 require a callable CommonJS export, while the
maintained fork exports an ES module. The adapter forwards arguments unchanged
and returns a Promise, including import and extraction failures. This supports
early Node 22 releases without relying on synchronous `require(ESM)`.

The audited callers are `@theia/cli` (plugin downloads and archive inspection),
`@theia/plugin-ext` (plugin deployment), `@theia/plugin-ext-vscode` (VSIX metadata,
extension deployment, and nested dependency archives), and `@theia/remote`
(native dependencies with its existing tar/tgz/zip plugins). These include
application runtime paths, not only build tooling.

The old `decompress@4.2.1` prefix-containment patch does not fix
[GHSA-hrh2-vp3x-79xf](https://github.com/advisories/GHSA-hrh2-vp3x-79xf).
The maintained fork handles traversal, symlink-chain validation, safe link
targets, duplicate entries, and file writes without following symlinks.

After installing application dependencies, run `yarn test:archive-extraction`
from `app/`. Tests cover the callable CommonJS API, Promise rejections, Theia's
options and return values, standard archive formats, custom plugins, and
malicious archives. Upgrading Theia or the fork requires rerunning these tests
and the application build. The fork intentionally rejects unsafe links and
duplicate entry paths that the old package accepted.
