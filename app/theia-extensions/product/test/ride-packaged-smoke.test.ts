/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import {
    RidePackagedSmokeActions,
    RidePackagedSmokeContribution,
    RidePackagedSmokeProtocol,
    RideSmokeAction,
    RideSmokeCompleteRequest,
    RideSmokePlan,
    RideSmokeStepRequest,
    RideTauriPackagedSmokeProtocol
} from '../src/browser/ride-packaged-smoke';
import { RidePackagedSmokeActionService } from '../src/browser/ride-packaged-smoke-actions';

const PROOF = 'b'.repeat(64);
const PROTOCOL_DIAGNOSTIC = { code: 'protocol-failed', message: 'Smoke protocol failed.' } as const;
const FULL_ACTIONS: readonly RideSmokeAction[] = [
    'editor-save',
    'terminal-sentinel',
    'workspace-search',
    'scm-status',
    'packaged-plugin-command',
    'secondary-window',
    'second-file-forwarding'
];
const EMPTY_ACTIONS: readonly RideSmokeAction[] = ['terminal-sentinel', 'packaged-plugin-command'];

interface ProtocolCall {
    readonly method: 'plan' | 'recordStep' | 'complete';
    readonly proof?: string;
    readonly request?: unknown;
}

function smokePlan(actions: RideSmokeAction[]): RideSmokePlan {
    return {
        specSha256: 'a'.repeat(64),
        scenario: 'full-file',
        profile: 'full',
        workspace: 'workspace',
        files: ['first.txt', 'second.txt'],
        actions,
        actionTimeoutMs: 1_000
    };
}

function activePlan(actions: RideSmokeAction[]): unknown {
    return {
        mode: 'active',
        plan: smokePlan(actions),
        sessionProof: PROOF,
        diagnostic: null
    };
}

function criticalEmptyPlan(): RideSmokePlan {
    return {
        ...smokePlan([...EMPTY_ACTIONS]),
        scenario: 'critical-empty',
        profile: 'tauri-critical',
        files: []
    };
}

function backendRetryPlan(): RideSmokePlan {
    return {
        ...smokePlan(['backend-retry']),
        scenario: 'backend-retry',
        profile: 'tauri-critical',
        files: []
    };
}

function activeCriticalEmptyPlan(): unknown {
    return {
        mode: 'active',
        plan: criticalEmptyPlan(),
        sessionProof: PROOF,
        diagnostic: null
    };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

function deferredValue<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

function deferredOutcome<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt++) {
        if (predicate()) {
            return;
        }
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.fail(message);
}

function manualTimers(): {
    readonly setTimeout: (callback: () => void, timeoutMs: number) => unknown;
    readonly clearTimeout: (handle: unknown) => void;
    readonly pending: () => number;
    advanceTo(timeMs: number): Promise<void>;
} {
    let now = 0;
    let order = 0;
    const timers = new Map<object, { readonly callback: () => void; readonly due: number; readonly order: number }>();
    return {
        setTimeout: (callback, timeoutMs) => {
            const handle = {};
            timers.set(handle, { callback, due: now + timeoutMs, order: order++ });
            return handle;
        },
        clearTimeout: handle => {
            timers.delete(handle as object);
        },
        pending: () => timers.size,
        advanceTo: async timeMs => {
            assert.ok(timeMs >= now, 'manual time cannot move backwards');
            while (true) {
                await new Promise<void>(resolve => setImmediate(resolve));
                const next = [...timers.entries()]
                    .filter(([, timer]) => timer.due <= timeMs)
                    .sort((left, right) => left[1].due - right[1].due || left[1].order - right[1].order)[0];
                if (!next) {
                    now = timeMs;
                    await new Promise<void>(resolve => setImmediate(resolve));
                    return;
                }
                now = next[1].due;
                timers.delete(next[0]);
                next[1].callback();
            }
        }
    };
}

class FakeProtocol implements RidePackagedSmokeProtocol {
    readonly calls: ProtocolCall[] = [];

    constructor(
        readonly tauri: boolean,
        protected readonly planResponse: unknown,
        protected readonly update: (method: 'recordStep' | 'complete', request: unknown) => unknown = method => ({
            status: method === 'complete' ? 'completed' : 'recorded',
            diagnostic: null
        })
    ) { }

    isTauri(): boolean {
        return this.tauri;
    }

    async plan(): Promise<unknown> {
        this.calls.push({ method: 'plan' });
        if (this.planResponse instanceof Error) {
            throw this.planResponse;
        }
        return this.planResponse;
    }

    async recordStep(sessionProof: string, request: unknown): Promise<unknown> {
        this.calls.push({ method: 'recordStep', proof: sessionProof, request });
        return this.update('recordStep', request);
    }

    async complete(sessionProof: string, request: unknown): Promise<unknown> {
        this.calls.push({ method: 'complete', proof: sessionProof, request });
        return this.update('complete', request);
    }
}

class ReplayAwareProtocol implements RidePackagedSmokeProtocol {
    readonly calls: ProtocolCall[] = [];
    readonly transitions: RideSmokeStepRequest[] = [];
    completion: RideSmokeCompleteRequest | undefined;
    protected lastTransition: RideSmokeStepRequest | undefined;
    protected pending: RideSmokeAction | undefined;
    protected nextAction = 0;
    protected actionFailed = false;

    constructor(
        protected readonly plannedActions: RideSmokeAction[],
        protected readonly dropFirstResponses: Set<'started' | 'passed' | 'failed' | 'complete'>
    ) { }

    isTauri(): boolean {
        return true;
    }

    async plan(): Promise<unknown> {
        this.calls.push({ method: 'plan' });
        return activePlan(this.plannedActions);
    }

    async recordStep(sessionProof: string, request: RideSmokeStepRequest): Promise<unknown> {
        this.calls.push({ method: 'recordStep', proof: sessionProof, request });
        if (!this.sameRequest(this.lastTransition, request)) {
            this.applyTransition(request);
            this.lastTransition = request;
            this.transitions.push(request);
            if (this.dropFirstResponses.delete(request.state)) {
                throw new Error('response lost after transition commit');
            }
        }
        return { status: 'recorded', diagnostic: null };
    }

    async complete(sessionProof: string, request: RideSmokeCompleteRequest): Promise<unknown> {
        this.calls.push({ method: 'complete', proof: sessionProof, request });
        if (this.completion !== undefined) {
            if (!this.sameRequest(this.completion, request)) {
                throw new Error('different request after terminal');
            }
            return { status: 'completed', diagnostic: null };
        }
        if (this.pending !== undefined
            || (request.status === 'passed' && (this.actionFailed || this.nextAction !== this.plannedActions.length))
            || (request.status === 'failed' && !this.actionFailed)) {
            throw new Error('illegal terminal request');
        }
        this.completion = request;
        if (this.dropFirstResponses.delete('complete')) {
            throw new Error('response lost after completion commit');
        }
        return { status: 'completed', diagnostic: null };
    }

    protected applyTransition(request: RideSmokeStepRequest): void {
        if (this.completion !== undefined) {
            throw new Error('transition after terminal');
        }
        if (request.state === 'started') {
            if (this.pending !== undefined || this.plannedActions[this.nextAction] !== request.action) {
                throw new Error('illegal started transition');
            }
            this.pending = request.action;
            return;
        }
        if (this.pending !== request.action) {
            throw new Error('illegal terminal transition');
        }
        this.pending = undefined;
        if (request.state === 'passed') {
            this.nextAction++;
        } else {
            this.actionFailed = true;
        }
    }

    protected sameRequest(
        first: RideSmokeStepRequest | RideSmokeCompleteRequest | undefined,
        second: RideSmokeStepRequest | RideSmokeCompleteRequest
    ): boolean {
        return first !== undefined && JSON.stringify(first) === JSON.stringify(second);
    }
}

class AmbiguousFailedRecordProtocol extends ReplayAwareProtocol {
    constructor(protected readonly applyFailedTransition: boolean) {
        super([...FULL_ACTIONS], new Set());
    }

    override async recordStep(sessionProof: string, request: RideSmokeStepRequest): Promise<unknown> {
        if (request.state !== 'failed') {
            return super.recordStep(sessionProof, request);
        }
        this.calls.push({ method: 'recordStep', proof: sessionProof, request });
        if (this.applyFailedTransition && !this.transitions.some(transition => transition.state === 'failed')) {
            this.applyTransition(request);
            this.lastTransition = request;
            this.transitions.push(request);
        }
        throw new Error('failed response lost with private details');
    }
}

function actions(
    calls: string[],
    overrides: Partial<RidePackagedSmokeActions> = {}
): RidePackagedSmokeActions {
    const action = (name: string) => async (_plan: RideSmokePlan): Promise<void> => {
        calls.push(name);
    };
    return {
        editorSave: action('editor-save'),
        terminalSentinel: action('terminal-sentinel'),
        workspaceSearch: action('workspace-search'),
        scmStatus: action('scm-status'),
        packagedPluginCommand: action('packaged-plugin-command'),
        secondaryWindow: action('secondary-window'),
        backendRetry: action('backend-retry'),
        prepareSecondFile: () => ({ dispose: () => undefined }),
        waitForSecondFile: action('second-file-forwarding'),
        ...overrides
    };
}

function forwardingActions(service: RidePackagedSmokeActionService): RidePackagedSmokeActions {
    return {
        ...actions([]),
        prepareSecondFile: plan => service.prepareSecondFile(plan),
        waitForSecondFile: plan => service.waitForSecondFile(plan)
    };
}

function immediateState(): FrontendApplicationStateService {
    return {
        reachedState: async (state: string) => {
            assert.equal(state, 'attached_shell');
        }
    } as unknown as FrontendApplicationStateService;
}

test('packaged smoke waits for attached_shell before querying the protocol', async () => {
    const shell = deferred();
    const reachedStates: string[] = [];
    const protocol = new FakeProtocol(true, { mode: 'disabled', plan: null, sessionProof: null, diagnostic: null });
    const contribution = new RidePackagedSmokeContribution(
        {
            reachedState: (state: string) => {
                reachedStates.push(state);
                return shell.promise;
            }
        } as unknown as FrontendApplicationStateService,
        protocol,
        () => actions([])
    );

    contribution.onStart();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(reachedStates, ['attached_shell']);
    assert.deepEqual(protocol.calls, []);

    shell.resolve();
    await waitUntil(() => protocol.calls.length === 1, 'the smoke plan was not queried after shell attachment');
    assert.deepEqual(protocol.calls, [{ method: 'plan' }]);
});

test('packaged smoke is inert outside Tauri and never resolves actions', async () => {
    const protocol = new FakeProtocol(false, activePlan([...FULL_ACTIONS]));
    let actionResolutions = 0;
    const contribution = new RidePackagedSmokeContribution(immediateState(), protocol, () => {
        actionResolutions++;
        return actions([]);
    });

    contribution.onStart();
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.deepEqual(protocol.calls, []);
    assert.equal(actionResolutions, 0);
});

test('packaged smoke disabled and rejected modes never resolve actions', async () => {
    for (const mode of ['disabled', 'rejected'] as const) {
        const protocol = new FakeProtocol(true, {
            mode,
            plan: null,
            sessionProof: null,
            diagnostic: mode === 'rejected'
                ? { code: 'protocol-failed', message: 'Smoke protocol failed.' }
                : null
        });
        let actionResolutions = 0;
        const contribution = new RidePackagedSmokeContribution(immediateState(), protocol, () => {
            actionResolutions++;
            return actions([]);
        });

        contribution.onStart();
        await waitUntil(() => protocol.calls.length === 1, `${mode} plan was not queried`);

        assert.equal(actionResolutions, 0, `${mode} must not resolve actions`);
        assert.deepEqual(protocol.calls, [{ method: 'plan' }]);
    }
});

test('packaged smoke executes exact plan order and records proof-carrying transitions', async () => {
    const orderedActions: RideSmokeAction[] = [
        'editor-save',
        'terminal-sentinel',
        'workspace-search',
        'scm-status',
        'packaged-plugin-command',
        'secondary-window',
        'second-file-forwarding'
    ];
    const protocol = new FakeProtocol(true, activePlan(orderedActions));
    const actionCalls: string[] = [];
    let actionResolutions = 0;
    let now = 10;
    const contribution = new RidePackagedSmokeContribution(
        immediateState(),
        protocol,
        () => {
            actionResolutions++;
            return actions(actionCalls);
        },
        { now: () => now++ }
    );

    contribution.onStart();
    await waitUntil(() => protocol.calls.some(call => call.method === 'complete'), 'smoke did not complete');

    assert.equal(actionResolutions, 1);
    assert.deepEqual(actionCalls, orderedActions);
    const updateCalls = protocol.calls.filter(call => call.method !== 'plan');
    assert.equal(updateCalls.length, orderedActions.length * 2 + 1);
    for (let index = 0; index < orderedActions.length; index++) {
        assert.deepEqual(updateCalls[index * 2], {
            method: 'recordStep',
            proof: PROOF,
            request: {
                action: orderedActions[index],
                state: 'started',
                durationMs: index * 2,
                diagnostic: null
            }
        });
        assert.deepEqual(updateCalls[index * 2 + 1], {
            method: 'recordStep',
            proof: PROOF,
            request: {
                action: orderedActions[index],
                state: 'passed',
                durationMs: index * 2 + 1,
                diagnostic: null
            }
        });
    }
    assert.deepEqual(updateCalls[updateCalls.length - 1], {
        method: 'complete',
        proof: PROOF,
        request: {
            status: 'passed',
            failurePhase: null,
            durationMs: orderedActions.length * 2,
            diagnostic: null
        }
    });
});

test('packaged smoke arms second-file observation before started becomes externally visible', async () => {
    const listeners = new Set<(event: { source: 'singleInstance'; relativePath: string }) => void>();
    const actionTimers: Array<{ callback: () => void; cleared: boolean }> = [];
    let subscriptionDisposals = 0;
    const smokeActions = new RidePackagedSmokeActionService({
        openRequests: {
            onDidOpenRequest: listener => {
                listeners.add(listener);
                return {
                    dispose: () => {
                        if (listeners.delete(listener)) {
                            subscriptionDisposals++;
                        }
                    }
                };
            }
        },
        setTimeout: callback => {
            const timer = { callback, cleared: false };
            actionTimers.push(timer);
            return timer;
        },
        clearTimeout: handle => {
            (handle as { cleared: boolean }).cleared = true;
        }
    });
    const protocol = new FakeProtocol(true, activePlan([...FULL_ACTIONS]), (method, request) => {
        if (method === 'recordStep'
            && (request as RideSmokeStepRequest).action === 'second-file-forwarding'
            && (request as RideSmokeStepRequest).state === 'started') {
            for (const listener of [...listeners]) {
                listener({ source: 'singleInstance', relativePath: 'second.txt' });
            }
        }
        return { status: method === 'complete' ? 'completed' : 'recorded', diagnostic: null };
    });
    new RidePackagedSmokeContribution(immediateState(), protocol, () => forwardingActions(smokeActions)).onStart();

    await waitUntil(() => actionTimers.length > 0, 'forwarding action did not begin waiting');
    await new Promise<void>(resolve => setImmediate(resolve));
    if (!protocol.calls.some(call => call.method === 'complete')) {
        actionTimers.find(timer => !timer.cleared)?.callback();
    }
    await waitUntil(() => protocol.calls.some(call => call.method === 'complete'), 'forwarding race did not complete');

    assert.deepEqual(protocol.calls.filter(call => call.method === 'recordStep'
        && (call.request as RideSmokeStepRequest).action === 'second-file-forwarding')
        .map(call => (call.request as RideSmokeStepRequest).state), ['started', 'passed']);
    assert.equal((protocol.calls.find(call => call.method === 'complete')
        ?.request as RideSmokeCompleteRequest).status, 'passed');
    assert.equal(subscriptionDisposals, 1);
});

test('packaged smoke releases a prepared second-file observer when started cannot be recorded', async () => {
    let preparationDisposals = 0;
    let actionExecutions = 0;
    const preparedActions = {
        ...actions([], {
            waitForSecondFile: async () => {
                actionExecutions++;
            }
        }),
        prepareSecondFile: () => ({
            dispose: () => preparationDisposals++
        })
    } as RidePackagedSmokeActions;
    const protocol = new FakeProtocol(true, activePlan([...FULL_ACTIONS]), (method, request) => ({
        status: method === 'recordStep'
            && (request as RideSmokeStepRequest).action === 'second-file-forwarding'
            ? 'invalid'
            : method === 'complete' ? 'completed' : 'recorded',
        diagnostic: null
    }));
    new RidePackagedSmokeContribution(immediateState(), protocol, () => preparedActions).onStart();

    await waitUntil(() => protocol.calls.filter(call => call.method === 'recordStep'
        && (call.request as RideSmokeStepRequest).action === 'second-file-forwarding').length === 2,
        'started transition was not retried');
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(actionExecutions, 0);
    assert.equal(preparationDisposals, 1);
    assert.equal(protocol.calls.some(call => call.method === 'complete'), false);
});

test('packaged smoke releases a prepared second-file observer after action failure', async () => {
    let preparationDisposals = 0;
    const preparedActions = {
        ...actions([], {
            waitForSecondFile: async () => {
                throw new Error('forwarding failed');
            }
        }),
        prepareSecondFile: () => ({
            dispose: () => preparationDisposals++
        })
    } as RidePackagedSmokeActions;
    const protocol = new FakeProtocol(true, activePlan([...FULL_ACTIONS]));
    new RidePackagedSmokeContribution(immediateState(), protocol, () => preparedActions).onStart();

    await waitUntil(() => protocol.calls.some(call => call.method === 'complete'),
        'failed forwarding action did not complete');

    assert.equal(preparationDisposals, 1);
    assert.equal((protocol.calls.find(call => call.method === 'complete')
        ?.request as RideSmokeCompleteRequest).status, 'failed');
});

test('packaged smoke dispose releases a prepared second-file observer while started is in flight', async () => {
    const startedResponse = deferredValue<unknown>();
    let preparationDisposals = 0;
    const preparedActions = {
        ...actions([], {
            waitForSecondFile: async () => {
                throw new Error('disposed forwarding action');
            }
        }),
        prepareSecondFile: () => ({
            dispose: () => preparationDisposals++
        })
    } as RidePackagedSmokeActions;
    const protocol = new FakeProtocol(true, activePlan([...FULL_ACTIONS]), (method, request) => {
        if (method === 'recordStep'
            && (request as RideSmokeStepRequest).action === 'second-file-forwarding'
            && (request as RideSmokeStepRequest).state === 'started') {
            return startedResponse.promise;
        }
        return { status: method === 'complete' ? 'completed' : 'recorded', diagnostic: null };
    });
    const contribution = new RidePackagedSmokeContribution(immediateState(), protocol, () => preparedActions);
    contribution.onStart();
    await waitUntil(() => protocol.calls.some(call => call.method === 'recordStep'
        && (call.request as RideSmokeStepRequest).action === 'second-file-forwarding'),
        'started transition did not begin');

    contribution.dispose();
    startedResponse.resolve({ status: 'recorded', diagnostic: null });
    await waitUntil(() => protocol.calls.some(call => call.method === 'complete'),
        'disposed forwarding action did not complete');

    assert.equal(preparationDisposals, 1);
});

test('packaged smoke fails fast with one bounded action failure and never reports passed', async () => {
    const protocol = new FakeProtocol(true, activePlan([...FULL_ACTIONS]));
    const actionCalls: string[] = [];
    const unsafeError = new Error('C:\\secret\\workspace token=very-secret --dangerous-command');
    const contribution = new RidePackagedSmokeContribution(
        immediateState(),
        protocol,
        () => actions(actionCalls, {
            editorSave: async () => {
                actionCalls.push('editor-save');
                throw unsafeError;
            }
        }),
        { now: (() => { let now = 0; return () => now++; })() }
    );

    contribution.onStart();
    await waitUntil(() => protocol.calls.some(call => call.method === 'complete'), 'failure was not completed');

    assert.deepEqual(actionCalls, ['editor-save']);
    const serialized = JSON.stringify(protocol.calls);
    assert.doesNotMatch(serialized, /secret|workspace token|dangerous-command/i);
    assert.deepEqual(protocol.calls.filter(call => call.method !== 'plan'), [
        {
            method: 'recordStep', proof: PROOF, request: {
                action: 'editor-save', state: 'started', durationMs: 0, diagnostic: null
            }
        },
        {
            method: 'recordStep', proof: PROOF, request: {
                action: 'editor-save', state: 'failed', durationMs: 1,
                diagnostic: { code: 'action-failed', message: 'Smoke action failed.' }
            }
        },
        {
            method: 'complete', proof: PROOF, request: {
                status: 'failed', failurePhase: 'action', durationMs: 2,
                diagnostic: { code: 'action-failed', message: 'Smoke action failed.' }
            }
        }
    ]);
    assert.equal(serialized.includes('"status":"passed"'), false);
});

test('packaged smoke reports a bounded timeout and does not await the stuck action forever', async () => {
    const protocol = new FakeProtocol(true, activePlan([...FULL_ACTIONS]));
    const timers: Array<() => void> = [];
    const contribution = new RidePackagedSmokeContribution(
        immediateState(),
        protocol,
        () => actions([], { editorSave: () => new Promise<void>(() => undefined) }),
        {
            now: (() => { let now = 0; return () => now++; })(),
            setTimeout: (callback: () => void) => {
                timers.push(callback);
                queueMicrotask(callback);
                return callback;
            },
            clearTimeout: () => undefined
        }
    );

    contribution.onStart();
    await waitUntil(() => protocol.calls.some(call => call.method === 'complete'), 'timeout was not completed');

    assert.equal(timers.length, 1);
    const serialized = JSON.stringify(protocol.calls);
    assert.match(serialized, /action-timeout/);
    assert.doesNotMatch(serialized, /status":"passed/);
});

test('packaged smoke recognizes production action timeout and cancels forwarding without late effects', async () => {
    const actionClock = manualTimers();
    const sequencerClock = manualTimers();
    const listeners = new Set<(event: { source: 'singleInstance'; relativePath: string }) => void>();
    let subscriptionDisposals = 0;
    const smokeActions = new RidePackagedSmokeActionService({
        openRequests: {
            onDidOpenRequest: listener => {
                listeners.add(listener);
                return {
                    dispose: () => {
                        if (listeners.delete(listener)) {
                            subscriptionDisposals++;
                        }
                    }
                };
            }
        },
        setTimeout: actionClock.setTimeout,
        clearTimeout: actionClock.clearTimeout
    });
    const protocol = new FakeProtocol(true, activePlan([...FULL_ACTIONS]));
    new RidePackagedSmokeContribution(
        immediateState(),
        protocol,
        () => forwardingActions(smokeActions),
        { setTimeout: sequencerClock.setTimeout, clearTimeout: sequencerClock.clearTimeout }
    ).onStart();

    await waitUntil(() => actionClock.pending() === 1 && listeners.size === 1,
        'forwarding action did not install its timeout and observer');
    await actionClock.advanceTo(1_000);
    await waitUntil(() => protocol.calls.some(call => call.method === 'complete'),
        'production timeout did not complete');

    const failed = protocol.calls.find(call => call.method === 'recordStep'
        && (call.request as RideSmokeStepRequest).state === 'failed')?.request as RideSmokeStepRequest;
    assert.equal(failed.diagnostic?.code, 'action-timeout');
    assert.equal(subscriptionDisposals, 1);
    assert.equal(listeners.size, 0);
    assert.equal(actionClock.pending(), 0);
    assert.equal(sequencerClock.pending(), 0);

    const callsAfterTimeout = protocol.calls.length;
    await actionClock.advanceTo(2_000);
    await sequencerClock.advanceTo(2_000);
    assert.equal(protocol.calls.length, callsAfterTimeout);
});

test('packaged smoke contains timer setup and cleanup failures and consumes late action rejection', async () => {
    for (const timerFailure of ['set', 'clear', 'late-reject'] as const) {
        const protocol = new FakeProtocol(true, activePlan([...FULL_ACTIONS]));
        const operation = deferredOutcome<void>();
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown) => unhandled.push(error);
        process.on('unhandledRejection', onUnhandled);
        try {
            const contribution = new RidePackagedSmokeContribution(
                immediateState(), protocol, () => actions([], { editorSave: () => operation.promise }),
                {
                    now: (() => { let now = 0; return () => now++; })(),
                    setTimeout: callback => {
                        if (timerFailure === 'set') {
                            throw new Error('timer setup failed with private details');
                        }
                        if (timerFailure === 'late-reject') {
                            queueMicrotask(callback);
                        } else {
                            queueMicrotask(() => operation.resolve());
                        }
                        return callback;
                    },
                    clearTimeout: () => {
                        if (timerFailure === 'clear') {
                            throw new Error('timer cleanup failed with private details');
                        }
                    }
                }
            );

            contribution.onStart();
            await waitUntil(() => protocol.calls.some(call => call.method === 'complete'),
                `${timerFailure} did not settle the smoke sequence`);
            if (timerFailure !== 'clear') {
                operation.reject(new Error('late action rejection with private details'));
            }
            await new Promise<void>(resolve => setImmediate(resolve));

            assert.deepEqual(unhandled, []);
            const completion = protocol.calls.find(call => call.method === 'complete')
                ?.request as RideSmokeCompleteRequest;
            assert.equal(completion.status, 'failed');
            assert.equal(completion.failurePhase, 'action');
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    }
});

test('packaged smoke safely contains malformed, rejected, and failed IPC responses', async () => {
    const malformed = new FakeProtocol(true, {
        mode: 'active',
        plan: { ...smokePlan([...FULL_ACTIONS]), actions: ['unknown-action'] },
        sessionProof: PROOF,
        diagnostic: null
    });
    let malformedActionResolutions = 0;
    new RidePackagedSmokeContribution(immediateState(), malformed, () => {
        malformedActionResolutions++;
        return actions([]);
    }, { now: () => 0 }).onStart();
    await waitUntil(() => malformed.calls.some(call => call.method === 'complete'), 'malformed plan was not rejected');
    assert.equal(malformedActionResolutions, 0);
    assert.deepEqual(malformed.calls[malformed.calls.length - 1], {
        method: 'complete', proof: PROOF, request: {
            status: 'failed', failurePhase: 'protocol', durationMs: 0,
            diagnostic: { code: 'protocol-failed', message: 'Smoke protocol failed.' }
        }
    });

    const rejectedUpdate = new FakeProtocol(true, activePlan([...FULL_ACTIONS]), method => ({
        status: method === 'recordStep' ? 'rejected' : 'completed',
        diagnostic: { code: 'protocol-failed', message: 'Smoke protocol failed.' }
    }));
    let rejectedActionCalls = 0;
    new RidePackagedSmokeContribution(immediateState(), rejectedUpdate, () => actions([], {
        editorSave: async () => { rejectedActionCalls++; }
    }), { now: () => 0 }).onStart();
    await waitUntil(() => rejectedUpdate.calls.filter(call => call.method === 'recordStep').length === 2,
        'step was not retried once');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(rejectedActionCalls, 0);
    const rejectedRecords = rejectedUpdate.calls.filter(call => call.method === 'recordStep');
    assert.equal(rejectedRecords.length, 2);
    assert.strictEqual(rejectedRecords[0].request, rejectedRecords[1].request);
    assert.equal(rejectedUpdate.calls.some(call => call.method === 'complete'), false);

    const failedPlan = new FakeProtocol(true, new Error('IPC failure with secret path C:\\private'));
    new RidePackagedSmokeContribution(immediateState(), failedPlan, () => actions([])).onStart();
    await waitUntil(() => failedPlan.calls.length === 1, 'failed plan IPC was not attempted');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(failedPlan.calls, [{ method: 'plan' }]);
});

test('packaged smoke binds active plans to the exact cross-language scenario matrix before resolving actions', async () => {
    const validPlans: RideSmokePlan[] = [
        { ...smokePlan([...FULL_ACTIONS]), scenario: 'critical-file', profile: 'tauri-critical' },
        { ...smokePlan([...EMPTY_ACTIONS]), scenario: 'critical-empty', profile: 'tauri-critical', files: [] },
        { ...smokePlan([...FULL_ACTIONS]), scenario: 'full-file', profile: 'full' },
        backendRetryPlan()
    ];
    for (const plan of validPlans) {
        let actionResolutions = 0;
        const protocol = new FakeProtocol(true, {
            mode: 'active', plan, sessionProof: PROOF, diagnostic: null
        }, method => ({
            status: method === 'recordStep' ? 'rejected' : 'completed',
            diagnostic: method === 'recordStep' ? PROTOCOL_DIAGNOSTIC : null
        }));
        new RidePackagedSmokeContribution(immediateState(), protocol, () => {
            actionResolutions++;
            return actions([]);
        }).onStart();
        await waitUntil(() => protocol.calls.some(call => call.method === 'recordStep'),
            `valid ${plan.scenario} plan did not start`);
        assert.equal(actionResolutions, 1, `valid ${plan.scenario} plan was rejected`);
    }

    const base = validPlans[0];
    const mismatches: RideSmokePlan[] = [
        { ...base, profile: 'full' },
        { ...base, files: [] },
        { ...base, actions: [...EMPTY_ACTIONS] },
        { ...validPlans[1], profile: 'full' },
        { ...validPlans[1], files: ['first.txt', 'second.txt'] },
        { ...validPlans[1], actions: [...FULL_ACTIONS] },
        { ...validPlans[2], profile: 'tauri-critical' },
        { ...validPlans[2], files: [] },
        { ...validPlans[2], actions: [...EMPTY_ACTIONS] }
    ];
    for (const plan of mismatches) {
        let actionResolutions = 0;
        const protocol = new FakeProtocol(true, {
            mode: 'active', plan, sessionProof: PROOF, diagnostic: null
        });
        new RidePackagedSmokeContribution(immediateState(), protocol, () => {
            actionResolutions++;
            return actions([]);
        }, { now: () => 0 }).onStart();
        await waitUntil(() => protocol.calls.some(call => call.method === 'complete'),
            `mismatched ${plan.scenario} plan was not closed`);
        assert.equal(actionResolutions, 0, `mismatched ${plan.scenario} plan resolved actions`);
        assert.deepEqual(protocol.calls[protocol.calls.length - 1], {
            method: 'complete',
            proof: PROOF,
            request: {
                status: 'failed', failurePhase: 'protocol', durationMs: 0,
                diagnostic: PROTOCOL_DIAGNOSTIC
            }
        });
    }
});

test('packaged smoke rejects forwarding plans without exactly one expected second file', async () => {
    const base = activePlan([...FULL_ACTIONS]) as {
        mode: 'active';
        plan: RideSmokePlan;
        sessionProof: string;
        diagnostic: null;
    };
    for (const files of [
        ['startup.R'],
        ['startup.R', 'forwarded.R', 'unexpected.R']
    ]) {
        const protocol = new FakeProtocol(true, {
            ...base,
            plan: { ...base.plan, files }
        });
        let actionResolutions = 0;
        const contribution = new RidePackagedSmokeContribution(immediateState(), protocol, () => {
            actionResolutions++;
            return actions([]);
        });

        contribution.onStart();
        await waitUntil(() => protocol.calls.some(call => call.method === 'complete'), 'invalid forwarding plan was not rejected');

        assert.equal(actionResolutions, 0);
        assert.deepEqual(protocol.calls[protocol.calls.length - 1], {
            method: 'complete',
            proof: PROOF,
            request: {
                status: 'failed',
                failurePhase: 'protocol',
                durationMs: 0,
                diagnostic: PROTOCOL_DIAGNOSTIC
            }
        });
    }
});

test('packaged smoke retries response-loss mutations with the identical request and reaches a legal passed terminal', async () => {
    const actionCalls: string[] = [];
    const protocol = new ReplayAwareProtocol(
        [...FULL_ACTIONS], new Set(['started', 'passed', 'complete'])
    );
    const contribution = new RidePackagedSmokeContribution(
        immediateState(), protocol, () => actions(actionCalls),
        { now: (() => { let now = 0; return () => now++; })() }
    );

    contribution.onStart();
    await waitUntil(() => protocol.completion !== undefined, 'response-loss sequence did not reach terminal');

    assert.deepEqual(actionCalls, FULL_ACTIONS);
    assert.equal(protocol.transitions.length, FULL_ACTIONS.length * 2);
    assert.equal(protocol.completion?.status, 'passed');
    for (const state of ['started', 'passed'] as const) {
        const attempts = protocol.calls.filter(call => call.method === 'recordStep'
            && (call.request as RideSmokeStepRequest).action === 'editor-save'
            && (call.request as RideSmokeStepRequest).state === state);
        assert.equal(attempts.length, 2);
        assert.strictEqual(attempts[0].request, attempts[1].request);
    }
    const completions = protocol.calls.filter(call => call.method === 'complete');
    assert.equal(completions.length, 2);
    assert.strictEqual(completions[0].request, completions[1].request);
});

test('packaged smoke retries failed transition and failed completion response loss without duplicate state', async () => {
    let actionCalls = 0;
    const protocol = new ReplayAwareProtocol([...FULL_ACTIONS], new Set(['failed', 'complete']));
    const contribution = new RidePackagedSmokeContribution(
        immediateState(), protocol, () => actions([], {
            editorSave: async () => {
                actionCalls++;
                throw new Error('bounded action failure');
            }
        }),
        { now: (() => { let now = 0; return () => now++; })() }
    );

    contribution.onStart();
    await waitUntil(() => protocol.completion !== undefined, 'failed response-loss sequence did not reach terminal');

    assert.equal(actionCalls, 1);
    assert.deepEqual(protocol.transitions.map(transition => transition.state), ['started', 'failed']);
    assert.equal(protocol.completion?.status, 'failed');
    const failures = protocol.calls.filter(call => call.method === 'recordStep'
        && (call.request as RideSmokeStepRequest).state === 'failed');
    assert.equal(failures.length, 2);
    assert.strictEqual(failures[0].request, failures[1].request);
    const completions = protocol.calls.filter(call => call.method === 'complete');
    assert.equal(completions.length, 2);
    assert.strictEqual(completions[0].request, completions[1].request);
});

test('packaged smoke stops after two identical uncertain started, passed, or complete attempts', async () => {
    for (const failedMutation of ['started', 'passed', 'complete'] as const) {
        const actionCalls: string[] = [];
        const protocol = new FakeProtocol(true, failedMutation === 'complete'
            ? activeCriticalEmptyPlan()
            : activePlan([...FULL_ACTIONS]),
            (method, request) => {
                const state = (request as RideSmokeStepRequest).state;
                if ((method === 'recordStep' && state === failedMutation) || method === failedMutation) {
                    throw new Error('ambiguous mutation with private details');
                }
                return { status: method === 'complete' ? 'completed' : 'recorded', diagnostic: null };
            });
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown) => unhandled.push(error);
        process.on('unhandledRejection', onUnhandled);
        try {
            new RidePackagedSmokeContribution(
                immediateState(), protocol, () => actions(actionCalls, {
                    editorSave: async () => { actionCalls.push('editor-save'); }
                }), { now: () => 0 }
            ).onStart();
            await waitUntil(() => protocol.calls.filter(call => {
                if (failedMutation === 'complete') {
                    return call.method === 'complete';
                }
                return call.method === 'recordStep'
                    && (call.request as RideSmokeStepRequest).state === failedMutation;
            }).length === 2, `${failedMutation} was not attempted exactly twice`);
            await new Promise<void>(resolve => setImmediate(resolve));

            const failedCalls = protocol.calls.filter(call => failedMutation === 'complete'
                ? call.method === 'complete'
                : call.method === 'recordStep' && (call.request as RideSmokeStepRequest).state === failedMutation);
            assert.equal(failedCalls.length, 2);
            assert.strictEqual(failedCalls[0].request, failedCalls[1].request);
            const failedIndex = protocol.calls.indexOf(failedCalls[0]);
            assert.equal(protocol.calls.slice(failedIndex + 2).length, 0);
            assert.deepEqual(unhandled, []);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    }
});

test('packaged smoke completes after failed transition was applied but both responses were lost', async () => {
    const protocol = new AmbiguousFailedRecordProtocol(true);
    new RidePackagedSmokeContribution(
        immediateState(), protocol, () => actions([], {
            editorSave: async () => { throw new Error('bounded action failure'); }
        }), { now: () => 0 }
    ).onStart();
    await waitUntil(() => protocol.completion !== undefined, 'ambiguous applied failure did not reach terminal');

    const failedCalls = protocol.calls.filter(call => call.method === 'recordStep'
        && (call.request as RideSmokeStepRequest).state === 'failed');
    assert.equal(failedCalls.length, 2);
    assert.strictEqual(failedCalls[0].request, failedCalls[1].request);
    assert.deepEqual(protocol.transitions.map(transition => transition.state), ['started', 'failed']);
    assert.equal(protocol.completion?.status, 'failed');
    assert.equal(protocol.calls.filter(call => call.method === 'complete').length, 1);
});

test('packaged smoke bounds failed completion attempts when failed transition was never applied', async () => {
    const protocol = new AmbiguousFailedRecordProtocol(false);
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
        new RidePackagedSmokeContribution(
            immediateState(), protocol, () => actions([], {
                editorSave: async () => { throw new Error('bounded action failure'); }
            }), { now: () => 0 }
        ).onStart();
        await waitUntil(() => protocol.calls.filter(call => call.method === 'complete').length === 2,
            'unapplied failed transition did not attempt bounded completion');
        await new Promise<void>(resolve => setImmediate(resolve));

        const failedCalls = protocol.calls.filter(call => call.method === 'recordStep'
            && (call.request as RideSmokeStepRequest).state === 'failed');
        const completions = protocol.calls.filter(call => call.method === 'complete');
        assert.equal(failedCalls.length, 2);
        assert.strictEqual(failedCalls[0].request, failedCalls[1].request);
        assert.equal(completions.length, 2);
        assert.strictEqual(completions[0].request, completions[1].request);
        assert.equal(protocol.completion, undefined);
        assert.deepEqual(protocol.transitions.map(transition => transition.state), ['started']);
        assert.deepEqual(unhandled, []);
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
});

test('packaged smoke rejects untrusted proof without issuing any mutation', async () => {
    for (const sessionProof of ['short-proof', 'A'.repeat(64), `${'a'.repeat(63)}g`, '', null]) {
        const response = { ...activeCriticalEmptyPlan() as Record<string, unknown>, sessionProof };
        const protocol = new FakeProtocol(true, response);
        let actionResolutions = 0;
        const contribution = new RidePackagedSmokeContribution(immediateState(), protocol, () => {
            actionResolutions++;
            return actions([]);
        });

        contribution.onStart();
        await waitUntil(() => protocol.calls.some(call => call.method === 'plan'), 'invalid proof plan was not queried');
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.equal(actionResolutions, 0, `invalid proof ${String(sessionProof)} resolved actions`);
        assert.deepEqual(protocol.calls, [{ method: 'plan' }]);
    }
});

test('packaged smoke strictly rejects malformed active response and plan shapes with trusted proof', async () => {
    const validResponse = activeCriticalEmptyPlan() as Record<string, unknown>;
    const validPlan = criticalEmptyPlan() as unknown as Record<string, unknown>;
    const { diagnostic: _diagnostic, ...missingResponseField } = validResponse;
    const { files: _files, ...missingPlanField } = validPlan;
    const malformed: Array<{ name: string; response: unknown }> = [
        { name: 'unknown response field', response: { ...validResponse, unexpected: true } },
        { name: 'missing response field', response: missingResponseField },
        { name: 'non-null active diagnostic', response: { ...validResponse, diagnostic: PROTOCOL_DIAGNOSTIC } },
        { name: 'unknown plan field', response: { ...validResponse, plan: { ...validPlan, unexpected: true } } },
        { name: 'missing plan field', response: { ...validResponse, plan: missingPlanField } }
    ];

    for (const entry of malformed) {
        const protocol = new FakeProtocol(true, entry.response);
        let actionResolutions = 0;
        new RidePackagedSmokeContribution(immediateState(), protocol, () => {
            actionResolutions++;
            return actions([]);
        }, { now: () => 0 }).onStart();
        await waitUntil(() => protocol.calls.some(call => call.method === 'complete'), `${entry.name} was not closed`);

        assert.equal(actionResolutions, 0, `${entry.name} resolved actions`);
        assert.deepEqual(protocol.calls.filter(call => call.method === 'complete').map(call => call.request), [{
            status: 'failed', failurePhase: 'protocol', durationMs: 0, diagnostic: PROTOCOL_DIAGNOSTIC
        }]);
    }
});

test('packaged smoke rejects non-canonical or non-portable workspace and file paths', async () => {
    const invalidPaths: Array<{ name: string; patch: Partial<RideSmokePlan> }> = [
        { name: 'absolute workspace', patch: { workspace: '/host/workspace' } },
        { name: 'drive workspace', patch: { workspace: 'C:/host/workspace' } },
        { name: 'traversal workspace', patch: { workspace: '../outside' } },
        { name: 'dot segment workspace', patch: { workspace: 'safe/./workspace' } },
        { name: 'empty segment workspace', patch: { workspace: 'safe//workspace' } },
        { name: 'backslash workspace', patch: { workspace: 'safe\\workspace' } },
        { name: 'reserved workspace', patch: { workspace: 'CON' } },
        { name: 'absolute file', patch: { files: ['/host/file.txt'] } },
        { name: 'traversal file', patch: { files: ['safe/../file.txt'] } },
        { name: 'backslash file', patch: { files: ['safe\\file.txt'] } },
        { name: 'control file', patch: { files: ['safe/bad\u0001.txt'] } },
        { name: 'forbidden file', patch: { files: ['safe/bad<name>.txt'] } },
        { name: 'trailing dot file', patch: { files: ['safe/file.'] } },
        { name: 'trailing space file', patch: { files: ['safe/file '] } },
        { name: 'reserved nested file', patch: { files: ['safe/AUX.txt'] } },
        { name: 'duplicate files', patch: { files: ['safe/file.txt', 'safe/file.txt'] } },
        { name: 'ordinal case collision', patch: { files: ['safe/File.txt', 'SAFE/file.TXT'] } }
    ];

    for (const entry of invalidPaths) {
        const response = activeCriticalEmptyPlan() as Record<string, unknown>;
        response.plan = { ...criticalEmptyPlan(), ...entry.patch };
        const protocol = new FakeProtocol(true, response);
        let actionResolutions = 0;
        new RidePackagedSmokeContribution(immediateState(), protocol, () => {
            actionResolutions++;
            return actions([]);
        }, { now: () => 0 }).onStart();
        await waitUntil(() => protocol.calls.some(call => call.method === 'complete'), `${entry.name} was not closed`);

        assert.equal(actionResolutions, 0, `${entry.name} resolved actions`);
        assert.equal((protocol.calls.find(call => call.method === 'complete')?.request as { failurePhase?: string }).failurePhase, 'protocol');
    }
});

test('packaged smoke rejects sparse file arrays before resolving actions', async () => {
    const sparseFiles = Array<string>(1);
    const deletedFiles = ['first.txt', 'second.txt'];
    delete deletedFiles[0];
    for (const files of [sparseFiles, deletedFiles]) {
        const response = activeCriticalEmptyPlan() as Record<string, unknown>;
        response.plan = { ...criticalEmptyPlan(), files };
        const protocol = new FakeProtocol(true, response);
        let actionResolutions = 0;
        new RidePackagedSmokeContribution(immediateState(), protocol, () => {
            actionResolutions++;
            return actions([]);
        }, { now: () => 0 }).onStart();
        await waitUntil(() => protocol.calls.some(call => call.method === 'complete'),
            'sparse files were not rejected');

        assert.equal(actionResolutions, 0);
        assert.equal((protocol.calls.find(call => call.method === 'complete')
            ?.request as RideSmokeCompleteRequest).failurePhase, 'protocol');
    }
});

test('packaged smoke deeply freezes the plan so actions cannot alter remaining sequencing', async () => {
    const protocol = new FakeProtocol(true, activePlan([...FULL_ACTIONS]));
    const actionCalls: string[] = [];
    const mutationResults: string[] = [];
    new RidePackagedSmokeContribution(immediateState(), protocol, () => actions(actionCalls, {
        editorSave: async plan => {
            actionCalls.push('editor-save');
            assert.equal(Object.isFrozen(plan), true);
            assert.equal(Object.isFrozen(plan.files), true);
            assert.equal(Object.isFrozen(plan.actions), true);
            for (const mutate of [
                () => (plan.actions as RideSmokeAction[]).splice(1, 1),
                () => { (plan.files as string[])[0] = 'mutated.txt'; },
                () => { (plan as { workspace: string }).workspace = 'mutated'; }
            ]) {
                try {
                    mutate();
                    mutationResults.push('ignored');
                } catch (error) {
                    assert.equal(error instanceof TypeError, true);
                    mutationResults.push('threw');
                }
            }
        }
    }), { now: () => 0 }).onStart();
    await waitUntil(() => protocol.calls.some(call => call.method === 'complete'), 'frozen plan did not complete');

    assert.deepEqual(actionCalls, FULL_ACTIONS);
    assert.equal(mutationResults.length, 3);
    assert.deepEqual(protocol.calls.filter(call => call.method === 'recordStep')
        .map(call => [(call.request as RideSmokeStepRequest).action, (call.request as RideSmokeStepRequest).state]), [
        ['editor-save', 'started'],
        ['editor-save', 'passed'],
        ['terminal-sentinel', 'started'],
        ['terminal-sentinel', 'passed'],
        ['workspace-search', 'started'],
        ['workspace-search', 'passed'],
        ['scm-status', 'started'],
        ['scm-status', 'passed'],
        ['packaged-plugin-command', 'started'],
        ['packaged-plugin-command', 'passed'],
        ['secondary-window', 'started'],
        ['secondary-window', 'passed'],
        ['second-file-forwarding', 'started'],
        ['second-file-forwarding', 'passed']
    ]);
    assert.equal((protocol.calls.find(call => call.method === 'complete')
        ?.request as RideSmokeCompleteRequest).status, 'passed');
});

test('packaged smoke path control-character boundary matches the canonical contract', async () => {
    const boundaries = [
        { codePoint: 0x001F, accepted: false },
        { codePoint: 0x0020, accepted: true },
        { codePoint: 0x007F, accepted: true },
        { codePoint: 0x0080, accepted: true },
        { codePoint: 0x009F, accepted: true },
        { codePoint: 0x00A0, accepted: true }
    ];

    for (const boundary of boundaries) {
        const character = String.fromCodePoint(boundary.codePoint);
        const response = activePlan([...FULL_ACTIONS]) as Record<string, unknown>;
        response.plan = {
            ...smokePlan([...FULL_ACTIONS]),
            files: [`safe/file${character}name.txt`, 'second.txt']
        };
        const protocol = new FakeProtocol(true, response);
        const actionCalls: string[] = [];
        new RidePackagedSmokeContribution(
            immediateState(), protocol, () => actions(actionCalls), { now: () => 0 }
        ).onStart();
        await waitUntil(() => protocol.calls.some(call => call.method === 'complete'),
            `U+${boundary.codePoint.toString(16).padStart(4, '0')} did not reach terminal`);

        assert.deepEqual(actionCalls, boundary.accepted ? FULL_ACTIONS : []);
        assert.equal(
            (protocol.calls.find(call => call.method === 'complete')?.request as { failurePhase?: string | null }).failurePhase,
            boundary.accepted ? null : 'protocol'
        );
    }
});

test('packaged smoke validates complete disabled and rejected plan response shapes', async () => {
    const malformedResponses: unknown[] = [
        { mode: 'disabled', plan: null, sessionProof: null },
        { mode: 'disabled', plan: {}, sessionProof: null, diagnostic: null },
        { mode: 'disabled', plan: null, sessionProof: null, diagnostic: null, extra: true },
        { mode: 'rejected', plan: null, sessionProof: null, diagnostic: null },
        { mode: 'rejected', plan: null, sessionProof: null, diagnostic: { ...PROTOCOL_DIAGNOSTIC, extra: true } },
        { mode: 'rejected', plan: null, sessionProof: null, diagnostic: { code: 'protocol-failed', message: 'wrong' } }
    ];
    for (const response of malformedResponses) {
        const protocol = new FakeProtocol(true, response);
        let actionResolutions = 0;
        new RidePackagedSmokeContribution(immediateState(), protocol, () => {
            actionResolutions++;
            return actions([]);
        }).onStart();
        await waitUntil(() => protocol.calls.length === 1, 'malformed inactive plan was not queried');
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(actionResolutions, 0);
        assert.deepEqual(protocol.calls, [{ method: 'plan' }]);
    }
});

test('packaged smoke rejects loosely shaped recorded updates instead of treating them as success', async () => {
    const invalidUpdates: unknown[] = [
        { status: 'recorded' },
        { status: 'recorded', diagnostic: null, extra: true },
        { status: 'recorded', diagnostic: PROTOCOL_DIAGNOSTIC },
        { status: 'recorded', diagnostic: { code: 'protocol-failed', message: 'wrong' } }
    ];
    for (const update of invalidUpdates) {
        const actionCalls: string[] = [];
        const protocol = new FakeProtocol(true, activePlan([...FULL_ACTIONS]), method => (
            method === 'recordStep' ? update : { status: 'completed', diagnostic: null }
        ));
        new RidePackagedSmokeContribution(
            immediateState(), protocol, () => actions(actionCalls), { now: () => 0 }
        ).onStart();
        await waitUntil(() => protocol.calls.filter(call => call.method === 'recordStep').length === 2,
            'invalid recorded update was not retried once');

        assert.deepEqual(actionCalls, []);
        const records = protocol.calls.filter(call => call.method === 'recordStep');
        assert.equal(records.length, 2);
        assert.strictEqual(records[0].request, records[1].request);
        assert.equal(protocol.calls.some(call => call.method === 'complete'), false);
    }
});

test('packaged smoke accepts only the exact Rust durability warning on completed update', async () => {
    const protocol = new FakeProtocol(true, activeCriticalEmptyPlan(), method => ({
        status: method === 'complete' ? 'completed' : 'recorded',
        diagnostic: method === 'complete'
            ? {
                code: 'report-durability-warning',
                message: 'Smoke report was committed but durability sync failed.'
            }
            : null
    }));
    new RidePackagedSmokeContribution(immediateState(), protocol, () => actions([])).onStart();
    await waitUntil(() => protocol.calls.some(call => call.method === 'complete'), 'durability warning completion was not attempted');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(protocol.calls.filter(call => call.method === 'complete').length, 1);
});

test('packaged smoke disposal and repeated startup never execute twice', async () => {
    const shell = deferred();
    const disposedProtocol = new FakeProtocol(true, activePlan([...FULL_ACTIONS]));
    const disposed = new RidePackagedSmokeContribution(
        { reachedState: () => shell.promise } as unknown as FrontendApplicationStateService,
        disposedProtocol,
        () => actions([])
    );
    disposed.onStart();
    disposed.onStart();
    disposed.dispose();
    shell.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(disposedProtocol.calls, []);

    const protocol = new FakeProtocol(true, activeCriticalEmptyPlan());
    const contribution = new RidePackagedSmokeContribution(immediateState(), protocol, () => actions([]));
    contribution.onStart();
    contribution.onStart();
    await waitUntil(() => protocol.calls.some(call => call.method === 'complete'), 'empty smoke did not complete');
    assert.equal(protocol.calls.filter(call => call.method === 'plan').length, 1);
    assert.equal(protocol.calls.filter(call => call.method === 'complete').length, 1);
});

test('packaged smoke plan already in flight reaches terminal when disposed before active response resumes', async () => {
    const pendingPlan = deferredValue<unknown>();
    const protocol = new FakeProtocol(true, pendingPlan.promise);
    let actionResolutions = 0;
    const contribution = new RidePackagedSmokeContribution(immediateState(), protocol, () => {
        actionResolutions++;
        return actions([]);
    }, { now: () => 0 });

    contribution.onStart();
    await waitUntil(() => protocol.calls.some(call => call.method === 'plan'), 'plan IPC was not issued');
    contribution.dispose();
    pendingPlan.resolve(activeCriticalEmptyPlan());
    await waitUntil(() => protocol.calls.some(call => call.method === 'complete'), 'in-flight active plan did not reach terminal');

    assert.equal(actionResolutions, 1);
    assert.deepEqual(protocol.calls.filter(call => call.method === 'complete').map(call => call.request), [{
        status: 'passed', failurePhase: null, durationMs: 0, diagnostic: null
    }]);
});

test('packaged smoke plan already in flight remains lazy when disposed response is disabled', async () => {
    const pendingPlan = deferredValue<unknown>();
    const protocol = new FakeProtocol(true, pendingPlan.promise);
    let actionResolutions = 0;
    const contribution = new RidePackagedSmokeContribution(immediateState(), protocol, () => {
        actionResolutions++;
        return actions([]);
    });

    contribution.onStart();
    await waitUntil(() => protocol.calls.some(call => call.method === 'plan'), 'plan IPC was not issued');
    contribution.dispose();
    pendingPlan.resolve({ mode: 'disabled', plan: null, sessionProof: null, diagnostic: null });
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(actionResolutions, 0);
    assert.deepEqual(protocol.calls, [{ method: 'plan' }]);
});

test('packaged smoke active session reaches failed terminal when disposed during a stuck action', async () => {
    const protocol = new FakeProtocol(true, activePlan([...FULL_ACTIONS]));
    const actionStarted = deferred();
    const timers: Array<() => void> = [];
    const contribution = new RidePackagedSmokeContribution(
        immediateState(),
        protocol,
        () => actions([], {
            editorSave: () => {
                actionStarted.resolve();
                return new Promise<void>(() => undefined);
            }
        }),
        {
            now: (() => { let now = 0; return () => now++; })(),
            setTimeout: callback => {
                timers.push(callback);
                return callback;
            },
            clearTimeout: () => undefined
        }
    );

    contribution.onStart();
    await actionStarted.promise;
    contribution.dispose();
    assert.equal(timers.length, 1);
    timers[0]();
    await waitUntil(() => protocol.calls.some(call => call.method === 'complete'), 'disposed active smoke did not fail terminally');

    const mutations = protocol.calls.filter(call => call.method !== 'plan');
    assert.deepEqual(mutations.map(call => [call.method, (call.request as { state?: string; status?: string }).state
        ?? (call.request as { status?: string }).status]), [
        ['recordStep', 'started'],
        ['recordStep', 'failed'],
        ['complete', 'failed']
    ]);
    assert.equal(mutations.some(call => (call.request as { status?: string }).status === 'passed'), false);
});

test('packaged smoke active session reaches passed terminal when disposed at an action boundary', async () => {
    const protocol = new FakeProtocol(true, activePlan([...FULL_ACTIONS]));
    const actionCalls: string[] = [];
    let contribution!: RidePackagedSmokeContribution;
    contribution = new RidePackagedSmokeContribution(
        immediateState(),
        protocol,
        () => actions(actionCalls, {
            editorSave: async () => {
                actionCalls.push('editor-save');
                contribution.dispose();
            }
        }),
        { now: (() => { let now = 0; return () => now++; })() }
    );

    contribution.onStart();
    contribution.onStart();
    await waitUntil(() => protocol.calls.some(call => call.method === 'complete'), 'disposed active smoke did not pass terminally');

    assert.deepEqual(actionCalls, FULL_ACTIONS);
    assert.equal(protocol.calls.filter(call => call.method === 'plan').length, 1);
    assert.deepEqual(protocol.calls.filter(call => call.method === 'complete').map(call => call.request), [{
        status: 'passed', failurePhase: null, durationMs: 14, diagnostic: null
    }]);
});

test('packaged smoke Tauri adapter emits the exact raw Value envelopes', async () => {
    const invokes: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const adapter = new RideTauriPackagedSmokeProtocol({
        isTauri: () => true,
        invoke: async (command: string, args?: Record<string, unknown>) => {
            invokes.push({ command, args });
            return { status: command === 'ride_smoke_plan' ? 'active' : 'recorded' };
        }
    });
    const transition = {
        action: 'editor-save' as const,
        state: 'started' as const,
        durationMs: 0,
        diagnostic: null
    };
    const completion = {
        status: 'passed' as const,
        failurePhase: null,
        durationMs: 1,
        diagnostic: null
    };

    assert.equal(adapter.isTauri(), true);
    await adapter.plan();
    await adapter.recordStep(PROOF, transition);
    await adapter.complete(PROOF, completion);

    assert.deepEqual(invokes, [
        { command: 'ride_smoke_plan', args: undefined },
        {
            command: 'ride_smoke_record_step',
            args: { request: { sessionProof: PROOF, request: transition } }
        },
        {
            command: 'ride_smoke_complete',
            args: { request: { sessionProof: PROOF, request: completion } }
        }
    ]);
});
