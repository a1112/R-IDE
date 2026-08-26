/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { ChildProcessWithoutNullStreams, spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
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

interface ControlledChild {
    readonly child: ChildProcessWithoutNullStreams;
    readonly killCalls: () => number;
    readonly emitExit: () => void;
}

let nextControlledPid = 50_000;

function createControlledChild(options: {
    readonly exitAfterKill?: 'after-grace-tick' | 'never';
    readonly shutdownGraceMs: number;
}): ControlledChild {
    const events = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let input = '';
    const stdin = new Writable({
        autoDestroy: false,
        write(chunk, _encoding, callback) {
            input += chunk.toString();
            let newline = input.indexOf('\n');
            while (newline >= 0) {
                const line = input.slice(0, newline);
                input = input.slice(newline + 1);
                if (line) {
                    const message = JSON.parse(line) as { id?: number; method?: string; params?: unknown };
                    if (message.method === 'initialize') {
                        stdout.write(`${JSON.stringify({ id: message.id, result: { initializeParams: message.params } })}\n`);
                    }
                }
                newline = input.indexOf('\n');
            }
            callback();
        }
    });
    const child = events as unknown as ChildProcessWithoutNullStreams;
    Object.assign(child, {
        stdin,
        stdout,
        stderr,
        pid: nextControlledPid,
        exitCode: null,
        signalCode: null
    });
    nextControlledPid += 1;

    let exited = false;
    let kills = 0;
    const emitExit = (): void => {
        if (exited) {
            return;
        }
        exited = true;
        Object.assign(child, { signalCode: 'SIGTERM' });
        child.emit('exit', null, 'SIGTERM');
        setImmediate(() => child.emit('close', null, 'SIGTERM'));
    };
    child.kill = (() => {
        kills += 1;
        if (options.exitAfterKill === 'never') {
            return false;
        }
        setTimeout(() => setImmediate(emitExit), options.shutdownGraceMs + 1);
        return true;
    }) as typeof child.kill;
    return { child, killCalls: () => kills, emitExit };
}

function createControlledHost(options: {
    readonly exitAfterKill?: 'after-grace-tick' | 'never';
    readonly shutdownGraceMs: number;
}): { host: RideCodexAppServerHost; children: ControlledChild[] } {
    const children: ControlledChild[] = [];
    const host = new RideCodexAppServerHost({
        resolver: { resolve: async () => launchSpec() },
        spawn: () => {
            const controlled = createControlledChild(options);
            children.push(controlled);
            return controlled.child;
        },
        handshakeTimeoutMs: 100,
        idleTimeoutMs: 10_000,
        shutdownGraceMs: options.shutdownGraceMs
    });
    return { host, children };
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

test('App Server spawn receives only a bounded platform allowlist and cannot inherit or overlay secrets', async () => {
    const secretEnvironment = {
        RIDE_TASK8_AUDIT_API_KEY: 'api-secret',
        RIDE_TASK8_AUDIT_TOKEN: 'token-secret',
        RIDE_TASK8_AUDIT_CREDENTIAL: 'credential-secret',
        RIDE_TASK8_AUDIT_PASSWORD: 'password-secret',
        RIDE_TASK8_AUDIT_SECRET: 'plain-secret'.repeat(800)
    } as const;
    const allowedKey = process.platform === 'win32' ? 'PATH' : 'HOME';
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries({
        ...secretEnvironment,
        [allowedKey]: 'safe-host-value'
    })) {
        previous.set(key, process.env[key]);
        process.env[key] = value;
    }

    const overlay = Object.freeze({
        [allowedKey]: 'safe-overlay-value',
        RIDE_TASK8_AUDIT_TOKEN: 'overlay-token-secret'.repeat(800),
        RIDE_TASK8_INNOCENT_BUT_UNREVIEWED: 'must-not-pass'
    });
    const spec = Object.freeze({ ...launchSpec(), environment: overlay });
    const harness = createHost({ resolve: async () => spec });
    try {
        const lease = await harness.host.acquire('foreground-panel');
        const environment = harness.records[0].options.env;
        assert.equal(environment[allowedKey], 'safe-overlay-value');
        for (const key of Object.keys(secretEnvironment)) {
            assert.equal(environment[key], undefined);
        }
        assert.equal(environment.RIDE_TASK8_INNOCENT_BUT_UNREVIEWED, undefined);
        assert.ok(Object.keys(environment).length <= 32);
        assert.ok(Buffer.byteLength(JSON.stringify(environment)) <= 16 * 1024);
        lease.release();
    } finally {
        await harness.host.dispose();
        for (const [key, value] of previous) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
});

test('App Server environment uses exact XDG and locale allowlists with compound secret denial', async t => {
    const secretKeys = [
        'XDG_PRIVATE_KEY',
        'LC_SIGNING_KEY',
        'XDG_OAUTH_TOKEN',
        'LC_DB_PASSWORD'
    ] as const;
    const unreviewedWildcardKeys = ['XDG_AUDIT_UNREVIEWED', 'LC_AUDIT_UNREVIEWED'] as const;
    const allowedEnvironment = Object.freeze({
        XDG_CONFIG_HOME: 'audit-config-home',
        XDG_CACHE_HOME: 'audit-cache-home',
        XDG_DATA_HOME: 'audit-data-home',
        XDG_STATE_HOME: 'audit-state-home',
        XDG_RUNTIME_DIR: 'audit-runtime-dir',
        LANG: 'audit-lang',
        LANGUAGE: 'audit-language',
        LC_ALL: 'audit-lc-all',
        LC_CTYPE: 'audit-lc-ctype',
        LC_NUMERIC: 'audit-lc-numeric',
        LC_TIME: 'audit-lc-time',
        LC_COLLATE: 'audit-lc-collate',
        LC_MONETARY: 'audit-lc-monetary',
        LC_MESSAGES: 'audit-lc-messages',
        LC_PAPER: 'audit-lc-paper',
        LC_NAME: 'audit-lc-name',
        LC_ADDRESS: 'audit-lc-address',
        LC_TELEPHONE: 'audit-lc-telephone',
        LC_MEASUREMENT: 'audit-lc-measurement',
        LC_IDENTIFICATION: 'audit-lc-identification'
    });

    await t.test('inherited compound secret keys are removed while exact safe keys remain', async () => {
        const previous = new Map<string, string | undefined>();
        for (const [key, value] of Object.entries({
            ...allowedEnvironment,
            ...Object.fromEntries(secretKeys.map(key => [key, `host-${key}`])),
            ...Object.fromEntries(unreviewedWildcardKeys.map(key => [key, `host-${key}`]))
        })) {
            previous.set(key, process.env[key]);
            process.env[key] = value;
        }
        const harness = createHost();
        try {
            const lease = await harness.host.acquire('foreground-panel');
            const environment = harness.records[0].options.env;
            for (const key of secretKeys) {
                assert.equal(environment[key], undefined);
            }
            for (const key of unreviewedWildcardKeys) {
                assert.equal(environment[key], undefined);
            }
            for (const [key, value] of Object.entries(allowedEnvironment)) {
                assert.equal(environment[key], value);
            }
            lease.release();
        } finally {
            await harness.host.dispose();
            for (const [key, value] of previous) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    });

    await t.test('overlay compound secret keys are removed and Windows safe keys normalize casing', async () => {
        const overlay: Record<string, string> = {
            ...allowedEnvironment,
            ...Object.fromEntries(secretKeys.map(key => [key, `overlay-${key}`])),
            ...Object.fromEntries(unreviewedWildcardKeys.map(key => [key, `overlay-${key}`]))
        };
        if (process.platform === 'win32') {
            delete overlay.XDG_CONFIG_HOME;
            delete overlay.LC_CTYPE;
            overlay.xdg_config_home = allowedEnvironment.XDG_CONFIG_HOME;
            overlay.lc_ctype = allowedEnvironment.LC_CTYPE;
        }
        const spec = Object.freeze({ ...launchSpec(), environment: Object.freeze(overlay) });
        const harness = createHost({ resolve: async () => spec });
        try {
            const lease = await harness.host.acquire('foreground-panel');
            const environment = harness.records[0].options.env;
            for (const key of secretKeys) {
                assert.equal(environment[key], undefined);
            }
            for (const key of unreviewedWildcardKeys) {
                assert.equal(environment[key], undefined);
            }
            for (const [key, value] of Object.entries(allowedEnvironment)) {
                assert.equal(environment[key], value);
            }
            assert.ok(Object.keys(environment).length <= 32);
            assert.ok(Buffer.byteLength(JSON.stringify(environment)) <= 16 * 1024);
            lease.release();
        } finally {
            await harness.host.dispose();
        }
    });
});

test('App Server environment overlay validation is descriptor-safe and fails closed on invalid values', async t => {
    await t.test('accessors are rejected without executing them', async () => {
        let getterCalls = 0;
        const environment = Object.create(null) as Record<string, string>;
        Object.defineProperty(environment, 'PATH', {
            enumerable: true,
            get: () => {
                getterCalls += 1;
                throw new Error('getter secret');
            }
        });
        const spec = Object.freeze({ ...launchSpec(), environment });
        const harness = createHost({ resolve: async () => spec });
        await assert.rejects(harness.host.acquire('foreground-panel'), /start|spawn/i);
        assert.equal(getterCalls, 0);
        assert.equal(harness.records.length, 0);
        await harness.host.dispose();
    });

    await t.test('oversized allowed values are rejected before spawn', async () => {
        const allowedKey = process.platform === 'win32' ? 'PATH' : 'HOME';
        const spec = Object.freeze({
            ...launchSpec(),
            environment: Object.freeze({ [allowedKey]: 'x'.repeat(16 * 1024) })
        });
        const harness = createHost({ resolve: async () => spec });
        await assert.rejects(harness.host.acquire('foreground-panel'), /start|spawn/i);
        assert.equal(harness.records.length, 0);
        await harness.host.dispose();
    });
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

test('initialized delivery failures reject startup before ready and clean the owned child', async t => {
    const cases = [
        'synchronous-throw',
        'asynchronous-callback-error',
        'asynchronous-close'
    ] as const;
    for (const failureMode of cases) {
        await t.test(failureMode, async () => {
            const records: SpawnRecord[] = [];
            const spawn = fakeSpawn(['normal'], records);
            let writes = 0;
            const host = new RideCodexAppServerHost({
                resolver: { resolve: async () => launchSpec() },
                spawn: (executable, args, options) => {
                    const child = spawn(executable, args, options);
                    const originalWrite = child.stdin.write.bind(child.stdin) as (...writeArgs: unknown[]) => boolean;
                    child.stdin.write = ((...writeArgs: unknown[]) => {
                        writes += 1;
                        if (writes !== 2) {
                            return originalWrite(...writeArgs);
                        }
                        if (failureMode === 'synchronous-throw') {
                            throw new Error('initialized synchronous write failure');
                        }
                        const callback = writeArgs.find(value => typeof value === 'function') as
                            ((error?: Error | null) => void) | undefined;
                        if (failureMode === 'asynchronous-callback-error') {
                            setImmediate(() => callback?.(new Error('initialized asynchronous write failure')));
                        } else {
                            setImmediate(() => child.stdin.emit('close'));
                        }
                        return true;
                    }) as typeof child.stdin.write;
                    return child;
                },
                handshakeTimeoutMs: 500,
                shutdownGraceMs: 200
            });

            try {
                await assert.rejects(host.acquire('foreground-panel'), /initialize|startup|exited/i);
                assert.equal(writes, 2);
                assert.notEqual(host.snapshot().state, 'ready');
                assert.equal(host.snapshot().initialization, undefined);
                assert.equal(records.length, 1);
                await waitFor(() => records[0].child.exitCode !== null || records[0].child.signalCode !== null);
                assert.equal(host.snapshot().pid, undefined);
            } finally {
                await host.dispose().catch(() => undefined);
                for (const record of records) {
                    if (record.child.exitCode === null && record.child.signalCode === null) {
                        record.child.kill();
                    }
                }
            }
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

test('acquire during irreversible idle stop waits for one fresh generation and ignores the old late exit', async () => {
    const harness = createHost({
        modes: ['ignore-stdin-close', 'normal'],
        idleTimeoutMs: 5,
        shutdownGraceMs: 80
    });
    const first = await harness.host.acquire('foreground-panel');
    const oldChild = harness.records[0].child;
    first.release();
    await waitFor(() => harness.host.snapshot().state === 'stopping');
    assert.equal(oldChild.exitCode, null);
    assert.equal(oldChild.signalCode, null);

    let acquiredWhileStopping = false;
    const pending = Promise.all([
        harness.host.acquire('active-turn'),
        harness.host.acquire('foreground-panel')
    ]).then(leases => {
        acquiredWhileStopping = true;
        return leases;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(acquiredWhileStopping, false);
    assert.equal(harness.records.length, 1);

    const leases = await pending;
    assert.equal(harness.records.length, 2);
    assert.equal(harness.host.snapshot().generation, 2);
    assert.equal(harness.host.snapshot().state, 'ready');
    assert.deepEqual(await leases[0].request('account/read', {}), {
        initialized: true,
        method: 'account/read',
        pid: harness.records[1].child.pid
    });

    oldChild.emit('exit', 0, null);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(harness.host.snapshot().generation, 2);
    assert.equal(harness.host.snapshot().state, 'ready');
    assert.equal(harness.records.length, 2);
    assert.equal(oldChild.listenerCount('exit'), 0);
    assert.equal(oldChild.listenerCount('close'), 0);

    leases.forEach(lease => lease.release());
    await harness.host.dispose();
    assert.ok(harness.records.every(record => record.child.exitCode !== null || record.child.signalCode !== null));
});

test('shutdown timeout retains sole child authority until exit is confirmed and an explicit retry follows', async () => {
    const harness = createHost({
        modes: ['ignore-stdin-close', 'normal'],
        idleTimeoutMs: 5,
        shutdownGraceMs: 15
    });
    const first = await harness.host.acquire('foreground-panel');
    const oldChild = harness.records[0].child;
    const originalKill = oldChild.kill.bind(oldChild);
    let killCalls = 0;
    oldChild.kill = (() => {
        killCalls += 1;
        return false;
    }) as typeof oldChild.kill;
    let accidentalLease: Awaited<ReturnType<RideCodexAppServerHost['acquire']>> | undefined;

    try {
        first.release();
        await waitFor(() => harness.host.snapshot().state === 'circuit-open');
        assert.equal(oldChild.exitCode, null);
        assert.equal(oldChild.signalCode, null);
        assert.equal(harness.records.length, 1);

        const retryError = await harness.host.retry().then(
            () => undefined,
            error => error as Error
        );
        const acquireResult = await harness.host.acquire('active-turn').then(
            lease => lease,
            error => error as Error
        );
        if (!(acquireResult instanceof Error)) {
            accidentalLease = acquireResult;
        }

        assert.ok(retryError instanceof RideCodexAppServerHostError);
        assert.equal(retryError.code, 'shutdown-timeout');
        assert.ok(acquireResult instanceof RideCodexAppServerHostError);
        assert.equal((acquireResult as RideCodexAppServerHostError).code, 'circuit-open');
        assert.equal(harness.host.snapshot().state, 'circuit-open');
        assert.equal(harness.records.length, 1);
        assert.ok(killCalls >= 2, 'explicit retry must attempt exact-child termination again');
        assert.ok(harness.records.filter(record =>
            record.child.exitCode === null && record.child.signalCode === null
        ).length <= 1);

        oldChild.kill = originalKill as typeof oldChild.kill;
        assert.equal(originalKill(), true);
        await waitFor(() => oldChild.exitCode !== null || oldChild.signalCode !== null);
        await waitFor(() => harness.host.snapshot().pid === undefined);
        await assert.rejects(harness.host.acquire('foreground-panel'), error => {
            assert.equal((error as RideCodexAppServerHostError).code, 'circuit-open');
            return true;
        });

        await harness.host.retry();
        const second = await harness.host.acquire('foreground-panel');
        assert.equal(harness.records.length, 2);
        assert.equal(harness.host.snapshot().generation, 2);
        assert.ok(harness.records.filter(record =>
            record.child.exitCode === null && record.child.signalCode === null
        ).length <= 1);
        second.release();
    } finally {
        accidentalLease?.release();
        oldChild.kill = originalKill as typeof oldChild.kill;
        if (oldChild.exitCode === null && oldChild.signalCode === null) {
            originalKill();
        }
        await harness.host.dispose().catch(() => undefined);
        for (const record of harness.records) {
            if (record.child.exitCode === null && record.child.signalCode === null) {
                record.child.kill();
            }
        }
    }
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

test('final disposal resolves across late exit races and never starts another generation', async () => {
    const rounds = 25;
    for (let round = 0; round < rounds; round += 1) {
        const harness = createControlledHost({ exitAfterKill: 'after-grace-tick', shutdownGraceMs: 4 });
        const lease = await harness.host.acquire('active-turn');
        assert.equal(harness.children.length, 1);

        const first = harness.host.dispose();
        const second = harness.host.dispose();
        const third = harness.host.dispose();
        assert.strictEqual(second, first);
        assert.strictEqual(third, first);
        await Promise.all([first, second, third]);

        assert.equal(harness.host.snapshot().state, 'disposed');
        assert.equal(harness.children.length, 1, `round ${round + 1} must not spawn a replacement`);
        assert.equal(harness.children[0].killCalls(), 1);
        await assert.rejects(harness.host.acquire('foreground-panel'), error => {
            assert.equal((error as RideCodexAppServerHostError).code, 'disposed');
            return true;
        });
        await assert.rejects(harness.host.retry(), error => {
            assert.equal((error as RideCodexAppServerHostError).code, 'disposed');
            return true;
        });

        harness.children[0].emitExit();
        harness.children[0].child.emit('close', null, 'SIGTERM');
        harness.children[0].child.emit('exit', null, 'SIGTERM');
        await waitFor(() => harness.host.snapshot().pid === undefined);
        assert.equal(harness.children[0].child.listenerCount('exit'), 0);
        assert.equal(harness.children[0].child.listenerCount('close'), 0);
        assert.equal(harness.host.snapshot().state, 'disposed');
        lease.release();
    }
});

test('final disposal bounds an unconfirmed child without dropping its late-exit authority', async () => {
    const harness = createControlledHost({ exitAfterKill: 'never', shutdownGraceMs: 5 });
    const lease = await harness.host.acquire('active-turn');
    const child = harness.children[0];
    const startedAt = Date.now();

    await assert.doesNotReject(harness.host.dispose());

    assert.ok(Date.now() - startedAt < 250, 'final disposal must remain bounded');
    assert.equal(harness.host.snapshot().state, 'disposed');
    assert.equal(harness.host.snapshot().pid, child.child.pid, 'host must retain unconfirmed child authority');
    assert.equal(child.killCalls(), 1);
    assert.ok(child.child.listenerCount('exit') > 0);
    assert.ok(child.child.listenerCount('close') > 0);
    assert.equal(harness.children.length, 1);
    const entries = harness.host.snapshot().diagnostics.entries;
    assert.equal(entries[entries.length - 1]?.code, 'shutdown-timeout');
    assertSafeDiagnostics(harness.host.snapshot().diagnostics);
    await assert.rejects(harness.host.acquire('foreground-panel'), /disposed/i);
    await assert.rejects(harness.host.retry(), /disposed/i);
    assert.equal(harness.children.length, 1);

    child.emitExit();
    await waitFor(() => harness.host.snapshot().pid === undefined);
    assert.equal(child.child.listenerCount('exit'), 0);
    assert.equal(child.child.listenerCount('close'), 0);
    assert.equal(harness.host.snapshot().state, 'disposed');
    lease.release();
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

test('diagnostic records redact generic credentials and local path forms without hiding HTTPS URLs', () => {
    const diagnostics = new RideCodexAppServerDiagnostics({
        maxEntries: 8,
        maxEntryBytes: 512
    });
    diagnostics.record(
        'spawn-failed',
        'credential=audit-credential password=audit-password key=audit-key api_key=audit-api '
        + 'token=audit-token secret=audit-secret authorization=Bearer audit-auth'
    );
    diagnostics.record('protocol-error', 'C:/Users/Audit User/private/repo/file.txt');
    diagnostics.record('protocol-error', 'C:\\Users\\Audit User\\private\\repo\\file.txt');
    diagnostics.record('protocol-error', '\\\\server\\private\\Audit User\\repo\\file.txt');
    diagnostics.record('protocol-error', '"/home/Audit User/private/repo/file.txt"');
    diagnostics.record('protocol-error', 'file:///C:/Users/Audit%20User/private/repo/file.txt');
    diagnostics.record('protocol-error', 'See https://example.test/reference?q=public for public guidance');

    const snapshot = diagnostics.snapshot();
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(
        serialized,
        /audit-(?:credential|password|key|api|token|secret|auth)|Audit(?:%20| )User|private[\\/]repo/i
    );
    assert.match(serialized, /https:\/\/example\.test\/reference\?q=public/);
    assert.ok(snapshot.entries.every(entry => Buffer.byteLength(entry.message) <= 512));
});

test('diagnostics redact quoted and spaced secrets, arbitrary local paths, and URL credentials across records and chunks', () => {
    const secretFragments = /audit password|audit api key|audit token|audit credential phrase|audit-user|audit-query|Audit(?:%20| )User|private|repo/i;
    const recordDiagnostics = new RideCodexAppServerDiagnostics({
        maxEntries: 8,
        maxEntryBytes: 1_024,
        maxStderrLines: 8,
        maxStderrBytes: 2_048,
        maxLineBytes: 1_024
    });
    recordDiagnostics.record(
        'protocol-error',
        '{"password":"audit password","api_key":\'audit api key\',"token" : "audit token"}'
    );
    recordDiagnostics.record('protocol-error', 'credential: audit credential phrase with spaces');
    recordDiagnostics.record('protocol-error', 'cwd=/home/Audit User/private/repo');
    recordDiagnostics.record('protocol-error', 'path:(/home/Audit User/private/repo)');
    recordDiagnostics.record('protocol-error', 'uri=file:///home/Audit User/private/repo');
    recordDiagnostics.record('protocol-error', 'cwd=C:\\Users\\Audit User\\private\\repo');
    recordDiagnostics.record('protocol-error', 'cwd=\\\\server\\Audit User\\private\\repo');
    recordDiagnostics.record(
        'protocol-error',
        'endpoint=https://audit-user:audit-password@example.test/reference?token=audit-query&public=ok'
    );

    const recordSnapshot = recordDiagnostics.snapshot();
    const serializedRecords = JSON.stringify(recordSnapshot);
    assert.doesNotMatch(serializedRecords, secretFragments);
    assert.ok(recordSnapshot.entries.every(entry => Buffer.byteLength(entry.message) <= 1_024));

    const streamDiagnostics = new RideCodexAppServerDiagnostics({
        maxStderrLines: 4,
        maxStderrBytes: 1_024,
        maxLineBytes: 512
    });
    streamDiagnostics.appendStderr(Buffer.from('{"password":"audit pass'));
    streamDiagnostics.appendStderr(Buffer.from('word","api_key":\'audit api'));
    streamDiagnostics.appendStderr(Buffer.from(' key\',"token":"audit token"} cwd=/home/Au'));
    streamDiagnostics.appendStderr(Buffer.from('dit User/private/repo file:///home/Audit User/private/repo'));
    streamDiagnostics.flushStderr();

    const streamSnapshot = streamDiagnostics.snapshot();
    assert.doesNotMatch(JSON.stringify(streamSnapshot), secretFragments);
    assert.ok(streamSnapshot.stderr.lines.length <= 4);
    assert.ok(streamSnapshot.stderr.bytes <= 1_024);
    assert.equal(streamSnapshot.stderr.truncated, false);
});

test('diagnostics redact compound credential fields without matching ordinary words', () => {
    const sensitiveCases = [
        '{"client_secret":"AUDIT_ALPHA"}',
        "{'private_key':'AUDIT_BRAVO'}",
        'client-secret=AUDIT_CHARLIE',
        'dbPassword: AUDIT_DELTA',
        'oauth_token=AUDIT_ECHO',
        'refreshToken: AUDIT_FOXTROT',
        'access_token=AUDIT_GOLF',
        'signingKey: AUDIT_HOTEL',
        'apiKey=AUDIT_INDIA',
        'x-api-key: AUDIT_JULIET',
        'X-Client-Secret: AUDIT_KILO',
        'ACCESS_KEY=AUDIT_LIMA',
        'credentialId=AUDIT_MIKE',
        'credentialValue: AUDIT_NOVEMBER'
    ];
    const sensitiveValues = /AUDIT_(?:ALPHA|BRAVO|CHARLIE|DELTA|ECHO|FOXTROT|GOLF|HOTEL|INDIA|JULIET|KILO|LIMA|MIKE|NOVEMBER)/;
    const ordinary = 'keyboard=ansi monkey=capuchin tokenizer=bpe';
    const recordDiagnostics = new RideCodexAppServerDiagnostics({
        maxEntries: sensitiveCases.length + 1,
        maxEntryBytes: 256
    });
    for (const detail of sensitiveCases) {
        recordDiagnostics.record('protocol-error', detail);
    }
    recordDiagnostics.record('protocol-error', ordinary);

    const recordSnapshot = recordDiagnostics.snapshot();
    const serializedRecords = JSON.stringify(recordSnapshot);
    assert.doesNotMatch(serializedRecords, sensitiveValues);
    assert.match(serializedRecords, /keyboard=ansi monkey=capuchin tokenizer=bpe/);

    const streamDiagnostics = new RideCodexAppServerDiagnostics({
        maxStderrLines: sensitiveCases.length,
        maxStderrBytes: 4_096,
        maxLineBytes: 256
    });
    streamDiagnostics.appendStderr(Buffer.from(`${sensitiveCases.join('\n')}\n`));
    streamDiagnostics.flushStderr();
    const streamSnapshot = streamDiagnostics.snapshot();
    assert.doesNotMatch(JSON.stringify(streamSnapshot), sensitiveValues);

    const chunkedDiagnostics = new RideCodexAppServerDiagnostics({
        maxStderrLines: 2,
        maxStderrBytes: 512,
        maxLineBytes: 256
    });
    chunkedDiagnostics.appendStderr(Buffer.from('{"client_sec'));
    chunkedDiagnostics.appendStderr(Buffer.from('ret":"AUDIT_ALPHA","private_key":"AUDIT_BR'));
    chunkedDiagnostics.appendStderr(Buffer.from('AVO"}\ncredentialVal'));
    chunkedDiagnostics.appendStderr(Buffer.from('ue: AUDIT_NOVEMBER\n'));
    chunkedDiagnostics.flushStderr();
    assert.doesNotMatch(JSON.stringify(chunkedDiagnostics.snapshot()), sensitiveValues);
});

test('diagnostics redact Basic and Digest authorization values across records and stderr chunks', () => {
    const credentialFragments = /QVVESVRfQkFTSUM=|AUDIT_USER|AUDIT_RESPONSE|AUDIT_PROXY|AUDIT_JSON|AUDIT_CHUNKED/i;
    const authorizationCases = [
        'Authorization: Basic QVVESVRfQkFTSUM=',
        'authorization=Digest username="AUDIT_USER", response="AUDIT_RESPONSE"',
        'Proxy-Authorization: Basic AUDIT_PROXY',
        'WWW-Authenticate: Digest username="AUDIT_USER", response="AUDIT_RESPONSE"',
        '{"Authorization":"Basic AUDIT_JSON"}',
        '{"proxyAuthorization":"Digest username=\'AUDIT_USER\', response=\'AUDIT_RESPONSE\'"}'
    ];
    const recordDiagnostics = new RideCodexAppServerDiagnostics({
        maxEntries: authorizationCases.length + 1,
        maxEntryBytes: 512
    });
    for (const detail of authorizationCases) {
        recordDiagnostics.record('protocol-error', detail);
    }
    recordDiagnostics.record('protocol-error', 'basic mode remains available');
    const recordSnapshot = recordDiagnostics.snapshot();
    assert.doesNotMatch(JSON.stringify(recordSnapshot), credentialFragments);
    assert.match(JSON.stringify(recordSnapshot), /basic mode remains available/);

    const stderrDiagnostics = new RideCodexAppServerDiagnostics({
        maxStderrLines: authorizationCases.length + 1,
        maxStderrBytes: 4_096,
        maxLineBytes: 512
    });
    stderrDiagnostics.appendStderr(Buffer.from(`${authorizationCases.join('\n')}\n`));
    stderrDiagnostics.flushStderr();
    assert.doesNotMatch(JSON.stringify(stderrDiagnostics.snapshot()), credentialFragments);

    const chunkedDiagnostics = new RideCodexAppServerDiagnostics({
        maxStderrLines: 2,
        maxStderrBytes: 1_024,
        maxLineBytes: 512
    });
    chunkedDiagnostics.appendStderr(Buffer.from('Proxy-Author'));
    chunkedDiagnostics.appendStderr(Buffer.from('ization: Digest username="AUDIT_'));
    chunkedDiagnostics.appendStderr(Buffer.from('CHUNKED", response="AUDIT_RESPONSE"\n'));
    chunkedDiagnostics.flushStderr();
    assert.doesNotMatch(JSON.stringify(chunkedDiagnostics.snapshot()), credentialFragments);
});

test('diagnostics redact literal Authenticate values across records and stderr chunks', () => {
    const credentialFragments = /AUDIT_BLOB|AUDIT_USER|AUDIT_RESPONSE|AUDIT_TOKEN_VALUE/i;
    const authenticateCases = [
        'Authenticate: Basic AUDIT_BLOB',
        'Authenticate=Digest username="AUDIT_USER", response="AUDIT_RESPONSE"',
        '{"Authenticate":"Bearer AUDIT_TOKEN_VALUE"}'
    ];
    const recordDiagnostics = new RideCodexAppServerDiagnostics({
        maxEntries: authenticateCases.length + 1,
        maxEntryBytes: 512
    });
    for (const detail of authenticateCases) {
        recordDiagnostics.record('protocol-error', detail);
    }
    recordDiagnostics.record('protocol-error', 'basic mode remains available');
    const recordSnapshot = JSON.stringify(recordDiagnostics.snapshot());
    assert.doesNotMatch(recordSnapshot, credentialFragments);
    assert.match(recordSnapshot, /basic mode remains available/);

    const stderrDiagnostics = new RideCodexAppServerDiagnostics({
        maxStderrLines: authenticateCases.length + 1,
        maxStderrBytes: 4_096,
        maxLineBytes: 512
    });
    stderrDiagnostics.appendStderr(Buffer.from(`${authenticateCases.join('\n')}\nbasic mode remains available\n`));
    stderrDiagnostics.flushStderr();
    const stderrSnapshot = JSON.stringify(stderrDiagnostics.snapshot());
    assert.doesNotMatch(stderrSnapshot, credentialFragments);
    assert.match(stderrSnapshot, /basic mode remains available/);

    const chunkedDiagnostics = new RideCodexAppServerDiagnostics({
        maxStderrLines: authenticateCases.length + 1,
        maxStderrBytes: 4_096,
        maxLineBytes: 512
    });
    chunkedDiagnostics.appendStderr(Buffer.from('Authen'));
    chunkedDiagnostics.appendStderr(Buffer.from('ticate: Basic AUDIT_'));
    chunkedDiagnostics.appendStderr(Buffer.from('BLOB\nAuthenticate=Digest username="AUDIT_'));
    chunkedDiagnostics.appendStderr(Buffer.from('USER", response="AUDIT_RESPONSE"\n{"Authen'));
    chunkedDiagnostics.appendStderr(Buffer.from('ticate":"Bearer AUDIT_TOKEN_'));
    chunkedDiagnostics.appendStderr(Buffer.from('VALUE"}\nbasic mode remains available\n'));
    chunkedDiagnostics.flushStderr();
    const chunkedSnapshot = JSON.stringify(chunkedDiagnostics.snapshot());
    assert.doesNotMatch(chunkedSnapshot, credentialFragments);
    assert.match(chunkedSnapshot, /basic mode remains available/);
});

test('stderr redaction survives chunk boundaries and bounds an overlong unterminated line', () => {
    const diagnostics = new RideCodexAppServerDiagnostics({
        maxEntries: 2,
        maxStderrLines: 3,
        maxStderrBytes: 256,
        maxLineBytes: 160
    });
    diagnostics.appendStderr(Buffer.from('credential=stream-credential api_'));
    diagnostics.appendStderr(Buffer.from('key=stream-api C:/Users/Au'));
    diagnostics.appendStderr(Buffer.from('dit User/private/repo "'));
    diagnostics.appendStderr(Buffer.from('/home/Audit User/private/repo"\n'));
    diagnostics.appendStderr(Buffer.from(`password=unterminated-password ${'x'.repeat(512)} Audit User/private/repo`));
    diagnostics.flushStderr();

    const snapshot = diagnostics.snapshot();
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(
        serialized,
        /stream-(?:credential|api)|unterminated-password|Audit User|private[\\/]repo/i
    );
    assert.ok(snapshot.stderr.lines.length <= 3);
    assert.ok(snapshot.stderr.bytes <= 256);
    assert.equal(snapshot.stderr.truncated, true);
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
    const harness = createHost({ modes: ['normal', 'normal'], shutdownGraceMs: 100 });
    const lease = await harness.host.acquire('active-turn');
    const oldChild = harness.records[0].child;
    try {
        oldChild.stdout.emit('error', new Error('Bearer private-transport-value'));
        await waitFor(() => harness.records.length === 2 && harness.host.snapshot().state === 'ready', 5_000);
        await waitFor(() => oldChild.exitCode !== null || oldChild.signalCode !== null, 1_000);
        assertSafeDiagnostics(harness.host.diagnostics.snapshot());
    } finally {
        if (oldChild.exitCode === null && oldChild.signalCode === null) {
            oldChild.kill();
        }
        lease.release();
        await harness.host.dispose();
    }
});
