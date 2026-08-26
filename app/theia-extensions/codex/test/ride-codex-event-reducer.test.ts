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
            { type: 'reasoning-delta', itemId: 'item-1', contentIndex: 0, delta: 'private reasoning' },
            { type: 'plan-delta', itemId: 'item-1', delta: 'step' },
            { type: 'command-output', itemId: 'command-1', delta: 'stdout' },
            { type: 'file-output', itemId: 'file-1', delta: 'patch' },
            { type: 'file-patch', itemId: 'file-1', changes: [{ path: 'src/a.ts', kind: 'update', diff: 'updated' }] },
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
        assert.deepEqual(snapshot.items.find(item => item.id === 'item-1')?.summaries, ['thinking']);
        assert.deepEqual(snapshot.items.find(item => item.id === 'item-1')?.reasoning, ['private reasoning']);
        assert.equal(snapshot.plan?.steps[0].step, 'build');
        assert.equal(snapshot.diff, '+line');
        assert.equal(snapshot.usage?.totalTokens, 10);
        assert.equal(snapshot.warnings.length, 1);
        assert.equal(snapshot.errors.length, 1);
        assert.ok(Object.isFrozen(snapshot));
        assert.ok(Object.isFrozen(snapshot.items));
        assert.ok(Object.isFrozen(snapshot.items[0]));
    });

    it('preserves and deeply freezes add, delete, update, and moved file patches', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            }
        });
        reducer.notifyMany({
            generation: 1,
            threadId: 'thread-1',
            turnId: 'turn-1',
            events: [
                { type: 'turn-started' },
                {
                    type: 'file-patch', itemId: 'file-1', changes: [
                        { path: 'src/added.ts', kind: 'add', diff: '' },
                        { path: 'src/deleted.ts', kind: 'delete', diff: '-deleted' },
                        { path: 'src/updated.ts', kind: 'update', diff: 'updated', movePath: null },
                        { path: 'src/old.ts', kind: 'update', diff: 'moved', movePath: 'src/new.ts' }
                    ]
                }
            ]
        } as RideCodexEventBatch);
        frames.shift()?.();

        const changes = reducer.snapshot().items[0].changes;
        assert.deepEqual(changes, [
            { path: 'src/added.ts', kind: 'add', diff: '' },
            { path: 'src/deleted.ts', kind: 'delete', diff: '-deleted' },
            { path: 'src/updated.ts', kind: 'update', diff: 'updated', movePath: null },
            { path: 'src/old.ts', kind: 'update', diff: 'moved', movePath: 'src/new.ts' }
        ]);
        assert.ok(Object.isFrozen(changes));
        assert.ok(changes.every(change => Object.isFrozen(change)));
    });

    it('rejects file patch changes with unknown fields or malformed movePath', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            }
        });
        for (const change of [
            { path: 'src/a.ts', kind: 'add', diff: '+a', unknown: true },
            { path: 'src/a.ts', kind: 'delete', diff: '-a', movePath: null },
            { path: 'src/a.ts', kind: 'update', diff: 'x', movePath: 1 },
            { path: 'src/\u001bunsafe.ts', kind: 'add', diff: '+a' },
            { path: '你'.repeat(11_000), kind: 'add', diff: '+a' },
            { path: 'src/a.ts', kind: 'add', diff: '你'.repeat(22_000) },
            { path: 'src/a.ts', kind: 'update', diff: 'x', movePath: '你'.repeat(11_000) },
            { path: 'src/a.ts', kind: 'unknown', diff: 'x' }
        ]) {
            reducer.notifyMany({
                generation: 1, threadId: 'thread-1', turnId: 'turn-1',
                events: [{ type: 'turn-started' }, { type: 'file-patch', itemId: 'file-1', changes: [change] }]
            } as RideCodexEventBatch);
        }

        assert.equal(frames.length, 0);
        assert.equal(reducer.snapshot().status, 'idle');
    });

    it('renders reasoning summary parts and reasoning text into separate UTF-8 bounded fields', () => {
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
                { type: 'item-started', itemId: 'reasoning-1', itemKind: 'reasoning' },
                { type: 'reasoning-summary-delta', itemId: 'reasoning-1', summaryIndex: 0, delta: '你你你' },
                { type: 'reasoning-summary-part', itemId: 'reasoning-1', summaryIndex: 1 },
                { type: 'reasoning-delta', itemId: 'reasoning-1', contentIndex: 0, delta: '界界界' }
            ]
        });
        frames.shift()?.();

        const item = reducer.snapshot().items[0];
        assert.deepEqual(item.summaries, ['你你', '']);
        assert.deepEqual(item.reasoning, ['界界']);
        assert.equal(item.text, '');
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

    it('rejects accessor-backed event data after native clone without changing state', () => {
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

        assert.equal(getterCalls, 1);
        assert.equal(frames.length, 0);
        assert.equal(reducer.snapshot().status, 'idle');
    });

    it('rejects Proxy batches, event arrays, events, and nested payloads before any reflective trap', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            }
        });
        let traps = 0;
        const proxied = <T extends object>(target: T): T => new Proxy(target, {
            get: () => { traps += 1; return undefined; },
            ownKeys: () => { traps += 1; return []; },
            getOwnPropertyDescriptor: () => { traps += 1; return undefined; },
            getPrototypeOf: () => { traps += 1; return Object.prototype; }
        });
        const valid = {
            generation: 1, threadId: 'thread-1', turnId: 'turn-1',
            events: [{ type: 'turn-started' as const }]
        };
        const batches: unknown[] = [
            proxied(valid),
            { ...valid, events: proxied([{ type: 'turn-started' as const }]) },
            { ...valid, events: [proxied({ type: 'turn-started' as const })] },
            {
                ...valid,
                events: [
                    { type: 'turn-started' as const },
                    { type: 'turn-terminal' as const, status: 'failed' as const, error: proxied({ code: 'turn-error', message: 'x' }) }
                ]
            }
        ];
        for (const batch of batches) {
            reducer.notifyMany(batch as RideCodexEventBatch);
        }

        assert.equal(traps, 0);
        assert.equal(frames.length, 0);
        assert.equal(reducer.snapshot().status, 'idle');
    });

    it('preserves a unique terminal when ordinary pending events consume the frame byte budget', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            },
            maxQueuedBytes: 256,
            maxBatchEvents: 16
        });
        reducer.notifyMany({
            generation: 1, threadId: 'thread-1', turnId: 'turn-1',
            events: [
                { type: 'turn-started' },
                { type: 'item-started', itemId: 'item-1', itemKind: 'agent-message' },
                { type: 'agent-delta', itemId: 'item-1', delta: 'x'.repeat(96) }
            ]
        });
        reducer.notifyMany({
            generation: 1, threadId: 'thread-1', turnId: 'turn-1',
            events: [{ type: 'turn-terminal', status: 'completed' }]
        });
        frames.shift()?.();

        assert.equal(reducer.snapshot().status, 'completed');
        assert.ok(reducer.snapshot().warnings.some(warning => warning.code === 'events-dropped'));
    });

    it('uses an exact terminal batch as an identity boundary when its start was compacted upstream', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            }
        });
        reducer.notifyMany({
            generation: 1, threadId: 'thread-1', turnId: 'turn-1',
            events: [{ type: 'turn-started' }]
        });
        reducer.notifyMany({
            generation: 1, threadId: 'thread-1', turnId: 'turn-2',
            events: [{ type: 'turn-terminal', status: 'completed' }]
        });
        frames.shift()?.();

        assert.equal(reducer.snapshot().turnId, 'turn-2');
        assert.equal(reducer.snapshot().status, 'completed');
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
