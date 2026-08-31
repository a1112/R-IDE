/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    RideCodexControlModel,
    RideCodexControlServices
} from '../src/browser/ride-codex-control-model';
import { RideCodexAuthSnapshot } from '../src/common/ride-codex-auth';
import { RideCodexConversationsSnapshot, RideCodexModelPage, RideCodexThreadPage, RideCodexThreadSummary } from '../src/common/ride-codex-conversations';
import { RideCodexEventBatchWire, RideCodexTurnResult } from '../src/common/ride-codex-events';

const AUTHENTICATED: RideCodexAuthSnapshot = Object.freeze({
    state: 'authenticated',
    account: Object.freeze({ type: 'apiKey' as const })
});

const THREAD: RideCodexThreadSummary = Object.freeze({
    id: 'thread-1',
    preview: 'Existing thread',
    name: null,
    modelProvider: 'openai',
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    cwd: 'C:\\workspace',
    status: Object.freeze({ kind: 'idle' as const, activeFlags: Object.freeze([]) })
});

const MODEL = Object.freeze({
    id: 'gpt-5-codex',
    model: 'gpt-5-codex',
    displayName: 'GPT-5 Codex',
    description: 'Codex',
    isDefault: true,
    hidden: false,
    inputModalities: Object.freeze(['text' as const]),
    supportedReasoningEfforts: Object.freeze([]),
    defaultReasoningEffort: 'medium',
    supportsPersonality: false,
    serviceTiers: Object.freeze([]),
    defaultServiceTier: null
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    return {
        promise: new Promise<T>(next => { resolve = next; }),
        resolve
    };
}

function conversationSnapshot(): RideCodexConversationsSnapshot {
    return Object.freeze({
        generation: 4,
        threads: Object.freeze([THREAD]),
        selectedThreadId: THREAD.id,
        persistedTranscriptCount: 0 as const
    });
}

test('initializes once, keeps model/thread controls bounded, and streams a turn through the reducer', async () => {
    const turnStarted = deferred<RideCodexTurnResult>();
    let turnEvents!: (wire: RideCodexEventBatchWire) => void;
    let approvalContext: unknown;
    const authCalls: string[] = [];
    const threadListRequests: unknown[] = [];
    const services: RideCodexControlServices = {
        auth: {
            activate: async () => { authCalls.push('activate'); return AUTHENTICATED; },
            status: async () => AUTHENTICATED,
            login: async request => {
                authCalls.push(request.type);
                return Object.freeze({ type: 'apiKey' as const });
            },
            cancelLogin: async () => undefined,
            logout: async () => Object.freeze({ state: 'unauthenticated' as const })
        },
        conversations: {
            status: async () => conversationSnapshot(),
            listModels: async () => Object.freeze({ data: Object.freeze([MODEL]), nextCursor: null }) as RideCodexModelPage,
            listThreads: async options => {
                threadListRequests.push(options);
                return Object.freeze({
                    data: Object.freeze([THREAD]), nextCursor: null, backwardsCursor: null
                }) as RideCodexThreadPage;
            },
            startThread: async () => THREAD,
            resumeThread: async () => THREAD,
            readThread: async () => THREAD,
            archiveThread: async () => undefined,
            selectThread: async () => undefined
        },
        turns: {
            startTurn: async () => turnStarted.promise,
            steerTurn: async () => Object.freeze({ threadId: THREAD.id, turnId: 'turn-2', status: 'in-progress' as const }),
            interruptTurn: async () => Object.freeze({ threadId: THREAD.id, turnId: 'turn-2', status: 'interrupted' as const }),
            disconnectClient: () => undefined
        },
        approvals: {
            setContext: async context => { approvalContext = context; },
            disposeContext: async () => undefined,
            approvals: async () => Object.freeze([]),
            decide: async () => Object.freeze({ status: 'responded' as const })
        }
    };
    const model = new RideCodexControlModel({
        services,
        workspaceRoot: 'C:\\workspace',
        scheduleFrame: callback => {
            callback();
            return { dispose: () => undefined };
        },
        onTurnEvents: callback => { turnEvents = callback; return { dispose: () => undefined }; }
    });

    await model.initialize();
    await model.initialize();
    assert.deepEqual(authCalls, ['activate']);
    assert.deepEqual(threadListRequests, [{ limit: 100 }]);
    assert.equal(model.snapshot().phase, 'ready');
    assert.equal(model.snapshot().selectedThreadId, THREAD.id);
    assert.equal(model.snapshot().selectedModelId, MODEL.id);

    await model.selectModel(MODEL.id);
    const turn = model.submitTurn('inspect the repository', 'message-1');
    turnStarted.resolve(Object.freeze({ threadId: THREAD.id, turnId: 'turn-2', status: 'in-progress' }));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(approvalContext, {
        generation: 4,
        threadId: THREAD.id,
        turnId: 'turn-2'
    });
    turnEvents(JSON.stringify({
        generation: 4,
        turnSequence: 1,
        threadId: THREAD.id,
        turnId: 'turn-2',
        events: [
            { type: 'turn-started' },
            { type: 'item-started', itemId: 'item-1', itemKind: 'agent-message' },
            { type: 'agent-delta', itemId: 'item-1', delta: 'done' },
            { type: 'turn-terminal', status: 'completed' }
        ]
    }));

    assert.deepEqual(await turn, { threadId: THREAD.id, turnId: 'turn-2', status: 'completed' });
    assert.equal(model.snapshot().turn.items[0]?.text, 'done');
    await model.dispose();
});

test('keeps an unauthenticated shell actionable without loading conversations', async () => {
    let listed = false;
    const services = {
        auth: {
            activate: async () => Object.freeze({ state: 'unauthenticated' as const }),
            status: async () => Object.freeze({ state: 'unauthenticated' as const }),
            login: async () => Object.freeze({ type: 'apiKey' as const }),
            cancelLogin: async () => undefined,
            logout: async () => Object.freeze({ state: 'unauthenticated' as const })
        },
        conversations: {
            status: async () => conversationSnapshot(),
            listModels: async () => { listed = true; return Object.freeze({ data: [], nextCursor: null }); },
            listThreads: async () => { listed = true; return Object.freeze({ data: [], nextCursor: null, backwardsCursor: null }); }
        },
        turns: {},
        approvals: {}
    } as unknown as RideCodexControlServices;
    const model = new RideCodexControlModel({
        services,
        workspaceRoot: 'C:\\workspace',
        scheduleFrame: callback => { callback(); return { dispose: () => undefined }; }
    });

    await model.initialize();
    assert.equal(model.snapshot().phase, 'auth-required');
    assert.equal(listed, false);
    await model.dispose();
});
