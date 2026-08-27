# Codex runtime and App Server

R-IDE integrates Codex through the reviewed Codex App Server protocol. The
frontend and backend extension are lazy: opening R-IDE does not resolve a CLI,
load the SDK, start an App Server, access the network, or write a managed
runtime. The first Codex action owns activation and all process cleanup.

## Runtime precedence

When activation needs the native Codex CLI, resolution is deterministic:

1. `RIDE_CODEX_PATH` (an explicit environment override).
2. The user-selected runtime override.
3. A compatible local/system Codex installation.
4. A reviewed managed runtime active pointer, when the host has bound the
   extension-owned runtime store.

Explicit values fail closed when they are blank, inaccessible, the wrong
architecture, or not the reviewed compatible version (`0.144.0`). Implicit
system candidates are bounded and may fall through to the next provider.

## No-bundle policy

The R-IDE installer does not carry the Codex CLI, a native Codex executable,
optional platform packages, or a `vendor/`/`codex-resources/` tree. The browser
backend carries only the JavaScript SDK compatibility bundle
`codex-sdk-runtime.mjs`; the App Server path is resolved at runtime.

Verify an unpacked browser or Tauri backend with:

```powershell
node scripts/verify-codex-packaging.mjs --root applications/browser/lib
node scripts/verify-codex-packaging.mjs --root applications/tauri/resources/backend
```

The verifier is case-insensitive, rejects links and non-regular artifacts, and
scans nested directories. It is a release gate, not a replacement for the
installer's normal file verification.

## Managed installation

Managed runtimes are private, versioned extension data, never a repository,
installation, global package-manager, or `PATH` directory. The host supplies
an extension-owned local runtime root; the store rejects network/UNC roots and
keeps a verified active pointer plus at most the previous valid version.

Installation requires explicit user consent bound to the exact reviewed
version, target, digest, URL origin, destination, and disk-space presentation.
The transaction then downloads from the pinned manifest, checks SHA-512 and
target metadata, rejects unsafe archive entries, probes the runtime, and
activates atomically. A failed App Server handshake restores the previous
pointer. Interrupted staging and stale journals are recovered on the next
store open.

The checked-in manifest currently supports Codex CLI `0.144.0` for:

| Target | Package |
| --- | --- |
| `x86_64-pc-windows-msvc` | `codex-win32-x64` |
| `aarch64-pc-windows-msvc` | `codex-win32-arm64` |
| `x86_64-apple-darwin` | `codex-darwin-x64` |
| `aarch64-apple-darwin` | `codex-darwin-arm64` |
| `x86_64-unknown-linux-musl` | `codex-linux-x64` |
| `aarch64-unknown-linux-musl` | `codex-linux-arm64` |

## Authentication and execution defaults

The App Server is the primary execution path. ChatGPT browser/device-code
login and API-key login are supported. API keys are forwarded only for the
authenticated request, are not persisted by the R-IDE auth broker, and are
redacted from diagnostics and public state. ChatGPT login state is represented
by bounded, secret-free snapshots.

New threads use the reviewed safe defaults: `workspaceWrite` sandboxing with
network access disabled and `on-request` approval policy. Only the stable
command-execution and file-change approval families are exposed to the UI;
unsupported or experimental approval requests are declined or ignored.

The SDK compatibility path is explicit and separate. It is used only by the
legacy compatibility adapter, shares the same resolved native CLI, and does
not automatically continue an active App Server turn.

## Diagnostics and recovery

App Server startup uses piped stdio, a bounded five-second handshake deadline,
continuous bounded stderr draining, generation-tagged requests, and one safe
restart after an unexpected exit. A second failure opens the circuit until the
user explicitly retries. Diagnostics contain stable categories and redacted,
bounded details; they must never include API keys, auth tokens, or local
account data.

For a missing runtime, install a compatible Codex CLI or set an absolute local
`RIDE_CODEX_PATH`, then retry Codex. For a managed-runtime failure, use the
Codex runtime settings to retry the consented installation; do not copy a
native executable into the R-IDE install directory.

The deterministic warm-activation report uses schema
`ride.codex-warm-activation` and enforces initialized p95 `<= 1,500 ms` plus
App Server handshake p95 `<= 5,000 ms`:

```powershell
node scripts/check-tauri-performance.mjs \
  --codex-warm-activation path/to/codex-warm-activation.json
```

Real download and login timings are informational and are not included in the
warm-activation sample.

## Packaged smoke and uninstall

The Codex packaged smoke is an explicit Windows manual gate. Its nonce-guarded
fake App Server is test-only and is unreachable during ordinary activation. It
checks inactive startup, activation, initialize/auth/model/thread exchange,
streaming, command approval, file approval, interruption, one crash/recovery,
process attribution, and idle exit:

```powershell
npm run smoke:tauri-packaged -- --scenario codex \
  --output path/to/codex-smoke.json
```

The smoke fixture does not contain or download the Codex CLI.

To uninstall, exit all R-IDE processes first, run the platform installer
uninstaller, and remove only the extension-owned managed runtime directory if
you want to delete downloaded runtimes. Never remove a computed broad parent
directory and never change global `PATH` or package-manager state. Active and
pending runtime pointers must be gone before deleting the verified runtime
root; otherwise leave the root for the next startup recovery pass.
