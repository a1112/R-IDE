/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RideCodexEventBatch } from '../src/common/ride-codex-events';
import { RideCodexEventReducer } from '../src/browser/ride-codex-event-reducer';

describe('RideCodexEventReducer minimal frame contract', () => {
    it('coalesces 1000 agent deltas without publishing before one animation frame', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            },
            maxItemBytes: 2_048,
            maxRetainedBytes: 4_096
        });
        let publishes = 0;
        reducer.onDidChange(() => {
            publishes += 1;
        });
        const batch: RideCodexEventBatch = {
            generation: 1,
            threadId: 'thread-1',
            turnId: 'turn-1',
            events: [
                { type: 'turn-started' },
                { type: 'item-started', itemId: 'item-1', itemKind: 'agent-message' },
                ...Array.from({ length: 1_000 }, () => ({
                    type: 'agent-delta' as const,
                    itemId: 'item-1',
                    delta: 'x'
                }))
            ]
        };

        reducer.notifyMany(batch);

        assert.equal(publishes, 0);
        assert.equal(reducer.snapshot().items.length, 0);
        assert.equal(frames.length, 1);

        frames.shift()?.();

        assert.equal(publishes, 1);
        assert.equal(reducer.snapshot().items.length, 1);
        assert.equal(reducer.snapshot().items[0].text, 'x'.repeat(1_000));
        assert.equal(frames.length, 0);
    });

    it('applies lifecycle and reviewed render events while terminal state stays monotonic', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            }
        });
        const events: RideCodexEventBatch['events'] = [
            { type: 'turn-started' },
            { type: 'item-started', itemId: 'item-1', itemKind: 'reasoning' },
            { type: 'reasoning-summary-part', itemId: 'item-1', summaryIndex: 0 },
            { type: 'reasoning-summary-delta', itemId: 'item-1', summaryIndex: 0, delta: 'thinking' },
            { type: 'plan-delta', itemId: 'item-1', delta: 'step' },
            { type: 'command-output', itemId: 'command-1', delta: 'stdout' },
            { type: 'file-output', itemId: 'file-1', delta: 'patch' },
            { type: 'file-patch', itemId: 'file-1', changes: [{ path: 'src/a.ts', kind: 'update' }] },
            { type: 'turn-plan', explanation: 'next', steps: [{ step: 'build', status: 'in-progress' }] },
            { type: 'turn-diff', diff: '+line' },
            { type: 'token-usage', totalTokens: 10, inputTokens: 4, outputTokens: 6 },
            { type: 'warning', code: 'server-warning', message: 'bounded warning' },
            { type: 'error', code: 'turn-error', message: 'safe failure', retryable: false },
            { type: 'item-completed', itemId: 'item-1', itemKind: 'reasoning' },
            { type: 'turn-terminal', status: 'failed', error: { code: 'turn-error', message: 'safe failure' } },
            { type: 'agent-delta', itemId: 'item-1', delta: 'late' },
            { type: 'turn-terminal', status: 'completed' }
        ];
        reducer.notifyMany({ generation: 1, threadId: 'thread-1', turnId: 'turn-1', events });
        frames.shift()?.();

        const snapshot = reducer.snapshot();
        assert.equal(snapshot.status, 'failed');
        assert.equal(snapshot.items.find(item => item.id === 'item-1')?.text.includes('late'), false);
        assert.equal(snapshot.plan?.steps[0].step, 'build');
        assert.equal(snapshot.diff, '+line');
        assert.equal(snapshot.usage?.totalTokens, 10);
        assert.equal(snapshot.warnings.length, 1);
        assert.equal(snapshot.errors.length, 1);
        assert.ok(Object.isFrozen(snapshot));
        assert.ok(Object.isFrozen(snapshot.items));
        assert.ok(Object.isFrozen(snapshot.items[0]));
    });

    it('enforces UTF-8 item, total, retained item, warning, and error bounds during storms', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            },
            maxItemBytes: 8,
            maxRetainedBytes: 16,
            maxRetainedItems: 2,
            maxDiagnosticHistory: 2
        });
        const events: RideCodexEventBatch['events'] = [
            { type: 'turn-started' },
            ...Array.from({ length: 5 }, (_, index) => ({
                type: 'item-started' as const,
                itemId: `item-${index}`,
                itemKind: 'agent-message' as const
            })),
            ...Array.from({ length: 20 }, (_, index) => ({
                type: 'agent-delta' as const,
                itemId: 'item-4',
                delta: '你'
            })),
            ...Array.from({ length: 5 }, (_, index) => ({
                type: 'warning' as const,
                code: 'server-warning' as const,
                message: `warning ${index}`
            })),
            ...Array.from({ length: 5 }, (_, index) => ({
                type: 'error' as const,
                code: 'turn-error' as const,
                message: `error ${index}`,
                retryable: false
            }))
        ];
        reducer.notifyMany({ generation: 1, threadId: 'thread-1', turnId: 'turn-1', events });
        frames.shift()?.();

        const snapshot = reducer.snapshot();
        assert.ok(snapshot.items.length <= 2);
        assert.ok(Buffer.byteLength(snapshot.items.find(item => item.id === 'item-4')?.text ?? '', 'utf8') <= 8);
        assert.ok(snapshot.retainedBytes <= 16);
        assert.equal(snapshot.warnings.length, 2);
        assert.equal(snapshot.errors.length, 2);
    });

    it('ignores duplicate, late, cross-turn, and old-generation batches', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            }
        });
        reducer.notifyMany({
            generation: 2, threadId: 'thread-1', turnId: 'turn-1',
            events: [{ type: 'turn-started' }, { type: 'turn-terminal', status: 'completed' }]
        });
        reducer.notifyMany({
            generation: 1, threadId: 'thread-1', turnId: 'turn-1',
            events: [{ type: 'warning', code: 'server-warning', message: 'old' }]
        });
        reducer.notifyMany({
            generation: 2, threadId: 'thread-1', turnId: 'turn-2',
            events: [{ type: 'warning', code: 'server-warning', message: 'cross' }]
        });
        frames.shift()?.();

        assert.equal(reducer.snapshot().status, 'completed');
        assert.equal(reducer.snapshot().warnings.length, 0);
    });

    it('dispose cancels the scheduled frame, releases queued events, and publishes nothing', () => {
        const frames: Array<() => void> = [];
        let cancelled = 0;
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => { cancelled += 1; } };
            }
        });
        let publishes = 0;
        reducer.onDidChange(() => { publishes += 1; });
        reducer.notifyMany({
            generation: 1, threadId: 'thread-1', turnId: 'turn-1',
            events: [{ type: 'turn-started' }, { type: 'agent-delta', itemId: 'i', delta: 'queued' }]
        });
        reducer.dispose();
        frames.shift()?.();

        assert.equal(cancelled, 1);
        assert.equal(publishes, 0);
        assert.equal(reducer.snapshot().items.length, 0);
    });

    it('starts a new turn in the same generation only after the prior terminal batch', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            }
        });
        reducer.notifyMany({
            generation: 1, threadId: 'thread-1', turnId: 'turn-1',
            events: [{ type: 'turn-started' }, { type: 'turn-terminal', status: 'completed' }]
        });
        reducer.notifyMany({
            generation: 1, threadId: 'thread-1', turnId: 'turn-2',
            events: [{ type: 'turn-started' }, { type: 'agent-delta', itemId: 'item-2', delta: 'new' }]
        });
        frames.shift()?.();

        assert.equal(reducer.snapshot().turnId, 'turn-2');
        assert.equal(reducer.snapshot().status, 'in-progress');
        assert.equal(reducer.snapshot().items[0].text, 'new');
    });

    it('rejects accessor-backed event data without invoking getters or changing state', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            }
        });
        let getterCalls = 0;
        const event = Object.defineProperty({ type: 'agent-delta', itemId: 'item-1' }, 'delta', {
            enumerable: true,
            get: () => {
                getterCalls += 1;
                return 'unsafe';
            }
        });
        reducer.notifyMany({
            generation: 1,
            threadId: 'thread-1',
            turnId: 'turn-1',
            events: [event as never]
        });

        assert.equal(getterCalls, 0);
        assert.equal(frames.length, 0);
        assert.equal(reducer.snapshot().status, 'idle');
    });

    it('rejects malformed typed events and bounds an oversized frontend batch with drop metadata', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            },
            maxBatchEvents: 4,
            maxQueuedBytes: 4_096,
            maxItemBytes: 2_048
        });
        reducer.notifyMany({
            generation: 1,
            threadId: 'thread-1',
            turnId: 'bad-turn',
            events: [{ type: 'turn-started' }, { type: 'turn-terminal' } as never]
        });
        assert.equal(frames.length, 0);
        assert.equal(reducer.snapshot().status, 'idle');

        reducer.notifyMany({
            generation: 1,
            threadId: 'thread-1',
            turnId: 'turn-1',
            events: [
                { type: 'turn-started' },
                ...Array.from({ length: 20 }, (_, index) => ({
                    type: 'warning' as const,
                    code: 'server-warning' as const,
                    message: `warning ${index}`
                }))
            ]
        });
        assert.equal(frames.length, 1);
        frames.shift()?.();

        assert.equal(reducer.snapshot().status, 'in-progress');
        assert.ok(reducer.snapshot().warnings.some(warning => warning.code === 'events-dropped'));
    });

    it('reports one frontend truncation when many small multibyte deltas fill an item', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            },
            maxItemBytes: 8,
            maxRetainedBytes: 64
        });
        reducer.notifyMany({
            generation: 1,
            threadId: 'thread-1',
            turnId: 'turn-1',
            events: [
                { type: 'turn-started' },
                { type: 'item-started', itemId: 'item-1', itemKind: 'agent-message' },
                ...Array.from({ length: 20 }, () => ({
                    type: 'agent-delta' as const, itemId: 'item-1', delta: '你'
                }))
            ]
        });
        frames.shift()?.();

        assert.ok(Buffer.byteLength(reducer.snapshot().items[0].text, 'utf8') <= 8);
        assert.equal(reducer.snapshot().warnings.filter(warning => warning.code === 'data-truncated').length, 1);
    });
});
