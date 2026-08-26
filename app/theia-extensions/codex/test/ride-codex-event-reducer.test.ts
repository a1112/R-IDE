/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    RIDE_CODEX_MIN_QUEUED_BYTES,
    RideCodexEventBatch,
    RideCodexTurnSnapshot
} from '../src/common/ride-codex-events';
import { RideCodexEventReducer } from '../src/browser/ride-codex-event-reducer';

const RETAINED_ARRAY_SLOT_BYTES = 8;
const WORST_VALID_IDENTIFIER = '\u0000'.repeat(512);
const MIN_COHERENT_QUEUE_BYTES = RIDE_CODEX_MIN_QUEUED_BYTES;

function batchWire(batch: unknown): string {
    return JSON.stringify(batch);
}

function independentlyRetainedBytes(snapshot: RideCodexTurnSnapshot): number {
    let bytes = snapshot.items.length * RETAINED_ARRAY_SLOT_BYTES;
    for (const item of snapshot.items) {
        bytes += Buffer.byteLength(item.id + item.kind + item.state + item.text, 'utf8');
        bytes += (item.summaries.length + item.reasoning.length + item.changes.length)
            * RETAINED_ARRAY_SLOT_BYTES;
        bytes += item.summaries.reduce((sum, value) => sum + Buffer.byteLength(value, 'utf8'), 0);
        bytes += item.reasoning.reduce((sum, value) => sum + Buffer.byteLength(value, 'utf8'), 0);
        bytes += item.changes.reduce((sum, change) => sum
            + Buffer.byteLength(change.path + change.kind + change.diff, 'utf8')
            + (change.kind === 'update' && typeof change.movePath === 'string'
                ? Buffer.byteLength(change.movePath, 'utf8') : 0), 0);
    }
    if (snapshot.plan) {
        bytes += snapshot.plan.steps.length * RETAINED_ARRAY_SLOT_BYTES;
        bytes += snapshot.plan.explanation === undefined
            ? 0 : Buffer.byteLength(snapshot.plan.explanation, 'utf8');
        bytes += snapshot.plan.steps.reduce((sum, step) =>
            sum + Buffer.byteLength(step.step + step.status, 'utf8'), 0);
    }
    bytes += snapshot.diff === undefined ? 0 : Buffer.byteLength(snapshot.diff, 'utf8');
    bytes += (snapshot.warnings.length + snapshot.errors.length) * RETAINED_ARRAY_SLOT_BYTES;
    bytes += snapshot.warnings.reduce((sum, warning) =>
        sum + Buffer.byteLength(warning.type + warning.code + warning.message, 'utf8'), 0);
    bytes += snapshot.errors.reduce((sum, error) =>
        sum + Buffer.byteLength(error.type + error.code + error.message, 'utf8'), 0);
    return bytes;
}

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

        reducer.notifyMany(batchWire(batch));

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
        reducer.notifyMany(batchWire({ generation: 1, threadId: 'thread-1', turnId: 'turn-1', events }));
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
        reducer.notifyMany(batchWire({
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
        } as RideCodexEventBatch));
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
            reducer.notifyMany(batchWire({
                generation: 1, threadId: 'thread-1', turnId: 'turn-1',
                events: [{ type: 'turn-started' }, { type: 'file-patch', itemId: 'file-1', changes: [change] }]
            } as RideCodexEventBatch));
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
            maxItemBytes: 12,
            maxRetainedBytes: 128
        });
        reducer.notifyMany(batchWire({
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
        }));
        frames.shift()?.();

        const item = reducer.snapshot().items[0];
        assert.deepEqual(item.summaries, ['你你你', '']);
        assert.deepEqual(item.reasoning, ['界']);
        assert.equal(item.text, '');
    });

    it('accepts reasoning indices through 1024, rejects larger indices, and accounts for array slots', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            },
            maxItemBytes: 8,
            maxRetainedBytes: 64 * 1024
        });
        reducer.notifyMany(batchWire({
            generation: 1,
            threadId: 'thread-1',
            turnId: 'turn-1',
            events: [
                { type: 'turn-started' },
                { type: 'reasoning-summary-part', itemId: 'reasoning-1', summaryIndex: 1_024 },
                { type: 'reasoning-delta', itemId: 'reasoning-1', contentIndex: 1_024, delta: 'x' }
            ]
        }));
        assert.equal(frames.length, 1);
        frames.shift()?.();

        const boundary = reducer.snapshot();
        assert.equal(boundary.items[0].summaries.length, 1_025);
        assert.equal(boundary.items[0].reasoning.length, 1_025);
        assert.ok(boundary.retainedBytes >= (1_025 + 1_025) * 8);

        reducer.notifyMany(batchWire({
            generation: 2,
            threadId: 'thread-2',
            turnId: 'turn-2',
            events: [
                { type: 'turn-started' },
                { type: 'reasoning-summary-part', itemId: 'reasoning-2', summaryIndex: 1_025 }
            ]
        }));
        reducer.notifyMany(batchWire({
            generation: 2,
            threadId: 'thread-2',
            turnId: 'turn-2',
            events: [
                { type: 'turn-started' },
                { type: 'reasoning-delta', itemId: 'reasoning-2', contentIndex: 100_000, delta: 'unsafe' }
            ]
        }));

        assert.equal(frames.length, 0);
        assert.equal(reducer.snapshot().generation, 1);
        assert.equal(reducer.snapshot().items[0].summaries.length, 1_025);
        assert.equal(reducer.snapshot().items[0].reasoning.length, 1_025);
    });

    it('enforces one aggregate UTF-8 item budget across mixed reasoning content', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            },
            maxItemBytes: 12,
            maxRetainedBytes: 1_024
        });
        reducer.notifyMany(batchWire({
            generation: 1,
            threadId: 'thread-1',
            turnId: 'turn-1',
            events: [
                { type: 'turn-started' },
                { type: 'agent-delta', itemId: 'mixed-1', delta: 'abc' },
                { type: 'reasoning-summary-delta', itemId: 'mixed-1', summaryIndex: 0, delta: '你你' },
                { type: 'reasoning-delta', itemId: 'mixed-1', contentIndex: 0, delta: '界界' }
            ]
        }));
        frames.shift()?.();

        const snapshot = reducer.snapshot();
        const item = snapshot.items[0];
        const payloadBytes = Buffer.byteLength(item.text, 'utf8')
            + item.summaries.reduce((sum, value) => sum + Buffer.byteLength(value, 'utf8'), 0)
            + item.reasoning.reduce((sum, value) => sum + Buffer.byteLength(value, 'utf8'), 0);
        assert.equal(payloadBytes, 12);
        assert.equal(item.text, 'abc');
        assert.deepEqual(item.summaries, ['你你']);
        assert.deepEqual(item.reasoning, ['界']);
        assert.equal(snapshot.warnings.filter(warning => warning.code === 'data-truncated').length, 1);
    });

    it('enforces one aggregate UTF-8 item budget across file patch path, diff, and movePath', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            },
            maxItemBytes: 18,
            maxRetainedBytes: 1_024
        });
        reducer.notifyMany(batchWire({
            generation: 1,
            threadId: 'thread-1',
            turnId: 'turn-1',
            events: [
                { type: 'turn-started' },
                { type: 'file-output', itemId: 'file-1', delta: 'abc' },
                {
                    type: 'file-patch', itemId: 'file-1', changes: [
                        { path: '你.t', kind: 'update', diff: '+界界', movePath: '新.ts' }
                    ]
                }
            ]
        }));
        frames.shift()?.();

        const snapshot = reducer.snapshot();
        const item = snapshot.items[0];
        const payloadBytes = Buffer.byteLength(item.text, 'utf8') + item.changes.reduce((sum, change) =>
            sum + Buffer.byteLength(change.path, 'utf8')
            + Buffer.byteLength(change.diff, 'utf8')
            + (change.kind === 'update' && typeof change.movePath === 'string'
                ? Buffer.byteLength(change.movePath, 'utf8') : 0), 0);
        assert.equal(payloadBytes, 18);
        assert.deepEqual(item.changes, [
            { path: '你.t', kind: 'update', diff: '+界界', movePath: '新' }
        ]);
        assert.equal(snapshot.warnings.filter(warning => warning.code === 'data-truncated').length, 1);
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
        reducer.notifyMany(batchWire({ generation: 1, threadId: 'thread-1', turnId: 'turn-1', events }));
        frames.shift()?.();

        const snapshot = reducer.snapshot();
        assert.ok(snapshot.items.length <= 2);
        assert.ok(Buffer.byteLength(snapshot.items.find(item => item.id === 'item-4')?.text ?? '', 'utf8') <= 8);
        assert.ok(snapshot.retainedBytes <= 16);
        assert.equal(snapshot.retainedBytes, independentlyRetainedBytes(snapshot));
        assert.equal(snapshot.warnings.length, 0);
        assert.equal(snapshot.errors.length, 0);
    });

    it('accounts for plan, diff, diagnostics, item fields, and slots in one hard retained budget', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            },
            maxItemBytes: 4_096,
            maxRetainedBytes: 32,
            maxDiagnosticHistory: 128
        });
        reducer.notifyMany(batchWire({
            generation: 1, threadId: 't', turnId: 'u',
            events: [
                { type: 'turn-started' },
                {
                    type: 'turn-plan', explanation: '你'.repeat(1_000),
                    steps: [{ step: 'plan'.repeat(250), status: 'in-progress' }]
                },
                { type: 'turn-diff', diff: 'd'.repeat(1_000) },
                { type: 'warning', code: 'server-warning', message: 'w'.repeat(1_000) },
                { type: 'turn-terminal', status: 'completed' }
            ]
        }));
        frames.shift()?.();

        const snapshot = reducer.snapshot();
        assert.equal(snapshot.status, 'completed');
        assert.equal(snapshot.retainedBytes, independentlyRetainedBytes(snapshot));
        assert.ok(snapshot.retainedBytes <= 32);
        assert.ok(snapshot.warnings.filter(warning => warning.code === 'data-truncated').length <= 1);
    });

    it('caps multibyte plans and diagnostic storms while keeping retainedBytes exact', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            },
            maxItemBytes: 2_048,
            maxRetainedBytes: 4_096,
            maxDiagnosticHistory: 1_000
        });
        reducer.notifyMany(batchWire({
            generation: 1, threadId: 'thread-1', turnId: 'turn-1',
            events: [
                { type: 'turn-started' },
                {
                    type: 'turn-plan', explanation: '界'.repeat(1_000),
                    steps: Array.from({ length: 1_000 }, (_, index) => ({
                        step: `你${index}`, status: 'pending'
                    }))
                },
                ...Array.from({ length: 500 }, (_, index) => ({
                    type: 'warning' as const,
                    code: 'server-warning' as const,
                    message: `警告${index}${'你'.repeat(20)}`
                })),
                ...Array.from({ length: 500 }, (_, index) => ({
                    type: 'error' as const,
                    code: 'turn-error' as const,
                    message: `错误${index}${'界'.repeat(20)}`,
                    retryable: false
                }))
            ]
        }));
        frames.shift()?.();

        const snapshot = reducer.snapshot();
        assert.ok((snapshot.plan?.steps.length ?? 0) <= 256);
        assert.equal(snapshot.retainedBytes, independentlyRetainedBytes(snapshot));
        assert.ok(snapshot.retainedBytes <= 4_096);
        assert.ok(snapshot.warnings.filter(warning => warning.code === 'data-truncated').length <= 1);
    });

    it('keeps the truncation diagnostic inside configured count and byte caps after item eviction', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            },
            maxRetainedBytes: 128 * 1024,
            maxRetainedItems: 1,
            maxDiagnosticHistory: 2
        });
        reducer.notifyMany(batchWire({
            generation: 1, threadId: 'thread-1', turnId: 'turn-1',
            events: [
                { type: 'turn-started' },
                { type: 'item-started', itemId: 'old', itemKind: 'other' },
                { type: 'item-started', itemId: 'new', itemKind: 'other' },
                {
                    type: 'turn-plan',
                    steps: Array.from({ length: 257 }, (_, index) => ({
                        step: `step-${index}`, status: 'pending'
                    }))
                },
                { type: 'warning', code: 'server-warning', message: 'first' },
                { type: 'warning', code: 'server-warning', message: 'second' }
            ]
        }));
        frames.shift()?.();

        const snapshot = reducer.snapshot();
        assert.deepEqual(snapshot.items.map(item => item.id), ['new']);
        assert.ok(snapshot.warnings.length + snapshot.errors.length <= 2);
        assert.equal(snapshot.warnings.filter(warning => warning.code === 'data-truncated').length, 1);
        assert.equal(snapshot.retainedBytes, independentlyRetainedBytes(snapshot));
        assert.ok(snapshot.retainedBytes <= 128 * 1024);
    });

    it('preserves a capped error instead of evicting it for a truncation diagnostic', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            },
            maxRetainedBytes: 128 * 1024,
            maxDiagnosticHistory: 1
        });
        reducer.notifyMany(batchWire({
            generation: 1, threadId: 'thread-1', turnId: 'turn-1',
            events: [
                { type: 'turn-started' },
                {
                    type: 'turn-plan',
                    steps: Array.from({ length: 257 }, (_, index) => ({
                        step: `step-${index}`, status: 'pending'
                    }))
                },
                { type: 'error', code: 'turn-error', message: 'kept error', retryable: false }
            ]
        }));
        frames.shift()?.();

        const snapshot = reducer.snapshot();
        assert.deepEqual(snapshot.errors.map(error => error.message), ['kept error']);
        assert.equal(snapshot.warnings.filter(warning => warning.code === 'data-truncated').length, 0);
        assert.equal(snapshot.retainedBytes, independentlyRetainedBytes(snapshot));
    });

    it('enforces an absolute diagnostic history count even when configuration is larger', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            },
            maxRetainedBytes: 1024 * 1024,
            maxDiagnosticHistory: 1_000
        });
        reducer.notifyMany(batchWire({
            generation: 1, threadId: 'thread-1', turnId: 'turn-1',
            events: [
                { type: 'turn-started' },
                ...Array.from({ length: 500 }, (_, index) => ({
                    type: 'warning' as const,
                    code: 'server-warning' as const,
                    message: `warning-${index}`
                }))
            ]
        }));
        frames.shift()?.();

        const snapshot = reducer.snapshot();
        assert.ok(snapshot.warnings.length + snapshot.errors.length <= 256);
        assert.equal(snapshot.retainedBytes, independentlyRetainedBytes(snapshot));
        assert.ok(snapshot.retainedBytes <= 64 * 1024);
    });

    it('honors the exact retained boundary and omits diagnostics that cannot fit', () => {
        const frames: Array<() => void> = [];
        const exact = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            },
            maxRetainedBytes: 32
        });
        exact.notifyMany(batchWire({
            generation: 1, threadId: 't', turnId: 'u',
            events: [
                { type: 'turn-started' },
                { type: 'warning', code: 'server-warning', message: 'abc' }
            ]
        }));
        frames.shift()?.();
        assert.equal(exact.snapshot().retainedBytes, 32);
        assert.equal(exact.snapshot().retainedBytes, independentlyRetainedBytes(exact.snapshot()));

        const tinyFrames: Array<() => void> = [];
        const tiny = new RideCodexEventReducer({
            scheduleFrame: callback => {
                tinyFrames.push(callback);
                return { dispose: () => undefined };
            },
            maxRetainedBytes: 8
        });
        tiny.notifyMany(batchWire({
            generation: 1, threadId: 't', turnId: 'u',
            events: [
                { type: 'turn-started' },
                { type: 'warning', code: 'server-warning', message: '你'.repeat(100) }
            ]
        }));
        tinyFrames.shift()?.();
        assert.equal(tiny.snapshot().retainedBytes, 0);
        assert.equal(tiny.snapshot().warnings.length, 0);
    });

    it('ignores duplicate, late, cross-turn, and old-generation batches', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            }
        });
        reducer.notifyMany(batchWire({
            generation: 2, threadId: 'thread-1', turnId: 'turn-1',
            events: [{ type: 'turn-started' }, { type: 'turn-terminal', status: 'completed' }]
        }));
        reducer.notifyMany(batchWire({
            generation: 1, threadId: 'thread-1', turnId: 'turn-1',
            events: [{ type: 'warning', code: 'server-warning', message: 'old' }]
        }));
        reducer.notifyMany(batchWire({
            generation: 2, threadId: 'thread-1', turnId: 'turn-2',
            events: [{ type: 'warning', code: 'server-warning', message: 'cross' }]
        }));
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
        reducer.notifyMany(batchWire({
            generation: 1, threadId: 'thread-1', turnId: 'turn-1',
            events: [{ type: 'turn-started' }, { type: 'agent-delta', itemId: 'i', delta: 'queued' }]
        }));
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
        reducer.notifyMany(batchWire({
            generation: 1, threadId: 'thread-1', turnId: 'turn-1',
            events: [{ type: 'turn-started' }, { type: 'turn-terminal', status: 'completed' }]
        }));
        reducer.notifyMany(batchWire({
            generation: 1, threadId: 'thread-1', turnId: 'turn-2',
            events: [{ type: 'turn-started' }, { type: 'agent-delta', itemId: 'item-2', delta: 'new' }]
        }));
        frames.shift()?.();

        assert.equal(reducer.snapshot().turnId, 'turn-2');
        assert.equal(reducer.snapshot().status, 'in-progress');
        assert.equal(reducer.snapshot().items[0].text, 'new');
    });

    it('accepts only canonical wire strings without observing top-level objects', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            }
        });
        const notify = reducer.notifyMany.bind(reducer) as (wire: unknown) => void;
        let traps = 0;
        let getters = 0;
        const proxy = new Proxy({}, {
            get: () => { traps += 1; return undefined; },
            ownKeys: () => { traps += 1; return []; },
            getOwnPropertyDescriptor: () => { traps += 1; return undefined; },
            getPrototypeOf: () => { traps += 1; return Object.prototype; }
        });
        const accessor = Object.defineProperty({}, 'generation', {
            enumerable: true,
            get: () => {
                getters += 1;
                return 1;
            }
        });

        notify(proxy);
        notify(accessor);

        assert.equal(traps, 0);
        assert.equal(getters, 0);
        assert.equal(frames.length, 0);
        assert.equal(reducer.snapshot().status, 'idle');

        notify(JSON.stringify({
            generation: 1,
            threadId: 'thread-1',
            turnId: 'turn-1',
            events: [
                { type: 'turn-started' },
                { type: 'agent-delta', itemId: 'item-1', delta: 'canonical' }
            ]
        }));
        frames.shift()?.();

        assert.equal(reducer.snapshot().status, 'in-progress');
        assert.equal(reducer.snapshot().items[0].text, 'canonical');
    });

    it('rejects accessor-backed event data without executing getters or changing state', () => {
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
        (reducer.notifyMany as (value: unknown) => void)({
            generation: 1,
            threadId: 'thread-1',
            turnId: 'turn-1',
            events: [event as never]
        });

        assert.equal(getterCalls, 0);
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
            (reducer.notifyMany as (value: unknown) => void)(batch);
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
            maxQueuedBytes: MIN_COHERENT_QUEUE_BYTES,
            maxBatchEvents: 16
        });
        reducer.notifyMany(batchWire({
            generation: 1, threadId: 'thread-1', turnId: 'turn-1',
            events: [
                { type: 'turn-started' },
                { type: 'item-started', itemId: 'item-1', itemKind: 'agent-message' },
                { type: 'agent-delta', itemId: 'item-1', delta: 'x'.repeat(MIN_COHERENT_QUEUE_BYTES) }
            ]
        }));
        reducer.notifyMany(batchWire({
            generation: 1, threadId: 'thread-1', turnId: 'turn-1',
            events: [{ type: 'turn-terminal', status: 'completed' }]
        }));
        frames.shift()?.();

        assert.equal(reducer.snapshot().status, 'completed');
        assert.ok(reducer.snapshot().warnings.some(warning => warning.code === 'events-dropped'));
    });

    it('rejects queue budgets below the coherent worst-identity boundary', () => {
        assert.throws(() => new RideCodexEventReducer({
            maxQueuedBytes: MIN_COHERENT_QUEUE_BYTES - 1
        }));
    });

    it('uses full batch bytes consistently and preserves terminal under a delta storm', () => {
        const frames: Array<() => void> = [];
        const startWire = batchWire({
            generation: 1, threadId: 'thread-1', turnId: 'turn-1',
            events: [{ type: 'turn-started' }]
        });
        const terminalWire = batchWire({
            generation: 1, threadId: 'thread-1', turnId: 'turn-1',
            events: [{ type: 'turn-terminal', status: 'completed' }]
        });
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            },
            maxQueuedBytes: MIN_COHERENT_QUEUE_BYTES,
            maxBatchEvents: 8
        });
        reducer.notifyMany(startWire);
        for (let index = 0; index < 50; index += 1) {
            reducer.notifyMany(batchWire({
                generation: 1, threadId: 'thread-1', turnId: 'turn-1',
                events: [{ type: 'agent-delta', itemId: 'item-1', delta: `delta-${index}` }]
            }));
        }
        reducer.notifyMany(terminalWire);
        frames.shift()?.();

        assert.equal(reducer.snapshot().status, 'completed');
        assert.ok(reducer.snapshot().retainedBytes <= 2 * 1024 * 1024);
    });

    it('accepts a max-size identity start and terminal at the exact queue boundary', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            },
            maxQueuedBytes: MIN_COHERENT_QUEUE_BYTES,
            maxBatchEvents: 8
        });
        const wire = batchWire({
            generation: Number.MAX_SAFE_INTEGER,
            threadId: WORST_VALID_IDENTIFIER,
            turnId: WORST_VALID_IDENTIFIER,
            events: [
                { type: 'turn-started' },
                { type: 'turn-terminal', status: 'completed' }
            ]
        });
        assert.ok(Buffer.byteLength(wire, 'utf8') <= MIN_COHERENT_QUEUE_BYTES);
        reducer.notifyMany(wire);
        frames.shift()?.();

        assert.equal(reducer.snapshot().status, 'completed');
        assert.equal(reducer.snapshot().turnId, WORST_VALID_IDENTIFIER);
    });

    it('uses an exact terminal batch as an identity boundary when its start was compacted upstream', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            }
        });
        reducer.notifyMany(batchWire({
            generation: 1, threadId: 'thread-1', turnId: 'turn-1',
            events: [{ type: 'turn-started' }]
        }));
        reducer.notifyMany(batchWire({
            generation: 1, threadId: 'thread-1', turnId: 'turn-2',
            events: [{ type: 'turn-terminal', status: 'completed' }]
        }));
        frames.shift()?.();

        assert.equal(reducer.snapshot().turnId, 'turn-2');
        assert.equal(reducer.snapshot().status, 'completed');
    });

    it('rejects malformed, oversized, and wrong-schema wires before accepting a bounded batch', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            },
            maxWireBytes: 4_096,
            maxBatchEvents: 4,
            maxQueuedBytes: MIN_COHERENT_QUEUE_BYTES,
            maxItemBytes: 2_048
        });
        for (const wire of [
            '{',
            ` ${batchWire({
                generation: 1, threadId: 'thread-1', turnId: 'non-canonical',
                events: [{ type: 'turn-started' }]
            })}`,
            '{"generation":1,"generation":2,"threadId":"thread-1","turnId":"duplicate","events":[{"type":"turn-started"}]}',
            batchWire({
                generation: 1, threadId: 'thread-1', turnId: 'bad-turn',
                events: [{ type: 'turn-started' }, { type: 'turn-terminal' }]
            }),
            batchWire({
                generation: 1, threadId: 'thread-1', turnId: 'bad-turn', unknown: true,
                events: [{ type: 'turn-started' }]
            }),
            batchWire({
                generation: 1, threadId: 'thread-1', turnId: 'bad-turn',
                events: [{ type: 'turn-started', unknown: true }]
            }),
            batchWire({
                generation: 1, threadId: 'thread-1', turnId: 'oversized',
                events: [{ type: 'agent-delta', itemId: 'item-1', delta: 'x'.repeat(4_096) }]
            })
        ]) {
            reducer.notifyMany(wire);
        }
        assert.equal(frames.length, 0);
        assert.equal(reducer.snapshot().status, 'idle');

        reducer.notifyMany(batchWire({
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
        }));
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
            maxRetainedBytes: 128
        });
        reducer.notifyMany(batchWire({
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
        }));
        frames.shift()?.();

        assert.ok(Buffer.byteLength(reducer.snapshot().items[0].text, 'utf8') <= 8);
        assert.equal(reducer.snapshot().warnings.filter(warning => warning.code === 'data-truncated').length, 1);
    });

    it('rejects maxBatchEvents below the coherent start-terminal pair', () => {
        assert.throws(() => new RideCodexEventReducer({ maxBatchEvents: 1 }), RangeError);
    });

    it('does not let a late finalized terminal replace the current turn', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            }
        });
        reducer.notifyMany(batchWire({
            generation: 1,
            threadId: 'thread-1',
            turnId: 'turn-1',
            events: [{ type: 'turn-started' }, { type: 'turn-terminal', status: 'completed' }]
        }));
        frames.shift()?.();
        reducer.notifyMany(batchWire({
            generation: 1,
            threadId: 'thread-1',
            turnId: 'turn-2',
            events: [{ type: 'turn-started' }]
        }));
        frames.shift()?.();
        reducer.notifyMany(batchWire({
            generation: 1,
            threadId: 'thread-1',
            turnId: 'turn-1',
            events: [{ type: 'turn-terminal', status: 'completed' }]
        }));
        frames.shift()?.();

        assert.equal(reducer.snapshot().turnId, 'turn-2');
        assert.equal(reducer.snapshot().status, 'in-progress');
    });

    it('keeps finalized identity history bounded while recent duplicates remain idempotent', () => {
        const frames: Array<() => void> = [];
        const reducer = new RideCodexEventReducer({
            scheduleFrame: callback => {
                frames.push(callback);
                return { dispose: () => undefined };
            }
        });
        for (let index = 0; index < 300; index += 1) {
            reducer.notifyMany(batchWire({
                generation: 1,
                threadId: 'thread-1',
                turnId: `turn-${index}`,
                events: [{ type: 'turn-started' }, { type: 'turn-terminal', status: 'completed' }]
            }));
            frames.shift()?.();
        }
        reducer.notifyMany(batchWire({
            generation: 1,
            threadId: 'thread-1',
            turnId: 'turn-current',
            events: [{ type: 'turn-started' }]
        }));
        frames.shift()?.();
        reducer.notifyMany(batchWire({
            generation: 1,
            threadId: 'thread-1',
            turnId: 'turn-299',
            events: [{ type: 'turn-terminal', status: 'completed' }]
        }));
        frames.shift()?.();

        assert.equal(reducer.snapshot().turnId, 'turn-current');
        assert.equal(reducer.snapshot().status, 'in-progress');
    });
});
