# Windows preview acceptance

Verified on the current Windows x64 host with temporary working directories,
isolated `RIDE_CONFIG_DIR` and WebView2 data, and a child PATH without Node.
This is host acceptance; a clean Windows machine and macOS/Linux remain pending.

| Check | Evidence |
| --- | --- |
| Production build | Tauri release executable, compiled Theia frontend/backend and four product extensions |
| Runtime | Bundled Node 24.15.0, actual Node-pty native addon, 70 VS Code plugins |
| Empty workspace | Existing `critical-empty` protocol: PTY terminal and actual `vscode.git` command |
| File workspace | Existing `critical-file` protocol: save, terminal, search, SCM, real plugin command, secondary window and second-file forwarding |
| Backend retry | Complete protocol: one document lifecycle, generation 1 to 2, a different owned Node root, two spawns, ready PID equals new root and zero old-tree processes |
| Exit | Native window WM_CLOSE exits normally; forced owned-main termination leaves no observed owned descendants |
| Startup failures | Missing Node, missing backend entry and an owned port-3000 fixture produce specific errors, no Node child and no foreign-process termination |
| Unit/static checks | 554 Node script/packaging tests including 9 archive safety and 2 glob compatibility tests; 275 product-extension tests; 381 Rust tests passed, 1 ignored; source ESLint, Rust format and Python syntax checks pass |

An earlier `critical-file` run timed out before forwarding progress; its logs and
failure record remain in `artifacts/critical-file-diagnostics-*`. A subsequent
sequential run passed the complete protocol. Run desktop acceptance scenarios
sequentially because the application is single-instance and owns port 3000.
An additional retry run completed the recovery protocol but timed out on the
independent startup report: the fault had been injected at shell attachment,
before full workbench initialization. A regression test now requires workbench
`ready` before the native crash step is committed; startup-report validation
remains mandatory in the final packaged driver.
The host's Windows PowerShell process query also once timed out during identity
capture; measurements prefer installed PowerShell 7 while retaining exact PID
and creation-time ownership checks and the Windows PowerShell fallback.
One failure-path run passed all three native checks but its temporary WebView2
folder cleanup raced a final filesystem write. The driver now retries cleanup
of its validated, owned temporary folder without hiding persistent failures.

Dependency security checks use the final esbuild metadata, positive
`bytesInOutput`, real installed package identities, output SHA-256 checks and
the npm Bulk Advisory API. The report is included as `bundle-audit.json` with
the raw response and its digest. At verification, 570 package versions have
zero high/critical matches and five remaining package-version matches:

- `@ai-sdk/provider-utils` 2.2.8: [resource consumption, low](https://github.com/advisories/GHSA-866g-f22w-33x8).
- `ai` 4.3.19: [upload file-type whitelist, low](https://github.com/advisories/GHSA-rwvc-j5jr-mgvh).
- `uuid` 7.0.3, 8.3.2 and 9.0.1: the same [v3/v5/v6 output-buffer bounds issue, moderate](https://github.com/advisories/GHSA-w5hq-g745-h8pq).

These remain recorded. Major AI SDK/UUID migrations and exploit reachability
have not been validated. This is not a zero-advisory claim for all dependencies:
the report excludes separately copied plugin code, Node's internal dependencies,
virtual bundler inputs and private local source, all listed in its scope.

Legacy decompressor code is replaced with a private CommonJS API bridge to
`@xhmikosr/decompress` 11.1.4. Its local version `4.2.2` is not an upstream
release. Tar 7.5.21 replaces tar 6; the old SCANOSS ESM import is adapted, while
the exact feature-graph verification remains enabled. The 318-to-277 exclusive
input change is explained by 42 tar-6 inputs being replaced by one tar-7 module.
Brace-expansion 5.0.12 retains its safety checks and named exports; a scoped
CommonJS compatibility bridge also supplies the callable API used by old
minimatch and ESLint. Both interfaces and actual legacy file globs are tested.
Temporary-fixture tests verify ordinary tar/VSIX extraction and reject parent
traversal, external archive links and pre-existing output junctions. Build-source
attestation and installed bridge byte comparison prevent stale local caches.

The backend retry fix preserves the desktop document during socket reconnect;
browser-only reload behavior remains unchanged. The smoke runner distinguishes
forwarded plugin reconnect warnings from native sidecar startup failures. Its
tests still reject missing runtime, pre-ready exit and sidecar launch failure.

Remaining limitations: WebView2 is required; Git, language servers/toolchains,
external AI and remote integration need user configuration and remain partly
unverified. The optional Windows CA addon uses the existing Node certificate-store
fallback; enterprise custom roots/proxies remain unverified. The optional keytar
credential-store addon is unavailable, so Theia uses its in-memory credentials
fallback. Preferences and state live outside the managed version directory;
credential persistence is not established. No original user configuration or
unowned process was changed by the acceptance drivers.
