/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    RideCodexApprovalCard,
    RideCodexApprovalClient,
    RideCodexApprovalContext
} from '../src/common/ride-codex-approvals';
import {
    RideCodexApprovalBroker,
    RideCodexApprovalHost,
    RideCodexApprovalHostLease,
    RideCodexApprovalScopeResolution
} from '../src/node/ride-codex-approval-broker';

type RequestId = string | number;

class FakeLease implements RideCodexApprovalHostLease {
    readonly kind = 'approval' as const;
    releases = 0;

    constructor(readonly generation: number) { }

    release(): void {
        this.releases += 1;
    }
}

class FakeHost implements RideCodexApprovalHost {
    generation = 7;
    state = 'ready';
    readonly leases: FakeLease[] = [];
    readonly responses: Array<Readonly<{
        generation: number;
        id: RequestId;
        result: unknown;
    }>> = [];
    readonly failingResponses = new Set<RequestId>();
    readonly #requestListeners = new Set<(request: Readonly<{
        id: RequestId;
        method: string;
        params: unknown;
    }>, generation: number) => void>();
    readonly #stateListeners = new Set<(event: Readonly<{ state: string; generation: number }>) => void>();
    readonly #notificationListeners = new Set<(notification: Readonly<{
        method: string;
        params: unknown;
    }>, generation: number) => void>();

    async acquire(kind: 'approval'): Promise<RideCodexApprovalHostLease> {
        assert.equal(kind, 'approval');
        const lease = new FakeLease(this.generation);
        this.leases.push(lease);
        return lease;
    }

    async respondServerRequest(generation: number, id: RequestId, result: unknown): Promise<void> {
        this.responses.push(Object.freeze({ generation, id, result }));
        if (this.failingResponses.has(id)) {
            throw new Error('C:\\Users\\alice\\secret.txt sk-live-secret');
        }
    }

    onStateChange(listener: (event: Readonly<{ state: string; generation: number }>) => void): { dispose(): void } {
        this.#stateListeners.add(listener);
        return { dispose: () => this.#stateListeners.delete(listener) };
    }

    onServerRequest(listener: (request: Readonly<{
        id: RequestId;
        method: string;
        params: unknown;
    }>, generation: number) => void): { dispose(): void } {
        this.#requestListeners.add(listener);
        return { dispose: () => this.#requestListeners.delete(listener) };
    }

    onNotification(listener: (notification: Readonly<{
        method: string;
        params: unknown;
    }>, generation: number) => void): { dispose(): void } {
        this.#notificationListeners.add(listener);
        return { dispose: () => this.#notificationListeners.delete(listener) };
    }

    snapshot(): Readonly<{ state: string; generation: number }> {
        return Object.freeze({ state: this.state, generation: this.generation });
    }

    emitState(state: string, generation = this.generation): void {
        this.state = state;
        this.generation = generation;
        for (const listener of [...this.#stateListeners]) {
            listener(Object.freeze({ state, generation }));
        }
    }

    emitRequest(request: ReturnType<typeof commandRequest>, generation = this.generation): void {
        for (const listener of [...this.#requestListeners]) {
            listener(request, generation);
        }
    }

    emitNotification(method: string, params: unknown, generation = this.generation): void {
        for (const listener of [...this.#notificationListeners]) {
            listener(Object.freeze({ method, params }), generation);
        }
    }
}

class RecordingClient implements RideCodexApprovalClient {
    readonly states: RideCodexApprovalCard[][] = [];
    throwOnChange = false;

    approvalsChanged(approvals: readonly RideCodexApprovalCard[]): void {
        if (this.throwOnChange) {
            throw new Error('listener secret sk-client-listener');
        }
        this.states.push([...approvals]);
    }

    latest(): readonly RideCodexApprovalCard[] {
        return this.states[this.states.length - 1] ?? [];
    }
}

class FakeClock {
    now = 1_000;
    readonly timers = new Map<number, Readonly<{ due: number; callback: () => void }>>();
    #nextId = 1;

    readonly schedule = (callback: () => void, delayMs: number): { dispose(): void } => {
        const id = this.#nextId++;
        this.timers.set(id, Object.freeze({ due: this.now + delayMs, callback }));
        return { dispose: () => this.timers.delete(id) };
    };

    advance(milliseconds: number): void {
        this.now += milliseconds;
        const due = [...this.timers.entries()]
            .filter(([, timer]) => timer.due <= this.now)
            .sort((left, right) => left[1].due - right[1].due);
        for (const [id, timer] of due) {
            if (this.timers.delete(id)) {
                timer.callback();
            }
        }
    }
}

const CONTEXT: RideCodexApprovalContext = Object.freeze({
    generation: 7,
    threadId: 'thread-alpha',
    turnId: 'turn-alpha'
});

function commandRequest(overrides: Record<string, unknown> = {}, id: RequestId = 'rpc-command-1'): Readonly<{
    id: RequestId;
    method: string;
    params: unknown;
}> {
    return Object.freeze({
        id,
        method: 'item/commandExecution/requestApproval',
        params: {
            threadId: CONTEXT.threadId,
            turnId: CONTEXT.turnId,
            itemId: 'item-command-1',
            startedAtMs: 1_700_000_000_000,
            environmentId: null,
            command: 'printf "<unsafe>& exact"',
            cwd: 'C:\\workspace\\src\\..\\src',
            reason: 'Needs access to the package registry.',
            networkApprovalContext: { host: 'registry.example.test', protocol: 'https' },
            commandActions: [{ type: 'unknown', command: 'display-only metadata' }],
            proposedExecpolicyAmendment: null,
            proposedNetworkPolicyAmendments: null,
            ...overrides
        }
    });
}

function fileRequest(overrides: Record<string, unknown> = {}, id: RequestId = 'rpc-file-1'): Readonly<{
    id: RequestId;
    method: string;
    params: unknown;
}> {
    return Object.freeze({
        id,
        method: 'item/fileChange/requestApproval',
        params: {
            threadId: CONTEXT.threadId,
            turnId: CONTEXT.turnId,
            itemId: 'item-file-1',
            startedAtMs: 1_700_000_000_001,
            reason: 'Apply the reviewed patch.',
            ...overrides
        }
    });
}

function resolution(changes: RideCodexApprovalScopeResolution['changes']): RideCodexApprovalScopeResolution {
    return Object.freeze({ workspaceRoot: 'C:\\workspace', changes: Object.freeze([...changes]) });
}

function createFixture(options: Readonly<{
    allowAcceptForSession?: boolean;
    maxPending?: number;
    resolveFileScope?: () => Promise<RideCodexApprovalScopeResolution | undefined>;
    resolveRealPath?: (path: string) => Promise<string>;
}> = {}) {
    const host = new FakeHost();
    const clock = new FakeClock();
    const broker = new RideCodexApprovalBroker({
        host,
        now: () => clock.now,
        schedule: clock.schedule,
        ttlMs: 1_000,
        maxPending: options.maxPending ?? 8,
        pathStyle: 'win32',
        allowAcceptForSession: () => options.allowAcceptForSession === true,
        resolveFileScope: options.resolveFileScope ?? (async () => resolution([
            { path: 'src\\..\\src\\a.ts', kind: 'update', movePath: 'src\\renamed.ts', diff: 'secret patch' },
            { path: 'src\\new.ts', kind: 'add', diff: '<script>unsafe</script>' }
        ])),
        resolveRealPath: options.resolveRealPath ?? (async path => path)
    });
    const client = new RecordingClient();
    const session = broker.connectClient(client);
    return { broker, client, clock, host, session };
}

async function flushAsync(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

async function waitForAsync(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (predicate()) {
            return;
        }
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.fail('Timed out waiting for the asynchronous broker result.');
}

describe('RideCodexApprovalBroker ownership', () => {
    it('publishes a deeply frozen opaque DTO and responds exactly once', async () => {
        const fixture = createFixture();
        await fixture.session.setContext(CONTEXT);
        await fixture.broker.handleServerRequest(commandRequest(), CONTEXT.generation);

        const card = fixture.client.latest()[0];
        assert.ok(card);
        assert.equal(card.kind, 'command');
        assert.match(card.token, /^[A-Za-z0-9_-]{32,}$/u);
        assert.match(card.fingerprint, /^[A-Za-z0-9_-]{32,}$/u);
        for (const serverIdentifier of ['rpc-command-1', 'thread-alpha', 'turn-alpha', 'item-command-1']) {
            assert.equal(card.token.includes(serverIdentifier), false);
            assert.equal(card.fingerprint.includes(serverIdentifier), false);
        }
        assert.ok(Object.isFrozen(card));
        assert.ok(Object.isFrozen(card.allowedDecisions));
        assert.deepEqual(card.allowedDecisions, ['accept', 'decline', 'cancel']);

        const decision = Object.freeze({
            token: card.token,
            fingerprint: card.fingerprint,
            decision: 'accept' as const
        });
        assert.deepEqual(await fixture.session.decide(decision), { status: 'responded' });
        assert.deepEqual(await fixture.session.decide(decision), {
            status: 'rejected', code: 'stale-approval'
        });
        assert.deepEqual(fixture.host.responses, [{
            generation: 7, id: 'rpc-command-1', result: { decision: 'accept' }
        }]);
        assert.equal(fixture.host.leases[0].releases, 1);
    });

    it('rejects forged, cross-client, cross-turn, and cross-generation ownership', async () => {
        const fixture = createFixture();
        await fixture.session.setContext(CONTEXT);
        const attacker = fixture.broker.connectClient(new RecordingClient());
        await attacker.setContext(CONTEXT);
        await fixture.broker.handleServerRequest(commandRequest(), CONTEXT.generation);
        const card = fixture.client.latest()[0];

        assert.deepEqual(await fixture.session.decide({
            token: card.token,
            fingerprint: `${card.fingerprint}forged`,
            decision: 'accept'
        }), { status: 'rejected', code: 'ownership-mismatch' });
        assert.deepEqual(await attacker.decide({
            token: card.token,
            fingerprint: card.fingerprint,
            decision: 'accept'
        }), { status: 'rejected', code: 'ownership-mismatch' });
        assert.equal(fixture.host.responses.length, 0);

        await fixture.session.setContext({ ...CONTEXT, turnId: 'turn-beta' });
        assert.deepEqual(await fixture.session.decide({
            token: card.token,
            fingerprint: card.fingerprint,
            decision: 'accept'
        }), { status: 'rejected', code: 'stale-approval' });
        assert.deepEqual(fixture.host.responses, [{
            generation: 7, id: 'rpc-command-1', result: { decision: 'cancel' }
        }]);
        assert.equal(fixture.host.leases[0].releases, 1);

        await fixture.session.setContext({ ...CONTEXT, generation: 8 });
        await fixture.broker.handleServerRequest(commandRequest({ turnId: 'turn-beta' }), 7);
        assert.equal(fixture.client.latest().length, 0);
    });

    it('shows exact command fields and exposes only policy-approved stable decisions', async () => {
        for (const allowAcceptForSession of [false, true]) {
            const fixture = createFixture({ allowAcceptForSession });
            await fixture.session.setContext(CONTEXT);
            await fixture.broker.handleServerRequest(commandRequest(), CONTEXT.generation);
            const card = fixture.client.latest()[0];

            assert.deepEqual(card, {
                kind: 'command',
                token: card.token,
                fingerprint: card.fingerprint,
                expiresAt: 2_000,
                command: 'printf "<unsafe>& exact"',
                cwd: 'C:\\workspace\\src',
                reason: 'Needs access to the package registry.',
                network: { host: 'registry.example.test', protocol: 'https' },
                allowedDecisions: allowAcceptForSession
                    ? ['accept', 'acceptForSession', 'decline', 'cancel']
                    : ['accept', 'decline', 'cancel']
            });
            assert.equal(JSON.stringify(card).includes('display-only metadata'), false);
            for (const decision of [
                'grantRoot', 'acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment',
                'process', 'unsandboxedShell'
            ]) {
                assert.deepEqual(await fixture.session.decide({
                    token: card.token, fingerprint: card.fingerprint, decision
                } as never), { status: 'rejected', code: 'invalid-decision' });
            }
            assert.deepEqual(await fixture.session.decide({
                token: card.token,
                fingerprint: card.fingerprint,
                decision: 'accept',
                scope: ['C:\\workspace\\expanded']
            } as never), { status: 'rejected', code: 'invalid-decision' });
            assert.equal(fixture.host.responses.length, 0);
            await fixture.session.disposeContext();
        }
    });

    it('declines malformed approved requests and ignores every other server request family', async () => {
        const fixture = createFixture();
        await fixture.session.setContext(CONTEXT);
        const rejected = [
            commandRequest({ proposedExecpolicyAmendment: ['prefix_rule'] }, 'exec-policy'),
            commandRequest({
                proposedNetworkPolicyAmendments: [{ host: 'example.test', action: 'allow' }]
            }, 'network-policy'),
            commandRequest({ networkApprovalContext: { host: 'example.test', protocol: 'ftp' } }, 'protocol'),
            commandRequest({
                networkApprovalContext: { host: 'user@example.test/path', protocol: 'https' }
            }, 'network-host'),
            commandRequest({ cwd: '\\\\server\\share' }, 'network-cwd'),
            commandRequest({ startedAtMs: Number.POSITIVE_INFINITY }, 'number'),
            commandRequest({ command: 'x'.repeat(64 * 1024 + 1) }, 'bytes'),
            fileRequest({ grantRoot: 'C:\\workspace' }, 'grant-root')
        ];
        for (const request of rejected) {
            await fixture.broker.handleServerRequest(request, CONTEXT.generation);
        }
        await fixture.broker.handleServerRequest({
            id: 'experimental', method: 'item/permissions/requestApproval', params: {}
        }, CONTEXT.generation);

        assert.equal(fixture.client.latest().length, 0);
        assert.deepEqual(fixture.host.responses.map(response => ({ id: response.id, result: response.result })),
            rejected.map(request => ({ id: request.id, result: { decision: 'decline' } })));
        assert.equal(fixture.host.leases.length, rejected.length);
        assert.ok(fixture.host.leases.every(lease => lease.releases === 1));
    });

    it('normalizes resolver-owned file scopes without retaining diffs or grant roots', async () => {
        const fixture = createFixture({ allowAcceptForSession: true });
        await fixture.session.setContext(CONTEXT);
        await fixture.broker.handleServerRequest(fileRequest(), CONTEXT.generation);

        const card = fixture.client.latest()[0];
        assert.deepEqual(card, {
            kind: 'file-change',
            token: card.token,
            fingerprint: card.fingerprint,
            expiresAt: 2_000,
            reason: 'Apply the reviewed patch.',
            changes: [
                { path: 'src\\a.ts', kind: 'update', movePath: 'src\\renamed.ts' },
                { path: 'src\\new.ts', kind: 'add' }
            ],
            allowedDecisions: ['accept', 'acceptForSession', 'decline', 'cancel']
        });
        assert.equal(JSON.stringify(card).includes('diff'), false);
        assert.equal(JSON.stringify(card).includes('C:\\workspace'), false);
        assert.ok(Object.isFrozen(card));
        assert.ok(Object.isFrozen(card.changes));
        assert.ok(card.changes.every(Object.isFrozen));
    });

    it('rejects workspace escapes, network/device paths, ADS, and realpath link escapes', async () => {
        const unsafeScopes: ReadonlyArray<Readonly<{
            path: string;
            realpath?: (path: string) => Promise<string>;
        }>> = [
            { path: '..\\outside.txt' },
            { path: '\\\\server\\share\\file.txt' },
            { path: '\\\\?\\C:\\workspace\\file.txt' },
            { path: '\\\\.\\PhysicalDrive0' },
            { path: 'src\\file.txt:stream' },
            { path: 'C:\\other\\outside.txt' },
            {
                path: 'linked\\outside.txt',
                realpath: async path => path.toLowerCase().includes('linked')
                    ? 'C:\\outside\\outside.txt' : path
            }
        ];
        for (let index = 0; index < unsafeScopes.length; index += 1) {
            const unsafe = unsafeScopes[index];
            const fixture = createFixture({
                resolveFileScope: async () => resolution([{ path: unsafe.path, kind: 'update' }]),
                resolveRealPath: unsafe.realpath
            });
            await fixture.session.setContext(CONTEXT);
            await fixture.broker.handleServerRequest(fileRequest({}, `unsafe-${index}`), CONTEXT.generation);

            assert.equal(fixture.client.latest().length, 0, unsafe.path);
            assert.deepEqual(fixture.host.responses, [{
                generation: 7, id: `unsafe-${index}`, result: { decision: 'decline' }
            }]);
            assert.equal(fixture.host.leases[0].releases, 1);
        }
    });

    it('cancels and releases exactly once on panel, context, turn, and backend disposal', async () => {
        for (const ending of ['panel', 'context', 'turn', 'backend'] as const) {
            const fixture = createFixture();
            await fixture.session.setContext(CONTEXT);
            await fixture.broker.handleServerRequest(commandRequest(), CONTEXT.generation);

            if (ending === 'panel') {
                fixture.session.dispose();
                fixture.session.dispose();
                await flushAsync();
            } else if (ending === 'context') {
                await fixture.session.disposeContext();
                await fixture.session.disposeContext();
            } else if (ending === 'turn') {
                await fixture.broker.closeContext(CONTEXT);
                await fixture.broker.closeContext(CONTEXT);
            } else {
                await fixture.broker.dispose();
                await fixture.broker.dispose();
            }

            assert.deepEqual(fixture.host.responses, [{
                generation: 7, id: 'rpc-command-1', result: { decision: 'cancel' }
            }], ending);
            assert.equal(fixture.host.leases[0].releases, 1, ending);
        }
    });

    it('makes late callbacks inert on process exit and generation change', async () => {
        const fixture = createFixture();
        await fixture.session.setContext(CONTEXT);
        await fixture.broker.handleServerRequest(commandRequest(), CONTEXT.generation);
        const card = fixture.client.latest()[0];

        fixture.host.emitState('circuit-open', 8);
        await flushAsync();

        assert.equal(fixture.host.responses.length, 0);
        assert.equal(fixture.host.leases[0].releases, 1);
        assert.deepEqual(await fixture.session.decide({
            token: card.token, fingerprint: card.fingerprint, decision: 'accept'
        }), { status: 'rejected', code: 'stale-approval' });
    });

    it('evicts by capacity and TTL with one cancellation and release per approval', async () => {
        const fixture = createFixture({ maxPending: 1 });
        await fixture.session.setContext(CONTEXT);
        await fixture.broker.handleServerRequest(commandRequest(), CONTEXT.generation);
        await fixture.broker.handleServerRequest(
            commandRequest({ itemId: 'item-command-2' }, 'rpc-command-2'),
            CONTEXT.generation
        );

        assert.deepEqual(fixture.host.responses, [{
            generation: 7, id: 'rpc-command-1', result: { decision: 'cancel' }
        }]);
        assert.equal(fixture.host.leases[0].releases, 1);
        assert.equal(fixture.client.latest().length, 1);

        fixture.clock.advance(1_001);
        await flushAsync();
        assert.deepEqual(fixture.host.responses[1], {
            generation: 7, id: 'rpc-command-2', result: { decision: 'cancel' }
        });
        assert.equal(fixture.host.leases[1].releases, 1);
        assert.equal(fixture.client.latest().length, 0);
    });

    it('contains responder and listener failures and releases their leases once', async () => {
        const responderFixture = createFixture();
        await responderFixture.session.setContext(CONTEXT);
        responderFixture.host.failingResponses.add('rpc-command-1');
        await responderFixture.broker.handleServerRequest(commandRequest(), CONTEXT.generation);
        const card = responderFixture.client.latest()[0];
        assert.deepEqual(await responderFixture.session.decide({
            token: card.token, fingerprint: card.fingerprint, decision: 'decline'
        }), { status: 'rejected', code: 'response-failed' });
        assert.equal(responderFixture.host.responses.length, 1);
        assert.equal(responderFixture.host.leases[0].releases, 1);

        const listenerFixture = createFixture();
        listenerFixture.client.throwOnChange = true;
        await listenerFixture.session.setContext(CONTEXT);
        await listenerFixture.broker.handleServerRequest(commandRequest(), CONTEXT.generation);
        await flushAsync();
        assert.deepEqual(listenerFixture.host.responses, [{
            generation: 7, id: 'rpc-command-1', result: { decision: 'cancel' }
        }]);
        assert.equal(listenerFixture.host.leases[0].releases, 1);
    });

    it('rejects accessors and proxies without invoking getters or traps', async () => {
        const fixture = createFixture();
        await fixture.session.setContext(CONTEXT);
        let getterCalls = 0;
        const params = { ...commandRequest().params as Record<string, unknown> };
        Object.defineProperty(params, 'command', {
            enumerable: true,
            get: () => {
                getterCalls += 1;
                return 'dangerous';
            }
        });
        await fixture.broker.handleServerRequest({
            id: 'accessor', method: 'item/commandExecution/requestApproval', params
        }, CONTEXT.generation);
        assert.equal(getterCalls, 0);

        let trapCalls = 0;
        const proxy = new Proxy({}, {
            ownKeys: () => { trapCalls += 1; return []; },
            getOwnPropertyDescriptor: () => { trapCalls += 1; return undefined; },
            get: () => { trapCalls += 1; return undefined; },
            getPrototypeOf: () => { trapCalls += 1; return Object.prototype; }
        });
        await fixture.broker.handleServerRequest({
            id: 'proxy', method: 'item/commandExecution/requestApproval', params: proxy
        }, CONTEXT.generation);

        assert.equal(trapCalls, 0);
        assert.equal(fixture.client.latest().length, 0);
        assert.deepEqual(fixture.host.responses.map(response => response.id), ['accessor', 'proxy']);
        assert.ok(fixture.host.leases.every(lease => lease.releases === 1));
    });

    it('operates through host callbacks and cancels on matching terminal turn notifications', async () => {
        const fixture = createFixture();
        await fixture.session.setContext(CONTEXT);
        fixture.host.emitRequest(commandRequest());
        await flushAsync();
        assert.equal(fixture.client.latest().length, 1);

        fixture.host.emitNotification('turn/completed', {
            threadId: CONTEXT.threadId,
            turn: { id: CONTEXT.turnId, status: 'interrupted' }
        });
        await flushAsync();

        assert.deepEqual(fixture.host.responses, [{
            generation: 7, id: 'rpc-command-1', result: { decision: 'cancel' }
        }]);
        assert.equal(fixture.host.leases[0].releases, 1);
        assert.equal(fixture.client.latest().length, 0);
    });

    it('contains policy and scheduler failures without leaking approval leases', async () => {
        for (const failure of ['policy', 'scheduler'] as const) {
            const host = new FakeHost();
            const broker = new RideCodexApprovalBroker({
                host,
                ttlMs: 1_000,
                pathStyle: 'win32',
                allowAcceptForSession: () => {
                    if (failure === 'policy') {
                        throw new Error('policy secret');
                    }
                    return false;
                },
                schedule: () => {
                    if (failure === 'scheduler') {
                        throw new Error('scheduler secret');
                    }
                    return { dispose: () => undefined };
                }
            });
            const client = new RecordingClient();
            const session = broker.connectClient(client);
            await session.setContext(CONTEXT);

            await assert.doesNotReject(broker.handleServerRequest(commandRequest(), CONTEXT.generation));
            assert.deepEqual(host.responses, [{
                generation: 7, id: 'rpc-command-1', result: { decision: 'decline' }
            }], failure);
            assert.equal(host.leases[0].releases, 1, failure);
            assert.equal(client.latest().length, 0, failure);
            await broker.dispose();
        }
    });

    it('bounds connected client state and cancels approvals owned by an evicted client', async () => {
        const host = new FakeHost();
        const broker = new RideCodexApprovalBroker({
            host,
            now: () => 1_000,
            ttlMs: 1_000,
            maxClients: 1,
            pathStyle: 'win32'
        });
        const firstClient = new RecordingClient();
        const first = broker.connectClient(firstClient);
        await first.setContext(CONTEXT);
        await broker.handleServerRequest(commandRequest(), CONTEXT.generation);
        assert.equal(firstClient.latest().length, 1);

        broker.connectClient(new RecordingClient());
        await flushAsync();

        assert.deepEqual(host.responses, [{
            generation: 7, id: 'rpc-command-1', result: { decision: 'cancel' }
        }]);
        assert.equal(host.leases[0].releases, 1);
        assert.deepEqual(await first.approvals(), []);
        await broker.dispose();
    });

    it('resolves file approvals operationally from validated host file-change notifications', async () => {
        const host = new FakeHost();
        const broker = new RideCodexApprovalBroker({
            host,
            now: () => 1_000,
            ttlMs: 1_000,
            pathStyle: 'win32',
            resolveRealPath: async path => path
        });
        const client = new RecordingClient();
        const session = broker.connectClient(client);
        await session.setContext(CONTEXT);
        host.emitNotification('thread/started', {
            thread: { id: CONTEXT.threadId, cwd: 'C:\\workspace' }
        });
        host.emitNotification('item/started', {
            threadId: CONTEXT.threadId,
            turnId: CONTEXT.turnId,
            item: {
                type: 'fileChange',
                id: 'item-file-1',
                changes: [{
                    path: 'src\\tracked.ts',
                    kind: { type: 'update', move_path: null },
                    diff: 'must not be retained'
                }],
                status: 'inProgress'
            },
            startedAtMs: 1_700_000_000_000
        });

        host.emitRequest(fileRequest());
        await waitForAsync(() => client.latest().length === 1);

        const card = client.latest()[0];
        assert.deepEqual(card, {
            kind: 'file-change',
            token: card.token,
            fingerprint: card.fingerprint,
            expiresAt: 2_000,
            reason: 'Apply the reviewed patch.',
            changes: [{ path: 'src\\tracked.ts', kind: 'update' }],
            allowedDecisions: ['accept', 'decline', 'cancel']
        });
        assert.equal(JSON.stringify(card).includes('must not be retained'), false);
        await broker.dispose();
    });
});
