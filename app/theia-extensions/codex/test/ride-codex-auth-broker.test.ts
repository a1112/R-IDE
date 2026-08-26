/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    normalizeRideCodexAccount,
    normalizeRideCodexAccountUpdate,
    normalizeRideCodexRateLimits,
    RideCodexAuthClient,
    RideCodexAuthSnapshot
} from '../src/common/ride-codex-auth';
import {
    RideCodexAuthBroker,
    RideCodexAuthHost,
    RideCodexAuthHostLease,
    RideCodexAuthHostStateEvent
} from '../src/node/ride-codex-auth-broker';
import { RideCodexAppServerDiagnostics } from '../src/node/ride-codex-diagnostics';
import type { RideCodexNotification } from '../src/node/ride-codex-jsonl-client';

interface RequestRecord {
    readonly method: string;
    readonly params: unknown;
}

class FakeAuthHost implements RideCodexAuthHost {
    readonly requests: RequestRecord[] = [];
    readonly notificationListeners = new Set<(notification: RideCodexNotification, generation: number) => void>();
    readonly stateListeners = new Set<(event: RideCodexAuthHostStateEvent) => void>();
    acquireCount = 0;
    releaseCount = 0;
    generation = 1;
    state: RideCodexAuthHostStateEvent['state'] = 'ready';
    acquireFailure: Error | undefined;
    stateListenerFailure: Error | undefined;
    responder: (method: string, params: unknown) => Promise<unknown> = async method => {
        if (method === 'account/read') {
            return { account: null, requiresOpenaiAuth: true };
        }
        if (method === 'account/rateLimits/read') {
            return emptyRateLimits();
        }
        return {};
    };

    async acquire(): Promise<RideCodexAuthHostLease> {
        this.acquireCount += 1;
        if (this.acquireFailure) {
            throw this.acquireFailure;
        }
        return {
            request: async (method, params) => {
                this.requests.push({ method, params });
                return this.responder(method, params);
            },
            release: () => { this.releaseCount += 1; }
        };
    }

    onNotification(listener: (notification: RideCodexNotification, generation: number) => void): { dispose(): void } {
        this.notificationListeners.add(listener);
        return { dispose: () => this.notificationListeners.delete(listener) };
    }

    onStateChange(listener: (event: RideCodexAuthHostStateEvent) => void): { dispose(): void } {
        if (this.stateListenerFailure) {
            throw this.stateListenerFailure;
        }
        this.stateListeners.add(listener);
        return { dispose: () => this.stateListeners.delete(listener) };
    }

    snapshot(): { state: RideCodexAuthHostStateEvent['state']; generation: number } {
        return { state: this.state, generation: this.generation };
    }

    notify(method: string, params: unknown, generation = this.generation): void {
        for (const listener of [...this.notificationListeners]) {
            listener({ method, params }, generation);
        }
    }

    changeState(state: RideCodexAuthHostStateEvent['state'], generation = this.generation): void {
        this.state = state;
        this.generation = generation;
        for (const listener of [...this.stateListeners]) {
            listener({ state, generation });
        }
    }
}

class RecordingClient implements RideCodexAuthClient {
    readonly snapshots: RideCodexAuthSnapshot[] = [];
    authStateChanged(snapshot: RideCodexAuthSnapshot): void {
        this.snapshots.push(snapshot);
    }
}

test('validates, bounds and deeply freezes the public auth model', () => {
    const account = normalizeRideCodexAccount({ type: 'chatgpt', email: 'user@example.com', planType: 'plus' });
    assert.deepEqual(account, { type: 'chatgpt', email: 'user@example.com', plan: 'plus' });
    assert.ok(Object.isFrozen(account));
    assert.throws(() => normalizeRideCodexAccount({ type: 'apiKey', apiKey: 'must-not-pass' }));
    assert.throws(() => normalizeRideCodexAccount({ type: 'chatgpt', email: 'x'.repeat(513), planType: 'plus' }));
    assert.throws(() => normalizeRideCodexAccountUpdate({ authMode: 'apikey', planType: 'plus' }));

    const rateLimits = normalizeRideCodexRateLimits({
        rateLimits: {
            limitId: 'codex', limitName: 'Codex',
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            secondary: null,
            credits: { hasCredits: true, unlimited: false, balance: '12.50' },
            individualLimit: null, planType: 'plus', rateLimitReachedType: null
        },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: { availableCount: '2', credits: null }
    });
    assert.equal(rateLimits?.primary?.usedPercent, 25);
    assert.equal(rateLimits?.resetCredits?.availableCount, '2');
    assert.ok(Object.isFrozen(rateLimits));
    assert.ok(Object.isFrozen(rateLimits?.primary));
    assert.throws(() => normalizeRideCodexRateLimits({ rateLimits: { primary: { usedPercent: 101 } } }));
});

test('host acquisition failures are generic and never echo API key input', async () => {
    const key = 'sk-acquire-failure-AAAABBBBCCCC';
    const host = new FakeAuthHost();
    host.acquireFailure = new Error(`host failed with ${key}`);
    const broker = new RideCodexAuthBroker({ host, diagnostics: new RideCodexAppServerDiagnostics() });
    const error = await broker.login({ type: 'apiKey', apiKey: key }).then(() => undefined, reason => reason as Error);
    assert.ok(error);
    assert.equal(String(error).includes(key), false);
    assert.equal(JSON.stringify(broker.snapshot()).includes(key), false);
    assert.ok((error?.message.length ?? 0) <= 160);
});

test('construction is inert and activation acquires only one shared host lease', async () => {
    const host = new FakeAuthHost();
    const broker = new RideCodexAuthBroker({ host, diagnostics: new RideCodexAppServerDiagnostics() });
    assert.equal(host.acquireCount, 0);
    assert.equal(broker.snapshot().state, 'inactive');

    await Promise.all([broker.activate(), broker.activate(), broker.readAccount()]);
    assert.equal(host.acquireCount, 1);
    assert.equal(broker.snapshot().state, 'unauthenticated');
    broker.dispose();
    assert.equal(host.releaseCount, 1);
    assert.equal(host.notificationListeners.size, 0);
    assert.equal(host.stateListeners.size, 0);
});

test('partial observer registration failure rolls back listeners without leaking diagnostics', () => {
    const host = new FakeAuthHost();
    const secret = 'sk-listener-construction-failure';
    host.stateListenerFailure = new Error(`listener failed with ${secret}`);
    assert.throws(
        () => new RideCodexAuthBroker({ host, diagnostics: new RideCodexAppServerDiagnostics() }),
        error => !String(error).includes(secret)
    );
    assert.equal(host.notificationListeners.size, 0);
    assert.equal(host.stateListeners.size, 0);
});

test('API key login is ephemeral, redacted, and authenticated only after account/read', async () => {
    const key = 'sk-task9-EPHEMERAL-KEY-1234567890';
    const host = new FakeAuthHost();
    const diagnostics = new RideCodexAppServerDiagnostics();
    host.responder = async (method, params) => {
        if (method === 'account/login/start') {
            assert.deepEqual(params, { type: 'apiKey', apiKey: key });
            diagnostics.record('protocol-error', `key=${key}`);
            diagnostics.appendStderr(Buffer.from(
                `prefix=${key.slice(0, 12)} middle=${key.slice(14, 18)} suffix=${key.slice(-12)}\n`
            ));
            return { type: 'apiKey' };
        }
        if (method === 'account/read') {
            assert.deepEqual(params, { refreshToken: false });
            return { account: { type: 'apiKey' }, requiresOpenaiAuth: false };
        }
        throw new Error('unexpected request');
    };
    const broker = new RideCodexAuthBroker({ host, diagnostics });

    const result = await broker.login({ type: 'apiKey', apiKey: key });
    assert.deepEqual(result, { type: 'apiKey' });
    assert.deepEqual(broker.snapshot().account, { type: 'apiKey' });
    assert.equal(broker.snapshot().state, 'authenticated');
    const serialized = JSON.stringify({ result, status: broker.snapshot(), diagnostics: diagnostics.snapshot() });
    assert.equal(serialized.includes(key), false);
    assert.equal(serialized.includes(key.slice(0, 12)), false);
    assert.equal(serialized.includes(key.slice(14, 18)), false);
    assert.equal(serialized.includes(key.slice(-12)), false);
});

test('concurrent API key redaction scopes are isolated and always removed', async () => {
    const host = new FakeAuthHost();
    const diagnostics = new RideCodexAppServerDiagnostics();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const keys = ['sk-first-AAAABBBBCCCCDDDDEEEE', 'sk-second-11112222333344445555'];
    host.responder = async (method, params) => {
        if (method === 'account/login/start') {
            const apiKey = (params as { apiKey: string }).apiKey;
            diagnostics.record('protocol-error', `credential=${apiKey}`);
            return apiKey === keys[0] ? first.promise : second.promise;
        }
        return { account: { type: 'apiKey' }, requiresOpenaiAuth: false };
    };
    const broker = new RideCodexAuthBroker({ host, diagnostics });
    const firstLogin = broker.login({ type: 'apiKey', apiKey: keys[0] }).catch(error => error);
    const secondLogin = broker.login({ type: 'apiKey', apiKey: keys[1] }).catch(error => error);
    await tick();
    assert.equal(JSON.stringify(diagnostics.snapshot()).includes(keys[0]), false);
    assert.equal(JSON.stringify(diagnostics.snapshot()).includes(keys[1]), false);
    second.resolve({ type: 'apiKey' });
    first.reject(new Error(keys[0]));
    await Promise.all([firstLogin, secondLogin]);
    assert.equal(diagnostics.transientSecretCount, 0);
});

test('API key secret scope is released as soon as login/start settles, before account confirmation', async () => {
    const host = new FakeAuthHost();
    const diagnostics = new RideCodexAppServerDiagnostics();
    const accountRead = deferred<unknown>();
    host.responder = async method => method === 'account/login/start'
        ? { type: 'apiKey' }
        : accountRead.promise;
    const broker = new RideCodexAuthBroker({ host, diagnostics });
    const login = broker.login({ type: 'apiKey', apiKey: 'sk-scope-release-AAAABBBBCCCC' });
    await eventually(() => host.requests.some(request => request.method === 'account/read'));
    assert.equal(diagnostics.transientSecretCount, 0);
    accountRead.resolve({ account: { type: 'apiKey' }, requiresOpenaiAuth: false });
    await login;
});

test('supports browser and device-code login plus bounded cancellation', async () => {
    const host = new FakeAuthHost();
    host.responder = async (method, params) => {
        if (method === 'account/login/start' && (params as { type: string }).type === 'chatgpt') {
            return { type: 'chatgpt', loginId: 'browser-login', authUrl: 'https://auth.openai.com/codex' };
        }
        if (method === 'account/login/start') {
            return {
                type: 'chatgptDeviceCode', loginId: 'device-login',
                verificationUrl: 'https://auth.openai.com/device', userCode: 'ABCD-EFGH'
            };
        }
        if (method === 'account/login/cancel') {
            return { status: 'canceled' };
        }
        return { account: null, requiresOpenaiAuth: true };
    };
    const broker = new RideCodexAuthBroker({ host, diagnostics: new RideCodexAppServerDiagnostics() });

    assert.deepEqual(await broker.login({ type: 'chatgpt' }), {
        type: 'chatgpt', loginId: 'browser-login', authUrl: 'https://auth.openai.com/codex'
    });
    await broker.cancelLogin('browser-login');
    await broker.cancelLogin('browser-login');
    await assert.rejects(broker.cancelLogin('unknown-login'), /known|login/i);
    assert.deepEqual(await broker.login({ type: 'chatgptDeviceCode' }), {
        type: 'chatgptDeviceCode', loginId: 'device-login',
        verificationUrl: 'https://auth.openai.com/device', userCode: 'ABCD-EFGH'
    });
});

test('login completion refreshes the account and maps remote failure to a generic bounded error', async () => {
    const host = new FakeAuthHost();
    let accountReads = 0;
    host.responder = async method => {
        if (method === 'account/login/start') {
            return { type: 'chatgpt', loginId: 'pending', authUrl: 'https://auth.openai.com/' };
        }
        if (method === 'account/read') {
            accountReads += 1;
            return { account: { type: 'chatgpt', email: 'person@example.com', planType: 'pro' }, requiresOpenaiAuth: false };
        }
        return emptyRateLimits();
    };
    const broker = new RideCodexAuthBroker({ host, diagnostics: new RideCodexAppServerDiagnostics() });
    const client = new RecordingClient();
    broker.setClient(client);
    await broker.login({ type: 'chatgpt' });
    host.notify('account/login/completed', { loginId: 'pending', success: true, error: null });
    await eventually(() => broker.snapshot().state === 'authenticated');
    assert.equal(accountReads, 1);
    assert.deepEqual(broker.snapshot().account, { type: 'chatgpt', email: 'person@example.com', plan: 'pro' });

    await broker.login({ type: 'chatgpt' });
    const secretRemoteError = 'remote-secret-' + 'x'.repeat(500);
    host.notify('account/login/completed', { loginId: 'pending', success: false, error: secretRemoteError });
    await eventually(() => broker.snapshot().state === 'error');
    assert.equal(JSON.stringify(broker.snapshot()).includes(secretRemoteError), false);
    assert.ok((broker.snapshot().error?.message.length ?? 0) <= 160);
    assert.ok(client.snapshots.every(snapshot => Object.isFrozen(snapshot)));
});

test('strictly maps rate limits, merges sparse notifications, and drops unknown raw fields', async () => {
    const host = new FakeAuthHost();
    host.responder = async method => method === 'account/read'
        ? { account: { type: 'apiKey' }, requiresOpenaiAuth: false }
        : {
            rateLimits: rateSnapshot({ usedPercent: 10 }),
            rateLimitsByLimitId: { codex: rateSnapshot({ usedPercent: 20 }) },
            rateLimitResetCredits: { availableCount: '1', credits: null },
            unknownSecret: 'must-not-survive'
        };
    const broker = new RideCodexAuthBroker({ host, diagnostics: new RideCodexAppServerDiagnostics() });
    await broker.activate();
    await broker.readRateLimits();
    host.notify('account/rateLimits/updated', { rateLimits: rateSnapshot({ usedPercent: 33 }) });
    assert.equal(broker.snapshot().rateLimits?.primary?.usedPercent, 33);
    assert.equal(JSON.stringify(broker.snapshot()).includes('must-not-survive'), false);

    host.notify('account/rateLimits/updated', { rateLimits: rateSnapshot({ usedPercent: Number.NaN }) });
    assert.equal(broker.snapshot().state, 'error');
});

test('notification validation never invokes raw toJSON hooks or retains unvalidated payloads', async () => {
    const host = new FakeAuthHost();
    const broker = new RideCodexAuthBroker({ host, diagnostics: new RideCodexAppServerDiagnostics() });
    await broker.activate();
    let calls = 0;
    const payload = {
        authMode: 'apikey',
        planType: null,
        toJSON: () => {
            calls += 1;
            return { secret: 'sk-notification-secret' };
        }
    };
    host.notify('account/updated', payload);
    assert.equal(calls, 0);
    assert.equal(JSON.stringify(broker.snapshot()).includes('sk-notification-secret'), false);
    assert.equal(broker.snapshot().state, 'error');
});

test('logout and newer operations win over stale reads and stale generations', async () => {
    const host = new FakeAuthHost();
    const staleRead = deferred<unknown>();
    let readCount = 0;
    host.responder = async method => {
        if (method === 'account/read') {
            readCount += 1;
            return readCount === 1 ? staleRead.promise : { account: null, requiresOpenaiAuth: true };
        }
        if (method === 'account/logout') {
            return {};
        }
        return emptyRateLimits();
    };
    const broker = new RideCodexAuthBroker({ host, diagnostics: new RideCodexAppServerDiagnostics() });
    const read = broker.readAccount();
    await tick();
    await broker.logout();
    staleRead.resolve({ account: { type: 'apiKey' }, requiresOpenaiAuth: false });
    await read;
    assert.equal(broker.snapshot().state, 'unauthenticated');
    assert.equal(broker.snapshot().account, undefined);

    host.changeState('circuit-open', 2);
    assert.equal(broker.snapshot().state, 'disconnected');
    host.notify('account/updated', { authMode: 'apikey', planType: null }, 1);
    assert.equal(broker.snapshot().state, 'disconnected');
});

test('logout wins over an older pending interactive login response', async () => {
    const host = new FakeAuthHost();
    const loginResponse = deferred<unknown>();
    host.responder = async method => {
        if (method === 'account/login/start') {
            return loginResponse.promise;
        }
        if (method === 'account/logout') {
            return {};
        }
        return { account: null, requiresOpenaiAuth: true };
    };
    const broker = new RideCodexAuthBroker({ host, diagnostics: new RideCodexAppServerDiagnostics() });
    const login = broker.login({ type: 'chatgpt' }).catch(error => error);
    await tick();
    await broker.logout();
    loginResponse.resolve({ type: 'chatgpt', loginId: 'stale', authUrl: 'https://auth.openai.com/' });
    await login;
    assert.equal(broker.snapshot().state, 'unauthenticated');
    assert.equal(broker.snapshot().pendingLogin, undefined);
});

test('logout clears account, rate limits, pending login, and disconnected clients stop receiving state', async () => {
    const host = new FakeAuthHost();
    host.responder = async (method, params) => {
        if (method === 'account/login/start') {
            return { type: 'chatgpt', loginId: 'pending', authUrl: 'https://auth.openai.com/' };
        }
        if (method === 'account/read') {
            return { account: { type: 'chatgpt', email: null, planType: 'team' }, requiresOpenaiAuth: false };
        }
        if (method === 'account/rateLimits/read') {
            return { ...emptyRateLimits(), rateLimits: rateSnapshot({ usedPercent: 1 }) };
        }
        assert.equal(method, 'account/logout');
        assert.deepEqual(params, {});
        return {};
    };
    const broker = new RideCodexAuthBroker({ host, diagnostics: new RideCodexAppServerDiagnostics() });
    const client = new RecordingClient();
    broker.setClient(client);
    await broker.login({ type: 'chatgpt' });
    await broker.readAccount();
    await broker.readRateLimits();
    broker.disconnectClient(client);
    const notificationCount = client.snapshots.length;
    await broker.logout();
    assert.equal(broker.snapshot().account, undefined);
    assert.equal(broker.snapshot().rateLimits, undefined);
    assert.equal(broker.snapshot().pendingLogin, undefined);
    assert.equal(client.snapshots.length, notificationCount);
});

function rateSnapshot(primary: { usedPercent: number }): Record<string, unknown> {
    return {
        limitId: 'codex', limitName: 'Codex',
        primary: { usedPercent: primary.usedPercent, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: null,
        credits: { hasCredits: false, unlimited: false, balance: null },
        individualLimit: null, planType: 'plus', rateLimitReachedType: null
    };
}

function emptyRateLimits(): Record<string, unknown> {
    return {
        rateLimits: {
            limitId: null, limitName: null, primary: null, secondary: null,
            credits: null, individualLimit: null, planType: null, rateLimitReachedType: null
        },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null
    };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function tick(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
}

async function eventually(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) {
            return;
        }
        await tick();
    }
    assert.fail('condition was not reached');
}
