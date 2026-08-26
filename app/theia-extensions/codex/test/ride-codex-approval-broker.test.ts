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
import * as backendModuleExports from '../src/node/ride-codex-backend-module';

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
    requestOwnership = true;
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

    ownsServerRequest(generation: number, _id: RequestId): boolean {
        return this.requestOwnership && this.state === 'ready' && this.generation === generation;
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
    readonly callbacks: Array<() => void> = [];
    #nextId = 1;

    readonly schedule = (callback: () => void, delayMs: number): { dispose(): void } => {
        const id = this.#nextId++;
        this.callbacks.push(callback);
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

class Deferred<T> {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
    readonly reject: (reason: Error) => void;

    constructor() {
        let resolve!: (value: T) => void;
        let reject!: (reason: Error) => void;
        this.promise = new Promise<T>((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });
        this.resolve = resolve;
        this.reject = reject;
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

function minimalCommandRequest(
    optional: Record<string, unknown> = {},
    id: RequestId = 'rpc-minimal-command'
): Readonly<{ id: RequestId; method: string; params: unknown }> {
    return Object.freeze({
        id,
        method: 'item/commandExecution/requestApproval',
        params: {
            threadId: CONTEXT.threadId,
            turnId: CONTEXT.turnId,
            itemId: 'item-minimal-command',
            startedAtMs: 1_700_000_000_000,
            ...optional
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
    allowAcceptForSession?: boolean | ((kind: 'command' | 'file-change') => boolean);
    maxPending?: number;
    resolveFileScope?: () => Promise<RideCodexApprovalScopeResolution | undefined>;
    resolveRealPath?: (path: string) => Promise<string>;
    now?: () => number;
    pathStyle?: 'posix' | 'win32';
    schedule?: (callback: () => void, delayMs: number) => { dispose(): void };
}> = {}) {
    const host = new FakeHost();
    const clock = new FakeClock();
    const broker = new RideCodexApprovalBroker({
        host,
        now: options.now ?? (() => clock.now),
        schedule: options.schedule ?? clock.schedule,
        ttlMs: 1_000,
        maxPending: options.maxPending ?? 8,
        pathStyle: options.pathStyle ?? 'win32',
        allowAcceptForSession: typeof options.allowAcceptForSession === 'function'
            ? options.allowAcceptForSession
            : () => options.allowAcceptForSession === true,
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
                cwd: 'C:\\workspace\\src\\..\\src',
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
            commandRequest({ networkApprovalContext: { host: 'example.test', protocol: 'ftp' } }, 'protocol'),
            commandRequest({ cwd: '\\\\server\\share' }, 'network-cwd'),
            commandRequest({ startedAtMs: Number.POSITIVE_INFINITY }, 'number'),
            commandRequest({ command: 'x'.repeat(64 * 1024 + 1) }, 'bytes')
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

    it('mirrors the reviewed Codex 0.144 command approval schema table and ignores amendments', async () => {
        const valid: ReadonlyArray<Readonly<{ name: string; optional: Record<string, unknown> }>> = [
            { name: 'minimal', optional: {} },
            {
                name: 'all nullable',
                optional: {
                    approvalId: null,
                    environmentId: null,
                    reason: null,
                    networkApprovalContext: null,
                    command: null,
                    cwd: null,
                    commandActions: null,
                    proposedExecpolicyAmendment: null,
                    proposedNetworkPolicyAmendments: null
                }
            },
            {
                name: 'all supplied',
                optional: {
                    approvalId: 'approval-callback',
                    environmentId: 'local-environment',
                    reason: 'reviewed reason',
                    networkApprovalContext: { host: 'registry.example.test', protocol: 'https' },
                    command: 'npm test -- --runInBand',
                    cwd: 'C:/workspace\\src\\..\\pkg',
                    commandActions: [
                        { type: 'read', command: 'type README.md', name: 'README.md', path: 'C:\\workspace\\README.md' },
                        { type: 'listFiles', command: 'dir' },
                        { type: 'listFiles', command: 'dir src', path: null },
                        { type: 'listFiles', command: 'dir test', path: 'test' },
                        { type: 'search', command: 'rg TODO' },
                        { type: 'search', command: 'rg TODO src', query: null, path: null },
                        { type: 'search', command: 'rg Task test', query: 'Task', path: 'test' },
                        { type: 'unknown', command: 'custom-command' }
                    ],
                    proposedExecpolicyAmendment: ['npm', 'test'],
                    proposedNetworkPolicyAmendments: [
                        { host: 'registry.example.test', action: 'allow' },
                        { host: 'blocked.example.test', action: 'deny' }
                    ]
                }
            },
            {
                name: 'empty defaults',
                optional: {
                    environmentId: null,
                    command: '',
                    cwd: '',
                    commandActions: [],
                    proposedExecpolicyAmendment: [],
                    proposedNetworkPolicyAmendments: []
                }
            },
            {
                name: 'schema strings without hostname format',
                optional: {
                    networkApprovalContext: { host: '', protocol: 'http' },
                    proposedNetworkPolicyAmendments: [
                        { host: 'user@example.test/path', action: 'allow' }
                    ]
                }
            }
        ];
        for (const entry of valid) {
            const fixture = createFixture();
            await fixture.session.setContext(CONTEXT);
            await fixture.broker.handleServerRequest(
                minimalCommandRequest(entry.optional, `valid-${entry.name}`), CONTEXT.generation
            );

            const card = fixture.client.latest()[0] as RideCodexApprovalCard | undefined;
            assert.ok(card, entry.name);
            assert.equal(card.kind, 'command', entry.name);
            assert.deepEqual(card.allowedDecisions, ['accept', 'decline', 'cancel'], entry.name);
            assert.equal(JSON.stringify(card).includes('Amendment'), false, entry.name);
            if (!Object.prototype.hasOwnProperty.call(entry.optional, 'command')
                || entry.optional.command === null) {
                assert.equal(Object.prototype.hasOwnProperty.call(card, 'command'), false, entry.name);
            } else {
                assert.equal((card as { command?: string }).command, entry.optional.command, entry.name);
            }
            if (typeof entry.optional.cwd === 'string') {
                assert.equal((card as { cwd?: string }).cwd, entry.optional.cwd, entry.name);
            }
            await fixture.session.disposeContext();
            assert.equal(fixture.host.leases[0].releases, 1, entry.name);
        }

        const invalid: ReadonlyArray<Readonly<{ name: string; optional: Record<string, unknown> }>> = [
            { name: 'unknown top-level field', optional: { unknown: true } },
            { name: 'invalid environment', optional: { environmentId: 1 } },
            { name: 'invalid command', optional: { command: [] } },
            { name: 'invalid cwd', optional: { cwd: 1 } },
            { name: 'invalid approval id', optional: { approvalId: false } },
            { name: 'invalid reason', optional: { reason: {} } },
            { name: 'invalid network field', optional: { networkApprovalContext: { host: 'example.test', protocol: 'https', extra: true } } },
            { name: 'invalid exec amendment type', optional: { proposedExecpolicyAmendment: 'npm' } },
            { name: 'invalid exec amendment item', optional: { proposedExecpolicyAmendment: ['npm', 1] } },
            { name: 'oversized exec amendment array', optional: { proposedExecpolicyAmendment: Array(129).fill('npm') } },
            { name: 'invalid network amendment action', optional: { proposedNetworkPolicyAmendments: [{ host: 'example.test', action: 'permit' }] } },
            { name: 'invalid network amendment host', optional: { proposedNetworkPolicyAmendments: [{ host: 1, action: 'allow' }] } },
            { name: 'unknown network amendment field', optional: { proposedNetworkPolicyAmendments: [{ host: 'example.test', action: 'allow', extra: true }] } },
            { name: 'oversized network amendment array', optional: { proposedNetworkPolicyAmendments: Array(129).fill({ host: 'example.test', action: 'allow' }) } },
            { name: 'read action missing path', optional: { commandActions: [{ type: 'read', command: 'type', name: 'name' }] } },
            { name: 'list action invalid path', optional: { commandActions: [{ type: 'listFiles', command: 'dir', path: 1 }] } },
            { name: 'search action invalid query', optional: { commandActions: [{ type: 'search', command: 'rg', query: 1 }] } },
            { name: 'action unknown field', optional: { commandActions: [{ type: 'unknown', command: 'x', extra: true }] } }
        ];
        const fixture = createFixture();
        await fixture.session.setContext(CONTEXT);
        for (const [index, entry] of invalid.entries()) {
            await fixture.broker.handleServerRequest(
                minimalCommandRequest(entry.optional, `invalid-${index}`), CONTEXT.generation
            );
        }
        assert.ok(fixture.client.states.every(state => state.length === 0));
        assert.deepEqual(fixture.host.responses.map(response => response.id),
            invalid.map((_, index) => `invalid-${index}`));
        assert.ok(fixture.host.responses.every(response =>
            (response.result as { decision?: string }).decision === 'decline'));
        assert.ok(fixture.host.leases.every(lease => lease.releases === 1));
    });

    it('validates nested amendments and actions without invoking accessors or Proxy traps', async () => {
        let traps = 0;
        const proxy = new Proxy([], {
            get: () => { traps += 1; return undefined; },
            getOwnPropertyDescriptor: () => { traps += 1; return undefined; }
        });
        let getters = 0;
        const amendment = { action: 'allow' } as Record<string, unknown>;
        Object.defineProperty(amendment, 'host', {
            enumerable: true,
            get: () => { getters += 1; return 'example.test'; }
        });
        const action: unknown[] = [{ type: 'listFiles', command: 'dir' }];
        Object.defineProperty(action, '0', {
            enumerable: true,
            configurable: true,
            get: () => { getters += 1; return { type: 'listFiles', command: 'dir' }; }
        });
        const fixture = createFixture();
        await fixture.session.setContext(CONTEXT);
        for (const [index, optional] of [
            { proposedExecpolicyAmendment: proxy },
            { proposedNetworkPolicyAmendments: [amendment] },
            { commandActions: action }
        ].entries()) {
            await fixture.broker.handleServerRequest(
                minimalCommandRequest(optional, `descriptor-${index}`), CONTEXT.generation
            );
        }
        assert.equal(traps, 0);
        assert.equal(getters, 0);
        assert.deepEqual(fixture.host.responses.map(response => response.id),
            ['descriptor-0', 'descriptor-1', 'descriptor-2']);
        assert.ok(fixture.host.leases.every(lease => lease.releases === 1));
    });

    it('retains the original safe cwd byte-for-byte and omits absent or null command text', async () => {
        const exactCwds = ['C:/workspace\\src\\..\\pkg', 'src/../pkg', 'C:\\workspace\\double\\\\separator'];
        for (const [index, cwd] of exactCwds.entries()) {
            const fixture = createFixture();
            await fixture.session.setContext(CONTEXT);
            await fixture.broker.handleServerRequest(
                minimalCommandRequest({ command: null, cwd }, `cwd-${index}`), CONTEXT.generation
            );
            const card = fixture.client.latest()[0] as RideCodexApprovalCard;
            assert.equal((card as { cwd?: string }).cwd, cwd);
            assert.equal(Object.prototype.hasOwnProperty.call(card, 'command'), false);
            await fixture.session.disposeContext();
        }
    });

    it('accepts bounded file grantRoot schema strings but never exposes grant decisions or the root', async () => {
        for (const [index, grantRoot] of [undefined, null, '', 'C:\\workspace\\reviewed'].entries()) {
            const fixture = createFixture({ allowAcceptForSession: true });
            await fixture.session.setContext(CONTEXT);
            const optional = grantRoot === undefined ? {} : { grantRoot };
            await fixture.broker.handleServerRequest(
                fileRequest(optional, `grant-root-${index}`), CONTEXT.generation
            );
            const card = fixture.client.latest()[0];
            assert.ok(card, String(grantRoot));
            assert.deepEqual(card.allowedDecisions,
                ['accept', 'acceptForSession', 'decline', 'cancel']);
            assert.equal(JSON.stringify(card).includes('grantRoot'), false);
            assert.equal(JSON.stringify(card).includes('C:\\workspace\\reviewed'), false);
            await fixture.broker.dispose();
        }
    });

    it('rejects drive-relative, network, and ADS command cwd forms', async () => {
        const unsafe = ['C:', 'C:relative', '\\\\server\\share', 'src\\file.txt:stream'];
        for (const [index, cwd] of unsafe.entries()) {
            const fixture = createFixture();
            await fixture.session.setContext(CONTEXT);
            await fixture.broker.handleServerRequest(
                minimalCommandRequest({ cwd }, `unsafe-cwd-${index}`), CONTEXT.generation
            );
            assert.equal(fixture.client.latest().length, 0, cwd);
            assert.deepEqual(fixture.host.responses[0]?.result, { decision: 'decline' }, cwd);
            assert.equal(fixture.host.leases[0].releases, 1, cwd);
        }
    });

    it('rejects every Windows DOS device alias in cwd, relative/absolute scopes, and movePath', async () => {
        const aliases = [
            'CON', 'prn.txt', 'Aux .log', 'nul...', 'COM1', 'com9.json', 'LPT1 ', 'lpt9...txt'
        ];
        for (const [index, alias] of aliases.entries()) {
            const cwdFixture = createFixture();
            await cwdFixture.session.setContext(CONTEXT);
            await cwdFixture.broker.handleServerRequest(
                minimalCommandRequest({ cwd: `C:\\workspace\\src\\${alias}` }, `device-cwd-${index}`),
                CONTEXT.generation
            );
            assert.equal(cwdFixture.client.latest().length, 0, `cwd ${alias}`);
            assert.deepEqual(cwdFixture.host.responses[0]?.result, { decision: 'decline' }, `cwd ${alias}`);

            for (const [scopeKind, scope] of [
                ['relative', resolution([{ path: `src\\${alias}\\file.ts`, kind: 'update' }])],
                ['absolute', resolution([{ path: `C:\\workspace\\${alias}`, kind: 'update' }])],
                ['move', resolution([{ path: 'src\\safe.ts', kind: 'update', movePath: `src\\${alias}` }])],
                ['workspace', { workspaceRoot: `C:\\${alias}\\workspace`, changes: [{ path: 'safe.ts', kind: 'update' as const }] }]
            ] as const) {
                const fixture = createFixture({ resolveFileScope: async () => scope });
                await fixture.session.setContext(CONTEXT);
                await fixture.broker.handleServerRequest(
                    fileRequest({}, `device-${index}-${scopeKind}`), CONTEXT.generation
                );
                assert.equal(fixture.client.latest().length, 0, `${scopeKind} ${alias}`);
                assert.deepEqual(fixture.host.responses[0]?.result,
                    { decision: 'decline' }, `${scopeKind} ${alias}`);
                assert.equal(fixture.host.leases[0].releases, 1, `${scopeKind} ${alias}`);
            }
        }
    });

    it('keeps DOS device spellings valid for POSIX cwd and file scopes', async () => {
        const fixture = createFixture({
            pathStyle: 'posix',
            resolveFileScope: async () => Object.freeze({
                workspaceRoot: '/workspace',
                changes: Object.freeze([
                    { path: 'CON/prn.txt', kind: 'update' as const, movePath: 'AUX/NUL.log' }
                ])
            })
        });
        await fixture.session.setContext(CONTEXT);
        await fixture.broker.handleServerRequest(
            minimalCommandRequest({ command: 'pwd', cwd: 'CON/PRN.txt' }, 'posix-command'),
            CONTEXT.generation
        );
        assert.equal((fixture.client.latest()[0] as { cwd?: string }).cwd, 'CON/PRN.txt');
        await fixture.session.disposeContext();
        await fixture.session.setContext(CONTEXT);
        await fixture.broker.handleServerRequest(fileRequest({}, 'posix-file'), CONTEXT.generation);
        const card = fixture.client.latest()[0];
        assert.equal(card.kind, 'file-change');
        assert.deepEqual(card.changes, [{
            path: 'CON/prn.txt', kind: 'update', movePath: 'AUX/NUL.log'
        }]);
        await fixture.broker.dispose();
    });

    it('uses the explicit reviewed 0.144 production policy for both stable approval families only', async () => {
        const policy = (backendModuleExports as unknown as {
            RIDE_CODEX_0_144_APPROVAL_POLICY?: (kind: 'command' | 'file-change') => boolean;
        }).RIDE_CODEX_0_144_APPROVAL_POLICY;
        assert.equal(typeof policy, 'function');
        assert.equal(policy?.('command'), true);
        assert.equal(policy?.('file-change'), true);
        assert.equal((policy as (kind: string) => boolean)('permissions'), false);

        const fixture = createFixture({ allowAcceptForSession: policy });
        await fixture.session.setContext(CONTEXT);
        await fixture.broker.handleServerRequest(commandRequest(), CONTEXT.generation);
        assert.deepEqual(fixture.client.latest()[0].allowedDecisions,
            ['accept', 'acceptForSession', 'decline', 'cancel']);
        await fixture.session.disposeContext();
        await fixture.session.setContext(CONTEXT);
        await fixture.broker.handleServerRequest(fileRequest(), CONTEXT.generation);
        assert.deepEqual(fixture.client.latest()[0].allowedDecisions,
            ['accept', 'acceptForSession', 'decline', 'cancel']);
        await fixture.broker.handleServerRequest({
            id: 'experimental-policy', method: 'item/permissions/requestApproval', params: {}
        }, CONTEXT.generation);
        assert.equal(fixture.client.latest().length, 1);
        assert.equal(fixture.host.responses.some(response => response.id === 'experimental-policy'), false);
        await fixture.broker.dispose();
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

    it('reschedules a scheduled TTL callback invoked at expiresAt - 1 without extending the TTL', async () => {
        const fixture = createFixture();
        await fixture.session.setContext(CONTEXT);
        await fixture.broker.handleServerRequest(commandRequest(), CONTEXT.generation);
        const card = fixture.client.latest()[0];
        const earlyCallback = fixture.clock.callbacks[0];
        assert.ok(earlyCallback);
        fixture.clock.now = card.expiresAt - 1;

        earlyCallback();
        await flushAsync();

        assert.equal(fixture.host.responses.length, 0);
        assert.deepEqual(fixture.client.latest(), [card]);
        assert.equal(fixture.client.latest()[0].expiresAt, card.expiresAt);
        assert.equal(fixture.clock.callbacks.length, 2);
        assert.equal(fixture.clock.timers.size, 1);
        assert.deepEqual([...fixture.clock.timers.values()].map(timer => timer.due), [card.expiresAt]);

        earlyCallback();
        await flushAsync();
        assert.equal(fixture.host.responses.length, 0);
        assert.deepEqual(await fixture.session.decide({
            token: card.token, fingerprint: card.fingerprint, decision: 'accept'
        }), { status: 'responded' });
        assert.deepEqual(fixture.host.responses, [{
            generation: 7, id: 'rpc-command-1', result: { decision: 'accept' }
        }]);
        assert.equal(fixture.host.leases[0].releases, 1);

        fixture.clock.callbacks[1]();
        await flushAsync();
        assert.equal(fixture.host.responses.length, 1);
        assert.equal(fixture.host.leases[0].releases, 1);
    });

    it('settles a scheduled TTL callback invoked exactly at expiresAt once', async () => {
        const fixture = createFixture();
        await fixture.session.setContext(CONTEXT);
        await fixture.broker.handleServerRequest(commandRequest(), CONTEXT.generation);
        const card = fixture.client.latest()[0];
        const callback = fixture.clock.callbacks[0];
        assert.ok(callback);
        fixture.clock.now = card.expiresAt;

        callback();
        callback();
        await flushAsync();

        assert.deepEqual(fixture.host.responses, [{
            generation: 7, id: 'rpc-command-1', result: { decision: 'cancel' }
        }]);
        assert.equal(fixture.host.leases[0].releases, 1);
        assert.equal(fixture.client.latest().length, 0);
    });

    it('settles a scheduled TTL callback invoked at expiresAt + 1 once', async () => {
        const fixture = createFixture();
        await fixture.session.setContext(CONTEXT);
        await fixture.broker.handleServerRequest(commandRequest(), CONTEXT.generation);
        const card = fixture.client.latest()[0];
        const callback = fixture.clock.callbacks[0];
        assert.ok(callback);
        fixture.clock.now = card.expiresAt + 1;

        callback();
        callback();
        await flushAsync();

        assert.deepEqual(fixture.host.responses, [{
            generation: 7, id: 'rpc-command-1', result: { decision: 'cancel' }
        }]);
        assert.equal(fixture.host.leases[0].releases, 1);
        assert.equal(fixture.client.latest().length, 0);
    });

    it('fails closed once when the scheduled TTL callback clock rolls back, is invalid, or throws', async () => {
        const cases: ReadonlyArray<Readonly<{
            name: string;
            callbackNow: () => number;
        }>> = [
            { name: 'rollback', callbackNow: () => 999 },
            { name: 'NaN', callbackNow: () => Number.NaN },
            { name: 'fractional', callbackNow: () => 1_999.5 },
            { name: 'infinite', callbackNow: () => Number.POSITIVE_INFINITY },
            { name: 'unsafe', callbackNow: () => Number.MAX_SAFE_INTEGER + 1 },
            { name: 'throwing', callbackNow: () => { throw new Error('clock failure'); } }
        ];
        for (const entry of cases) {
            let callbackInvoked = false;
            const fixture = createFixture({
                now: () => callbackInvoked ? entry.callbackNow() : 1_000
            });
            await fixture.session.setContext(CONTEXT);
            await fixture.broker.handleServerRequest(
                commandRequest({}, `callback-clock-${entry.name}`), CONTEXT.generation
            );
            const card = fixture.client.latest()[0];
            const callback = fixture.clock.callbacks[0];
            assert.ok(callback);
            callbackInvoked = true;

            callback();
            callback();
            await flushAsync();

            assert.deepEqual(fixture.host.responses, [{
                generation: 7,
                id: `callback-clock-${entry.name}`,
                result: { decision: 'decline' }
            }], entry.name);
            assert.equal(fixture.host.leases[0].releases, 1, entry.name);
            assert.deepEqual(await fixture.session.decide({
                token: card.token, fingerprint: card.fingerprint, decision: 'accept'
            }), { status: 'rejected', code: 'stale-approval' }, entry.name);
            await fixture.broker.dispose();
        }
    });

    it('fails closed once when rescheduling an early TTL callback throws', async () => {
        const callbacks: Array<() => void> = [];
        const delays: number[] = [];
        let disposals = 0;
        const fixture = createFixture({
            schedule: (callback, delayMs) => {
                callbacks.push(callback);
                delays.push(delayMs);
                if (callbacks.length === 2) {
                    throw new Error('reschedule failure');
                }
                let disposed = false;
                return {
                    dispose: () => {
                        if (!disposed) {
                            disposed = true;
                            disposals += 1;
                        }
                    }
                };
            }
        });
        await fixture.session.setContext(CONTEXT);
        await fixture.broker.handleServerRequest(commandRequest(), CONTEXT.generation);
        const card = fixture.client.latest()[0];
        fixture.clock.now = card.expiresAt - 1;

        callbacks[0]();
        callbacks[0]();
        await flushAsync();

        assert.deepEqual(delays, [1_000, 1]);
        assert.equal(disposals, 1);
        assert.deepEqual(fixture.host.responses, [{
            generation: 7, id: 'rpc-command-1', result: { decision: 'decline' }
        }]);
        assert.equal(fixture.host.leases[0].releases, 1);
        assert.equal(fixture.client.latest().length, 0);
        assert.deepEqual(await fixture.session.decide({
            token: card.token, fingerprint: card.fingerprint, decision: 'accept'
        }), { status: 'rejected', code: 'stale-approval' });
    });

    it('reschedules a synchronous early TTL callback invoked before pending insertion', async () => {
        const callbacks: Array<() => void> = [];
        const delays: number[] = [];
        let scheduleCalls = 0;
        const fixture = createFixture({
            schedule: (callback, delayMs) => {
                callbacks.push(callback);
                delays.push(delayMs);
                scheduleCalls += 1;
                if (scheduleCalls === 1) {
                    callback();
                }
                return { dispose: () => undefined };
            }
        });
        await fixture.session.setContext(CONTEXT);

        await fixture.broker.handleServerRequest(commandRequest(), CONTEXT.generation);

        const card = fixture.client.latest()[0];
        assert.ok(card);
        assert.deepEqual(delays, [1_000, 1_000]);
        assert.equal(card.expiresAt, 2_000);
        assert.equal(fixture.host.responses.length, 0);
        assert.deepEqual(await fixture.session.decide({
            token: card.token, fingerprint: card.fingerprint, decision: 'accept'
        }), { status: 'responded' });
        callbacks.forEach(callback => callback());
        await flushAsync();
        assert.deepEqual(fixture.host.responses, [{
            generation: 7, id: 'rpc-command-1', result: { decision: 'accept' }
        }]);
        assert.equal(fixture.host.leases[0].releases, 1);
    });

    it('reschedules repeated early TTL callbacks and makes superseded callbacks inert', async () => {
        const fixture = createFixture();
        await fixture.session.setContext(CONTEXT);
        await fixture.broker.handleServerRequest(commandRequest(), CONTEXT.generation);
        const card = fixture.client.latest()[0];

        for (const offset of [-3, -2, -1]) {
            fixture.clock.now = card.expiresAt + offset;
            const callback = fixture.clock.callbacks[fixture.clock.callbacks.length - 1];
            assert.ok(callback);
            callback();
            await flushAsync();
            assert.equal(fixture.host.responses.length, 0, `offset ${offset}`);
            assert.equal(fixture.client.latest()[0].expiresAt, card.expiresAt, `offset ${offset}`);
            assert.equal(fixture.clock.timers.size, 1, `offset ${offset}`);
            assert.deepEqual(
                [...fixture.clock.timers.values()].map(timer => timer.due),
                [card.expiresAt],
                `offset ${offset}`
            );
        }

        fixture.clock.now = card.expiresAt;
        fixture.clock.callbacks.slice(0, -1).forEach(callback => callback());
        await flushAsync();
        assert.equal(fixture.host.responses.length, 0);
        fixture.clock.callbacks[fixture.clock.callbacks.length - 1]?.();
        await flushAsync();
        assert.deepEqual(fixture.host.responses, [{
            generation: 7, id: 'rpc-command-1', result: { decision: 'cancel' }
        }]);
        assert.equal(fixture.host.leases[0].releases, 1);
        assert.equal(fixture.client.latest().length, 0);
    });

    it('settles once when a TTL callback races a decision', async () => {
        const fixture = createFixture();
        await fixture.session.setContext(CONTEXT);
        await fixture.broker.handleServerRequest(commandRequest(), CONTEXT.generation);
        const card = fixture.client.latest()[0];
        const callback = fixture.clock.callbacks[0];
        assert.ok(callback);
        fixture.clock.now = card.expiresAt;

        callback();
        const decision = await fixture.session.decide({
            token: card.token, fingerprint: card.fingerprint, decision: 'accept'
        });
        await flushAsync();

        assert.deepEqual(decision, { status: 'rejected', code: 'stale-approval' });
        assert.deepEqual(fixture.host.responses, [{
            generation: 7, id: 'rpc-command-1', result: { decision: 'cancel' }
        }]);
        assert.equal(fixture.host.leases[0].releases, 1);
    });

    it('makes rescheduled TTL callbacks inert after context, broker, and process cleanup', async () => {
        for (const ending of ['context', 'broker', 'process'] as const) {
            const fixture = createFixture();
            await fixture.session.setContext(CONTEXT);
            await fixture.broker.handleServerRequest(
                commandRequest({}, `rescheduled-cleanup-${ending}`), CONTEXT.generation
            );
            const card = fixture.client.latest()[0];
            fixture.clock.now = card.expiresAt - 1;
            fixture.clock.callbacks[0]();
            await flushAsync();
            const lateCallbacks = [...fixture.clock.callbacks];

            if (ending === 'context') {
                await fixture.session.disposeContext();
            } else if (ending === 'broker') {
                await fixture.broker.dispose();
            } else {
                fixture.host.emitState('circuit-open', CONTEXT.generation);
                await flushAsync();
            }

            fixture.clock.now = card.expiresAt + 1;
            lateCallbacks.forEach(callback => callback());
            await flushAsync();
            assert.deepEqual(fixture.host.responses, ending === 'process' ? [] : [{
                generation: 7,
                id: `rescheduled-cleanup-${ending}`,
                result: { decision: 'cancel' }
            }], ending);
            assert.equal(fixture.host.leases[0].releases, 1, ending);
            assert.equal(fixture.client.latest().length, 0, ending);
            assert.deepEqual(await fixture.session.decide({
                token: card.token, fingerprint: card.fingerprint, decision: 'accept'
            }), { status: 'rejected', code: 'stale-approval' }, ending);
            await fixture.broker.dispose();
        }
    });

    it('enforces the hard TTL at expiresAt - 1, expiresAt, and expiresAt + 1 despite delayed timers', async () => {
        for (const offset of [-1, 0, 1]) {
            const fixture = createFixture();
            await fixture.session.setContext(CONTEXT);
            await fixture.broker.handleServerRequest(
                commandRequest({}, `ttl-${offset}`), CONTEXT.generation
            );
            const card = fixture.client.latest()[0];
            const lateTimer = fixture.clock.callbacks[0];
            assert.ok(lateTimer);
            fixture.clock.now = card.expiresAt + offset;

            assert.deepEqual(await fixture.session.decide({
                token: card.token, fingerprint: card.fingerprint, decision: 'accept'
            }), { status: 'responded' });
            assert.deepEqual(fixture.host.responses, [{
                generation: 7,
                id: `ttl-${offset}`,
                result: { decision: offset < 0 ? 'accept' : 'cancel' }
            }], `offset ${offset}`);
            assert.equal(fixture.host.leases[0].releases, 1, `offset ${offset}`);
            assert.equal(fixture.client.latest().length, 0, `offset ${offset}`);

            lateTimer();
            await flushAsync();
            assert.equal(fixture.host.responses.length, 1, `late callback at offset ${offset}`);
            assert.equal(fixture.host.leases[0].releases, 1, `late callback at offset ${offset}`);
            await fixture.broker.dispose();
        }
    });

    it('fails closed once when the decision clock rolls backward, is invalid, or throws', async () => {
        const cases: ReadonlyArray<Readonly<{
            name: string;
            decideNow: () => number;
        }>> = [
            { name: 'rollback', decideNow: () => 999 },
            { name: 'NaN', decideNow: () => Number.NaN },
            { name: 'fractional', decideNow: () => 1_000.5 },
            { name: 'infinite', decideNow: () => Number.POSITIVE_INFINITY },
            { name: 'throwing', decideNow: () => { throw new Error('clock failure'); } }
        ];
        for (const entry of cases) {
            let deciding = false;
            const fixture = createFixture({ now: () => deciding ? entry.decideNow() : 1_000 });
            await fixture.session.setContext(CONTEXT);
            await fixture.broker.handleServerRequest(
                commandRequest({}, `clock-${entry.name}`), CONTEXT.generation
            );
            const card = fixture.client.latest()[0];
            const lateTimer = fixture.clock.callbacks[0];
            deciding = true;

            assert.deepEqual(await fixture.session.decide({
                token: card.token, fingerprint: card.fingerprint, decision: 'accept'
            }), { status: 'responded' }, entry.name);
            assert.deepEqual(fixture.host.responses, [{
                generation: 7,
                id: `clock-${entry.name}`,
                result: { decision: 'decline' }
            }], entry.name);
            assert.equal(fixture.host.leases[0].releases, 1, entry.name);
            lateTimer();
            await flushAsync();
            assert.equal(fixture.host.responses.length, 1, entry.name);
            assert.equal(fixture.host.leases[0].releases, 1, entry.name);
            await fixture.broker.dispose();
        }
    });

    it('reauthorizes after delayed file-scope and realpath settlement for every owner and host race', async () => {
        const races = [
            'context-switch', 'disconnect', 'broker-dispose', 'process-exit', 'restart', 'request-lost'
        ] as const;
        for (const stage of ['scope', 'realpath'] as const) {
            for (const outcome of ['resolve', 'reject'] as const) {
                for (const race of races) {
                    const deferred = new Deferred<RideCodexApprovalScopeResolution | string>();
                    let entered = false;
                    let realPathCalls = 0;
                    const fixture = createFixture({
                        resolveFileScope: stage === 'scope'
                            ? async () => {
                                entered = true;
                                return deferred.promise as Promise<RideCodexApprovalScopeResolution>;
                            }
                            : async () => resolution([{ path: 'src\\pending.ts', kind: 'update' }]),
                        resolveRealPath: stage === 'realpath'
                            ? async path => {
                                realPathCalls += 1;
                                if (realPathCalls === 1) {
                                    entered = true;
                                    return deferred.promise as Promise<string>;
                                }
                                return path;
                            }
                            : async path => path
                    });
                    await fixture.session.setContext(CONTEXT);
                    const id = `${stage}-${outcome}-${race}`;
                    const operation = fixture.broker.handleServerRequest(fileRequest({}, id), CONTEXT.generation);
                    await waitForAsync(() => entered);

                    if (race === 'context-switch') {
                        await fixture.session.setContext({ ...CONTEXT, turnId: 'turn-after-race' });
                    } else if (race === 'disconnect') {
                        fixture.session.dispose();
                        await flushAsync();
                    } else if (race === 'broker-dispose') {
                        await fixture.broker.dispose();
                    } else if (race === 'process-exit') {
                        fixture.host.emitState('circuit-open', CONTEXT.generation);
                    } else if (race === 'restart') {
                        fixture.host.emitState('ready', CONTEXT.generation + 1);
                    } else {
                        fixture.host.requestOwnership = false;
                    }

                    if (race !== 'request-lost') {
                        assert.ok(fixture.client.states.every(state => state.length === 0),
                            `${id} before late settlement`);
                        assert.equal(fixture.clock.timers.size, 0, `${id} before late settlement`);
                        assert.equal(fixture.host.leases[0].releases, 1,
                            `${id} before late settlement`);
                        if (race === 'context-switch' || race === 'disconnect' || race === 'broker-dispose') {
                            assert.deepEqual(fixture.host.responses, [{
                                generation: 7, id, result: { decision: 'cancel' }
                            }], `${id} before late settlement`);
                        } else {
                            assert.deepEqual(fixture.host.responses, [], `${id} before late settlement`);
                        }
                    }

                    if (outcome === 'reject') {
                        deferred.reject(new Error('late scope failure'));
                    } else if (stage === 'scope') {
                        deferred.resolve(resolution([{ path: 'src\\pending.ts', kind: 'update' }]));
                    } else {
                        deferred.resolve('C:\\workspace');
                    }
                    await assert.doesNotReject(operation, id);

                    assert.ok(fixture.client.states.every(state => state.length === 0), id);
                    assert.equal(fixture.clock.timers.size, 0, id);
                    assert.equal(fixture.host.leases[0].releases, 1, id);
                    if (race === 'process-exit' || race === 'restart' || race === 'request-lost') {
                        assert.deepEqual(fixture.host.responses, [], id);
                    } else {
                        assert.deepEqual(fixture.host.responses, [{
                            generation: 7, id, result: { decision: 'cancel' }
                        }], id);
                    }
                    await fixture.broker.dispose();
                }
            }
        }
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
