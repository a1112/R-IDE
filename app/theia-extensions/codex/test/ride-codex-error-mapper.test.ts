/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deepFreezeRideCodex, RideCodexEventBatch } from '../src/common/ride-codex-events';
import {
    RideCodexApprovalCard,
    RideCodexApprovalDecision
} from '../src/common/ride-codex-approvals';
import {
    mapRideCodexError,
    RideCodexErrorLayer
} from '../src/browser/ride-codex-error-mapper';
import {
    createRideCodexCommandRenderModel,
    createRideCodexFileRenderModel,
    RideCodexCommandOutput,
    RideCodexFileChanges
} from '../src/browser/ride-codex-renderers';
import {
    RideCodexApprovalDialog,
    RideCodexApprovalDialogState
} from '../src/browser/ride-codex-approval-dialog';
import { RideCodexEventReducer } from '../src/browser/ride-codex-event-reducer';

interface ElementLike {
    readonly type?: unknown;
    readonly props?: Readonly<Record<string, unknown>>;
}

function visitTree(value: unknown, visitor: (element: ElementLike) => void): void {
    if (Array.isArray(value)) {
        value.forEach(child => visitTree(child, visitor));
        return;
    }
    if (!value || typeof value !== 'object') {
        return;
    }
    const element = value as ElementLike;
    visitor(element);
    visitTree(element.props?.children, visitor);
}

function textNodes(value: unknown): string[] {
    const texts: string[] = [];
    const walk = (candidate: unknown): void => {
        if (typeof candidate === 'string') {
            texts.push(candidate);
        } else if (Array.isArray(candidate)) {
            candidate.forEach(walk);
        } else if (candidate && typeof candidate === 'object') {
            walk((candidate as ElementLike).props?.children);
        }
    };
    walk(value);
    return texts;
}

function assertTextOnlyReactTree(value: unknown): void {
    visitTree(value, element => {
        assert.equal(Object.prototype.hasOwnProperty.call(element.props ?? {}, 'dangerouslySetInnerHTML'), false);
    });
}

function reducerItem(events: RideCodexEventBatch['events'], maxItemBytes = 64 * 1024) {
    const frames: Array<() => void> = [];
    const reducer = new RideCodexEventReducer({
        maxItemBytes,
        maxRetainedBytes: 256 * 1024,
        scheduleFrame: callback => {
            frames.push(callback);
            return { dispose: () => undefined };
        }
    });
    reducer.notifyMany(JSON.stringify({
        generation: 1,
        turnSequence: 1,
        threadId: 'thread-1',
        turnId: 'turn-1',
        events
    }));
    frames.shift()?.();
    const item = reducer.snapshot().items[0];
    assert.ok(item);
    return item;
}

describe('mapRideCodexError', () => {
    const cases: ReadonlyArray<Readonly<{
        signal: string;
        layer: RideCodexErrorLayer;
        code: string;
        retryable: boolean;
        action: string;
    }>> = [
        { signal: 'runtime-missing', layer: 'runtime/install', code: 'runtime-missing', retryable: true, action: 'install' },
        { signal: 'install-failed', layer: 'runtime/install', code: 'install-failed', retryable: true, action: 'retry' },
        { signal: 'startup-failed', layer: 'startup', code: 'startup-failed', retryable: true, action: 'retry' },
        { signal: 'protocol-error', layer: 'protocol', code: 'protocol-error', retryable: true, action: 'restart' },
        { signal: 'unauthorized', layer: 'auth', code: 'unauthorized', retryable: true, action: 'sign-in' },
        { signal: 'rate-limit', layer: 'turn', code: 'rate-limit', retryable: true, action: 'retry-later' },
        { signal: 'context-limit', layer: 'turn', code: 'context-limit', retryable: true, action: 'reduce-context' },
        { signal: 'sandbox-denied', layer: 'turn', code: 'sandbox-denied', retryable: false, action: 'review-sandbox' },
        { signal: 'transport-error', layer: 'protocol', code: 'transport-error', retryable: true, action: 'restart' },
        { signal: 'interrupted', layer: 'turn', code: 'interrupted', retryable: true, action: 'retry' }
    ];

    for (const entry of cases) {
        it(`maps ${entry.signal} to stable localized-safe data`, () => {
            const mapped = mapRideCodexError(entry.signal);
            assert.equal(mapped.layer, entry.layer);
            assert.equal(mapped.code, entry.code);
            assert.equal(mapped.retryable, entry.retryable);
            assert.equal(mapped.action, entry.action);
            assert.equal(typeof mapped.title, 'string');
            assert.equal(typeof mapped.message, 'string');
            assert.ok(Object.isFrozen(mapped));
            assert.doesNotMatch(JSON.stringify(mapped), /C:\\|\/Users\/|sk-[A-Za-z0-9]/u);
        });
    }

    it('does not inspect or leak errors, accessors, proxies, paths, server text, or secrets', () => {
        let getterCalls = 0;
        const accessor = Object.defineProperty({}, 'message', {
            enumerable: true,
            get: () => {
                getterCalls += 1;
                return 'C:\\Users\\alice\\private.txt sk-accessor-secret';
            }
        });
        let trapCalls = 0;
        const proxy = new Proxy({}, {
            get: () => { trapCalls += 1; return 'sk-proxy-secret'; },
            ownKeys: () => { trapCalls += 1; return []; },
            getOwnPropertyDescriptor: () => { trapCalls += 1; return undefined; },
            getPrototypeOf: () => { trapCalls += 1; return Object.prototype; }
        });
        for (const value of [
            accessor,
            proxy,
            new Error('C:\\Users\\alice\\private.txt sk-error-secret'),
            { code: 'unauthorized', data: { token: 'sk-nested-secret' } }
        ]) {
            const mapped = mapRideCodexError(value, 'startup');
            assert.deepEqual(mapped, {
                layer: 'startup',
                title: 'Codex could not start',
                message: 'Codex could not be started safely.',
                code: 'startup-error',
                retryable: true,
                action: 'retry'
            });
            assert.doesNotMatch(JSON.stringify(mapped), /alice|private|secret|sk-/iu);
        }
        assert.equal(getterCalls, 0);
        assert.equal(trapCalls, 0);
    });

    it('maps reducer-produced classified safe codes end to end', () => {
        const classified = [
            { code: 'unauthorized', layer: 'auth', action: 'sign-in' },
            { code: 'rate-limit', layer: 'turn', action: 'retry-later' },
            { code: 'context-limit', layer: 'turn', action: 'reduce-context' },
            { code: 'sandbox-denied', layer: 'turn', action: 'review-sandbox' },
            { code: 'transport-error', layer: 'protocol', action: 'restart' }
        ] as const;
        for (const entry of classified) {
            const frames: Array<() => void> = [];
            const reducer = new RideCodexEventReducer({
                scheduleFrame: callback => {
                    frames.push(callback);
                    return { dispose: () => undefined };
                }
            });
            reducer.notifyMany(JSON.stringify({
                generation: 1,
                turnSequence: 1,
                threadId: 'thread-1',
                turnId: 'turn-1',
                events: [
                    { type: 'turn-started' },
                    {
                        type: 'error', code: entry.code,
                        message: 'fixed coordinator message', retryable: false
                    }
                ]
            }));
            frames.shift()?.();
            const reduced = reducer.snapshot().errors[0];
            assert.ok(reduced, entry.code);

            const mapped = mapRideCodexError(reduced.code);
            assert.equal(mapped.code, entry.code);
            assert.equal(mapped.layer, entry.layer);
            assert.equal(mapped.action, entry.action);
            assert.doesNotMatch(JSON.stringify(mapped), /coordinator|server|secret|api.?key/iu);
        }
    });
});

describe('RideCodex approval dialog', () => {
    it('renders immutable safe fields and exactly the broker-provided decisions as React text', () => {
        const card = deepFreezeRideCodex({
            kind: 'command',
            token: 'opaque-token',
            fingerprint: 'opaque-fingerprint',
            expiresAt: 2_000,
            command: '<img src=x onerror=alert(1)> & exact',
            cwd: 'C:\\workspace\\safe',
            reason: '<script>reason</script>',
            network: { host: 'registry.example.test', protocol: 'https' },
            allowedDecisions: ['accept', 'decline', 'cancel']
        }) as RideCodexApprovalCard;
        const state: RideCodexApprovalDialogState = Object.freeze({ approval: card, busy: false });
        const selected: string[] = [];
        const tree = RideCodexApprovalDialog({
            state,
            onDecision: (decision: RideCodexApprovalDecision) => selected.push(decision)
        });
        const decisions: string[] = [];
        visitTree(tree, element => {
            if (element.type === 'button') {
                decisions.push(String(element.props?.['data-decision']));
                (element.props?.onClick as (() => void) | undefined)?.();
            }
        });

        assert.deepEqual(decisions, ['accept', 'decline', 'cancel']);
        assert.deepEqual(selected, decisions);
        assert.equal(decisions.includes('acceptForSession'), false);
        assert.equal(decisions.includes('grantRoot'), false);
        assert.ok(textNodes(tree).includes('<img src=x onerror=alert(1)> & exact'));
        assert.ok(textNodes(tree).includes('<script>reason</script>'));
        assertTextOnlyReactTree(tree);
    });
});

describe('RideCodex command and file renderers', () => {
    it('accepts only reducer-provenance items and rejects proxies without invoking traps', () => {
        const forged = deepFreezeRideCodex({
            id: 'forged',
            kind: 'command',
            state: 'completed',
            text: 'must not render',
            summaries: [],
            reasoning: [],
            changes: []
        });
        assert.equal(createRideCodexCommandRenderModel(forged as never), undefined);

        let trapCalls = 0;
        const target = Object.preventExtensions({});
        const proxy = new Proxy(target, {
            ownKeys: () => { trapCalls += 1; return []; },
            getOwnPropertyDescriptor: () => { trapCalls += 1; return undefined; },
            get: () => { trapCalls += 1; return undefined; }
        });
        assert.equal(createRideCodexCommandRenderModel(proxy as never), undefined);
        assert.equal(createRideCodexFileRenderModel(proxy as never), undefined);
        assert.equal(trapCalls, 0);
    });

    it('uses reducer-owned UTF-8 truncation metadata for multibyte command output', () => {
        const item = reducerItem([
            { type: 'turn-started' },
            { type: 'item-started', itemId: 'command-1', itemKind: 'command' },
            { type: 'command-output', itemId: 'command-1', delta: '你a界b' }
        ], 5);
        const model = createRideCodexCommandRenderModel(item);

        assert.deepEqual(model, {
            kind: 'command',
            output: '你a',
            truncation: {
                truncated: true,
                omittedUtf8Bytes: 4,
                omittedChanges: 0,
                omittedPaths: 0
            }
        });
        assert.ok(Object.isFrozen(model));
        assert.ok(Object.isFrozen(model?.truncation));
    });

    it('represents add/delete/update/move deterministically and renders unsafe text without raw HTML', () => {
        const item = reducerItem([
            { type: 'turn-started' },
            { type: 'item-started', itemId: 'file-1', itemKind: 'file-change' },
            {
                type: 'file-patch',
                itemId: 'file-1',
                changes: [
                    { path: '<img>.ts', kind: 'add', diff: '<script>add</script>' },
                    { path: 'old.ts', kind: 'delete', diff: '-old' },
                    { path: 'same.ts', kind: 'update', diff: '+new' },
                    { path: 'from.ts', kind: 'update', movePath: 'to.ts', diff: 'move' }
                ]
            }
        ]);
        const model = createRideCodexFileRenderModel(item);

        assert.deepEqual(model, {
            kind: 'file-change',
            changes: [
                { operation: 'add', path: '<img>.ts', diff: '<script>add</script>' },
                { operation: 'delete', path: 'old.ts', diff: '-old' },
                { operation: 'update', path: 'same.ts', diff: '+new' },
                { operation: 'move', fromPath: 'from.ts', toPath: 'to.ts', diff: 'move' }
            ],
            truncation: {
                truncated: false,
                omittedUtf8Bytes: 0,
                omittedChanges: 0,
                omittedPaths: 0
            }
        });
        const tree = RideCodexFileChanges({ model: model! });
        assert.ok(textNodes(tree).includes('<img>.ts'));
        assert.ok(textNodes(tree).includes('<script>add</script>'));
        assertTextOnlyReactTree(tree);
    });

    it('applies aggregate output, change, path, and patch limits with deterministic metadata', () => {
        const commandItem = reducerItem([
            { type: 'turn-started' },
            { type: 'command-output', itemId: 'command-1', delta: '你a界b' }
        ]);
        const command = createRideCodexCommandRenderModel(commandItem, { maxOutputBytes: 4 });
        assert.equal(command?.output, '你a');
        assert.equal(command?.truncation.omittedUtf8Bytes, 4);

        const fileItem = reducerItem([
            { type: 'turn-started' },
            {
                type: 'file-patch',
                itemId: 'file-1',
                changes: [
                    { path: 'long-name-one.ts', kind: 'add', diff: 'abcdef' },
                    { path: 'long-name-two.ts', kind: 'delete', diff: 'ghijkl' },
                    { path: 'third.ts', kind: 'update', diff: 'mnopqr' }
                ]
            }
        ]);
        const files = createRideCodexFileRenderModel(fileItem, {
            maxChanges: 2,
            maxPathBytes: 8,
            maxPatchBytes: 4,
            maxTotalBytes: 20
        });
        assert.deepEqual(files?.changes, [
            { operation: 'add', path: 'long-nam', diff: 'abcd' }
        ]);
        assert.deepEqual(files?.truncation, {
            truncated: true,
            omittedUtf8Bytes: 46,
            omittedChanges: 2,
            omittedPaths: 1
        });
        const commandTree = RideCodexCommandOutput({ model: command! });
        assertTextOnlyReactTree(commandTree);
    });
});
