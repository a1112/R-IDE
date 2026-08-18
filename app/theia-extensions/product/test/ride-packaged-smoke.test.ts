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
    RideSmokePlan,
    RideTauriPackagedSmokeProtocol
} from '../src/browser/ride-packaged-smoke';

const PROOF = 'b'.repeat(64);
const PROTOCOL_DIAGNOSTIC = { code: 'protocol-failed', message: 'Smoke protocol failed.' } as const;

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

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt++) {
        if (predicate()) {
            return;
        }
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.fail(message);
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
        waitForSecondFile: action('second-file-forwarding'),
        ...overrides
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
    const protocol = new FakeProtocol(false, activePlan(['editor-save']));
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

test('packaged smoke fails fast with one bounded action failure and never reports passed', async () => {
    const protocol = new FakeProtocol(true, activePlan(['editor-save', 'terminal-sentinel']));
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
    const protocol = new FakeProtocol(true, activePlan(['editor-save']));
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

test('packaged smoke safely contains malformed, rejected, and failed IPC responses', async () => {
    const malformed = new FakeProtocol(true, {
        mode: 'active',
        plan: { ...smokePlan(['editor-save']), actions: ['unknown-action'] },
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

    const rejectedUpdate = new FakeProtocol(true, activePlan(['editor-save']), method => ({
        status: method === 'recordStep' ? 'rejected' : 'completed',
        diagnostic: { code: 'protocol-failed', message: 'Smoke protocol failed.' }
    }));
    let rejectedActionCalls = 0;
    new RidePackagedSmokeContribution(immediateState(), rejectedUpdate, () => actions([], {
        editorSave: async () => { rejectedActionCalls++; }
    }), { now: () => 0 }).onStart();
    await waitUntil(() => rejectedUpdate.calls.some(call => call.method === 'recordStep'), 'step was not attempted');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(rejectedActionCalls, 0);
    assert.equal(rejectedUpdate.calls.filter(call => call.method === 'recordStep').length, 1);
    assert.deepEqual(rejectedUpdate.calls.filter(call => call.method === 'complete').map(call => call.request), [{
        status: 'failed', failurePhase: 'protocol', durationMs: 0,
        diagnostic: { code: 'protocol-failed', message: 'Smoke protocol failed.' }
    }]);

    const failedPlan = new FakeProtocol(true, new Error('IPC failure with secret path C:\\private'));
    new RidePackagedSmokeContribution(immediateState(), failedPlan, () => actions([])).onStart();
    await waitUntil(() => failedPlan.calls.length === 1, 'failed plan IPC was not attempted');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(failedPlan.calls, [{ method: 'plan' }]);
});

test('packaged smoke started IPC failure attempts one protocol completion without replay', async () => {
    const actionCalls: string[] = [];
    const protocol = new FakeProtocol(true, activePlan(['editor-save']), (method, request) => {
        if (method === 'recordStep') {
            throw new Error('ambiguous started mutation with C:\\private\\secret');
        }
        return { status: 'completed', diagnostic: null };
    });
    const contribution = new RidePackagedSmokeContribution(
        immediateState(), protocol, () => actions(actionCalls), { now: () => 0 }
    );

    contribution.onStart();
    await waitUntil(() => protocol.calls.some(call => call.method === 'complete'), 'started failure compensation was not attempted');

    assert.deepEqual(actionCalls, []);
    assert.deepEqual(protocol.calls.filter(call => call.method !== 'plan'), [
        {
            method: 'recordStep', proof: PROOF, request: {
                action: 'editor-save', state: 'started', durationMs: 0, diagnostic: null
            }
        },
        {
            method: 'complete', proof: PROOF, request: {
                status: 'failed', failurePhase: 'protocol', durationMs: 0,
                diagnostic: { code: 'protocol-failed', message: 'Smoke protocol failed.' }
            }
        }
    ]);
});

test('packaged smoke passed IPC failure attempts failed transition and action completion once', async () => {
    const actionCalls: string[] = [];
    const protocol = new FakeProtocol(true, activePlan(['editor-save']), (method, request) => {
        if (method === 'recordStep' && (request as { state?: string }).state === 'passed') {
            return { status: 'rejected', diagnostic: { code: 'protocol-failed', message: 'Smoke protocol failed.' } };
        }
        return { status: method === 'complete' ? 'completed' : 'recorded', diagnostic: null };
    });
    const contribution = new RidePackagedSmokeContribution(
        immediateState(), protocol, () => actions(actionCalls),
        { now: (() => { let now = 0; return () => now++; })() }
    );

    contribution.onStart();
    await waitUntil(() => protocol.calls.some(call => call.method === 'complete'), 'passed failure compensation was not attempted');

    assert.deepEqual(actionCalls, ['editor-save']);
    assert.deepEqual(protocol.calls.filter(call => call.method !== 'plan').map(call => [
        call.method,
        (call.request as { state?: string; status?: string }).state ?? (call.request as { status?: string }).status
    ]), [
        ['recordStep', 'started'],
        ['recordStep', 'passed'],
        ['recordStep', 'failed'],
        ['complete', 'failed']
    ]);
    assert.equal(protocol.calls.filter(call =>
        call.method === 'recordStep' && (call.request as { state?: string }).state === 'passed'
    ).length, 1);
    assert.equal(protocol.calls.some(call =>
        call.method === 'complete' && (call.request as { status?: string }).status === 'passed'
    ), false);
});

test('packaged smoke failed transition IPC failure cannot suppress one action completion attempt', async () => {
    const protocol = new FakeProtocol(true, activePlan(['editor-save']), (method, request) => {
        if (method === 'recordStep' && (request as { state?: string }).state === 'failed') {
            throw new Error('failed transition was ambiguous');
        }
        return { status: method === 'complete' ? 'completed' : 'recorded', diagnostic: null };
    });
    const contribution = new RidePackagedSmokeContribution(
        immediateState(),
        protocol,
        () => actions([], { editorSave: async () => { throw new Error('unsafe action details'); } }),
        { now: (() => { let now = 0; return () => now++; })() }
    );

    contribution.onStart();
    await waitUntil(() => protocol.calls.some(call => call.method === 'complete'), 'action completion was suppressed');

    assert.deepEqual(protocol.calls.filter(call => call.method !== 'plan').map(call => [
        call.method,
        (call.request as { state?: string; status?: string }).state ?? (call.request as { status?: string }).status
    ]), [
        ['recordStep', 'started'],
        ['recordStep', 'failed'],
        ['complete', 'failed']
    ]);
});

test('packaged smoke terminal completion failure is consumed without retry', async () => {
    for (const terminalFailure of ['throw', 'malformed'] as const) {
        const protocol = new FakeProtocol(true, activePlan([]), method => {
            assert.equal(method, 'complete');
            if (terminalFailure === 'throw') {
                throw new Error('terminal result unknown with secret');
            }
            return { status: 'completed' };
        });
        const contribution = new RidePackagedSmokeContribution(immediateState(), protocol, () => actions([]));

        contribution.onStart();
        await waitUntil(() => protocol.calls.some(call => call.method === 'complete'), `${terminalFailure} completion was not attempted`);
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.equal(protocol.calls.filter(call => call.method === 'complete').length, 1);
        assert.equal(protocol.calls.filter(call => call.method === 'recordStep').length, 0);
    }
});

test('packaged smoke rejects untrusted proof without issuing any mutation', async () => {
    for (const sessionProof of ['short-proof', 'A'.repeat(64), `${'a'.repeat(63)}g`, '', null]) {
        const response = { ...activePlan([]) as Record<string, unknown>, sessionProof };
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
    const validResponse = activePlan([]) as Record<string, unknown>;
    const validPlan = smokePlan([]) as unknown as Record<string, unknown>;
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
        const response = activePlan([]) as Record<string, unknown>;
        response.plan = { ...smokePlan([]), ...entry.patch };
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
        const response = activePlan(['editor-save']) as Record<string, unknown>;
        response.plan = { ...smokePlan(['editor-save']), files: [`safe/file${character}name.txt`] };
        const protocol = new FakeProtocol(true, response);
        const actionCalls: string[] = [];
        new RidePackagedSmokeContribution(
            immediateState(), protocol, () => actions(actionCalls), { now: () => 0 }
        ).onStart();
        await waitUntil(() => protocol.calls.some(call => call.method === 'complete'),
            `U+${boundary.codePoint.toString(16).padStart(4, '0')} did not reach terminal`);

        assert.deepEqual(actionCalls, boundary.accepted ? ['editor-save'] : []);
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
        const protocol = new FakeProtocol(true, activePlan(['editor-save']), method => (
            method === 'recordStep' ? update : { status: 'completed', diagnostic: null }
        ));
        new RidePackagedSmokeContribution(
            immediateState(), protocol, () => actions(actionCalls), { now: () => 0 }
        ).onStart();
        await waitUntil(() => protocol.calls.some(call => call.method === 'complete'), 'invalid recorded update was not compensated');

        assert.deepEqual(actionCalls, []);
        assert.equal(protocol.calls.filter(call => call.method === 'recordStep').length, 1);
        assert.equal((protocol.calls.find(call => call.method === 'complete')?.request as { failurePhase?: string }).failurePhase, 'protocol');
    }
});

test('packaged smoke accepts only the exact Rust durability warning on completed update', async () => {
    const protocol = new FakeProtocol(true, activePlan([]), method => ({
        status: 'completed',
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
    const disposedProtocol = new FakeProtocol(true, activePlan(['editor-save']));
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

    const protocol = new FakeProtocol(true, activePlan([]));
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
    pendingPlan.resolve(activePlan([]));
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
    const protocol = new FakeProtocol(true, activePlan(['editor-save']));
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
    const protocol = new FakeProtocol(true, activePlan(['editor-save', 'terminal-sentinel']));
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

    assert.deepEqual(actionCalls, ['editor-save', 'terminal-sentinel']);
    assert.equal(protocol.calls.filter(call => call.method === 'plan').length, 1);
    assert.deepEqual(protocol.calls.filter(call => call.method === 'complete').map(call => call.request), [{
        status: 'passed', failurePhase: null, durationMs: 4, diagnostic: null
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
