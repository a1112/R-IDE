/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { ChildProcessWithoutNullStreams, spawn as nodeSpawn } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Container } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import backendModule from '../src/node/ride-codex-backend-module';
import {
    RideCodexAppServerDiagnostics,
    RideCodexAppServerDiagnosticSnapshot
} from '../src/node/ride-codex-diagnostics';
import {
    RideCodexAppServerHost,
    RideCodexAppServerHostError,
    RideCodexAppServerSpawn,
    RideCodexAppServerSpawnOptions
} from '../src/node/ride-codex-app-server-host';
import { createRideCodexLaunchSpec, RideCodexLaunchSpec } from '../src/node/ride-codex-launch-spec';
import { RideCodexRuntimeResolver } from '../src/node/ride-codex-runtime-resolver';

const fixture = resolve(__dirname, '../../fixtures/fake-app-server.mjs');

interface SpawnRecord {
    readonly executable: string;
    readonly args: readonly string[];
    readonly options: RideCodexAppServerSpawnOptions;
    readonly child: ChildProcessWithoutNullStreams;
    readonly mode: string;
}

function launchSpec(): RideCodexLaunchSpec {
    return createRideCodexLaunchSpec({
        executable: process.execPath,
        version: '0.144.0',
        target: process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-musl',
        source: 'system'
    });
}

function fakeSpawn(modes: readonly string[], records: SpawnRecord[]): RideCodexAppServerSpawn {
    return (executable, args, options) => {
        const mode = modes[Math.min(records.length, modes.length - 1)] ?? 'normal';
        const child = nodeSpawn(process.execPath, [fixture], {
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, RIDE_FAKE_APP_SERVER_MODE: mode }
        });
        records.push({ executable, args: [...args], options, child, mode });
        return child;
    };
}

function createHost(options: {
    readonly modes?: readonly string[];
    readonly handshakeTimeoutMs?: number;
    readonly idleTimeoutMs?: number;
    readonly shutdownGraceMs?: number;
    readonly diagnostics?: RideCodexAppServerDiagnostics;
    readonly resolve?: () => Promise<RideCodexLaunchSpec>;
} = {}): { host: RideCodexAppServerHost; records: SpawnRecord[]; resolveCalls: () => number } {
    const records: SpawnRecord[] = [];
    let resolutions = 0;
    const resolver = {
        resolve: async () => {
            resolutions += 1;
            return options.resolve ? options.resolve() : launchSpec();
        }
    };
    const host = new RideCodexAppServerHost({
        resolver,
        diagnostics: options.diagnostics,
        spawn: fakeSpawn(options.modes ?? ['normal'], records),
        handshakeTimeoutMs: options.handshakeTimeoutMs ?? 1_000,
        idleTimeoutMs: options.idleTimeoutMs ?? 10_000,
        shutdownGraceMs: options.shutdownGraceMs ?? 100
    });
    return { host, records, resolveCalls: () => resolutions };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error('Timed out waiting for fake App Server state');
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

function assertSafeDiagnostics(snapshot: RideCodexAppServerDiagnosticSnapshot): void {
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(
        serialized,
        /bearer-secret|api-secret|token-secret|plain-secret|sk-project-value|private-user|private user|long workspace|workspace\\project/i
    );
    assert.ok(Buffer.byteLength(serialized) < 4_096, `diagnostics must remain bounded, got ${Buffer.byteLength(serialized)} bytes`);
}

test('constructors and backend singleton bindings stay inert until first acquire', async () => {
    const direct = createHost();
    assert.equal(direct.resolveCalls(), 0);
    assert.equal(direct.records.length, 0);

    const container = new Container();
    container.load(backendModule);
    assert.strictEqual(container.get(RideCodexRuntimeResolver), container.get(RideCodexRuntimeResolver));
    assert.strictEqual(container.get(RideCodexAppServerDiagnostics), container.get(RideCodexAppServerDiagnostics));
    const boundHost = container.get(RideCodexAppServerHost);
    assert.strictEqual(boundHost, container.get(RideCodexAppServerHost));
    assert.ok(container.getAll(BackendApplicationContribution).includes(boundHost));
    assert.equal(boundHost.snapshot().state, 'stopped');

    const lease = await direct.host.acquire('foreground-panel');
    assert.equal(direct.resolveCalls(), 1);
    assert.equal(direct.records.length, 1);
    lease.release();
    await direct.host.dispose();
    await boundHost.dispose();
});

test('concurrent panel, thread, and approval acquires share one resolver result, process, and RPC connection', async () => {
    const harness = createHost();
    const leases = await Promise.all([
        harness.host.acquire('foreground-panel'),
        harness.host.acquire('active-turn'),
        harness.host.acquire('approval'),
        ...Array.from({ length: 24 }, (_, index) => harness.host.acquire(index % 2 ? 'active-turn' : 'foreground-panel'))
    ]);

    assert.equal(harness.resolveCalls(), 1);
    assert.equal(harness.records.length, 1);
    const replies = await Promise.all(leases.map(lease => lease.request('account/read', {})));
    assert.equal(new Set(replies.map(reply => (reply as { pid: number }).pid)).size, 1);
    assert.ok(replies.every(reply => (reply as { initialized: boolean }).initialized));
    leases.forEach(lease => lease.release());
    await harness.host.dispose();
});

test('spawns only the resolver native executable with exact app-server stdio arguments and initializes exactly', async () => {
    const harness = createHost();
    const lease = await harness.host.acquire('foreground-panel');
    const record = harness.records[0];
    assert.equal(record.executable, process.execPath);
    assert.deepEqual(record.args, ['app-server', '--stdio']);
    assert.equal(record.options.shell, false);
    assert.deepEqual(record.options.stdio, ['pipe', 'pipe', 'pipe']);

    const initialization = harness.host.snapshot().initialization;
    assert.deepEqual(initialization, {
        clientInfo: { name: 'r-ide', title: 'R-IDE', version: '1.72.100' },
        capabilities: { experimentalApi: false, requestAttestation: false }
    });
    assert.deepEqual(Object.keys(initialization?.capabilities ?? {}).sort(), ['experimentalApi', 'requestAttestation']);
    assert.deepEqual(await lease.request('model/list', { fixture: 'report-initialize' }), {
        initialized: true,
        initializeParams: {
            clientInfo: { name: 'r-ide', title: 'R-IDE', version: '1.72.100' },
            capabilities: { experimentalApi: false, requestAttestation: false }
        },
        method: 'model/list',
        pid: record.child.pid
    });
    lease.release();
    await harness.host.dispose();
});

test('actual child early exit, handshake timeout, and malformed output reject startup with safe diagnostics', async t => {
    const cases: ReadonlyArray<readonly [string, string, number, RegExp]> = [
        ['early exit', 'early-exit', 500, /exited|startup/i],
        ['handshake timeout', 'handshake-timeout', 25, /handshake|timed out/i],
        ['malformed output', 'malformed', 500, /protocol|initialize/i]
    ];
    for (const [name, mode, timeoutMs, expected] of cases) {
        await t.test(name, async () => {
            const harness = createHost({ modes: [mode], handshakeTimeoutMs: timeoutMs });
            await assert.rejects(harness.host.acquire('foreground-panel'), error => {
                assert.ok(error instanceof RideCodexAppServerHostError);
                assert.match((error as Error).message, expected);
                return true;
            });
            await harness.host.dispose();
            assertSafeDiagnostics(harness.host.diagnostics.snapshot());
            assert.equal(harness.records[0].child.exitCode === null && harness.records[0].child.signalCode === null, false);
        });
    }
});

test('exit and dispose reject every pending RPC exactly once', async t => {
    await t.test('unexpected exit', async () => {
        const harness = createHost({ modes: ['normal', 'normal'] });
        const lease = await harness.host.acquire('active-turn');
        let firstRejects = 0;
        let secondRejects = 0;
        const first = lease.request('account/read', { fixture: 'pending' }).catch(error => {
            firstRejects += 1;
            throw error;
        });
        const second = lease.request('thread/list', { fixture: 'pending' }).catch(error => {
            secondRejects += 1;
            throw error;
        });
        const crash = lease.request('model/list', { fixture: 'crash' });
        await Promise.all([assert.rejects(first), assert.rejects(second), assert.rejects(crash)]);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(firstRejects, 1);
        assert.equal(secondRejects, 1);
        lease.release();
        await harness.host.dispose();
    });

    await t.test('dispose', async () => {
        const harness = createHost();
        const lease = await harness.host.acquire('active-turn');
        let rejects = 0;
        const pending = lease.request('account/read', { fixture: 'pending' }).catch(error => {
            rejects += 1;
            throw error;
        });
        const rejected = assert.rejects(pending, /disposed|closed/i);
        await harness.host.dispose();
        await rejected;
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(rejects, 1);
        lease.release();
    });
});

test('stderr is continuously drained into a redacted line-and-byte bounded recent ring', async () => {
    const diagnostics = new RideCodexAppServerDiagnostics({
        maxEntries: 8,
        maxStderrLines: 4,
        maxStderrBytes: 192,
        maxLineBytes: 48
    });
    const harness = createHost({ modes: ['stderr-flood'], diagnostics, handshakeTimeoutMs: 5_000 });
    const lease = await harness.host.acquire('foreground-panel');
    const snapshot = diagnostics.snapshot();
    assert.ok(snapshot.stderr.lines.length <= 4);
    assert.ok(snapshot.stderr.bytes <= 192);
    assert.equal(snapshot.stderr.truncated, true);
    assertSafeDiagnostics(snapshot);
    assert.deepEqual(await lease.request('account/read', {}), {
        initialized: true,
        method: 'account/read',
        pid: harness.records[0].child.pid
    });
    lease.release();
    await harness.host.dispose();
});

test('leases drive one cancellable idle timer then graceful stdin close and bounded exact-child termination', async t => {
    await t.test('reacquire cancels idle shutdown', async () => {
        const harness = createHost({ idleTimeoutMs: 40 });
        const first = await harness.host.acquire('foreground-panel');
        first.release();
        await new Promise(resolve => setTimeout(resolve, 15));
        const second = await harness.host.acquire('active-turn');
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(harness.records.length, 1);
        assert.equal(harness.records[0].child.exitCode, null);
        second.release();
        await waitFor(() => harness.records[0].child.exitCode !== null || harness.records[0].child.signalCode !== null);
        assert.equal(harness.host.snapshot().state, 'stopped');
        await harness.host.dispose();
    });

    await t.test('uncooperative exact child is killed once after grace', async () => {
        const harness = createHost({ modes: ['ignore-stdin-close'], idleTimeoutMs: 10, shutdownGraceMs: 20 });
        const lease = await harness.host.acquire('foreground-panel');
        let killCalls = 0;
        const child = harness.records[0].child;
        const originalKill = child.kill.bind(child);
        child.kill = ((signal?: NodeJS.Signals | number) => {
            killCalls += 1;
            return originalKill(signal);
        }) as typeof child.kill;
        lease.release();
        await waitFor(() => child.exitCode !== null || child.signalCode !== null);
        assert.equal(killCalls, 1);
        await harness.host.dispose();
        assert.equal(killCalls, 1);
    });
});

test('one unexpected crash restarts once, a second crash opens a stable circuit, and retry resets it', async () => {
    const harness = createHost({ modes: ['crash-after-initialize', 'crash-after-initialize', 'normal'] });
    const lease = await harness.host.acquire('active-turn');
    await waitFor(() => harness.records.length === 2);
    await waitFor(() => harness.host.snapshot().state === 'circuit-open');
    assert.equal(harness.records.length, 2);

    await assert.rejects(harness.host.acquire('foreground-panel'), error => {
        assert.equal((error as RideCodexAppServerHostError).code, 'circuit-open');
        return true;
    });
    await assert.rejects(lease.request('account/read', {}), /circuit/i);
    await harness.host.retry();
    await waitFor(() => harness.records.length === 3);
    assert.deepEqual(await lease.request('account/read', {}), {
        initialized: true,
        method: 'account/read',
        pid: harness.records[2].child.pid
    });
    lease.release();
    await harness.host.dispose();
});

test('an unsafe approval crash never restarts and remains circuit-open after approval release until retry', async () => {
    const harness = createHost({ modes: ['crash-after-initialize', 'normal'] });
    const approval = await harness.host.acquire('approval');
    assert.equal(harness.host.snapshot().unsafeApprovalCount, 1);
    await waitFor(() => harness.host.snapshot().state === 'circuit-open');
    assert.equal(harness.records.length, 1);
    const entries = harness.host.snapshot().diagnostics.entries;
    assert.equal(entries[entries.length - 1]?.code, 'unsafe-approval-exit');
    approval.release();
    assert.equal(harness.host.snapshot().unsafeApprovalCount, 0);
    await assert.rejects(harness.host.acquire('foreground-panel'), /circuit/i);
    await harness.host.retry();
    const lease = await harness.host.acquire('foreground-panel');
    assert.equal(harness.records.length, 2);
    lease.release();
    await harness.host.dispose();
});

test('release, crash, restart, and dispose races are idempotent and generation-isolated', async () => {
    const harness = createHost({ modes: ['normal', 'normal'], idleTimeoutMs: 10, shutdownGraceMs: 20 });
    const lease = await harness.host.acquire('active-turn');
    const oldChild = harness.records[0].child;
    lease.release();
    lease.release();
    const reacquired = await harness.host.acquire('foreground-panel');
    await assert.rejects(reacquired.request('model/list', { fixture: 'crash' }));
    await waitFor(() => harness.records.length === 2 && harness.host.snapshot().state === 'ready');
    oldChild.emit('exit', 29, null);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(harness.host.snapshot().leaseCount, 1);
    assert.equal(harness.host.snapshot().state, 'ready');
    assert.equal(harness.records.length, 2);

    await Promise.all([harness.host.dispose(), harness.host.dispose(), harness.host.dispose()]);
    reacquired.release();
    await assert.rejects(harness.host.acquire('foreground-panel'), /disposed/i);
    await assert.rejects(harness.host.retry(), /disposed/i);
    assert.ok(harness.records.every(record => record.child.exitCode !== null || record.child.signalCode !== null));
});

test('diagnostic ring independently redacts secrets and paths while retaining recent bounded categories', () => {
    const diagnostics = new RideCodexAppServerDiagnostics({
        maxEntries: 2,
        maxStderrLines: 2,
        maxStderrBytes: 80,
        maxLineBytes: 40
    });
    diagnostics.record('early-exit', 'Authorization: Bearer abc apiKey=def C:\\Users\\secret\\repo');
    diagnostics.record('handshake-timeout', 'OPENAI_API_KEY sk-project-value /home/private/work/project');
    diagnostics.record('circuit-open', 'secret=jkl');
    diagnostics.appendStderr(Buffer.from(
        'first api_key=one\nsecond Bearer two\nthird "C:\\Users\\Private User\\Long Workspace\\file.txt"\n'
    ));
    diagnostics.flushStderr();
    const snapshot = diagnostics.snapshot();
    assert.deepEqual(snapshot.entries.map(entry => entry.code), ['handshake-timeout', 'circuit-open']);
    assert.ok(snapshot.stderr.lines.length <= 2);
    assert.ok(snapshot.stderr.bytes <= 80);
    assert.equal(snapshot.entriesTruncated, true);
    assert.equal(snapshot.stderr.truncated, true);
    assertSafeDiagnostics(snapshot);
});

test('synchronous spawn and listener failures roll back without leaking a child or allowing stale late events', async t => {
    await t.test('spawn throws', async () => {
        const host = new RideCodexAppServerHost({
            resolver: { resolve: async () => launchSpec() },
            spawn: () => { throw new Error('C:\\secret\\spawn failed apiKey=value'); },
            handshakeTimeoutMs: 50
        });
        await assert.rejects(host.acquire('foreground-panel'), /spawn|start/i);
        assert.equal(host.snapshot().state, 'stopped');
        assertSafeDiagnostics(host.diagnostics.snapshot());
        await host.dispose();
    });

    await t.test('missing pipe', async () => {
        const records: SpawnRecord[] = [];
        const spawn = fakeSpawn(['normal'], records);
        const host = new RideCodexAppServerHost({
            resolver: { resolve: async () => launchSpec() },
            spawn: (file, args, options) => {
                const child = spawn(file, args, options);
                Object.defineProperty(child, 'stdout', { configurable: true, value: null });
                return child;
            },
            handshakeTimeoutMs: 50
        });
        await assert.rejects(host.acquire('foreground-panel'), /pipe|start/i);
        await waitFor(() => records[0].child.exitCode !== null || records[0].child.signalCode !== null);
        await host.dispose();
    });

    await t.test('stderr listener registration throws', async () => {
        const records: SpawnRecord[] = [];
        const spawn = fakeSpawn(['normal'], records);
        const host = new RideCodexAppServerHost({
            resolver: { resolve: async () => launchSpec() },
            spawn: (file, args, options) => {
                const child = spawn(file, args, options);
                const on = child.stderr.on.bind(child.stderr);
                child.stderr.on = ((event: string, listener: (...args: unknown[]) => void) => {
                    if (event === 'data') {
                        throw new Error('C:\\Private User\\listener apiKey=value');
                    }
                    return on(event, listener);
                }) as typeof child.stderr.on;
                return child;
            },
            handshakeTimeoutMs: 100,
            shutdownGraceMs: 50
        });
        await assert.rejects(host.acquire('foreground-panel'), /start/i);
        await waitFor(() => records[0].child.exitCode !== null || records[0].child.signalCode !== null);
        assert.equal(records[0].child.listenerCount('exit'), 0);
        assertSafeDiagnostics(host.diagnostics.snapshot());
        await host.dispose();
    });
});

test('a live stdio failure cleans the old exact child before starting the next generation', async () => {
    const harness = createHost({ modes: ['normal', 'normal'], shutdownGraceMs: 50 });
    const lease = await harness.host.acquire('active-turn');
    const oldChild = harness.records[0].child;
    try {
        oldChild.stdout.emit('error', new Error('Bearer private-transport-value'));
        await waitFor(() => harness.records.length === 2 && harness.host.snapshot().state === 'ready');
        await waitFor(() => oldChild.exitCode !== null || oldChild.signalCode !== null, 500);
        assertSafeDiagnostics(harness.host.diagnostics.snapshot());
    } finally {
        if (oldChild.exitCode === null && oldChild.signalCode === null) {
            oldChild.kill();
        }
        lease.release();
        await harness.host.dispose();
    }
});
