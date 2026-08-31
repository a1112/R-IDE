# Codex Lazy Runtime and App Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the eager/accidental Theia Codex integration with an R-IDE-owned, demand-loaded Codex runtime that uses App Server for interactive work, retains a bounded SDK compatibility path, never bundles Codex CLI binaries, and exposes Codex process cost through the existing Tauri sampler.

**Architecture:** A permanent lightweight frontend proxy activates a first-party Theia extension exactly once. The backend resolves one native Codex CLI with `override > compatible system > managed` precedence, owns one stdio JSONL App Server process, and exposes typed auth/thread/turn/approval RPCs. The compatibility SDK is bundled as JavaScript only and imported only on explicit SDK use. The existing Tauri process tree remains the lifecycle and metrics boundary.

**Tech Stack:** TypeScript 5.9, Eclipse Theia 1.73, Inversify, Node.js 22, `node:test`, React 18/19, esbuild, OpenAI Codex CLI/App Server 0.144.0 stable protocol, `@openai/codex-sdk` 0.49.0 compatibility API, Rust 2021, Tauri 2.1, `sysinfo`, GitHub Actions.

---

## Execution Rules and Baseline

- Read [the approved design](./2026-08-23-codex-runtime-app-server-design.md) before implementation. The design wins if this checklist omits a safety constraint.
- Use `@superpowers:test-driven-development` for every task: add one focused failing test, observe the expected failure, implement only enough to pass, then refactor while green.
- Use `@superpowers:systematic-debugging` for any failure that does not match the expected red state. Do not weaken assertions to make an unexplained failure disappear.
- Use `@openai-docs` before changing the supported CLI version or stable method allowlist. Regenerate from the matching CLI and review the diff; never infer protocol changes from memory.
- Use `@superpowers:verification-before-completion` before the final commit, push, PR update, or performance claim.
- Never place API keys, login artifacts, CLI archives, generated managed runtimes, or real account fixtures in Git.
- Never run the managed-runtime network path before a user-consent token is validated.
- Keep build output out of the constrained system disk. In every PowerShell used for Rust work, set:

```powershell
$env:CARGO_TARGET_DIR = 'L:\R-IDE-builds\ride-codex-app-server-target'
```

### Create the isolated implementation worktree

Run from `D:\Project\R-IDE`:

```powershell
git fetch origin
git worktree add .worktrees/codex-app-server -b codex/codex-app-server-integration codex/tauri-rust-performance
Set-Location .worktrees/codex-app-server
git merge --no-ff main
git merge-base --is-ancestor d18d49b HEAD
git merge-base --is-ancestor 12fb5ca HEAD
$env:CARGO_TARGET_DIR = 'L:\R-IDE-builds\ride-codex-app-server-target'
```

Expected: both `git merge-base` commands exit `0`; `git status --short --branch` names `codex/codex-app-server-integration`. If the branch or worktree already exists, inspect and reuse it rather than deleting it.

## Task 1: Scaffold the First-Party Codex Extension

**Files:**

- Create: `app/theia-extensions/codex/package.json`
- Create: `app/theia-extensions/codex/tsconfig.json`
- Create: `app/theia-extensions/codex/tsconfig.test.json`
- Create: `app/theia-extensions/codex/src/common/ride-codex-protocol.ts`
- Create: `app/theia-extensions/codex/src/browser/ride-codex-frontend-module.ts`
- Create: `app/theia-extensions/codex/src/node/ride-codex-backend-module.ts`
- Create: `app/scripts/test/codex-package-wiring.test.mjs`
- Modify: `app/package.json`
- Modify: `app/applications/browser/package.json`
- Modify: `app/yarn.lock`
- Delete: `app/patches/@theia+ai-codex+1.73.0-next.2.patch`

**Step 1: Write the failing wiring test**

```js
test('browser uses the R-IDE Codex extension without the patched upstream package', async () => {
  const browser = JSON.parse(await readFile('applications/browser/package.json', 'utf8'));
  const root = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(browser.dependencies['@theia/ai-codex'], undefined);
  assert.equal(browser.dependencies['theia-ide-codex-ext'], '1.72.100');
  assert.match(root.scripts['build:extensions'], /theia-extensions\/codex/);
  await assert.rejects(access('patches/@theia+ai-codex+1.73.0-next.2.patch'));
});
```

Run from `app`:

```powershell
node --test scripts/test/codex-package-wiring.test.mjs
```

Expected: FAIL because the browser still depends on `@theia/ai-codex` and the local package does not exist.

**Step 2: Implement the minimum package shell**

- Name the package `theia-ide-codex-ext`, version `1.72.100`, and expose both frontend and backend Theia modules.
- Depend directly on only the Theia APIs used by the local implementation; do not depend on `@theia/ai-codex`.
- Add `build`, `test`, `lint`, and `clean` scripts matching `theia-ide-product-ext` conventions.
- Register the workspace in `build:extensions`, replace the browser dependency, remove the obsolete patch, and regenerate only `app/yarn.lock` with the repository package manager.
- Keep both modules side-effect free: bindings are allowed, but no CLI resolution, SDK import, process spawn, filesystem scan, timer, or network call may occur in module evaluation or constructors.

```ts
export const RideCodexServicePath = '/services/ride-codex';
export const RideCodexService = Symbol('RideCodexService');

export interface RideCodexService {
    status(): Promise<{ state: 'inactive' | 'activating' | 'ready' | 'error' }>;
    activate(): Promise<void>;
}
```

Run from `app`:

```powershell
yarn install
npm --workspace theia-ide-codex-ext run build
node --test scripts/test/codex-package-wiring.test.mjs
```

Expected: PASS; lockfile changes contain the local package wiring and no new Codex platform binary package.

**Step 3: Commit**

```powershell
git add app/package.json app/yarn.lock app/applications/browser/package.json app/theia-extensions/codex app/scripts/test/codex-package-wiring.test.mjs app/patches/@theia+ai-codex+1.73.0-next.2.patch
git commit -m "refactor: own the Codex Theia extension"
```

## Task 2: Add the Permanent Zero-Work Frontend Proxy

**Files:**

- Create: `app/theia-extensions/codex/src/browser/ride-codex-activation.ts`
- Create: `app/theia-extensions/codex/src/browser/ride-codex-chat-agent-proxy.ts`
- Create: `app/theia-extensions/codex/test/ride-codex-activation.test.ts`
- Create: `app/applications/browser/tauri-src/codex-proxy-frontend-module.ts`
- Create: `app/applications/browser/tauri-src/codex-feature.ts`
- Create: `app/scripts/test/codex-deferred-profile.test.mjs`
- Modify: `app/theia-extensions/codex/src/browser/ride-codex-frontend-module.ts`
- Modify: `app/applications/browser/tauri-profile.json`
- Modify: `app/applications/browser/tauri-src/esbuild-deferred.mjs`
- Modify: `app/scripts/test/tauri-frontend-profile.test.mjs`

**Step 1: Write failing activation and profile tests**

```ts
test('concurrent explicit requests share one activation and startup performs no work', async () => {
    const calls: string[] = [];
    const activation = new RideCodexActivation(() => {
        calls.push('load');
        return Promise.resolve({ activate: async () => calls.push('activate') });
    });
    assert.deepEqual(calls, []);
    await Promise.all([activation.activate(), activation.activate()]);
    assert.deepEqual(calls, ['load', 'activate']);
});
```

```js
test('tauri-critical aliases the local Codex module to a deferred codex-activate chunk', () => {
  const codex = profile.featureGroups.ai.deferredFrontendModules
    .find(entry => entry.action === 'codex-activate');
  assert.equal(codex.package, 'theia-ide-codex-ext');
  assert.equal(codex.proxy, 'tauri-src/codex-proxy-frontend-module.ts');
  assert.equal(codex.entry, 'tauri-src/codex-feature.ts');
});
```

Run from `app`:

```powershell
npm --workspace theia-ide-codex-ext test
node --test scripts/test/codex-deferred-profile.test.mjs scripts/test/tauri-frontend-profile.test.mjs
```

Expected: FAIL because there is no idempotent activation object or local-package alias support.

**Step 2: Implement the proxy contract**

- Register only a stable command/agent identity and state machine (`inactive`, `activating`, `ready`, `error`) at startup.
- Render the shell immediately; load `codex-feature.ts` only when the user opens Codex or invokes a Codex command.
- Make retries explicit after an activation error and prevent activation after disposal.
- Change the esbuild alias resolver from an `@theia/*`-only filter to exact escaped keys from `deferredFrontendModules`, so the local package can be aliased without broad interception.
- Move `@theia/ai-codex` out of the blocked list by replacing it with the local package declaration; do not unblock unrelated AI packages.
- Add metadata assertions proving the startup bundle contains the proxy but not `ride-codex-feature`, `@openai/codex-sdk`, installer code, or App Server client code.

```ts
load: () => import('./codex-feature').then(module => module.createCodexFeature())
```

Run the same two commands again. Expected: PASS.

**Step 3: Commit**

```powershell
git add app/theia-extensions/codex app/applications/browser/tauri-profile.json app/applications/browser/tauri-src app/scripts/test/codex-deferred-profile.test.mjs app/scripts/test/tauri-frontend-profile.test.mjs
git commit -m "perf: defer Codex frontend activation"
```

## Task 3: Pin and Review the Stable App Server Protocol

**Files:**

- Create: `app/scripts/generate-codex-app-server-schema.mjs`
- Create: `app/scripts/test/generate-codex-app-server-schema.test.mjs`
- Create: `app/theia-extensions/codex/src/common/generated/app-server/0.144.0/schema.json`
- Create: `app/theia-extensions/codex/src/common/generated/app-server/0.144.0/types/`
- Create: `app/theia-extensions/codex/src/common/ride-codex-methods.ts`
- Create: `app/theia-extensions/codex/src/common/codex-app-server-compatibility.json`
- Modify: `app/theia-extensions/codex/tsconfig.json`
- Modify: `app/package.json`

**Step 1: Write the failing contract test**

```js
test('production allowlist is stable and initialize never opts into experiments', async () => {
  const methods = await import('../../theia-extensions/codex/lib/common/ride-codex-methods.js');
  assert.deepEqual(methods.INITIALIZE_CAPABILITIES, {
    experimentalApi: false,
    requestAttestation: false,
  });
  assert.equal(methods.CLIENT_METHODS.has('thread/shellCommand'), false);
  assert.equal(methods.CLIENT_METHODS.has('process/exec'), false);
});
```

Run from `app`:

```powershell
node --test scripts/test/generate-codex-app-server-schema.test.mjs
```

Expected: FAIL because no reviewed schema, matrix, or allowlist exists.

**Step 2: Generate and constrain the protocol**

- With `@openai-docs`, re-check the official App Server initialize sequence and stable schema-generation commands.
- Generate into a temporary directory with `codex app-server generate-ts --out <dir>` and `codex app-server generate-json-schema --out <dir>`; normalize generated paths/newlines before checking in output.
- Make the script support `--write` and `--check`. `--check` must compare generated output only when a matching CLI is explicitly supplied; ordinary CI validates checked-in schema shape without downloading a CLI.
- Record CLI `0.144.0`, schema directory, supported targets, minimum/maximum compatible protocol version, and reviewed stable method list in the compatibility JSON.
- Allow only `initialize`, account/model/thread/turn methods and the two approval request families listed in the design. Unknown notifications are diagnosable but not fatal; unknown server requests are rejected as unsupported.

```ts
export const INITIALIZE_CAPABILITIES = Object.freeze({
    experimentalApi: false,
    requestAttestation: false
});
```

Run from `app`:

```powershell
node scripts/generate-codex-app-server-schema.mjs --codex codex --version 0.144.0 --write
npm --workspace theia-ide-codex-ext run build
node --test scripts/test/generate-codex-app-server-schema.test.mjs
node scripts/generate-codex-app-server-schema.mjs --codex codex --version 0.144.0 --check
```

Expected: PASS and `--check` reports no diff. If local CLI is not exactly `0.144.0`, stop and update the reviewed matrix through a separate protocol-review change; do not silently generate a different version.

**Step 3: Commit**

```powershell
git add app/package.json app/scripts/generate-codex-app-server-schema.mjs app/scripts/test/generate-codex-app-server-schema.test.mjs app/theia-extensions/codex
git commit -m "build: pin the Codex App Server protocol"
```

## Task 4: Implement the Bounded JSONL RPC Client

**Files:**

- Create: `app/theia-extensions/codex/src/node/ride-codex-jsonl-framer.ts`
- Create: `app/theia-extensions/codex/src/node/ride-codex-jsonl-client.ts`
- Create: `app/theia-extensions/codex/src/node/ride-codex-message-validator.ts`
- Create: `app/theia-extensions/codex/test/ride-codex-jsonl-client.test.ts`

**Step 1: Write failing framing/correlation tests**

```ts
test('frames split and coalesced JSON lines and correlates out-of-order responses', async () => {
    const transport = new FakeTransport();
    const client = new RideCodexJsonlClient(transport, { maxLineBytes: 1024, maxPending: 2 });
    const one = client.request('model/list', {});
    const two = client.request('thread/list', {});
    transport.stdout('{"id":2,"result":{"data":[]}}\n{"id":');
    transport.stdout('1,"result":{"data":[]}}\n');
    assert.deepEqual(await Promise.all([one, two]), [{ data: [] }, { data: [] }]);
});
```

Also cover malformed JSON, overlong lines, duplicate/unknown response IDs, timeout, transport exit, max-pending rejection, valid notifications, and unsupported server requests.

Run from `app`:

```powershell
npm --workspace theia-ide-codex-ext test
```

Expected: FAIL because the framing and request client do not exist.

**Step 2: Implement the minimum client**

- Buffer bytes until newline; support CRLF; reject a line over the configured byte limit before parsing it.
- Use monotonically increasing safe integer IDs and a bounded `Map` of pending requests.
- Validate `{id,result|error}`, `{method,params}`, and server-request envelopes against the checked-in contract before dispatch.
- Reject every pending request exactly once on timeout, malformed connection data, disposal, or child exit.
- Never write after transport close; remove all timers and listeners on settlement.
- Ignore unknown notifications after one bounded diagnostic event; reply with method-not-found to unknown server requests.

```ts
request(method: StableClientMethod, params: unknown, timeoutMs = 30_000): Promise<unknown>;
respond(id: RequestId, result: unknown): void;
respondError(id: RequestId, code: number, message: string): void;
```

Run the package test again. Expected: PASS with no dangling handles under `node --test`.

**Step 3: Commit**

```powershell
git add app/theia-extensions/codex/src/node app/theia-extensions/codex/test/ride-codex-jsonl-client.test.ts
git commit -m "feat: add bounded Codex JSONL RPC"
```

## Task 5: Resolve One Native CLI Lazily

**Files:**

- Create: `app/theia-extensions/codex/src/node/ride-codex-launch-spec.ts`
- Create: `app/theia-extensions/codex/src/node/ride-codex-runtime-resolver.ts`
- Create: `app/theia-extensions/codex/src/node/ride-codex-runtime-probe.ts`
- Create: `app/theia-extensions/codex/test/ride-codex-runtime-resolver.test.ts`

**Step 1: Write failing resolver tests**

```ts
test('does no probing before activation and resolves override before system and managed', async () => {
    const probes: string[] = [];
    const resolver = fixtureResolver({ probes, override: 'X:/codex.exe', system: 'Y:/codex.cmd', managed: 'Z:/codex.exe' });
    assert.deepEqual(probes, []);
    assert.equal((await resolver.resolve()).executable, normalize('X:/codex.exe'));
    assert.deepEqual(probes, [normalize('X:/codex.exe')]);
});
```

Add Windows fixtures for a `codex.ps1`/`codex.cmd` npm wrapper whose adjacent package contains `codex-package.json` and `vendor/x86_64-pc-windows-msvc/bin/codex.exe`. Add tests for incompatible version, wrong architecture, missing App Server command, invalid explicit override, and no fallback past an invalid explicit override.

Run from `app`:

```powershell
npm --workspace theia-ide-codex-ext test
```

Expected: FAIL because the resolver does not exist.

**Step 2: Implement the resolver and probe**

- Keep construction inert. `resolve()` is the first operation allowed to read overrides, inspect `PATH`, inspect npm wrappers, or read the managed active pointer.
- Return a `CodexLaunchSpec` with an absolute native executable, immutable channel-neutral environment, version, target, source, and diagnostics. App Server and SDK must consume this same object.
- Resolve Windows npm launchers to their optional target package and `codex-package.json` entrypoint; never launch PowerShell just to reach `codex.exe`.
- Probe with bounded `codex --version` and `codex app-server --help`; require the reviewed compatibility range and platform/architecture.
- Treat an invalid explicit override as actionable configuration error. System and managed candidates may fall through only when absent or incompatible.

```ts
export interface CodexLaunchSpec {
    readonly executable: string;
    readonly version: string;
    readonly target: string;
    readonly source: 'override' | 'system' | 'managed';
}
```

Run the package test again. Expected: PASS and resolver spies show zero pre-activation reads.

**Step 3: Commit**

```powershell
git add app/theia-extensions/codex/src/node/ride-codex-launch-spec.ts app/theia-extensions/codex/src/node/ride-codex-runtime-resolver.ts app/theia-extensions/codex/src/node/ride-codex-runtime-probe.ts app/theia-extensions/codex/test/ride-codex-runtime-resolver.test.ts
git commit -m "feat: resolve a shared native Codex runtime"
```

## Task 6: Stage a Verified Managed Runtime

**Files:**

- Create: `app/theia-extensions/codex/src/node/ride-codex-runtime-manifest.ts`
- Create: `app/theia-extensions/codex/src/node/ride-codex-runtime-fetcher.ts`
- Create: `app/theia-extensions/codex/src/node/ride-codex-runtime-stager.ts`
- Create: `app/theia-extensions/codex/resources/codex-runtime-manifest.json`
- Create: `app/theia-extensions/codex/test/ride-codex-runtime-stager.test.ts`
- Modify: `app/theia-extensions/codex/package.json`
- Modify: `app/yarn.lock`

**Step 1: Write failing integrity and extraction tests**

```ts
test('rejects hash mismatch, traversal, links, wrong target, and insufficient disk', async t => {
    await assert.rejects(stage(t, fixture('hash-mismatch.tgz')), /integrity/i);
    await assert.rejects(stage(t, fixture('dot-dot.tgz')), /unsafe archive path/i);
    await assert.rejects(stage(t, fixture('symlink.tgz')), /link entry/i);
    await assert.rejects(stage(t, fixture('wrong-target.tgz')), /target mismatch/i);
    await assert.rejects(stage(t, fixture('valid.tgz'), { freeBytes: 1 }), /disk space/i);
});
```

Run from `app`:

```powershell
npm --workspace theia-ide-codex-ext test
```

Expected: FAIL because no managed-runtime staging primitives exist.

**Step 2: Implement verified staging only**

- Populate the checked-in manifest from official npm registry metadata for each supported target. Record package/version, exact tarball URL, SHA-512 SRI, expected compressed and extracted sizes, target triple, layout version, and native entrypoint. Never use `latest`.
- Use a unique staging directory beneath the extension-owned runtime root. Stream download and hash computation; enforce byte and redirect limits.
- Before download, call Node 22 `fs.statfs` and require expected extracted size plus explicit safety margin.
- Extract with a direct, pinned archive dependency; reject absolute paths, `..`, device files, hard links, symbolic links, alternate streams, and entries outside the single expected package root.
- Parse `codex-package.json`, verify layout/version/target/entrypoint, set executable permission where applicable, then run the bounded runtime probe.
- This task stages but does not activate a version. It exposes no public method that performs a network fetch without the authorization object introduced in Task 7.

```ts
stage(authorization: InstallAuthorization, target: RuntimeTarget): Promise<StagedRuntime>;
```

Run from `app`:

```powershell
yarn install
npm --workspace theia-ide-codex-ext test
```

Expected: PASS; fixture archives stay under the test temporary directory.

**Step 3: Commit**

```powershell
git add app/yarn.lock app/theia-extensions/codex
git commit -m "feat: verify managed Codex runtime staging"
```

## Task 7: Enforce Consent, Atomic Activation, and Rollback

**Files:**

- Create: `app/theia-extensions/codex/src/common/ride-codex-installation.ts`
- Create: `app/theia-extensions/codex/src/node/ride-codex-install-consent.ts`
- Create: `app/theia-extensions/codex/src/node/ride-codex-runtime-store.ts`
- Create: `app/theia-extensions/codex/src/node/ride-codex-managed-installer.ts`
- Create: `app/theia-extensions/codex/test/ride-codex-managed-installer.test.ts`
- Modify: `app/theia-extensions/codex/src/node/ride-codex-runtime-stager.ts`
- Modify: `app/theia-extensions/codex/src/node/ride-codex-runtime-resolver.ts`

**Step 1: Write the failing state-machine test**

```ts
test('requires matching consent, switches atomically, rolls back, and retains two versions', async () => {
    await assert.rejects(installer.install(undefined), /consent/i);
    const token = consent.issue(presentationFor('0.144.0'));
    await installer.install(token);
    assert.equal(await store.activeVersion(), '0.144.0');
    await assert.rejects(installer.install(consent.issue(presentationFor('0.145.0')), { failHandshake: true }));
    assert.equal(await store.activeVersion(), '0.144.0');
    assert.deepEqual(await store.versions(), ['0.143.0', '0.144.0']);
});
```

Also test expired/replayed/mismatched tokens, interrupted pointer write, concurrent installs, cleanup outside the verified root, and recovery from a stale staging directory.

Run from `app`:

```powershell
npm --workspace theia-ide-codex-ext test
```

Expected: FAIL because consent and activation are not enforced.

**Step 2: Implement the install transaction**

- Present source, version, target, URL origin, install root, required space, and two-version rollback policy before issuing a short-lived single-use in-memory consent token.
- Bind the token to the exact manifest digest and target. Validate it before the first network call.
- Serialize installation per runtime root with a lock. Write `active.json.tmp`, fsync file and parent where supported, then rename atomically.
- Keep the new valid version and the previous valid version. Delete only obsolete directories whose canonical paths remain under the versioned extension-owned root.
- If post-activation App Server handshake fails, restore the previous active pointer and surface both primary and rollback diagnostics.
- Expose progress states, but never include archive contents, secrets, or local account data.

```ts
type InstallState = 'awaiting-consent' | 'downloading' | 'verifying' | 'activating' | 'ready' | 'rolled-back' | 'failed';
```

Run the package test again. Expected: PASS, including concurrent and crash-recovery fixtures.

**Step 3: Commit**

```powershell
git add app/theia-extensions/codex
git commit -m "feat: activate managed Codex runtimes safely"
```

## Task 8: Own One Lazy App Server Process

**Files:**

- Create: `app/theia-extensions/codex/src/node/ride-codex-app-server-host.ts`
- Create: `app/theia-extensions/codex/src/node/ride-codex-diagnostics.ts`
- Create: `app/theia-extensions/codex/test/fixtures/fake-app-server.mjs`
- Create: `app/theia-extensions/codex/test/ride-codex-app-server-host.test.ts`
- Modify: `app/theia-extensions/codex/src/node/ride-codex-backend-module.ts`

**Step 1: Write failing host lifecycle tests**

```ts
test('starts once, initializes stable capabilities, idles out, then opens a circuit', async () => {
    const host = fixtureHost({ idleMs: 600_000, handshakeMs: 5_000 });
    await Promise.all([host.acquire('panel'), host.acquire('thread')]);
    assert.equal(host.spawnCount, 1);
    assert.deepEqual(host.requests[0], {
        method: 'initialize',
        params: {
            clientInfo: { name: 'r-ide', title: 'R-IDE', version: '1.72.100' },
            capabilities: { experimentalApi: false, requestAttestation: false }
        }
    });
    await host.crash();
    assert.equal(host.spawnCount, 2);
    await host.crash();
    await assert.rejects(host.acquire('retry'), /circuit breaker/i);
});
```

Add tests for early exit, five-second handshake timeout, stderr backpressure, redacted/bounded diagnostics, pending-request rejection, one restart, no restart during unsafe approval, ten-minute idle stop, release/dispose races, and one process shared by many threads.

Run from `app`:

```powershell
npm --workspace theia-ide-codex-ext test
```

Expected: FAIL because no process host exists.

**Step 2: Implement the host**

- Spawn exactly `launchSpec.executable` with `['app-server', '--stdio']`, piped stdin/stdout/stderr, and no shell. This is the reviewed explicit stdio form for CLI 0.144.0.
- Drain stderr continuously into a redacted ring buffer with byte and line caps.
- Complete `initialize` before any account/model/thread call. Do not set experimental capabilities.
- Track leases for active turns, approvals, and foreground panel demand. Start the idle timer only when every lease is released.
- Gracefully close stdin, wait a bounded interval, then terminate. Rely on the existing R-IDE process-tree containment for final descendant cleanup.
- Restart once after unexpected exit only when no unsafe approval is pending; then open a circuit breaker until explicit retry.
- Ensure constructors remain inert and activation owns the first call to `resolver.resolve()`.

Run the package test again. Expected: PASS and `node --test` exits without leaked child processes.

**Step 3: Commit**

```powershell
git add app/theia-extensions/codex/src/node app/theia-extensions/codex/test
git commit -m "feat: supervise the Codex App Server"
```

## Task 9: Add Auth Brokerage and Plaintext-Key Migration

**Files:**

- Create: `app/theia-extensions/codex/src/common/ride-codex-auth.ts`
- Create: `app/theia-extensions/codex/src/node/ride-codex-auth-broker.ts`
- Create: `app/theia-extensions/codex/src/browser/ride-codex-auth-controller.ts`
- Create: `app/theia-extensions/codex/test/ride-codex-auth-broker.test.ts`
- Create: `app/theia-extensions/codex/test/ride-codex-auth-controller.test.ts`
- Modify: `app/theia-extensions/codex/src/common/ride-codex-protocol.ts`
- Modify: `app/theia-extensions/codex/src/node/ride-codex-diagnostics.ts`

**Step 1: Write failing auth and redaction tests**

```ts
test('uses an API key ephemerally and never exposes it through state or diagnostics', async () => {
    const key = 'sk-test-secret-fragment';
    await broker.login({ type: 'apiKey', apiKey: key });
    assert.equal(appServer.last('account/login/start').params.apiKey, key);
    assert.doesNotMatch(JSON.stringify(await broker.status()), /secret-fragment/);
    assert.doesNotMatch(diagnostics.dump(), /secret-fragment|sk-test/);
});
```

Add tests for ChatGPT browser login, device-code login, cancellation, completion notification, account/read, logout, rate limits, disconnect, key disposal, and one-time migration of `ai-features.codex.apiKey`/shared OpenAI plaintext preferences.

Run from `app`:

```powershell
npm --workspace theia-ide-codex-ext test
```

Expected: FAIL because auth brokerage and migration do not exist.

**Step 2: Implement explicit auth modes**

- Map `account/login/start`, `account/login/cancel`, `account/read`, `account/logout`, account update, login completion, and rate-limit notifications into typed frontend state.
- Send `{ type: 'apiKey', apiKey }` only over the existing local RPC to App Server; do not place the key in preferences, command arguments, diagnostics, telemetry, or persisted host state.
- Redact authorization headers, secret-like environment names, OpenAI key formats, query credentials, and the exact transient key fragment before any diagnostic leaves the backend.
- Detect old plaintext preferences only after explicit Codex activation. Prompt once; on acceptance send the key, await successful account state, then delete the old preference. On decline leave Codex inactive and preserve the preference for manual handling.
- Never parse or copy Codex account files; ChatGPT auth remains App Server-owned.

Run the package test again. Expected: PASS and secret fixtures never occur in snapshots or test logs.

**Step 3: Commit**

```powershell
git add app/theia-extensions/codex
git commit -m "feat: broker Codex authentication safely"
```

## Task 10: Implement Models and Persistent Threads

**Files:**

- Create: `app/theia-extensions/codex/src/common/ride-codex-conversations.ts`
- Create: `app/theia-extensions/codex/src/node/ride-codex-thread-coordinator.ts`
- Create: `app/theia-extensions/codex/test/ride-codex-thread-coordinator.test.ts`
- Modify: `app/theia-extensions/codex/src/common/ride-codex-protocol.ts`
- Modify: `app/theia-extensions/codex/src/node/ride-codex-app-server-host.ts`

**Step 1: Write failing thread mapping tests**

```ts
test('lists, starts, resumes, reads, and archives App Server threads without a local transcript', async () => {
    const coordinator = fixtureCoordinator();
    const started = await coordinator.start({ cwd: 'D:/work', model: 'gpt-5' });
    await coordinator.resume(started.id);
    await coordinator.read(started.id);
    await coordinator.archive(started.id);
    assert.deepEqual(coordinator.calls.map(call => call.method), [
        'thread/start', 'thread/resume', 'thread/read', 'thread/archive'
    ]);
    assert.equal(coordinator.persistedTranscriptCount, 0);
});
```

Also test pagination, model capability mapping, stale selected thread, workspace-normalized `cwd`, default `"workspace-write"` sandbox, approvals enabled, and a thread resumed after the single safe process restart.

Run from `app`:

```powershell
npm --workspace theia-ide-codex-ext test
```

Expected: FAIL because no conversation coordinator exists.

**Step 2: Implement stable model/thread operations**

- Support `model/list`, `thread/list`, `thread/start`, `thread/resume`, `thread/read`, and `thread/archive` only when present in the reviewed stable allowlist.
- Normalize model capabilities without inventing unsupported options.
- Start/resume with normalized workspace cwd, the exact protocol sandbox literal `"workspace-write"`, and explicit approval policy. Full access requires a separate user action and is not part of this release.
- Keep only UI selection/layout state in R-IDE. App Server is authoritative for history and transcript content.
- Reconcile `thread/started` and `thread/status/changed` notifications idempotently.

Run the package test again. Expected: PASS.

**Step 3: Commit**

```powershell
git add app/theia-extensions/codex
git commit -m "feat: expose Codex models and threads"
```

## Task 11: Stream Turns with Steering, Interrupt, and Backpressure

**Files:**

- Create: `app/theia-extensions/codex/src/common/ride-codex-events.ts`
- Create: `app/theia-extensions/codex/src/node/ride-codex-turn-coordinator.ts`
- Create: `app/theia-extensions/codex/src/browser/ride-codex-event-reducer.ts`
- Create: `app/theia-extensions/codex/test/ride-codex-turn-coordinator.test.ts`
- Create: `app/theia-extensions/codex/test/ride-codex-event-reducer.test.ts`
- Modify: `app/theia-extensions/codex/src/common/ride-codex-protocol.ts`

**Step 1: Write failing streaming tests**

```ts
test('coalesces deltas, bounds retained output, steers the active turn, and interrupts terminally', async () => {
    const stream = fixtureTurn({ maxQueuedBytes: 4096, maxItemBytes: 2048 });
    await stream.start('thread-1', text('hello'));
    stream.notifyMany(agentDeltas(1_000));
    assert.equal(stream.frontendFlushCount, 0);
    stream.flushFrame();
    assert.equal(stream.frontendFlushCount, 1);
    await stream.steer(text('focus tests'));
    await stream.interrupt();
    assert.equal(stream.state, 'interrupted');
});
```

Add tests for turn/item lifecycle, reasoning summary/text deltas, command output, file patch deltas, usage, warnings, structured errors, late notifications, slow/disconnected frontend, interrupt timeout, and release of every App Server lease.

Run from `app`:

```powershell
npm --workspace theia-ide-codex-ext test
```

Expected: FAIL because turn coordination and reducers do not exist.

**Step 2: Implement bounded streaming**

- Map `turn/start`, `turn/steer`, and `turn/interrupt` with exact thread and expected-turn IDs.
- Reduce the approved stable notification families into typed immutable UI state.
- Batch high-frequency deltas at animation-frame cadence in the frontend and at a bounded cadence in the backend transport. Cap queued bytes, retained item count, bytes per item, and diagnostic history.
- Preserve terminal states (`completed`, `failed`, `interrupted`) and ignore duplicate/late terminal notifications idempotently.
- On interrupt timeout, restart the host, resume the persisted thread, and report interruption uncertainty; never claim the old turn completed.
- Release active-turn leases in `finally` for success, error, cancellation, disconnect, and process exit.

Run the package test again. Expected: PASS with deterministic fake clocks.

**Step 3: Commit**

```powershell
git add app/theia-extensions/codex
git commit -m "feat: stream bounded Codex turns"
```

## Task 12: Handle Approvals, Changes, Commands, and Errors

**Files:**

- Create: `app/theia-extensions/codex/src/common/ride-codex-approvals.ts`
- Create: `app/theia-extensions/codex/src/node/ride-codex-approval-broker.ts`
- Create: `app/theia-extensions/codex/src/browser/ride-codex-approval-dialog.tsx`
- Create: `app/theia-extensions/codex/src/browser/ride-codex-renderers.tsx`
- Create: `app/theia-extensions/codex/src/browser/ride-codex-error-mapper.ts`
- Create: `app/theia-extensions/codex/test/ride-codex-approval-broker.test.ts`
- Create: `app/theia-extensions/codex/test/ride-codex-error-mapper.test.ts`
- Modify: `app/theia-extensions/codex/src/browser/ride-codex-event-reducer.ts`

**Step 1: Write failing safety tests**

```ts
test('answers each approval once and rejects stale or cross-turn decisions', async () => {
    const request = broker.commandRequest({ id: 7, threadId: 't1', turnId: 'u1', command: ['git', 'status'] });
    await broker.decide(request.token, 'accept');
    await assert.rejects(broker.decide(request.token, 'accept'), /already resolved/i);
    await assert.rejects(broker.decide(forge(request.token, { turnId: 'u2' }), 'accept'), /ownership/i);
});
```

Also test normalized file scopes, workspace escape rejection, decision allowlists, `acceptForSession` visibility, panel/context disposal, process exit, command output truncation, file patch rendering, and mapping of unauthorized/rate-limit/context-limit/sandbox/transport errors.

Run from `app`:

```powershell
npm --workspace theia-ide-codex-ext test
```

Expected: FAIL because approval ownership and renderers do not exist.

**Step 2: Implement the safe approval boundary**

- Handle only `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` server requests.
- Bind an opaque frontend token to process generation, request ID, thread, turn, item, normalized scope, and allowed decisions. Resolve once.
- Offer `acceptForSession` only when the protocol explicitly allows it. Do not expose unstable `grantRoot` or experimental process/shell methods.
- Show exact command, cwd, normalized changed paths, and known network implications. Reject any client-supplied scope expansion.
- Render command output and file changes from validated events with byte limits and safe text escaping.
- Map errors into runtime/install, startup, protocol, auth, and turn layers without leaking redacted diagnostics.

Run the package test again. Expected: PASS.

**Step 3: Commit**

```powershell
git add app/theia-extensions/codex
git commit -m "feat: secure Codex approvals and rendering"
```

## Task 13: Integrate the Codex Agent and Control Surface with Theia

**Files:**

- Create: `app/theia-extensions/codex/src/browser/ride-codex-chat-agent.ts`
- Create: `app/theia-extensions/codex/src/browser/ride-codex-control-model.ts`
- Create: `app/theia-extensions/codex/src/browser/ride-codex-control-widget.tsx`
- Create: `app/theia-extensions/codex/src/browser/ride-codex-contribution.ts`
- Create: `app/theia-extensions/codex/test/ride-codex-chat-agent.test.ts`
- Create: `app/theia-extensions/codex/test/ride-codex-control-model.test.ts`
- Modify: `app/theia-extensions/codex/src/browser/ride-codex-chat-agent-proxy.ts`
- Modify: `app/applications/browser/tauri-src/codex-feature.ts`

**Step 1: Write failing Theia integration tests**

```ts
test('the stable proxy becomes one real ChatAgent after explicit activation', async () => {
    const harness = createTheiaCodexHarness();
    assert.equal(harness.agentRegistry.count('Codex'), 1);
    assert.equal(harness.backend.activateCalls, 0);
    await harness.commands.executeCommand('ride.codex.open');
    assert.equal(harness.backend.activateCalls, 1);
    assert.equal(harness.agentRegistry.count('Codex'), 1);
});
```

Add tests for immediate shell display, runtime consent/progress, auth selection, model/thread selection, turn submission, steer, interrupt, approval cards, retry after circuit break, disposal, localization, and no duplicate command/agent registration.

Run from `app`:

```powershell
npm --workspace theia-ide-codex-ext test
```

Expected: FAIL because the real local agent/control surface is absent.

**Step 2: Implement the first-party UI adapter**

- Port only needed behavior from the installed Theia Codex integration into R-IDE-owned classes; do not import or patch `@theia/ai-codex`.
- Implement Theia `Agent`/`ChatAgent` contracts using the local event reducer and existing `@theia/ai-chat` response content types.
- Keep the proxy identity stable. Activation replaces proxy behavior/delegates, not the cached contribution token.
- Make the control widget a state-driven shell: runtime selection/install, ChatGPT or API-key auth, model and thread controls, status/errors, then existing chat surfaces for content.
- Preserve workspace path safety and restore actual file-change rendering instead of the commented upstream changeset path.

Run from `app`:

```powershell
npm --workspace theia-ide-codex-ext test
npm --workspace theia-ide-codex-ext run build
node --test scripts/test/codex-deferred-profile.test.mjs
```

Expected: PASS and the startup-inventory assertion still excludes the heavy feature.

**Step 3: Commit**

```powershell
git add app/theia-extensions/codex app/applications/browser/tauri-src/codex-feature.ts
git commit -m "feat: integrate the lazy Codex agent UI"
```

## Task 14: Harden the SDK Compatibility Channel

**Files:**

- Create: `app/theia-extensions/codex/src/node/ride-codex-sdk-adapter.ts`
- Create: `app/theia-extensions/codex/src/node/ride-codex-sdk-runtime-entry.ts`
- Create: `app/theia-extensions/codex/test/ride-codex-sdk-adapter.test.ts`
- Create: `app/scripts/test/codex-sdk-bundle.test.mjs`
- Modify: `app/theia-extensions/codex/package.json`
- Modify: `app/applications/browser/esbuild.mjs`
- Modify: `app/applications/tauri/copy-backend.js`
- Modify: `app/yarn.lock`

**Step 1: Write failing lazy-SDK tests**

```ts
test('imports SDK only on explicit compatibility use and shares the resolved CLI', async () => {
    const loads: string[] = [];
    const adapter = fixtureSdkAdapter({ loads, executable: 'X:/codex.exe', maxThreads: 8 });
    assert.deepEqual(loads, []);
    await adapter.run({ channel: 'sdk', threadKey: 'one', input: 'test' });
    assert.deepEqual(loads, ['codex-sdk-runtime.mjs']);
    assert.equal(adapter.lastOptions.codexPath, normalize('X:/codex.exe'));
});
```

Add tests for API-key forwarding, immediate abort, listener cleanup, LRU thread eviction, bounded clients, explicit channel diagnostics, and refusal to continue an App Server turn automatically through SDK.

```js
test('SDK runtime output is JavaScript-only', async () => {
  const files = await walk('applications/browser/lib/backend');
  assert(files.includes('codex-sdk-runtime.mjs'));
  assert.equal(files.some(file => /vendor|codex(?:\.exe)?$|codex-(?:x64|arm64)/i.test(file)), false);
});
```

Run from `app`:

```powershell
npm --workspace theia-ide-codex-ext test
node --test scripts/test/codex-sdk-bundle.test.mjs
```

Expected: FAIL because there is no explicit SDK bundle or adapter.

**Step 2: Implement the compatibility bundle**

- Add direct pinned `@openai/codex-sdk` `0.49.0` dependency to the local extension and regenerate the lockfile.
- Add a separate Node ESM esbuild entry that emits `applications/browser/lib/backend/codex-sdk-runtime.mjs` only. Reject `.exe`, native optional target packages, `vendor/`, and SDK resource copying during the build.
- Dynamically import that output only in `RideCodexSdkAdapter.run()`.
- Pass the shared native `CodexLaunchSpec.executable` and selected ephemeral API key through the supported SDK options.
- Reuse a bounded LRU of thread/client records, propagate `AbortSignal` immediately, dispose listeners in `finally`, and never auto-fallback an active App Server turn.
- Keep `copy-backend.js` recursive JS copying, but add an assertion rather than a special vendor-copy path.

Run from `app`:

```powershell
yarn install
npm --workspace theia-ide-codex-ext test
npm --workspace theia-ide-browser-app run build:tauri-backend
node --test scripts/test/codex-sdk-bundle.test.mjs
```

Expected: PASS; the SDK module is absent from initial backend evaluation telemetry and the output directory contains no Codex native payload.

**Step 3: Commit**

```powershell
git add app/yarn.lock app/theia-extensions/codex app/applications/browser/esbuild.mjs app/applications/tauri/copy-backend.js app/scripts/test/codex-sdk-bundle.test.mjs
git commit -m "perf: lazy load the Codex SDK compatibility path"
```

## Task 15: Attribute Codex in the Existing Rust Process Sampler

**Files:**

- Modify: `app/applications/tauri/src-tauri/src/performance.rs`
- Modify: `app/applications/tauri/src-tauri/src/lib.rs`
- Modify: `app/theia-extensions/product/src/browser/ride-performance.ts`
- Modify: `app/theia-extensions/product/test/ride-performance.test.ts`

**Step 1: Write failing Rust and footer tests**

```rust
#[test]
fn codex_groups_partition_agent_usage_without_changing_total() {
    let snapshot = aggregate_snapshot(&codex_tree(), 10, Some(20), 1, 1);
    assert_eq!(snapshot.codex_agent.process_count, 5);
    assert_eq!(snapshot.codex_agent.memory_bytes,
        snapshot.codex_app_server.memory_bytes
        + snapshot.codex_sdk.memory_bytes
        + snapshot.codex_commands.memory_bytes);
    assert_eq!(snapshot.total.memory_bytes,
        snapshot.main.memory_bytes + snapshot.backend.memory_bytes
        + snapshot.plugin_host.memory_bytes + snapshot.codex_agent.memory_bytes
        + snapshot.other.memory_bytes);
}
```

```ts
test('Codex hover shows agent and channel breakdown in Chinese', () => {
    const view = formatPerformanceSnapshot(snapshotWithCodex(), 'zh-CN');
    assert.match(view.tooltip, /Codex Agent/);
    assert.match(view.tooltip, /App Server/);
    assert.match(view.tooltip, /SDK/);
    assert.match(view.tooltip, /命令子进程/);
});
```

Run from the worktree root:

```powershell
$env:CARGO_TARGET_DIR = 'L:\R-IDE-builds\ride-codex-app-server-target'
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml performance::tests::codex -- --nocapture
Set-Location app
npm --workspace theia-ide-product-ext test
```

Expected: FAIL because the snapshot has no Codex groups.

**Step 2: Extend classification without another scan**

- Add `codexAgent`, `codexAppServer`, `codexSdk`, and `codexCommands` usage groups to the serialized snapshot.
- Keep `total = main + backend + pluginHost + codexAgent + other`. Make the three Codex subgroups a non-overlapping partition of `codexAgent`.
- Preserve precedence: root main PID, exact owned backend PID, and plugin-host identity are classified before Codex matching.
- Identify native Codex roots by executable identity plus `app-server` or `exec` command mode. Attribute recognized Codex resource helpers to the owning channel; attribute other descendants beneath a Codex root to `codexCommands`.
- Reuse the already-selected R-IDE tree, identity refresh, CPU normalization, timestamp, and two-second frontend poll. Do not instantiate another `System`, refresh process identities twice, or add another timer.
- Add tests for ancestry, duplicate/conflicting PID defenses, saturated totals, command descendants, helpers, false positives containing the word `codex`, and unchanged aggregate totals.
- Add English/Chinese tooltip labels. The compact footer remains total CPU/memory; hover adds Codex breakdown only when its process count is nonzero.

Run from the worktree root:

```powershell
$env:CARGO_TARGET_DIR = 'L:\R-IDE-builds\ride-codex-app-server-target'
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --locked --all-targets
Set-Location app
npm --workspace theia-ide-product-ext test
```

Expected: PASS. Existing no-overlap polling tests remain green.

**Step 3: Commit**

```powershell
git add app/applications/tauri/src-tauri/src/performance.rs app/applications/tauri/src-tauri/src/lib.rs app/theia-extensions/product/src/browser/ride-performance.ts app/theia-extensions/product/test/ride-performance.test.ts
git commit -m "feat: report Codex process-tree usage"
```

## Task 16: Add Packaged Smoke, Artifact, Performance, CI, and User Documentation Gates

**Files:**

- Create: `app/scripts/verify-codex-packaging.mjs`
- Create: `app/scripts/test/verify-codex-packaging.test.mjs`
- Create: `app/scripts/test/codex-packaged-smoke.test.mjs`
- Create: `app/docs/codex-runtime.md`
- Modify: `app/scripts/tauri-packaged-smoke-contract.mjs`
- Modify: `app/scripts/run-tauri-packaged-smoke.mjs`
- Modify: `app/theia-extensions/product/src/browser/ride-packaged-smoke.ts`
- Modify: `app/theia-extensions/product/src/browser/ride-packaged-smoke-actions.ts`
- Modify: `app/theia-extensions/product/src/browser/ride-packaged-smoke-bindings.ts`
- Modify: `app/theia-extensions/product/test/ride-packaged-smoke.test.ts`
- Modify: `app/theia-extensions/product/test/ride-packaged-smoke-actions.test.ts`
- Modify: `app/theia-extensions/product/test/ride-packaged-smoke-bindings.test.ts`
- Modify: `app/scripts/check-tauri-performance.mjs`
- Modify: `app/scripts/test/check-tauri-performance.test.mjs`
- Modify: `app/package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/tauri.yml`

**Step 1: Write failing packaging and smoke contracts**

```js
test('release inventory excludes every bundled Codex runtime payload', async () => {
  const result = await verifyCodexPackaging(fixtureArtifact());
  assert.deepEqual(result.forbidden, []);
  assert.equal(result.files.some(file => file.endsWith('codex-sdk-runtime.mjs')), true);
});
```

```js
test('codex packaged scenario proves inactive, activate, stream, approve, interrupt, recover, and idle-exit', () => {
  assert.deepEqual(SMOKE_SCENARIO_REQUIREMENTS.codex.actions, [
    'codex-inactive', 'codex-activate', 'codex-stream', 'codex-command-approval',
    'codex-file-approval', 'codex-interrupt', 'codex-recover', 'codex-idle-exit'
  ]);
});
```

Run from `app`:

```powershell
node --test scripts/test/verify-codex-packaging.test.mjs scripts/test/codex-packaged-smoke.test.mjs scripts/test/tauri-packaged-smoke-contract.test.mjs
```

Expected: FAIL because Codex inventory and smoke gates are absent.

**Step 2: Implement deterministic release gates**

- Scan unpacked and installer inventories case-insensitively for `codex.exe`, native `codex` payloads, optional target packages, `vendor/`, `codex-resources/`, and populated managed-runtime directories. Permit only the reviewed JavaScript SDK bundle, protocol schema, docs, and installer manifest.
- Add a test-only fake App Server launch path guarded by the existing packaged-smoke nonce/environment contract. It must use the packaged Node runtime plus the fixture and must be unreachable in ordinary production activation.
- Before `codex-activate`, assert no CLI resolution marker, SDK evaluation marker, network request, managed-runtime write, App Server process, or Codex descendant.
- Exercise initialize, auth fixture, model/thread read, streamed turn, both approvals, interruption, one crash/resume, circuit behavior, process attribution, idle exit, and app-shutdown cleanup.
- Add warm activation timing (`panel shell`, `runtime resolved`, `process spawned`, `initialized`) and enforce reference Windows release p95 `<= 1,500 ms`, hard handshake timeout `5,000 ms`, existing startup budgets, and settled whole-tree idle-memory regression `<= 3%`.
- Keep real download/login timings informational and outside the warm activation sample.
- Add CI jobs for extension/unit/schema/fake-server tests on supported platforms, artifact inventory on every package, and manual Windows packaged interaction smoke. Do not label compile-only jobs as interactive coverage.
- Document runtime precedence, no-bundle policy, install location, consent, supported CLI matrix, ChatGPT/API-key modes, sandbox/approval defaults, rollback, diagnostics, and uninstall cleanup.

Run from `app`:

```powershell
node --test scripts/test/*.test.mjs
npm --workspace theia-ide-codex-ext test
npm --workspace theia-ide-product-ext test
npm run build:extensions
npm --workspace theia-ide-browser-app run build:tauri-backend
node scripts/verify-codex-packaging.mjs --root applications/browser/lib
```

Run from the worktree root:

```powershell
$env:CARGO_TARGET_DIR = 'L:\R-IDE-builds\ride-codex-app-server-target'
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --locked --all-targets
Set-Location app
npm run verify:tauri-profile
npm run build:tauri
npm run smoke:tauri-packaged -- --scenario codex --output 'L:\R-IDE-builds\ride-codex-app-server-smoke.json'
npm run measure:tauri-startup -- --output 'L:\R-IDE-builds\ride-codex-app-server-startup.json'
npm run check:tauri-performance
```

Expected: all deterministic tests/builds pass; on the reference Windows host the packaged Codex scenario passes, warm activation p95 is at most 1,500 ms, existing startup/memory gates remain green, and no Codex runtime binary is in the artifact.

**Step 3: Review and commit**

```powershell
git diff --check
git status --short
git add .github/workflows/ci.yml .github/workflows/tauri.yml app/package.json app/docs/codex-runtime.md app/scripts app/theia-extensions/product
git commit -m "ci: gate packaged Codex runtime integration"
```

## Final Verification Before Push or PR Update

Invoke `@superpowers:verification-before-completion`, then capture fresh output rather than relying on prior task runs:

```powershell
git merge-base --is-ancestor d18d49b HEAD
git merge-base --is-ancestor 12fb5ca HEAD
git diff --check
Set-Location app
node --test scripts/test/*.test.mjs
npm --workspace theia-ide-codex-ext test
npm --workspace theia-ide-product-ext test
npm run build:extensions
npm --workspace theia-ide-browser-app run build:tauri-backend
node scripts/verify-codex-packaging.mjs --root applications/browser/lib
Set-Location ..
$env:CARGO_TARGET_DIR = 'L:\R-IDE-builds\ride-codex-app-server-target'
cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml --locked --all-targets
git status --short --branch
git log --oneline --decorate -20
```

Required evidence before claiming completion:

- Both baseline ancestry checks exit `0`.
- All Node, extension, product, and Rust suites pass with no leaked fake/App Server process.
- The backend bundle contains the JavaScript SDK runtime but no Codex executable/vendor payload.
- Startup inventory proves zero pre-activation CLI/SDK/App Server activity.
- The packaged Windows smoke and same-host performance artifacts are attached or their manual-only status is stated precisely.
- The worktree is clean except for intentionally uncommitted user changes, which must be listed and preserved.
- Push/PR actions happen only after the user authorizes that external state change or when continuing their already explicit push/CI instruction.
