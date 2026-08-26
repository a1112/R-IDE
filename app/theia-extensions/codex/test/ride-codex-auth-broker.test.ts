/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    RideCodexAuthClient,
    RideCodexAuthSnapshot,
    trustedRideCodexAuthNormalizers
} from '../src/common/ride-codex-auth';
import {
    RideCodexAuthBroker,
    RideCodexAuthHost,
    RideCodexAuthHostLease,
    RideCodexAuthHostStateEvent
} from '../src/node/ride-codex-auth-broker';
import { rideCodexNodeAuthNormalizers } from '../src/node/ride-codex-auth-normalizers';
import { RideCodexAppServerDiagnostics } from '../src/node/ride-codex-diagnostics';
import type { RideCodexNotification } from '../src/node/ride-codex-jsonl-client';

const {
    normalizeRideCodexAccount,
    normalizeRideCodexAccountUpdate,
    normalizeRideCodexRateLimits
} = trustedRideCodexAuthNormalizers;

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
    responder: (method: string, params: unknown) => unknown | Promise<unknown> = method => {
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
            request: (method, params) => {
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

test('rate-limit response validation rejects unknown and descriptor-unsafe top-level data without invoking getters', () => {
    const valid = emptyRateLimits();
    assert.throws(
        () => normalizeRideCodexRateLimits({ ...valid, unknownSecret: 'sk-unknown-rate-limit' }),
        /unsupported property/i
    );

    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, valid);
    assert.deepEqual(normalizeRideCodexRateLimits(nullPrototype), normalizeRideCodexRateLimits(valid));

    let getterCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'rateLimits', {
        enumerable: true,
        get: () => {
            getterCalls += 1;
            return valid.rateLimits;
        }
    });
    Object.defineProperty(accessor, 'rateLimitsByLimitId', { enumerable: true, value: null });
    Object.defineProperty(accessor, 'rateLimitResetCredits', { enumerable: true, value: null });
    assert.throws(() => normalizeRideCodexRateLimits(accessor), /unsafe property/i);
    assert.equal(getterCalls, 0);

    const inherited = Object.create({ rateLimits: valid.rateLimits }) as Record<string, unknown>;
    assert.throws(() => normalizeRideCodexRateLimits(inherited), /plain record/i);

    const revoked = Proxy.revocable(valid, {});
    revoked.revoke();
    assert.throws(() => normalizeRideCodexRateLimits(revoked.proxy));
});

test('rate-limit reads reject an ordinary Proxy without invoking any traps or changing state', async () => {
    const host = new FakeAuthHost();
    const diagnostics = new RideCodexAppServerDiagnostics();
    host.responder = async method => method === 'account/read'
        ? { account: { type: 'apiKey' }, requiresOpenaiAuth: false }
        : emptyRateLimits();
    const broker = new RideCodexAuthBroker({ host, diagnostics });
    await broker.activate();
    const before = broker.snapshot();
    const hostile = trapCountingProxy(emptyRateLimits());
    host.responder = () => hostile.proxy;

    await assert.rejects(broker.readRateLimits(), /invalid data/i);
    assert.equal(hostile.trapCount(), 0);
    assert.equal(broker.snapshot(), before);
    assert.equal(JSON.stringify(diagnostics.snapshot()).includes('sk-proxy-target-secret'), false);
});

test('node auth normalizers reject top-level and nested Proxies before every reflective trap', () => {
    const cases: Array<readonly [string, (proxy: object) => unknown, (value: unknown) => unknown]> = [
        ['rate response', proxy => proxy, value => rideCodexNodeAuthNormalizers.normalizeRideCodexRateLimits(value)],
        ['rateLimits', proxy => ({ ...emptyRateLimits(), rateLimits: proxy }), value =>
            rideCodexNodeAuthNormalizers.normalizeRideCodexRateLimits(value)],
        ['rateLimitsByLimitId', proxy => ({ ...emptyRateLimits(), rateLimitsByLimitId: proxy }), value =>
            rideCodexNodeAuthNormalizers.normalizeRideCodexRateLimits(value)],
        ['rate-limit bucket', proxy => ({ ...emptyRateLimits(), rateLimitsByLimitId: { codex: proxy } }), value =>
            rideCodexNodeAuthNormalizers.normalizeRideCodexRateLimits(value)],
        ['primary window', proxy => ({ ...emptyRateLimits(), rateLimits: { ...rateSnapshot({ usedPercent: 10 }), primary: proxy } }), value =>
            rideCodexNodeAuthNormalizers.normalizeRideCodexRateLimits(value)],
        ['secondary window', proxy => ({ ...emptyRateLimits(), rateLimits: { ...rateSnapshot({ usedPercent: 10 }), secondary: proxy } }), value =>
            rideCodexNodeAuthNormalizers.normalizeRideCodexRateLimits(value)],
        ['credits', proxy => ({ ...emptyRateLimits(), rateLimits: { ...rateSnapshot({ usedPercent: 10 }), credits: proxy } }), value =>
            rideCodexNodeAuthNormalizers.normalizeRideCodexRateLimits(value)],
        ['reset credits', proxy => ({ ...emptyRateLimits(), rateLimitResetCredits: proxy }), value =>
            rideCodexNodeAuthNormalizers.normalizeRideCodexRateLimits(value)],
        ['account response', proxy => ({ account: proxy, requiresOpenaiAuth: false }), value =>
            rideCodexNodeAuthNormalizers.normalizeRideCodexAccountReadResult(value)],
        ['account', proxy => proxy, value => rideCodexNodeAuthNormalizers.normalizeRideCodexAccount(value)],
        ['login request', proxy => proxy, value => rideCodexNodeAuthNormalizers.normalizeRideCodexLoginRequest(value)],
        ['login result', proxy => proxy, value => rideCodexNodeAuthNormalizers.normalizeRideCodexLoginResult(value)],
        ['cancel result', proxy => proxy, value => rideCodexNodeAuthNormalizers.normalizeRideCodexCancelResult(value)],
        ['account notification', proxy => proxy, value => rideCodexNodeAuthNormalizers.normalizeRideCodexAccountUpdate(value)],
        ['login notification', proxy => proxy, value => rideCodexNodeAuthNormalizers.normalizeRideCodexLoginCompletion(value)],
        ['rate notification', proxy => ({ rateLimits: proxy }), value =>
            rideCodexNodeAuthNormalizers.normalizeRideCodexRateLimitUpdate(value)]
    ];
    const targets: Readonly<Record<string, object>> = {
        'rate response': emptyRateLimits(),
        rateLimits: rateSnapshot({ usedPercent: 10 }),
        rateLimitsByLimitId: { codex: rateSnapshot({ usedPercent: 10 }) },
        'rate-limit bucket': rateSnapshot({ usedPercent: 10 }),
        'primary window': { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        'secondary window': { usedPercent: 10, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
        credits: { hasCredits: false, unlimited: false, balance: null },
        'reset credits': { availableCount: '1', credits: null },
        'account response': { type: 'apiKey' },
        account: { type: 'apiKey' },
        'login request': { type: 'chatgpt' },
        'login result': { type: 'chatgpt', loginId: 'proxy-login', authUrl: 'https://auth.openai.com/' },
        'cancel result': { status: 'canceled' },
        'account notification': { authMode: 'apikey', planType: null },
        'login notification': { loginId: 'proxy-login', success: true, error: null },
        'rate notification': rateSnapshot({ usedPercent: 10 })
    };

    for (const [label, wrap, normalize] of cases) {
        const hostile = trapCountingProxy(targets[label]);
        assert.throws(() => normalize(wrap(hostile.proxy)), /proxy|unsafe/i, label);
        assert.equal(hostile.trapCount(), 0, label);
        assert.deepEqual(hostile.trapCounts(), {
            get: 0,
            getOwnPropertyDescriptor: 0,
            getPrototypeOf: 0,
            ownKeys: 0
        }, label);
    }

    const revoked = Proxy.revocable(emptyRateLimits(), {});
    revoked.revoke();
    assert.throws(
        () => rideCodexNodeAuthNormalizers.normalizeRideCodexRateLimits(revoked.proxy),
        /proxy|unsafe/i
    );
});

test('all broker auth response paths reject Proxies without traps, state mutation, or diagnostic leakage', async () => {
    const host = new FakeAuthHost();
    const diagnostics = new RideCodexAppServerDiagnostics();
    host.responder = async method => method === 'account/read'
        ? { account: { type: 'apiKey' }, requiresOpenaiAuth: false }
        : emptyRateLimits();
    const broker = new RideCodexAuthBroker({ host, diagnostics });
    await broker.activate();

    const account = trapCountingProxy({ account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: false });
    host.responder = () => account.proxy;
    const beforeAccount = broker.snapshot();
    await assert.rejects(broker.readAccount(), /invalid data/i);
    assert.equal(account.trapCount(), 0);
    assert.equal(broker.snapshot(), beforeAccount);

    const login = trapCountingProxy({ type: 'chatgpt', loginId: 'proxy-login', authUrl: 'https://auth.openai.com/' });
    host.responder = () => login.proxy;
    const beforeLogin = broker.snapshot();
    await assert.rejects(broker.login({ type: 'chatgpt' }), /invalid data/i);
    assert.equal(login.trapCount(), 0);
    assert.equal(broker.snapshot(), beforeLogin);

    host.responder = async method => method === 'account/login/start'
        ? { type: 'chatgpt', loginId: 'cancel-proxy-login', authUrl: 'https://auth.openai.com/' }
        : { status: 'canceled' };
    await broker.login({ type: 'chatgpt' });
    const cancel = trapCountingProxy({ status: 'canceled' });
    host.responder = () => cancel.proxy;
    const beforeCancel = broker.snapshot();
    await assert.rejects(broker.cancelLogin('cancel-proxy-login'), /invalid data/i);
    assert.equal(cancel.trapCount(), 0);
    assert.equal(broker.snapshot(), beforeCancel);

    assert.equal(JSON.stringify(diagnostics.snapshot()).includes('sk-proxy-target-secret'), false);
});

test('all broker auth notification paths reject Proxies without traps or trusted-state replacement', async () => {
    const host = new FakeAuthHost();
    const diagnostics = new RideCodexAppServerDiagnostics();
    host.responder = async method => method === 'account/read'
        ? { account: { type: 'apiKey' }, requiresOpenaiAuth: false }
        : method === 'account/login/start'
            ? { type: 'chatgpt', loginId: 'notification-login', authUrl: 'https://auth.openai.com/' }
            : emptyRateLimits();
    const broker = new RideCodexAuthBroker({ host, diagnostics });
    await broker.activate();

    for (const [method, target] of [
        ['account/updated', { authMode: 'apikey', planType: null }],
        ['account/rateLimits/updated', { rateLimits: rateSnapshot({ usedPercent: 50 }) }]
    ] as const) {
        const hostile = trapCountingProxy(target);
        const before = broker.snapshot();
        host.notify(method, hostile.proxy);
        assert.equal(hostile.trapCount(), 0, method);
        assert.equal(broker.snapshot(), before, method);
    }

    await broker.login({ type: 'chatgpt' });
    const completion = trapCountingProxy({ loginId: 'notification-login', success: true, error: null });
    const beforeCompletion = broker.snapshot();
    host.notify('account/login/completed', completion.proxy);
    assert.equal(completion.trapCount(), 0);
    assert.equal(broker.snapshot(), beforeCompletion);
    assert.equal(JSON.stringify(diagnostics.snapshot()).includes('sk-proxy-target-secret'), false);
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

test('strictly maps rate limits and merges sparse notifications', async () => {
    const host = new FakeAuthHost();
    host.responder = async method => method === 'account/read'
        ? { account: { type: 'apiKey' }, requiresOpenaiAuth: false }
        : {
            rateLimits: rateSnapshot({ usedPercent: 10 }),
            rateLimitsByLimitId: { codex: rateSnapshot({ usedPercent: 20 }) },
            rateLimitResetCredits: { availableCount: '1', credits: null }
        };
    const broker = new RideCodexAuthBroker({ host, diagnostics: new RideCodexAppServerDiagnostics() });
    await broker.activate();
    await broker.readRateLimits();
    host.notify('account/rateLimits/updated', { rateLimits: rateSnapshot({ usedPercent: 33 }) });
    assert.equal(broker.snapshot().rateLimits?.primary?.usedPercent, 33);

    const beforeInvalid = broker.snapshot();
    host.notify('account/rateLimits/updated', { rateLimits: rateSnapshot({ usedPercent: Number.NaN }) });
    assert.equal(broker.snapshot(), beforeInvalid);
});

test('unknown rate-limit response and notification fields fail closed without replacing trusted rate state', async () => {
    const host = new FakeAuthHost();
    const diagnostics = new RideCodexAppServerDiagnostics();
    const secret = 'sk-unknown-rate-limit-must-not-survive';
    host.responder = async method => method === 'account/read'
        ? { account: { type: 'apiKey' }, requiresOpenaiAuth: false }
        : {
            rateLimits: rateSnapshot({ usedPercent: 10 }),
            rateLimitsByLimitId: null,
            rateLimitResetCredits: null,
            unknownSecret: secret
        };
    const broker = new RideCodexAuthBroker({ host, diagnostics });
    await broker.activate();
    const beforeUnknownRead = broker.snapshot();
    await assert.rejects(broker.readRateLimits(), /invalid data/i);
    assert.equal(broker.snapshot(), beforeUnknownRead);

    host.responder = async method => method === 'account/rateLimits/read'
        ? { ...emptyRateLimits(), rateLimits: rateSnapshot({ usedPercent: 20 }) }
        : { account: { type: 'apiKey' }, requiresOpenaiAuth: false };
    await broker.readRateLimits();
    const trusted = broker.snapshot();
    host.notify('account/rateLimits/updated', {
        rateLimits: rateSnapshot({ usedPercent: 80 }),
        unknownSecret: secret
    });
    assert.equal(broker.snapshot(), trusted);
    assert.equal(JSON.stringify({ snapshot: broker.snapshot(), diagnostics: diagnostics.snapshot() }).includes(secret), false);
});

test('a validated rate notification wins over an older pending read without rejecting the read', async () => {
    const host = new FakeAuthHost();
    const pending = deferred<unknown>();
    host.responder = async method => method === 'account/read'
        ? { account: { type: 'apiKey' }, requiresOpenaiAuth: false }
        : pending.promise;
    const broker = new RideCodexAuthBroker({ host, diagnostics: new RideCodexAppServerDiagnostics() });
    await broker.activate();

    const read = broker.readRateLimits();
    await tick();
    host.notify('account/rateLimits/updated', { rateLimits: rateSnapshot({ usedPercent: 80 }) });
    pending.resolve({ ...emptyRateLimits(), rateLimits: rateSnapshot({ usedPercent: 10 }) });

    const result = await read;
    assert.equal(result.rateLimits?.primary?.usedPercent, 80);
    assert.equal(broker.snapshot().rateLimits?.primary?.usedPercent, 80);
});

test('invalid rate notifications do not invalidate a pending valid read', async () => {
    const host = new FakeAuthHost();
    const pending = deferred<unknown>();
    host.responder = async method => method === 'account/read'
        ? { account: { type: 'apiKey' }, requiresOpenaiAuth: false }
        : pending.promise;
    const broker = new RideCodexAuthBroker({ host, diagnostics: new RideCodexAppServerDiagnostics() });
    await broker.activate();

    const read = broker.readRateLimits();
    await tick();
    host.notify('account/rateLimits/updated', {
        rateLimits: rateSnapshot({ usedPercent: 80 }),
        unknownField: 'invalid'
    });
    pending.resolve({ ...emptyRateLimits(), rateLimits: rateSnapshot({ usedPercent: 10 }) });

    const result = await read;
    assert.equal(result.rateLimits?.primary?.usedPercent, 10);
    assert.equal(broker.snapshot().rateLimits?.primary?.usedPercent, 10);
});

test('new reads, validated notifications, logout, and host generations order rate-limit commits', async () => {
    const host = new FakeAuthHost();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let rateReads = 0;
    host.responder = async method => {
        if (method === 'account/read') {
            return { account: { type: 'apiKey' }, requiresOpenaiAuth: false };
        }
        if (method === 'account/logout') {
            return {};
        }
        rateReads += 1;
        return rateReads === 1 ? first.promise : second.promise;
    };
    const broker = new RideCodexAuthBroker({ host, diagnostics: new RideCodexAppServerDiagnostics() });
    await broker.activate();

    const oldRead = broker.readRateLimits().catch(error => error as Error);
    await tick();
    const currentRead = broker.readRateLimits();
    await tick();
    host.notify('account/rateLimits/updated', { rateLimits: rateSnapshot({ usedPercent: 80 }) });
    second.resolve({ ...emptyRateLimits(), rateLimits: rateSnapshot({ usedPercent: 20 }) });
    assert.equal((await currentRead).rateLimits?.primary?.usedPercent, 80);
    first.resolve({ ...emptyRateLimits(), rateLimits: rateSnapshot({ usedPercent: 10 }) });
    assert.match(String(await oldRead), /superseded/i);
    assert.equal(broker.snapshot().rateLimits?.primary?.usedPercent, 80);

    const logoutRead = deferred<unknown>();
    host.responder = async method => method === 'account/rateLimits/read' ? logoutRead.promise : {};
    const pendingLogoutRead = broker.readRateLimits().catch(error => error as Error);
    await tick();
    await broker.logout();
    logoutRead.resolve({ ...emptyRateLimits(), rateLimits: rateSnapshot({ usedPercent: 5 }) });
    assert.match(String(await pendingLogoutRead), /superseded/i);
    assert.equal(broker.snapshot().rateLimits, undefined);

    const generationRead = deferred<unknown>();
    host.responder = async method => method === 'account/rateLimits/read' ? generationRead.promise : {
        account: { type: 'apiKey' }, requiresOpenaiAuth: false
    };
    const pendingGenerationRead = broker.readRateLimits().catch(error => error as Error);
    await tick();
    host.changeState('circuit-open', 2);
    generationRead.resolve({ ...emptyRateLimits(), rateLimits: rateSnapshot({ usedPercent: 1 }) });
    assert.match(String(await pendingGenerationRead), /superseded/i);
    assert.equal(broker.snapshot().state, 'disconnected');
    assert.equal(broker.snapshot().rateLimits, undefined);
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

function trapCountingProxy<T extends object>(target: T): {
    proxy: T;
    trapCount(): number;
    trapCounts(): Readonly<Record<'get' | 'getOwnPropertyDescriptor' | 'getPrototypeOf' | 'ownKeys', number>>;
} {
    const traps = { get: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0, ownKeys: 0 };
    const count = <K extends keyof typeof traps, R>(key: K, value: R): R => {
        traps[key] += 1;
        return value;
    };
    Object.defineProperty(target, 'proxyTargetSecret', {
        configurable: true,
        enumerable: false,
        value: 'sk-proxy-target-secret'
    });
    return {
        proxy: new Proxy(target, {
            get: (object, key, receiver) => count('get', Reflect.get(object, key, receiver)),
            getOwnPropertyDescriptor: (object, key) =>
                count('getOwnPropertyDescriptor', Reflect.getOwnPropertyDescriptor(object, key)),
            getPrototypeOf: object => count('getPrototypeOf', Reflect.getPrototypeOf(object)),
            ownKeys: object => count('ownKeys', Reflect.ownKeys(object))
        }),
        trapCount: () => Object.values(traps).reduce((total, value) => total + value, 0),
        trapCounts: () => Object.freeze({ ...traps })
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
