/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    RIDE_CODEX_MIN_QUEUED_BYTES,
    type RideCodexEventBatch,
    type RideCodexUiEvent
} from '../src/common/ride-codex-events';
import type { RideCodexNotification } from '../src/node/ride-codex-jsonl-client';
import {
    RideCodexTurnCoordinator,
    RideCodexTurnHost,
    RideCodexTurnHostLease,
    RideCodexTurnScheduler
} from '../src/node/ride-codex-turn-coordinator';

const WORST_VALID_IDENTIFIER = '\u0000'.repeat(512);
const MIN_COHERENT_QUEUE_BYTES = RIDE_CODEX_MIN_QUEUED_BYTES;

function validTurn(id = 'turn-1', status = 'inProgress'): Record<string, unknown> {
    return {
        id,
        items: [],
        itemsView: 'full',
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null
    };
}

function validThread(id = 'thread-1'): Record<string, unknown> {
    return {
        id,
        sessionId: 'session-1',
        forkedFromId: null,
        parentThreadId: null,
        preview: '',
        ephemeral: false,
        modelProvider: 'openai',
        createdAt: 1,
        updatedAt: 1,
        recencyAt: null,
        status: { type: 'idle' },
        path: null,
        cwd: 'C:\\workspace',
        cliVersion: '0.144.0',
        source: 'appServer',
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: []
    };
}

function validResumeResponse(threadId = 'thread-1'): Record<string, unknown> {
    return {
        thread: validThread(threadId),
        model: 'gpt-5.4',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: 'C:\\workspace',
        instructionSources: [],
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: {
            type: 'workspaceWrite',
            writableRoots: ['C:\\workspace'],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false
        },
        reasoningEffort: null
    };
}

function validThreadItems(): Record<string, unknown>[] {
    return [
        {
            type: 'userMessage', id: 'user-1', clientId: null,
            content: [
                {
                    type: 'text', text: 'hello',
                    text_elements: [
                        { byteRange: { start: 0, end: 5 }, placeholder: null },
                        { byteRange: { start: 5, end: 5 }, placeholder: 'cursor' }
                    ]
                },
                { type: 'image', detail: 'original', url: 'https://example.test/image.png' },
                { type: 'image', detail: 'auto', url: 'https://example.test/auto.png' },
                { type: 'image', detail: 'low', url: 'https://example.test/low.png' },
                { type: 'image', detail: 'high', url: 'https://example.test/high.png' },
                { type: 'localImage', path: 'C:\\workspace\\image.png' },
                { type: 'skill', name: 'review', path: 'C:\\skills\\review' },
                { type: 'mention', name: 'README', path: 'C:\\workspace\\README.md' }
            ]
        },
        {
            type: 'hookPrompt', id: 'hook-1',
            fragments: [{ text: 'review', hookRunId: 'run-1' }]
        },
        {
            type: 'agentMessage', id: 'agent-1', text: 'done', phase: 'final_answer',
            memoryCitation: {
                entries: [{ path: 'memory.md', lineStart: 1, lineEnd: 2, note: 'context' }],
                threadIds: ['thread-memory']
            }
        },
        { type: 'plan', id: 'plan-1', text: 'step' },
        { type: 'reasoning', id: 'reasoning-1', summary: ['summary'], content: ['detail'] },
        {
            type: 'commandExecution', id: 'command-1', command: 'Get-ChildItem', cwd: 'C:\\workspace',
            processId: null, source: 'agent', status: 'completed',
            commandActions: [
                { type: 'read', command: 'Get-Content README.md', name: 'README', path: 'C:\\workspace\\README.md' },
                { type: 'listFiles', command: 'Get-ChildItem', path: null },
                { type: 'search', command: 'rg Codex', query: 'Codex', path: 'C:\\workspace' },
                { type: 'unknown', command: 'custom-tool' }
            ],
            aggregatedOutput: 'README.md', exitCode: 0, durationMs: 1
        },
        {
            type: 'fileChange', id: 'file-1', status: 'completed',
            changes: [
                { path: 'added.txt', kind: { type: 'add' }, diff: '+added' },
                { path: 'deleted.txt', kind: { type: 'delete' }, diff: '-deleted' },
                { path: 'old.txt', kind: { type: 'update', move_path: 'new.txt' }, diff: 'renamed' },
                { path: 'same.txt', kind: { type: 'update', move_path: null }, diff: 'changed' }
            ]
        },
        {
            type: 'mcpToolCall', id: 'mcp-1', server: 'server', tool: 'tool', status: 'completed',
            arguments: { query: 'value', nested: [1, true, null] },
            appContext: {
                connectorId: 'connector', linkId: null, resourceUri: 'resource://one',
                appName: 'App', templateId: null, actionName: 'Run'
            },
            mcpAppResourceUri: 'resource://legacy', pluginId: 'plugin',
            result: {
                content: [{ type: 'text', text: 'result' }],
                structuredContent: { ok: true }, _meta: { trace: 'one' }
            },
            error: null, durationMs: 2
        },
        {
            type: 'mcpToolCall', id: 'mcp-2', server: '', tool: '', status: 'failed',
            arguments: null, appContext: null, pluginId: null, result: null,
            error: { message: 'failed' }, durationMs: null
        },
        {
            type: 'dynamicToolCall', id: 'dynamic-1', namespace: 'tools', tool: 'run',
            arguments: { value: 1 }, status: 'completed',
            contentItems: [
                { type: 'inputText', text: 'output' },
                { type: 'inputImage', imageUrl: 'https://example.test/result.png' }
            ],
            success: true, durationMs: 3
        },
        {
            type: 'dynamicToolCall', id: 'dynamic-2', namespace: null, tool: '',
            arguments: [], status: 'inProgress', contentItems: null, success: null, durationMs: null
        },
        {
            type: 'collabAgentToolCall', id: 'collab-1', tool: 'spawnAgent', status: 'completed',
            senderThreadId: 'thread-1', receiverThreadIds: ['thread-2'], prompt: 'review',
            model: 'gpt-5.4', reasoningEffort: 'high',
            agentsStates: { 'thread-2': { status: 'running', message: null } }
        },
        {
            type: 'collabAgentToolCall', id: 'collab-2', tool: 'closeAgent', status: 'failed',
            senderThreadId: 'thread-1', receiverThreadIds: [], prompt: null,
            model: null, reasoningEffort: null,
            agentsStates: {
                pending: { status: 'pendingInit', message: null },
                interrupted: { status: 'interrupted', message: '' },
                completed: { status: 'completed', message: null },
                errored: { status: 'errored', message: 'failed' },
                shutdown: { status: 'shutdown', message: null },
                missing: { status: 'notFound', message: null }
            }
        },
        {
            type: 'subAgentActivity', id: 'sub-1', kind: 'interacted',
            agentThreadId: 'thread-2', agentPath: 'agent/path'
        },
        {
            type: 'webSearch', id: 'web-1', query: 'Codex',
            action: { type: 'search', query: 'Codex', queries: ['Codex 0.144'] }
        },
        {
            type: 'webSearch', id: 'web-2', query: 'page',
            action: { type: 'openPage', url: 'https://example.test' }
        },
        {
            type: 'webSearch', id: 'web-3', query: 'find',
            action: { type: 'findInPage', url: null, pattern: 'Codex' }
        },
        { type: 'webSearch', id: 'web-4', query: '', action: { type: 'other' } },
        { type: 'webSearch', id: 'web-5', query: '', action: null },
        { type: 'imageView', id: 'view-1', path: 'C:\\workspace\\image.png' },
        { type: 'sleep', id: 'sleep-1', durationMs: 1 },
        {
            type: 'imageGeneration', id: 'image-1', status: 'completed', revisedPrompt: null,
            result: 'generated', savedPath: 'C:\\workspace\\generated.png'
        },
        {
            type: 'imageGeneration', id: 'image-2', status: '', revisedPrompt: 'prompt', result: ''
        },
        { type: 'enteredReviewMode', id: 'review-in', review: 'Review changes' },
        { type: 'exitedReviewMode', id: 'review-out', review: '' },
        { type: 'contextCompaction', id: 'compact-1' }
    ];
}

function decodeBatch(wire: string): RideCodexEventBatch {
    return JSON.parse(wire) as RideCodexEventBatch;
}

class FakeScheduler implements RideCodexTurnScheduler {
    readonly callbacks: Array<() => void> = [];

    schedule(callback: () => void) {
        let disposed = false;
        this.callbacks.push(() => {
            if (!disposed) {
                callback();
            }
        });
        return { dispose: () => { disposed = true; } };
    }

    flushOne(): void {
        this.callbacks.shift()?.();
    }
}

class FakeTurnHost implements RideCodexTurnHost {
    readonly calls: Array<Readonly<{ method: string; params: unknown }>> = [];
    releases = 0;
    restartCalls: number[] = [];
    generation = 1;
    interruptPromise: Promise<unknown> | undefined;
    startPromise: Promise<unknown> | undefined;
    steerPromise: Promise<unknown> | undefined;
    nextTurnId = 'turn-1';
    steerTurnId = 'turn-1';
    rejectMethod: string | undefined;
    restartPromise: Promise<number> | undefined;
    resumeResponse: unknown = validResumeResponse();
    readonly #notifications = new Set<(notification: RideCodexNotification, generation: number) => void>();
    readonly #states = new Set<(event: Readonly<{ state: 'ready'; generation: number }>) => void>();

    async acquire(kind: 'active-turn' | 'foreground-panel'): Promise<RideCodexTurnHostLease> {
        return {
            generation: this.generation,
            request: (method, params) => {
                this.calls.push(Object.freeze({ method, params }));
                if (method === this.rejectMethod) {
                    throw new Error('C:\\secret\\workspace apiKey=plain-secret');
                }
                if (method === 'turn/start') {
                    if (this.startPromise) {
                        return this.startPromise;
                    }
                    return { turn: validTurn(this.nextTurnId) };
                }
                if (method === 'turn/steer') {
                    if (this.steerPromise) {
                        return this.steerPromise;
                    }
                    return { turnId: this.steerTurnId };
                }
                if (method === 'turn/interrupt' && this.interruptPromise) {
                    return this.interruptPromise;
                }
                if (method === 'thread/resume') {
                    return this.resumeResponse;
                }
                return {};
            },
            release: () => {
                this.releases += 1;
            }
        };
    }

    onNotification(listener: (notification: RideCodexNotification, generation: number) => void) {
        this.#notifications.add(listener);
        return { dispose: () => this.#notifications.delete(listener) };
    }

    onStateChange(listener: (event: Readonly<{ state: 'ready'; generation: number }>) => void) {
        this.#states.add(listener);
        return { dispose: () => this.#states.delete(listener) };
    }

    snapshot() {
        return Object.freeze({ state: 'ready' as const, generation: this.generation });
    }

    async restartForRecovery(expectedGeneration: number): Promise<number> {
        this.restartCalls.push(expectedGeneration);
        if (this.restartPromise) {
            return this.restartPromise;
        }
        this.generation += 1;
        return this.generation;
    }

    emit(method: string, params: unknown): void {
        for (const listener of [...this.#notifications]) {
            listener(Object.freeze({ method, params }) as RideCodexNotification, this.generation);
        }
    }


    emitState(state: 'ready' | 'restarting' | 'circuit-open' | 'disposed', generation = this.generation): void {
        for (const listener of [...this.#states]) {
            listener(Object.freeze({ state, generation }) as Readonly<{ state: 'ready'; generation: number }>);
        }
    }
}

describe('RideCodexTurnCoordinator minimal streaming contract', () => {
    it('sends exact start, steer expectedTurnId, and interrupt calls', async () => {
        const host = new FakeTurnHost();
        const coordinator = new RideCodexTurnCoordinator({ host });
        const service = coordinator.connectClient({ turnEvents: () => undefined });

        await service.startTurn({
            threadId: 'thread-1',
            clientMessageId: 'client-message-1',
            input: [{ type: 'text', text: 'hello' }]
        });
        await service.steerTurn({
            threadId: 'thread-1',
            expectedTurnId: 'turn-1',
            input: [{ type: 'local-image', path: 'C:\\workspace\\image.png' }]
        });
        const interrupting = service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });
        await Promise.resolve();
        host.emit('turn/completed', {
            threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted', items: [] }
        });
        await interrupting;

        assert.deepEqual(host.calls, [
            {
                method: 'turn/start',
                params: {
                    threadId: 'thread-1',
                    clientUserMessageId: 'client-message-1',
                    input: [{ type: 'text', text: 'hello', text_elements: [] }]
                }
            },
            {
                method: 'turn/steer',
                params: {
                    threadId: 'thread-1',
                    expectedTurnId: 'turn-1',
                    input: [{ type: 'localImage', path: 'C:\\workspace\\image.png' }]
                }
            },
            {
                method: 'turn/interrupt',
                params: { threadId: 'thread-1', turnId: 'turn-1' }
            }
        ]);
    });

    it('holds the active-turn lease until a matching terminal notification', async () => {
        const host = new FakeTurnHost();
        const coordinator = new RideCodexTurnCoordinator({ host });
        const service = coordinator.connectClient({ turnEvents: () => undefined });

        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }] });
        assert.equal(host.releases, 0);

        host.emit('turn/completed', {
            threadId: 'thread-1',
            turn: { id: 'turn-1', status: 'completed', items: [] }
        });

        assert.equal(host.releases, 1);
        await coordinator.dispose();
        assert.equal(host.releases, 1);
    });

    it('coalesces 1000 backend agent deltas into one scheduled immutable batch', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const wires: string[] = [];
        const coordinator = new RideCodexTurnCoordinator({
            host,
            scheduler,
            maxQueuedBytes: MIN_COHERENT_QUEUE_BYTES,
            maxItemBytes: 2_048
        });
        const service = coordinator.connectClient({ turnEvents: wire => { wires.push(wire); } });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }] });
        host.emit('item/started', {
            threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 1,
            item: { type: 'agentMessage', id: 'item-1', text: '', phase: null, memoryCitation: null }
        });
        for (let index = 0; index < 1_000; index += 1) {
            host.emit('item/agentMessage/delta', {
                threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'x'
            });
        }

        assert.equal(wires.length, 0);
        assert.equal(scheduler.callbacks.length, 1);
        scheduler.flushOne();
        await Promise.resolve();

        assert.equal(wires.length, 1);
        const batch = decodeBatch(wires[0]);
        const delta = batch.events.find(event => event.type === 'agent-delta') as
            | Extract<RideCodexUiEvent, { delta: string }>
            | undefined;
        assert.equal(delta?.delta, 'x'.repeat(1_000));
    });

    it('delivers a primitive bounded JSON wire with exact event fidelity', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const deliveries: unknown[] = [];
        const coordinator = new RideCodexTurnCoordinator({ host, scheduler, maxQueuedBytes: MIN_COHERENT_QUEUE_BYTES });
        const service = coordinator.connectClient({
            turnEvents: wire => { deliveries.push(wire); }
        });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }] });
        host.emit('turn/started', {
            threadId: 'thread-1',
            turn: { id: 'turn-1', status: 'inProgress', items: [] }
        });
        host.emit('item/started', {
            threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 1,
            item: { type: 'agentMessage', id: 'item-1', text: '', phase: null, memoryCitation: null }
        });
        host.emit('item/agentMessage/delta', {
            threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: '你好'
        });
        scheduler.flushOne();
        await Promise.resolve();

        assert.equal(deliveries.length, 1);
        assert.equal(typeof deliveries[0], 'string');
        const wire = deliveries[0] as string;
        assert.ok(Buffer.byteLength(wire, 'utf8') <= 4_096);
        assert.deepEqual(JSON.parse(wire), {
            generation: 1,
            threadId: 'thread-1',
            turnId: 'turn-1',
            events: [
                { type: 'turn-started' },
                { type: 'item-started', itemId: 'item-1', itemKind: 'agent-message' },
                { type: 'agent-delta', itemId: 'item-1', delta: '你好' }
            ]
        });
    });

    it('normalizes the reviewed turn, item, reasoning, plan, command, file, usage, warning, and error families', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const eventTypes: string[] = [];
        const normalizedEvents: RideCodexUiEvent[] = [];
        const coordinator = new RideCodexTurnCoordinator({ host, scheduler });
        const service = coordinator.connectClient({
            turnEvents: wire => {
                const batch = decodeBatch(wire);
                eventTypes.push(...batch.events.map(event => event.type));
                normalizedEvents.push(...batch.events);
            }
        });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }] });
        const base = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' };
        host.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [] } });
        host.emit('item/started', {
            ...base, startedAtMs: 1,
            item: { type: 'reasoning', id: 'item-1', summary: [], content: [] }
        });
        host.emit('item/reasoning/summaryTextDelta', { ...base, summaryIndex: 0, delta: 'why' });
        host.emit('item/reasoning/summaryPartAdded', { ...base, summaryIndex: 1 });
        host.emit('item/reasoning/textDelta', { ...base, contentIndex: 0, delta: 'details' });
        host.emit('item/plan/delta', { ...base, delta: 'plan delta' });
        host.emit('item/commandExecution/outputDelta', { ...base, delta: 'stdout' });
        host.emit('item/fileChange/outputDelta', { ...base, delta: 'patch output' });
        host.emit('item/fileChange/patchUpdated', {
            ...base,
            changes: [
                { path: 'src/added.ts', kind: { type: 'add' }, diff: '+added' },
                { path: 'src/deleted.ts', kind: { type: 'delete' }, diff: '-deleted' },
                { path: 'src/updated.ts', kind: { type: 'update', move_path: null }, diff: '' },
                { path: 'src/old-name.ts', kind: { type: 'update', move_path: 'src/new-name.ts' }, diff: 'renamed' }
            ]
        });
        host.emit('turn/plan/updated', {
            threadId: 'thread-1', turnId: 'turn-1', explanation: 'next',
            plan: [{ step: 'build', status: 'inProgress' }]
        });
        host.emit('turn/diff/updated', { threadId: 'thread-1', turnId: 'turn-1', diff: '+line' });
        host.emit('thread/tokenUsage/updated', {
            threadId: 'thread-1', turnId: 'turn-1',
            tokenUsage: { total: { totalTokens: 10, inputTokens: 4, cachedInputTokens: 1, outputTokens: 6, reasoningOutputTokens: 2 }, last: null, modelContextWindow: 100 }
        });
        host.emit('warning', { threadId: 'thread-1', message: 'bounded warning' });
        host.emit('error', {
            threadId: 'thread-1', turnId: 'turn-1', willRetry: false,
            error: { message: 'safe failure', codexErrorInfo: null, additionalDetails: null }
        });
        host.emit('item/completed', {
            ...base, completedAtMs: 2,
            item: { type: 'reasoning', id: 'item-1', summary: ['why'], content: [] }
        });
        scheduler.flushOne();
        await Promise.resolve();

        for (const expected of [
            'turn-started', 'item-started', 'reasoning-summary-delta', 'reasoning-summary-part', 'reasoning-delta',
            'plan-delta', 'command-output', 'file-output', 'file-patch', 'turn-plan', 'turn-diff',
            'token-usage', 'warning', 'error', 'item-completed'
        ]) {
            assert.ok(eventTypes.includes(expected), `missing ${expected}`);
        }
        const patchEvent = normalizedEvents.find(
            (event): event is Extract<RideCodexUiEvent, { type: 'file-patch' }> => event.type === 'file-patch'
        );
        assert.deepEqual(patchEvent?.changes, [
            { path: 'src/added.ts', kind: 'add', diff: '+added' },
            { path: 'src/deleted.ts', kind: 'delete', diff: '-deleted' },
            { path: 'src/updated.ts', kind: 'update', diff: '', movePath: null },
            { path: 'src/old-name.ts', kind: 'update', diff: 'renamed', movePath: 'src/new-name.ts' }
        ]);
        assert.deepEqual(normalizedEvents.find(event => event.type === 'reasoning-delta'), {
            type: 'reasoning-delta', itemId: 'item-1', contentIndex: 0, delta: 'details'
        });
    });

    it('keeps reasoning summary, part, and text streams distinct at UTF-8 boundaries', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const events: RideCodexUiEvent[] = [];
        const coordinator = new RideCodexTurnCoordinator({ host, scheduler, maxItemBytes: 8 });
        const service = coordinator.connectClient({ turnEvents: wire => { events.push(...decodeBatch(wire).events); } });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        const base = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1' };
        host.emit('item/started', {
            ...base, startedAtMs: 1,
            item: { type: 'reasoning', id: 'reasoning-1', summary: [], content: [] }
        });
        host.emit('item/reasoning/summaryTextDelta', { ...base, summaryIndex: 0, delta: '你你你' });
        host.emit('item/reasoning/summaryPartAdded', { ...base, summaryIndex: 1 });
        host.emit('item/reasoning/textDelta', { ...base, contentIndex: 0, delta: '界界界' });
        scheduler.flushOne();
        await Promise.resolve();

        const summary = events.find(event => event.type === 'reasoning-summary-delta');
        const part = events.find(event => event.type === 'reasoning-summary-part');
        const reasoning = events.find(event => event.type === 'reasoning-delta');
        assert.equal(summary?.type === 'reasoning-summary-delta' ? Buffer.byteLength(summary.delta, 'utf8') : -1, 6);
        assert.deepEqual(part, { type: 'reasoning-summary-part', itemId: 'reasoning-1', summaryIndex: 1 });
        assert.equal(reasoning?.type === 'reasoning-delta' ? Buffer.byteLength(reasoning.delta, 'utf8') : -1, 6);
    });

    it('ignores cross-thread, cross-turn, old-generation, duplicate terminal, and late notifications', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const types: string[] = [];
        const coordinator = new RideCodexTurnCoordinator({ host, scheduler });
        const service = coordinator.connectClient({ turnEvents: wire => { types.push(...decodeBatch(wire).events.map(event => event.type)); } });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }] });
        host.emit('item/agentMessage/delta', { threadId: 'thread-2', turnId: 'turn-1', itemId: 'i', delta: 'bad' });
        host.emit('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-2', itemId: 'i', delta: 'bad' });
        host.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } });
        host.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', items: [] } });
        host.emit('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'i', delta: 'late' });
        host.generation = 2;
        host.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } });
        scheduler.flushOne();
        await Promise.resolve();

        assert.equal(types.filter(type => type === 'turn-terminal').length, 1);
        assert.equal(types.filter(type => type === 'agent-delta').length, 0);
        assert.equal(host.releases, 1);
    });

    it('keeps frontend delivery single-flight and disconnects a throwing client without affecting peers', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        let resolveSlow!: () => void;
        const slow = new Promise<void>(resolve => { resolveSlow = resolve; });
        let slowCalls = 0;
        let healthyCalls = 0;
        const coordinator = new RideCodexTurnCoordinator({ host, scheduler, maxBatchEvents: 8 });
        const owner = coordinator.connectClient({ turnEvents: () => { slowCalls += 1; return slow; } });
        coordinator.connectClient({ turnEvents: () => { throw new Error('frontend failed'); } });
        coordinator.connectClient({ turnEvents: () => { healthyCalls += 1; } });
        await owner.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }] });

        for (let index = 0; index < 20; index += 1) {
            host.emit('warning', { threadId: 'thread-1', message: `warning ${index}` });
            scheduler.flushOne();
        }
        await Promise.resolve();

        assert.equal(slowCalls, 1);
        assert.ok(healthyCalls > 1);
        resolveSlow();
        await Promise.resolve();
        await Promise.resolve();
        assert.ok(slowCalls <= 2);
    });

    it('marks interrupt timeout uncertain, releases the old lease, restarts once, and resumes the persistent thread', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const timeoutCallbacks: Array<() => void> = [];
        host.interruptPromise = Promise.resolve({});
        let clearedTimers = 0;
        const coordinator = new RideCodexTurnCoordinator({
            host,
            scheduler,
            interruptTimeoutMs: 25,
            timers: {
                setTimeout: callback => { timeoutCallbacks.push(callback); return callback; },
                clearTimeout: () => { clearedTimers += 1; }
            }
        });
        const service = coordinator.connectClient({ turnEvents: () => undefined });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }] });
        const interrupting = service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });
        let settled = false;
        void interrupting.finally(() => { settled = true; });
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(settled, false, 'an empty interrupt ACK is not a terminal result');
        timeoutCallbacks.shift()?.();

        const result = await interrupting;

        assert.equal(result.status, 'interrupt-uncertain');
        assert.deepEqual(host.restartCalls, [1]);
        assert.equal(host.releases, 2);
        assert.deepEqual(host.calls[host.calls.length - 1], {
            method: 'thread/resume',
            params: { threadId: 'thread-1' }
        });
        assert.equal(clearedTimers, 1);
    });

    it('rejects turn/start while interrupt recovery restart is pending', async () => {
        const host = new FakeTurnHost();
        const timeoutCallbacks: Array<() => void> = [];
        let resolveRestart!: (generation: number) => void;
        host.interruptPromise = Promise.resolve({});
        host.restartPromise = new Promise(resolve => { resolveRestart = resolve; });
        const coordinator = new RideCodexTurnCoordinator({
            host,
            interruptTimeoutMs: 10,
            timers: {
                setTimeout: callback => { timeoutCallbacks.push(callback); return callback; },
                clearTimeout: () => undefined
            }
        });
        const service = coordinator.connectClient({ turnEvents: () => undefined });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        const interrupting = service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });
        await Promise.resolve();
        timeoutCallbacks.shift()?.();
        await Promise.resolve();

        await assert.rejects(
            service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'two' }] }),
            error => (error as { code?: string }).code === 'operation-superseded'
        );
        assert.equal(host.calls.filter(call => call.method === 'turn/start').length, 1);

        host.generation = 2;
        resolveRestart(2);
        await interrupting;
        await coordinator.dispose();
    });

    it('linearizes interrupt-uncertain before synchronous recovery host state changes', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const timeoutCallbacks: Array<() => void> = [];
        const events: RideCodexUiEvent[] = [];
        host.interruptPromise = Promise.resolve({});
        const restart = host.restartForRecovery.bind(host);
        host.restartForRecovery = expectedGeneration => {
            host.emitState('restarting', expectedGeneration);
            return restart(expectedGeneration);
        };
        const coordinator = new RideCodexTurnCoordinator({
            host, scheduler, interruptTimeoutMs: 10,
            timers: {
                setTimeout: callback => { timeoutCallbacks.push(callback); return callback; },
                clearTimeout: () => undefined
            }
        });
        const service = coordinator.connectClient({
            turnEvents: wire => { events.push(...decodeBatch(wire).events); }
        });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        const interrupting = service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });
        timeoutCallbacks.shift()?.();
        assert.equal((await interrupting).status, 'interrupt-uncertain');
        while (scheduler.callbacks.length > 0) {
            scheduler.flushOne();
            await Promise.resolve();
        }

        assert.deepEqual(
            events.filter(event => event.type === 'turn-terminal').map(event => event.status),
            ['interrupt-uncertain']
        );
        await coordinator.dispose();
    });

    it('adopts the recovered generation before the next turn receives notifications', async () => {
        const host = new FakeTurnHost();
        const timeoutCallbacks: Array<() => void> = [];
        host.interruptPromise = Promise.resolve({});
        const coordinator = new RideCodexTurnCoordinator({
            host,
            interruptTimeoutMs: 10,
            timers: {
                setTimeout: callback => { timeoutCallbacks.push(callback); return callback; },
                clearTimeout: () => undefined
            }
        });
        const service = coordinator.connectClient({ turnEvents: () => undefined });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        const interrupting = service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });
        timeoutCallbacks.shift()?.();
        await interrupting;

        host.nextTurnId = 'turn-2';
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'two' }] });
        host.emit('turn/completed', {
            threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed', items: [] }
        });
        host.nextTurnId = 'turn-3';
        assert.equal((await service.startTurn({
            threadId: 'thread-1', input: [{ type: 'text', text: 'three' }]
        })).turnId, 'turn-3');
        await coordinator.dispose();
    });

    it('blocks host-overlapping operations and client rebinding until one recovery completes', async () => {
        const host = new FakeTurnHost();
        const timeoutCallbacks: Array<() => void> = [];
        let resolveRestart!: (generation: number) => void;
        host.interruptPromise = Promise.resolve({});
        host.restartPromise = new Promise(resolve => { resolveRestart = resolve; });
        const coordinator = new RideCodexTurnCoordinator({
            host,
            interruptTimeoutMs: 10,
            timers: {
                setTimeout: callback => { timeoutCallbacks.push(callback); return callback; },
                clearTimeout: () => undefined
            }
        });
        const client = { turnEvents: () => undefined };
        const service = coordinator.connectClient(client);
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        const interrupting = service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });
        await Promise.resolve();
        const fireTimeout = timeoutCallbacks.shift();
        fireTimeout?.();
        fireTimeout?.();
        await Promise.resolve();

        await assert.rejects(
            service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'two' }] }),
            error => (error as { code?: string }).code === 'operation-superseded'
        );
        await assert.rejects(
            service.steerTurn({
                threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'more' }]
            }),
            error => (error as { code?: string }).code === 'operation-superseded'
        );
        await assert.rejects(
            service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' }),
            error => (error as { code?: string }).code === 'operation-superseded'
        );
        assert.throws(
            () => service.setClient(client),
            error => (error as { code?: string }).code === 'operation-superseded'
        );
        assert.throws(
            () => coordinator.connectClient({ turnEvents: () => undefined }),
            error => (error as { code?: string }).code === 'operation-superseded'
        );
        assert.equal(host.calls.filter(call => call.method === 'turn/start').length, 1);
        assert.deepEqual(host.restartCalls, [1]);

        host.generation = 2;
        resolveRestart(2);
        assert.equal((await interrupting).status, 'interrupt-uncertain');
        host.nextTurnId = 'turn-2';
        assert.equal((await service.startTurn({
            threadId: 'thread-1', input: [{ type: 'text', text: 'after recovery' }]
        })).turnId, 'turn-2');
        assert.equal(host.calls.filter(call => call.method === 'turn/start').length, 2);
        assert.equal(host.releases, 2);
        await coordinator.dispose();
        assert.equal(host.releases, 3);
    });

    it('clears a failed recovery barrier without duplicate recovery or lease leaks', async () => {
        const host = new FakeTurnHost();
        const timeoutCallbacks: Array<() => void> = [];
        host.interruptPromise = Promise.resolve({});
        host.restartPromise = Promise.reject(new Error('restart failed'));
        void host.restartPromise.catch(() => undefined);
        const coordinator = new RideCodexTurnCoordinator({
            host,
            interruptTimeoutMs: 10,
            timers: {
                setTimeout: callback => { timeoutCallbacks.push(callback); return callback; },
                clearTimeout: () => undefined
            }
        });
        const service = coordinator.connectClient({ turnEvents: () => undefined });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        const interrupting = service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });
        await Promise.resolve();
        const fireTimeout = timeoutCallbacks.shift();
        fireTimeout?.();
        fireTimeout?.();
        assert.equal((await interrupting).status, 'interrupt-uncertain');
        assert.deepEqual(host.restartCalls, [1]);
        assert.equal(host.releases, 1);

        host.restartPromise = undefined;
        host.nextTurnId = 'turn-2';
        assert.equal((await service.startTurn({
            threadId: 'thread-1', input: [{ type: 'text', text: 'after failure' }]
        })).turnId, 'turn-2');
        await coordinator.dispose();
        assert.equal(host.releases, 2);
    });

    it('fails malformed interrupt ACKs closed and releases the active lease without recovery', async () => {
        const host = new FakeTurnHost();
        host.interruptPromise = Promise.resolve({ unexpected: true });
        let clearedTimers = 0;
        const coordinator = new RideCodexTurnCoordinator({
            host,
            timers: {
                setTimeout: callback => setTimeout(callback, 1_000),
                clearTimeout: handle => {
                    clearedTimers += 1;
                    clearTimeout(handle as ReturnType<typeof setTimeout>);
                }
            }
        });
        const service = coordinator.connectClient({ turnEvents: () => undefined });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });

        await assert.rejects(
            service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' }),
            error => (error as { code?: string }).code === 'invalid-data'
        );
        assert.equal(host.releases, 1);
        assert.deepEqual(host.restartCalls, []);
        assert.equal(clearedTimers, 1);
    });

    it('fails recovery closed for malformed resume responses without invoking Proxy or accessor traps', async () => {
        let traps = 0;
        const proxied = new Proxy({}, {
            get: () => { traps += 1; return undefined; },
            ownKeys: () => { traps += 1; return []; },
            getOwnPropertyDescriptor: () => { traps += 1; return undefined; },
            getPrototypeOf: () => { traps += 1; return Object.prototype; }
        });
        const accessor = Object.defineProperty({}, 'thread', {
            enumerable: true,
            get: () => { traps += 1; return { id: 'thread-1' }; }
        });
        for (const response of [
            {},
            { thread: { id: 'wrong-thread' } },
            { thread: { id: 'thread-1' } },
            { ...validResumeResponse(), extra: true },
            {
                ...validResumeResponse(),
                thread: { ...validThread(), status: { type: 'futureStatus' } }
            },
            {
                ...validResumeResponse(),
                thread: { ...validThread(), createdAt: Number.NaN }
            },
            {
                ...validResumeResponse(),
                thread: { ...validThread(), source: { subAgent: { bogus: true } } }
            },
            {
                ...validResumeResponse(),
                thread: {
                    ...validThread(),
                    source: {
                        subAgent: {
                            thread_spawn: {
                                parent_thread_id: 'parent', depth: 1, agent_path: null,
                                agent_nickname: null, agent_role: null, extra: true
                            }
                        }
                    }
                }
            },
            {
                ...validResumeResponse(),
                thread: {
                    ...validThread(),
                    turns: [{ ...validTurn('resumed-turn'), items: [{
                        type: 'userMessage', id: 'user-1', clientId: null,
                        content: [{ type: 'text', text: 'x', text_elements: [{ bad: true }] }]
                    }] }]
                }
            },
            proxied,
            accessor
        ]) {
            const host = new FakeTurnHost();
            const scheduler = new FakeScheduler();
            const timeoutCallbacks: Array<() => void> = [];
            const events: RideCodexUiEvent[] = [];
            host.interruptPromise = new Promise(() => undefined);
            host.resumeResponse = response;
            const coordinator = new RideCodexTurnCoordinator({
                host,
                scheduler,
                interruptTimeoutMs: 10,
                timers: {
                    setTimeout: callback => { timeoutCallbacks.push(callback); return callback; },
                    clearTimeout: () => undefined
                }
            });
            const service = coordinator.connectClient({
                turnEvents: wire => { events.push(...decodeBatch(wire).events); }
            });
            await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
            const interrupting = service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });
            timeoutCallbacks.shift()?.();
            assert.equal((await interrupting).status, 'interrupt-uncertain');
            while (scheduler.callbacks.length > 0) {
                scheduler.flushOne();
                await Promise.resolve();
            }
            assert.ok(events.some(event => event.type === 'error' && event.code === 'recovery-failed'));
            await coordinator.dispose();
        }
        assert.equal(traps, 0);
    });

    it('accepts all stable Codex 0.144 recovery source, status, policy, sandbox and transcript variants', async () => {
        const sources: unknown[] = [
            'cli', 'vscode', 'exec', 'appServer', 'unknown',
            { custom: 'integration' },
            { subAgent: 'review' },
            { subAgent: 'compact' },
            { subAgent: 'memory_consolidation' },
            { subAgent: { other: 'future-stable-source' } },
            {
                subAgent: {
                    thread_spawn: {
                        parent_thread_id: 'parent-thread', depth: 1, agent_path: null,
                        agent_nickname: 'worker', agent_role: 'reviewer'
                    }
                }
            }
        ];
        const statuses: unknown[] = [
            { type: 'notLoaded' }, { type: 'idle' }, { type: 'systemError' },
            { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnUserInput'] }
        ];
        const approvalPolicies: unknown[] = [
            'untrusted', 'on-request', 'never',
            {
                granular: {
                    sandbox_approval: true, rules: false, skill_approval: true,
                    request_permissions: false, mcp_elicitations: true
                }
            }
        ];
        const sandboxes: unknown[] = [
            { type: 'dangerFullAccess' },
            { type: 'readOnly', networkAccess: false },
            { type: 'externalSandbox', networkAccess: 'restricted' },
            {
                type: 'workspaceWrite', writableRoots: ['C:\\workspace'], networkAccess: true,
                excludeTmpdirEnvVar: false, excludeSlashTmp: true
            }
        ];
        const reviewers = ['user', 'auto_review', 'guardian_subagent'];

        for (let index = 0; index < sources.length; index += 1) {
            const host = new FakeTurnHost();
            const scheduler = new FakeScheduler();
            const timeoutCallbacks: Array<() => void> = [];
            const events: RideCodexUiEvent[] = [];
            host.interruptPromise = Promise.resolve({});
            host.resumeResponse = {
                ...validResumeResponse(),
                thread: {
                    ...validThread(),
                    source: sources[index],
                    status: statuses[index % statuses.length],
                    threadSource: index % 2 === 0 ? null : 'desktop',
                    gitInfo: index % 2 === 0 ? null : {
                        sha: 'abc123', branch: 'main', originUrl: 'https://example.test/repo.git'
                    },
                    turns: index === sources.length - 1
                        ? [{ ...validTurn('resumed-turn', 'completed'), items: validThreadItems() }]
                        : []
                },
                approvalPolicy: approvalPolicies[index % approvalPolicies.length],
                approvalsReviewer: reviewers[index % reviewers.length],
                sandbox: sandboxes[index % sandboxes.length],
                reasoningEffort: index % 2 === 0 ? null : 'high'
            };
            const coordinator = new RideCodexTurnCoordinator({
                host, scheduler, interruptTimeoutMs: 10,
                timers: {
                    setTimeout: callback => { timeoutCallbacks.push(callback); return callback; },
                    clearTimeout: () => undefined
                }
            });
            const service = coordinator.connectClient({
                turnEvents: wire => { events.push(...decodeBatch(wire).events); }
            });
            await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
            const interrupting = service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });
            timeoutCallbacks.shift()?.();
            assert.equal((await interrupting).status, 'interrupt-uncertain');
            while (scheduler.callbacks.length > 0) {
                scheduler.flushOne();
                await Promise.resolve();
            }
            assert.equal(events.some(event => event.type === 'error' && event.code === 'recovery-failed'), false);
            await coordinator.dispose();
        }
    });

    it('releases the active lease on owner disconnect and host restart, and rejects hung acquire on dispose', async () => {
        const host = new FakeTurnHost();
        const coordinator = new RideCodexTurnCoordinator({ host });
        const first = coordinator.connectClient({ turnEvents: () => undefined });
        await first.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        first.dispose();
        assert.equal(host.releases, 1);

        const second = coordinator.connectClient({ turnEvents: () => undefined });
        await second.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'two' }] });
        host.emitState('restarting');
        assert.equal(host.releases, 2);

        let resolveAcquire!: (lease: RideCodexTurnHostLease) => void;
        let lateReleases = 0;
        const hungHost = new FakeTurnHost();
        hungHost.acquire = () => new Promise(resolve => { resolveAcquire = resolve; });
        const hungCoordinator = new RideCodexTurnCoordinator({ host: hungHost });
        const hungService = hungCoordinator.connectClient({ turnEvents: () => undefined });
        const starting = hungService.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'hung' }] });
        await hungCoordinator.dispose();
        await assert.rejects(starting, error => (error as { code?: string }).code === 'disposed');
        resolveAcquire({
            generation: 1,
            request: async () => ({}),
            release: () => { lateReleases += 1; }
        });
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(lateReleases, 1);
    });

    it('rejects Proxy and accessor payloads before traps without polluting active state', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const batches: unknown[] = [];
        const coordinator = new RideCodexTurnCoordinator({ host, scheduler });
        const service = coordinator.connectClient({ turnEvents: wire => { batches.push(wire); } });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }] });
        scheduler.flushOne();
        await Promise.resolve();
        batches.length = 0;
        let traps = 0;
        const proxied = new Proxy({}, {
            ownKeys: () => { traps += 1; return []; },
            getOwnPropertyDescriptor: () => { traps += 1; return undefined; },
            get: () => { traps += 1; return undefined; }
        });
        host.emit('item/agentMessage/delta', proxied);
        const accessor = Object.defineProperty({}, 'threadId', {
            enumerable: true,
            get: () => { traps += 1; return 'thread-1'; }
        });
        host.emit('item/agentMessage/delta', accessor);
        host.emit('item/agentMessage/delta', {
            threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: proxied
        });
        host.emit('item/agentMessage/delta', {
            threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: '你'.repeat(200_000)
        });
        scheduler.flushOne();
        await Promise.resolve();

        assert.equal(traps, 0);
        assert.equal(batches.length, 0);
        assert.equal(host.releases, 0);
    });

    it('fails malformed file patch kinds closed without invoking nested Proxy or accessor traps', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const batches: RideCodexEventBatch[] = [];
        const coordinator = new RideCodexTurnCoordinator({ host, scheduler });
        const service = coordinator.connectClient({ turnEvents: wire => { batches.push(decodeBatch(wire)); } });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }] });
        scheduler.flushOne();
        await Promise.resolve();
        host.emit('item/started', {
            threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 1,
            item: { type: 'fileChange', id: 'item-1' }
        });
        scheduler.flushOne();
        await Promise.resolve();
        batches.length = 0;
        let traps = 0;
        const proxiedKind = new Proxy({ type: 'add' }, {
            ownKeys: () => { traps += 1; return []; },
            getOwnPropertyDescriptor: () => { traps += 1; return undefined; },
            get: () => { traps += 1; return undefined; }
        });
        const accessorKind = Object.defineProperty({ type: 'update' }, 'move_path', {
            enumerable: true,
            get: () => { traps += 1; return 'src/unsafe.ts'; }
        });
        const invalidChanges: unknown[] = [
            { path: 'src/a.ts', kind: 'add', diff: 'safe diff' },
            { path: 'src/a.ts', kind: { type: 'unknown' }, diff: 'safe diff' },
            { path: 'src/a.ts', kind: { type: 'add', move_path: null }, diff: 'safe diff' },
            { path: 'src/a.ts', kind: { type: 'delete', extra: true }, diff: 'safe diff' },
            { path: 'src/a.ts', kind: { type: 'update' }, diff: 'safe diff' },
            { path: 'src/a.ts', kind: { type: 'update', move_path: 1 }, diff: 'safe diff' },
            { path: 'src/a.ts', kind: { type: 'update', move_path: '你'.repeat(11_000) }, diff: 'safe diff' },
            { path: 'src/\u001bunsafe.ts', kind: { type: 'add' }, diff: 'safe diff' },
            { path: '你'.repeat(11_000), kind: { type: 'add' }, diff: 'safe diff' },
            { path: 'src/a.ts', kind: { type: 'add' }, diff: '你'.repeat(22_000) },
            { path: 'src/a.ts', kind: proxiedKind, diff: 'safe diff' },
            { path: 'src/a.ts', kind: accessorKind, diff: 'safe diff' },
            { path: 'src/a.ts', kind: { type: 'add' }, diff: 'safe diff', extra: true },
            { path: 'src/a.ts', kind: { type: 'add' } }
        ];
        for (const change of invalidChanges) {
            host.emit('item/fileChange/patchUpdated', {
                threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1',
                changes: [change]
            });
        }
        scheduler.flushOne();
        await Promise.resolve();

        assert.equal(traps, 0);
        assert.equal(batches.length, 0);
    });

    it('retains truncation metadata for each rapid turn identity before a flush', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const batches: RideCodexEventBatch[] = [];
        const coordinator = new RideCodexTurnCoordinator({
            host, scheduler, maxQueuedBytes: MIN_COHERENT_QUEUE_BYTES, maxItemBytes: 8
        });
        const service = coordinator.connectClient({ turnEvents: wire => { batches.push(decodeBatch(wire)); } });

        for (const turnId of ['turn-1', 'turn-2']) {
            host.nextTurnId = turnId;
            await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: turnId }] });
            host.emit('item/started', {
                threadId: 'thread-1', turnId, startedAtMs: 1,
                item: { type: 'agentMessage', id: `item-${turnId}`, text: '', phase: null, memoryCitation: null }
            });
            for (let index = 0; index < 16; index += 1) {
                host.emit('item/agentMessage/delta', {
                    threadId: 'thread-1', turnId, itemId: `item-${turnId}`, delta: 'x'
                });
            }
            host.emit('turn/completed', {
                threadId: 'thread-1', turn: { id: turnId, status: 'completed', items: [] }
            });
        }
        while (scheduler.callbacks.length > 0) {
            scheduler.flushOne();
            await Promise.resolve();
        }

        for (const turnId of ['turn-1', 'turn-2']) {
            assert.ok(batches.some(batch => batch.turnId === turnId && batch.events.some(event =>
                event.type === 'warning' && event.code === 'data-truncated'
            )), `missing truncation metadata for ${turnId}`);
        }
    });

    it('does not relabel an unflushed terminal batch when a new turn starts in the same generation', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const batches: Array<{ turnId: string; types: string[] }> = [];
        const coordinator = new RideCodexTurnCoordinator({ host, scheduler });
        const service = coordinator.connectClient({
            turnEvents: wire => {
                const batch = decodeBatch(wire);
                batches.push({ turnId: batch.turnId, types: batch.events.map(event => event.type) });
            }
        });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        host.emit('turn/completed', {
            threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] }
        });
        host.nextTurnId = 'turn-2';
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'two' }] });
        while (scheduler.callbacks.length > 0) {
            scheduler.flushOne();
            await Promise.resolve();
        }

        assert.deepEqual(batches, [
            { turnId: 'turn-1', types: ['turn-started', 'turn-terminal'] },
            { turnId: 'turn-2', types: ['turn-started'] }
        ]);
    });

    it('preserves a terminal event when notification pressure fills maxQueuedBytes', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const types: string[] = [];
        const coordinator = new RideCodexTurnCoordinator({
            host, scheduler, maxQueuedBytes: MIN_COHERENT_QUEUE_BYTES, maxItemBytes: 2_048, maxBatchEvents: 64
        });
        const service = coordinator.connectClient({
            turnEvents: wire => { types.push(...decodeBatch(wire).events.map(event => event.type)); }
        });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        for (let index = 0; index < 100; index += 1) {
            host.emit('warning', { threadId: 'thread-1', message: `warning-${index}-${'你'.repeat(40)}` });
        }
        host.emit('turn/completed', {
            threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] }
        });
        while (scheduler.callbacks.length > 0) {
            scheduler.flushOne();
            await Promise.resolve();
        }

        assert.ok(types.includes('turn-terminal'));
        assert.equal(host.releases, 1);
    });

    it('rejects queues below the coherent identity boundary and accepts the exact boundary', async () => {
        const host = new FakeTurnHost();
        assert.throws(() => new RideCodexTurnCoordinator({
            host, maxQueuedBytes: MIN_COHERENT_QUEUE_BYTES - 1
        }));

        host.generation = Number.MAX_SAFE_INTEGER;
        host.nextTurnId = WORST_VALID_IDENTIFIER;
        const scheduler = new FakeScheduler();
        const wires: string[] = [];
        const coordinator = new RideCodexTurnCoordinator({
            host, scheduler, maxQueuedBytes: MIN_COHERENT_QUEUE_BYTES
        });
        const service = coordinator.connectClient({ turnEvents: wire => { wires.push(wire); } });
        await service.startTurn({
            threadId: WORST_VALID_IDENTIFIER,
            input: [{ type: 'text', text: 'one' }]
        });
        host.emit('turn/completed', {
            threadId: WORST_VALID_IDENTIFIER,
            turn: { id: WORST_VALID_IDENTIFIER, status: 'completed', items: [] }
        });
        scheduler.flushOne();

        assert.equal(wires.length, 1);
        assert.ok(Buffer.byteLength(wires[0], 'utf8') <= MIN_COHERENT_QUEUE_BYTES);
        assert.deepEqual(decodeBatch(wires[0]).events.map(event => event.type), [
            'turn-started', 'turn-terminal'
        ]);
    });

    it('keeps terminal then next-start ordering for a slow frontend with a bounded pending queue', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        let resolveFirst!: () => void;
        const firstDelivery = new Promise<void>(resolve => { resolveFirst = resolve; });
        const deliveries: Array<{ turnId: string; types: string[] }> = [];
        const coordinator = new RideCodexTurnCoordinator({ host, scheduler });
        let call = 0;
        const service = coordinator.connectClient({
            turnEvents: wire => {
                const batch = decodeBatch(wire);
                deliveries.push({ turnId: batch.turnId, types: batch.events.map(event => event.type) });
                call += 1;
                return call === 1 ? firstDelivery : undefined;
            }
        });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        scheduler.flushOne();
        host.emit('turn/completed', {
            threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] }
        });
        scheduler.flushOne();
        host.nextTurnId = 'turn-2';
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'two' }] });
        scheduler.flushOne();
        resolveFirst();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        assert.deepEqual(deliveries, [
            { turnId: 'turn-1', types: ['turn-started'] },
            { turnId: 'turn-1', types: ['turn-terminal'] },
            { turnId: 'turn-2', types: ['turn-started'] }
        ]);
    });

    it('compacts seven slow-client turns as coherent bounded identities and keeps the latest terminal visible', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        let unblock!: () => void;
        const blocked = new Promise<void>(resolve => { unblock = resolve; });
        const delivered: RideCodexEventBatch[] = [];
        let calls = 0;
        const coordinator = new RideCodexTurnCoordinator({
            host, scheduler, maxQueuedBytes: MIN_COHERENT_QUEUE_BYTES, maxBatchEvents: 8
        });
        const service = coordinator.connectClient({
            turnEvents: wire => {
                delivered.push(decodeBatch(wire));
                calls += 1;
                return calls === 1 ? blocked : undefined;
            }
        });

        for (let index = 1; index <= 7; index += 1) {
            const turnId = `turn-${index}`;
            host.nextTurnId = turnId;
            await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: turnId }] });
            scheduler.flushOne();
            host.emit('turn/completed', {
                threadId: 'thread-1', turn: { id: turnId, status: 'completed', items: [] }
            });
            scheduler.flushOne();
        }
        assert.equal(delivered.length, 1);

        unblock();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        assert.ok(delivered.length <= 5);
        const byTurn = new Map<string, string[]>();
        for (const batch of delivered) {
            const types = byTurn.get(batch.turnId) ?? [];
            types.push(...batch.events.map(event => event.type));
            byTurn.set(batch.turnId, types);
            assert.ok(Buffer.byteLength(JSON.stringify(batch), 'utf8') <= MIN_COHERENT_QUEUE_BYTES);
        }
        for (const [turnId, types] of byTurn) {
            assert.ok(types.includes('turn-started'), `missing start for ${turnId}`);
            assert.ok(types.includes('turn-terminal'), `missing terminal for ${turnId}`);
            assert.ok(types.indexOf('turn-started') < types.indexOf('turn-terminal'), `invalid order for ${turnId}`);
        }
        assert.ok(byTurn.get('turn-7')?.includes('turn-terminal'));
        assert.ok(delivered.flatMap(batch => batch.events).some(event =>
            event.type === 'warning' && event.code === 'events-dropped'
        ));
    });

    it('preserves the unique terminal for one slow-client turn across a delta storm', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        let unblock!: () => void;
        const blocked = new Promise<void>(resolve => { unblock = resolve; });
        const delivered: RideCodexEventBatch[] = [];
        let calls = 0;
        const coordinator = new RideCodexTurnCoordinator({
            host, scheduler, maxQueuedBytes: MIN_COHERENT_QUEUE_BYTES, maxBatchEvents: 8, maxItemBytes: 128
        });
        const service = coordinator.connectClient({
            turnEvents: wire => {
                delivered.push(decodeBatch(wire));
                calls += 1;
                return calls === 1 ? blocked : undefined;
            }
        });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        scheduler.flushOne();
        host.emit('item/started', {
            threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 1,
            item: { type: 'agentMessage', id: 'item-1', text: '', phase: null, memoryCitation: null }
        });
        for (let index = 0; index < 100; index += 1) {
            host.emit('item/agentMessage/delta', {
                threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: '你'
            });
            scheduler.flushOne();
        }
        host.emit('turn/completed', {
            threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] }
        });
        scheduler.flushOne();
        unblock();
        await Promise.resolve();
        await Promise.resolve();

        assert.ok(delivered.flatMap(batch => batch.events).some(event => event.type === 'turn-terminal'));
        assert.ok(delivered.length <= 2);
    });

    it('releases the active lease and exposes only a stable error when steer or interrupt RPC fails', async () => {
        for (const method of ['turn/steer', 'turn/interrupt'] as const) {
            const host = new FakeTurnHost();
            host.rejectMethod = method;
            const coordinator = new RideCodexTurnCoordinator({ host });
            const service = coordinator.connectClient({ turnEvents: () => undefined });
            await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
            const operation = method === 'turn/steer'
                ? service.steerTurn({
                    threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'more' }]
                })
                : service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });
            await assert.rejects(operation, error => {
                assert.equal((error as { code?: string }).code, 'operation-failed');
                assert.doesNotMatch(String((error as Error).message), /secret|apiKey|workspace/i);
                return true;
            });
            assert.equal(host.releases, 1, method);
            await coordinator.dispose();
        }
    });

    it('normal interrupt confirmation waits after the empty ACK for the exact terminal and clears its timer', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        let clearedTimers = 0;
        const coordinator = new RideCodexTurnCoordinator({
            host,
            scheduler,
            timers: {
                setTimeout: callback => setTimeout(callback, 1_000),
                clearTimeout: handle => {
                    clearedTimers += 1;
                    clearTimeout(handle as ReturnType<typeof setTimeout>);
                }
            }
        });
        const service = coordinator.connectClient({ turnEvents: () => undefined });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        const interrupting = service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });
        let settled = false;
        void interrupting.finally(() => { settled = true; });
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(settled, false);
        assert.equal(host.releases, 0);
        host.emit('turn/completed', {
            threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted', items: [] }
        });
        const result = await interrupting;
        assert.equal(result.status, 'interrupted');
        assert.equal(host.releases, 1);
        assert.equal(clearedTimers, 1);
        host.emit('turn/completed', {
            threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] }
        });
        assert.equal(host.releases, 1);
    });

    it('linearizes an exact terminal that arrives before the start response', async () => {
        for (const status of ['completed', 'failed', 'interrupted'] as const) {
            const host = new FakeTurnHost();
            let rejectStart!: (error: unknown) => void;
            host.startPromise = new Promise((_resolve, reject) => { rejectStart = reject; });
            const coordinator = new RideCodexTurnCoordinator({ host });
            const service = coordinator.connectClient({ turnEvents: () => undefined });
            const starting = service.startTurn({
                threadId: 'thread-1', input: [{ type: 'text', text: status }]
            });
            await Promise.resolve();
            await Promise.resolve();
            host.emit('turn/started', {
                threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [] }
            });
            host.emit('turn/completed', {
                threadId: 'thread-1', turn: { id: 'turn-1', status, items: [] }
            });

            const result = await starting;
            assert.deepEqual(result, { threadId: 'thread-1', turnId: 'turn-1', status });
            assert.ok(Object.isFrozen(result));
            assert.equal(host.releases, 1);
            rejectStart(new Error('late start response'));
            await Promise.resolve();
            await Promise.resolve();
            assert.equal(host.releases, 1);
            await coordinator.dispose();
        }
    });

    it('linearizes an exact interrupted terminal before the interrupt response and absorbs its late rejection', async () => {
        const host = new FakeTurnHost();
        let rejectInterrupt!: (error: unknown) => void;
        host.interruptPromise = new Promise((_resolve, reject) => { rejectInterrupt = reject; });
        const coordinator = new RideCodexTurnCoordinator({ host });
        const service = coordinator.connectClient({ turnEvents: () => undefined });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        const interrupting = service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });
        host.emit('turn/completed', {
            threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted', items: [] }
        });

        const result = await interrupting;
        assert.deepEqual(result, { threadId: 'thread-1', turnId: 'turn-1', status: 'interrupted' });
        assert.equal(host.releases, 1);
        rejectInterrupt(new Error('late interrupt response'));
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(host.releases, 1);
    });

    it('linearizes an exact terminal before the steer response without accepting a cross-turn result', async () => {
        const host = new FakeTurnHost();
        let resolveSteer!: (value: unknown) => void;
        host.steerPromise = new Promise(resolve => { resolveSteer = resolve; });
        const coordinator = new RideCodexTurnCoordinator({ host });
        const service = coordinator.connectClient({ turnEvents: () => undefined });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        const steering = service.steerTurn({
            threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'more' }]
        });
        host.emit('turn/completed', {
            threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] }
        });

        assert.deepEqual(await steering, {
            threadId: 'thread-1', turnId: 'turn-1', status: 'completed'
        });
        assert.equal(host.releases, 1);
        resolveSteer({ turnId: 'different-turn' });
        await Promise.resolve();
        assert.equal(host.releases, 1);
    });

    it('keeps interrupt timeout uncertain when a completed notification arrives after the timeout boundary', async () => {
        const host = new FakeTurnHost();
        const timeoutCallbacks: Array<() => void> = [];
        host.interruptPromise = new Promise(() => undefined);
        const coordinator = new RideCodexTurnCoordinator({
            host,
            interruptTimeoutMs: 10,
            timers: {
                setTimeout: callback => { timeoutCallbacks.push(callback); return callback; },
                clearTimeout: () => undefined
            }
        });
        const service = coordinator.connectClient({ turnEvents: () => undefined });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        const interrupting = service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });
        timeoutCallbacks.shift()?.();
        host.emit('turn/completed', {
            threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] }
        });

        assert.equal((await interrupting).status, 'interrupt-uncertain');
        assert.equal(host.releases, 2);
    });

    it('dispose terminates interrupt recovery even when the host restart is hung', async () => {
        const host = new FakeTurnHost();
        const timeoutCallbacks: Array<() => void> = [];
        host.interruptPromise = new Promise(() => undefined);
        host.restartPromise = new Promise(() => undefined);
        const coordinator = new RideCodexTurnCoordinator({
            host,
            interruptTimeoutMs: 10,
            timers: {
                setTimeout: callback => { timeoutCallbacks.push(callback); return callback; },
                clearTimeout: () => undefined
            }
        });
        const service = coordinator.connectClient({ turnEvents: () => undefined });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        const interrupting = service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });
        timeoutCallbacks.shift()?.();
        await Promise.resolve();
        await coordinator.dispose();

        await assert.rejects(interrupting, error => (error as { code?: string }).code === 'disposed');
        assert.equal(host.releases, 1);
    });

    it('ignores duplicate item lifecycle and late deltas after item completion', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const types: string[] = [];
        const coordinator = new RideCodexTurnCoordinator({ host, scheduler });
        const service = coordinator.connectClient({
            turnEvents: wire => { types.push(...decodeBatch(wire).events.map(event => event.type)); }
        });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        const params = {
            threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 1,
            item: { type: 'agentMessage', id: 'item-1', text: '', phase: null, memoryCitation: null }
        };
        host.emit('item/started', params);
        host.emit('item/started', params);
        host.emit('item/completed', { ...params, completedAtMs: 2 });
        host.emit('item/completed', { ...params, completedAtMs: 2 });
        host.emit('item/agentMessage/delta', {
            threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'late'
        });
        scheduler.flushOne();
        await Promise.resolve();

        assert.equal(types.filter(type => type === 'item-started').length, 1);
        assert.equal(types.filter(type => type === 'item-completed').length, 1);
        assert.equal(types.filter(type => type === 'agent-delta').length, 0);
    });

    it('bounds multibyte deltas, batch events, queue bytes, and retained item storms', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const batches: RideCodexEventBatch[] = [];
        const coordinator = new RideCodexTurnCoordinator({
            host,
            scheduler,
            maxQueuedBytes: MIN_COHERENT_QUEUE_BYTES,
            maxItemBytes: 2_048,
            maxBatchEvents: 16,
            maxRetainedItems: 2,
            maxDiagnosticHistory: 2
        });
        const service = coordinator.connectClient({ turnEvents: wire => { batches.push(decodeBatch(wire)); } });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        for (let index = 0; index < 3; index += 1) {
            host.emit('item/started', {
                threadId: 'thread-1', turnId: 'turn-1', startedAtMs: index,
                item: { type: 'agentMessage', id: `item-${index}`, text: '', phase: null, memoryCitation: null }
            });
        }
        for (let index = 0; index < 1_000; index += 1) {
            host.emit('item/agentMessage/delta', {
                threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-2', delta: '你'
            });
        }
        host.emit('item/agentMessage/delta', {
            threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-0', delta: 'evicted'
        });
        for (let index = 0; index < 100; index += 1) {
            host.emit('warning', { threadId: 'thread-1', message: `warning ${index} ${'你'.repeat(50)}` });
        }
        while (scheduler.callbacks.length > 0) {
            scheduler.flushOne();
            await Promise.resolve();
        }

        assert.ok(batches.every(batch => batch.events.length <= 16));
        assert.ok(batches.every(batch => Buffer.byteLength(JSON.stringify(batch), 'utf8') <= MIN_COHERENT_QUEUE_BYTES));
        const deltas = batches.flatMap(batch => batch.events)
            .filter((event): event is RideCodexUiEvent & { type: 'agent-delta'; itemId: string; delta: string } =>
                event.type === 'agent-delta'
            );
        assert.equal(deltas.some(event => event.itemId === 'item-0'), false);
        assert.ok(deltas.some(event => event.itemId === 'item-2'));
        assert.ok(deltas.every(event => Buffer.byteLength(event.delta, 'utf8') <= 2_048));
        assert.ok(batches.flatMap(batch => batch.events).some(event =>
            event.type === 'warning' && event.code === 'data-truncated'
        ));
        assert.ok(batches.flatMap(batch => batch.events).some(event =>
            event.type === 'warning' && event.code === 'events-dropped'
        ));
    });

    it('cancels hung start requests on dispose and host exit with one release and absorbs late settlement', async () => {
        for (const boundary of ['dispose', 'circuit-open'] as const) {
            const host = new FakeTurnHost();
            let settle!: (value: unknown) => void;
            host.startPromise = new Promise(resolve => { settle = resolve; });
            const coordinator = new RideCodexTurnCoordinator({ host });
            const service = coordinator.connectClient({ turnEvents: () => undefined });
            const starting = service.startTurn({
                threadId: 'thread-1', input: [{ type: 'text', text: 'hung' }]
            });
            await Promise.resolve();
            await Promise.resolve();
            if (boundary === 'dispose') {
                await coordinator.dispose();
            } else {
                host.emitState('circuit-open');
            }
            await assert.rejects(starting, error => {
                const code = (error as { code?: string }).code;
                return code === 'disposed' || code === 'operation-superseded';
            });
            assert.equal(host.releases, 1, boundary);
            settle({ turn: { id: 'late-turn', status: 'inProgress', items: [] } });
            await Promise.resolve();
            assert.equal(host.releases, 1, boundary);
            await coordinator.dispose();
        }
    });

    it('linearizes concurrent starts and mismatched steer responses without leaking the active lease', async () => {
        const host = new FakeTurnHost();
        let resolveStart!: (value: unknown) => void;
        host.startPromise = new Promise(resolve => { resolveStart = resolve; });
        const coordinator = new RideCodexTurnCoordinator({ host });
        const service = coordinator.connectClient({ turnEvents: () => undefined });
        const first = service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        await assert.rejects(
            service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'two' }] }),
            error => (error as { code?: string }).code === 'turn-active'
        );
        resolveStart({ turn: validTurn('turn-1') });
        await first;
        host.steerTurnId = 'turn-2';
        await assert.rejects(service.steerTurn({
            threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'more' }]
        }));
        assert.equal(host.releases, 1);
    });

    it('reports bounded recovery failure but keeps the timed-out turn interrupt-uncertain', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const timeoutCallbacks: Array<() => void> = [];
        const events: RideCodexUiEvent[] = [];
        host.interruptPromise = new Promise(() => undefined);
        host.restartPromise = Promise.reject(new Error('C:\\private\\codex token=secret'));
        void host.restartPromise.catch(() => undefined);
        const coordinator = new RideCodexTurnCoordinator({
            host,
            scheduler,
            interruptTimeoutMs: 10,
            timers: {
                setTimeout: callback => { timeoutCallbacks.push(callback); return callback; },
                clearTimeout: () => undefined
            }
        });
        const service = coordinator.connectClient({
            turnEvents: wire => { events.push(...decodeBatch(wire).events); }
        });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        const interrupting = service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });
        timeoutCallbacks.shift()?.();
        const result = await interrupting;
        while (scheduler.callbacks.length > 0) {
            scheduler.flushOne();
            await Promise.resolve();
        }

        assert.equal(result.status, 'interrupt-uncertain');
        const serialized = JSON.stringify(events);
        assert.match(serialized, /recovery-failed/);
        assert.doesNotMatch(serialized, /private|token=|secret/i);
        assert.equal(host.releases, 1);
    });

    it('truncates one oversized UTF-8 delta and emits bounded drop metadata', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const events: RideCodexUiEvent[] = [];
        const coordinator = new RideCodexTurnCoordinator({
            host, scheduler, maxQueuedBytes: MIN_COHERENT_QUEUE_BYTES, maxItemBytes: 2_048
        });
        const service = coordinator.connectClient({
            turnEvents: wire => { events.push(...decodeBatch(wire).events); }
        });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        host.emit('item/started', {
            threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 1,
            item: { type: 'agentMessage', id: 'item-1', text: '', phase: null, memoryCitation: null }
        });
        host.emit('item/agentMessage/delta', {
            threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: '你'.repeat(1_000)
        });
        while (scheduler.callbacks.length > 0) {
            scheduler.flushOne();
            await Promise.resolve();
        }

        const delta = events.find((event): event is RideCodexUiEvent & { type: 'agent-delta'; delta: string } =>
            event.type === 'agent-delta'
        );
        assert.ok(delta);
        assert.ok(Buffer.byteLength(delta.delta, 'utf8') <= 2_048);
        assert.ok(events.some(event => event.type === 'warning' && event.code === 'data-truncated'));
    });

    it('reports pending-delivery drops after a slow frontend resumes', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        let resolveFirst!: () => void;
        const first = new Promise<void>(resolve => { resolveFirst = resolve; });
        const delivered: RideCodexUiEvent[] = [];
        let calls = 0;
        const coordinator = new RideCodexTurnCoordinator({ host, scheduler, maxBatchEvents: 4 });
        const service = coordinator.connectClient({
            turnEvents: wire => {
                delivered.push(...decodeBatch(wire).events);
                calls += 1;
                return calls === 1 ? first : undefined;
            }
        });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        scheduler.flushOne();
        for (let index = 0; index < 50; index += 1) {
            host.emit('warning', { threadId: 'thread-1', message: `warning ${index}` });
            scheduler.flushOne();
        }
        resolveFirst();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        assert.ok(delivered.some(event => event.type === 'warning' && event.code === 'events-dropped'));
        assert.ok(calls <= 2);
    });

    it('disconnects a throwing thenable without preventing later healthy clients from receiving the batch', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        let thenGetterCalls = 0;
        let healthyCalls = 0;
        const coordinator = new RideCodexTurnCoordinator({ host, scheduler });
        const owner = coordinator.connectClient({ turnEvents: () => undefined });
        coordinator.connectClient({
            turnEvents: () => Object.defineProperty({}, 'then', {
                get: () => {
                    thenGetterCalls += 1;
                    throw new Error('then getter failed');
                }
            }) as Promise<void>
        });
        coordinator.connectClient({ turnEvents: () => { healthyCalls += 1; } });
        await owner.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });

        assert.doesNotThrow(() => scheduler.flushOne());
        assert.equal(thenGetterCalls, 1);
        assert.equal(healthyCalls, 1);
    });

    it('reconciles turn/started before start response once and serializes steer against interrupt', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        let resolveStart!: (value: unknown) => void;
        host.startPromise = new Promise(resolve => { resolveStart = resolve; });
        const types: string[] = [];
        const coordinator = new RideCodexTurnCoordinator({ host, scheduler });
        const service = coordinator.connectClient({
            turnEvents: wire => { types.push(...decodeBatch(wire).events.map(event => event.type)); }
        });
        const starting = service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        await Promise.resolve();
        await Promise.resolve();
        host.emit('turn/started', {
            threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [] }
        });
        resolveStart({ turn: validTurn('turn-1') });
        await starting;
        let resolveSteer!: (value: unknown) => void;
        host.steerPromise = new Promise(resolve => { resolveSteer = resolve; });
        const steering = service.steerTurn({
            threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'more' }]
        });
        await assert.rejects(
            service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' }),
            error => (error as { code?: string }).code === 'operation-superseded'
        );
        resolveSteer({ turnId: 'turn-1' });
        await steering;
        scheduler.flushOne();
        await Promise.resolve();

        assert.equal(types.filter(type => type === 'turn-started').length, 1);
        assert.equal(host.releases, 0);
    });

    it('delivers every terminal boundary at the exported exact queue minimum with maximum identities', async () => {
        for (const status of ['completed', 'interrupted', 'failed'] as const) {
            const host = new FakeTurnHost();
            host.generation = Number.MAX_SAFE_INTEGER;
            host.nextTurnId = WORST_VALID_IDENTIFIER;
            const scheduler = new FakeScheduler();
            const wires: string[] = [];
            const coordinator = new RideCodexTurnCoordinator({
                host,
                scheduler,
                maxQueuedBytes: RIDE_CODEX_MIN_QUEUED_BYTES,
                maxBatchEvents: 2
            });
            const service = coordinator.connectClient({ turnEvents: wire => { wires.push(wire); } });
            await service.startTurn({
                threadId: WORST_VALID_IDENTIFIER,
                input: [{ type: 'text', text: status }]
            });
            host.emit('turn/completed', {
                threadId: WORST_VALID_IDENTIFIER,
                turn: { id: WORST_VALID_IDENTIFIER, status, items: [] }
            });
            while (scheduler.callbacks.length > 0) {
                scheduler.flushOne();
                await Promise.resolve();
            }

            const events = wires.flatMap(wire => decodeBatch(wire).events);
            assert.deepEqual(events.filter(event => event.type === 'turn-started').length, 1, status);
            assert.deepEqual(events.filter(event => event.type === 'turn-terminal').length, 1, status);
            assert.equal(events.find(event => event.type === 'turn-terminal')?.status, status);
            assert.ok(wires.every(wire => Buffer.byteLength(wire, 'utf8') <= RIDE_CODEX_MIN_QUEUED_BYTES));
            assert.ok(wires.every(wire => decodeBatch(wire).events.length > 0));
        }

        const host = new FakeTurnHost();
        host.generation = Number.MAX_SAFE_INTEGER - 1;
        host.nextTurnId = WORST_VALID_IDENTIFIER;
        host.interruptPromise = Promise.resolve({});
        host.resumeResponse = validResumeResponse(WORST_VALID_IDENTIFIER);
        const scheduler = new FakeScheduler();
        const timeoutCallbacks: Array<() => void> = [];
        const wires: string[] = [];
        const coordinator = new RideCodexTurnCoordinator({
            host,
            scheduler,
            maxQueuedBytes: RIDE_CODEX_MIN_QUEUED_BYTES,
            maxBatchEvents: 2,
            interruptTimeoutMs: 10,
            timers: {
                setTimeout: callback => { timeoutCallbacks.push(callback); return callback; },
                clearTimeout: () => undefined
            }
        });
        const service = coordinator.connectClient({ turnEvents: wire => { wires.push(wire); } });
        await service.startTurn({
            threadId: WORST_VALID_IDENTIFIER,
            input: [{ type: 'text', text: 'uncertain' }]
        });
        const interrupting = service.interruptTurn({
            threadId: WORST_VALID_IDENTIFIER,
            turnId: WORST_VALID_IDENTIFIER
        });
        await Promise.resolve();
        timeoutCallbacks.shift()?.();
        assert.equal((await interrupting).status, 'interrupt-uncertain');
        while (scheduler.callbacks.length > 0) {
            scheduler.flushOne();
            await Promise.resolve();
        }
        const uncertainEvents = wires.flatMap(wire => decodeBatch(wire).events);
        assert.deepEqual(uncertainEvents.map(event => event.type), ['turn-started', 'turn-terminal']);
        assert.equal(uncertainEvents[1].type === 'turn-terminal' && uncertainEvents[1].status, 'interrupt-uncertain');
        assert.ok(wires.every(wire => Buffer.byteLength(wire, 'utf8') <= RIDE_CODEX_MIN_QUEUED_BYTES));
        assert.ok(wires.every(wire => decodeBatch(wire).events.length > 0));
    });

    it('accounts for exact chunked wire bytes and never delivers empty batches', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const wires: string[] = [];
        const coordinator = new RideCodexTurnCoordinator({
            host,
            scheduler,
            maxQueuedBytes: RIDE_CODEX_MIN_QUEUED_BYTES,
            maxBatchEvents: 2
        });
        const service = coordinator.connectClient({ turnEvents: wire => { wires.push(wire); } });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        for (let index = 0; index < 100; index += 1) {
            host.emit('warning', { threadId: 'thread-1', message: `warning-${index}` });
        }
        host.emit('turn/completed', {
            threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', items: [] }
        });
        while (scheduler.callbacks.length > 0) {
            scheduler.flushOne();
            await Promise.resolve();
        }

        assert.ok(wires.length > 0);
        assert.ok(wires.every(wire => decodeBatch(wire).events.length > 0));
        assert.ok(wires.reduce((sum, wire) => sum + Buffer.byteLength(wire, 'utf8'), 0)
            <= RIDE_CODEX_MIN_QUEUED_BYTES);
        const events = wires.flatMap(wire => decodeBatch(wire).events);
        assert.ok(events.some(event => event.type === 'turn-started'));
        assert.ok(events.some(event => event.type === 'turn-terminal'));
    });

    it('rejects maxBatchEvents below the coherent start-terminal pair', () => {
        assert.throws(
            () => new RideCodexTurnCoordinator({ host: new FakeTurnHost(), maxBatchEvents: 1 }),
            error => (error as { code?: string }).code === 'invalid-data'
        );
    });

    it('accepts a schema-valid Codex 0.144 hookPrompt item', async () => {
        const host = new FakeTurnHost();
        host.startPromise = Promise.resolve({
            turn: {
                ...validTurn(),
                items: [{ type: 'hookPrompt', id: 'hook-1', fragments: [{ text: 'review', hookRunId: 'run-1' }] }]
            }
        });
        const coordinator = new RideCodexTurnCoordinator({ host });
        const service = coordinator.connectClient({ turnEvents: () => undefined });

        assert.equal((await service.startTurn({
            threadId: 'thread-1', input: [{ type: 'text', text: 'one' }]
        })).status, 'in-progress');
        await coordinator.dispose();
    });

    it('rejects malformed memoryCitation and text_elements nested objects', async () => {
        const malformedItems: unknown[] = [
            {
                type: 'agentMessage', id: 'agent-1', text: 'done', phase: null,
                memoryCitation: { bad: true }
            },
            {
                type: 'userMessage', id: 'user-1', clientId: null,
                content: [{ type: 'text', text: 'hello', text_elements: [{ bad: true }] }]
            }
        ];
        for (const item of malformedItems) {
            const host = new FakeTurnHost();
            host.startPromise = Promise.resolve({ turn: { ...validTurn(), items: [item] } });
            const coordinator = new RideCodexTurnCoordinator({ host });
            const service = coordinator.connectClient({ turnEvents: () => undefined });
            await assert.rejects(
                service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] }),
                error => (error as { code?: string }).code === 'invalid-data'
            );
            await coordinator.dispose();
        }
    });

    it('reports recovery-failed for a malformed subAgent source', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const timeoutCallbacks: Array<() => void> = [];
        const events: RideCodexUiEvent[] = [];
        host.interruptPromise = Promise.resolve({});
        host.resumeResponse = {
            ...validResumeResponse(),
            thread: { ...validThread(), source: { subAgent: { bogus: true } } }
        };
        const coordinator = new RideCodexTurnCoordinator({
            host, scheduler, interruptTimeoutMs: 10,
            timers: {
                setTimeout: callback => { timeoutCallbacks.push(callback); return callback; },
                clearTimeout: () => undefined
            }
        });
        const service = coordinator.connectClient({
            turnEvents: wire => { events.push(...decodeBatch(wire).events); }
        });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        const interrupting = service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });
        timeoutCallbacks.shift()?.();
        await interrupting;
        while (scheduler.callbacks.length > 0) {
            scheduler.flushOne();
            await Promise.resolve();
        }

        assert.ok(events.some(event => event.type === 'error' && event.code === 'recovery-failed'));
        await coordinator.dispose();
    });

    it('accepts every Codex 0.144 ThreadItem variant and all directly nested stable variants', async () => {
        const host = new FakeTurnHost();
        host.startPromise = Promise.resolve({
            turn: { ...validTurn(), items: validThreadItems() }
        });
        const coordinator = new RideCodexTurnCoordinator({ host });
        const service = coordinator.connectClient({ turnEvents: () => undefined });

        assert.equal((await service.startTurn({
            threadId: 'thread-1', input: [{ type: 'text', text: 'one' }]
        })).status, 'in-progress');
        await coordinator.dispose();
    });

    it('rejects malformed nested ThreadItem data that previously passed shallow validation', async () => {
        const malformedItems: unknown[] = [
            {
                type: 'agentMessage', id: 'agent-1', text: 'done', phase: null,
                memoryCitation: { bad: true }
            },
            {
                type: 'userMessage', id: 'user-1', clientId: null,
                content: [{ type: 'text', text: 'hello', text_elements: [{ bad: true }] }]
            },
            {
                type: 'commandExecution', id: 'command-1', command: 'run', cwd: 'C:\\workspace',
                processId: null, source: 'agent', status: 'completed',
                commandActions: [{ bad: true }], aggregatedOutput: null, exitCode: 0, durationMs: 1
            },
            {
                type: 'mcpToolCall', id: 'mcp-1', server: 'server', tool: 'tool', status: 'completed',
                arguments: { nested: undefined }, appContext: null, pluginId: null,
                result: null, error: null, durationMs: null
            },
            {
                type: 'dynamicToolCall', id: 'dynamic-1', namespace: null, tool: 'run',
                arguments: {}, status: 'completed',
                contentItems: [{ type: 'inputText', text: 'ok', extra: true }],
                success: true, durationMs: 1
            },
            {
                type: 'collabAgentToolCall', id: 'collab-1', tool: 'wait', status: 'completed',
                senderThreadId: 'thread-1', receiverThreadIds: [], prompt: null, model: null,
                reasoningEffort: null, agentsStates: { child: { status: 'running', message: null, extra: true } }
            },
            {
                type: 'webSearch', id: 'web-1', query: 'query',
                action: { type: 'other', extra: true }
            },
            { type: 'sleep', id: 'sleep-1', durationMs: Number.POSITIVE_INFINITY },
            { type: 'hookPrompt', id: 'hook-1', fragments: [{ text: 'x'.repeat(65_537), hookRunId: 'run' }] },
            Object.assign(Object.create({ inherited: true }), { type: 'contextCompaction', id: 'compact-1' })
        ];

        for (const item of malformedItems) {
            const host = new FakeTurnHost();
            host.startPromise = Promise.resolve({ turn: { ...validTurn(), items: [item] } });
            const coordinator = new RideCodexTurnCoordinator({ host });
            const service = coordinator.connectClient({ turnEvents: () => undefined });
            await assert.rejects(
                service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] }),
                error => (error as { code?: string }).code === 'invalid-data'
            );
            await coordinator.dispose();
        }
    });

    it('strictly validates complete turn/start and exact turn/steer responses', async () => {
        const malformedStarts: unknown[] = [
            { turn: { id: 'turn-1', status: 'inProgress', items: [] } },
            { turn: { ...validTurn(), itemsView: 'unknown' } },
            { turn: { ...validTurn(), items: [{ type: 'contextCompaction' }] } },
            { turn: { ...validTurn(), startedAt: Number.POSITIVE_INFINITY } },
            {
                turn: {
                    ...validTurn('turn-1', 'failed'),
                    error: {
                        message: 'failed',
                        codexErrorInfo: {
                            httpConnectionFailed: { httpStatusCode: 500, extra: true }
                        },
                        additionalDetails: null
                    }
                }
            },
            { turn: validTurn(), extra: true },
            Object.assign(Object.create({ inherited: true }), { turn: validTurn() }),
            { turn: { ...validTurn(), items: Array.from({ length: 1_025 }, () => null) } }
        ];
        let accessorReads = 0;
        malformedStarts.push(Object.defineProperty({}, 'turn', {
            enumerable: true,
            get: () => {
                accessorReads += 1;
                return validTurn();
            }
        }));
        for (const response of malformedStarts) {
            const host = new FakeTurnHost();
            host.startPromise = Promise.resolve(response);
            const coordinator = new RideCodexTurnCoordinator({ host });
            const service = coordinator.connectClient({ turnEvents: () => undefined });
            await assert.rejects(
                service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] }),
                error => (error as { code?: string }).code === 'invalid-data'
            );
            assert.equal(host.releases, 1);
        }
        assert.equal(accessorReads, 0);

        const validItemHost = new FakeTurnHost();
        validItemHost.startPromise = Promise.resolve({
            turn: { ...validTurn(), items: [{ type: 'contextCompaction', id: 'item-1' }] }
        });
        const validItemCoordinator = new RideCodexTurnCoordinator({ host: validItemHost });
        const validItemService = validItemCoordinator.connectClient({ turnEvents: () => undefined });
        assert.equal((await validItemService.startTurn({
            threadId: 'thread-1', input: [{ type: 'text', text: 'one' }]
        })).status, 'in-progress');

        const originalImageHost = new FakeTurnHost();
        originalImageHost.startPromise = Promise.resolve({
            turn: {
                ...validTurn(),
                items: [{
                    type: 'userMessage',
                    id: 'item-2',
                    clientId: null,
                    content: [{ type: 'localImage', detail: 'original', path: 'C:\\workspace\\image.png' }]
                }]
            }
        });
        const originalImageCoordinator = new RideCodexTurnCoordinator({ host: originalImageHost });
        const originalImageService = originalImageCoordinator.connectClient({ turnEvents: () => undefined });
        assert.equal((await originalImageService.startTurn({
            threadId: 'thread-1', input: [{ type: 'text', text: 'one' }]
        })).status, 'in-progress');

        for (const response of [
            {},
            { turnId: 'turn-1', extra: true },
            Object.assign(Object.create({ inherited: true }), { turnId: 'turn-1' })
        ]) {
            const host = new FakeTurnHost();
            host.steerPromise = Promise.resolve(response);
            const coordinator = new RideCodexTurnCoordinator({ host });
            const service = coordinator.connectClient({ turnEvents: () => undefined });
            await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
            await assert.rejects(
                service.steerTurn({
                    threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'more' }]
                }),
                error => (error as { code?: string }).code === 'invalid-data'
            );
        }
    });

    it('preserves empty plan text and diff updates while rejecting unknown plan enums', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const events: RideCodexUiEvent[] = [];
        const coordinator = new RideCodexTurnCoordinator({ host, scheduler });
        const service = coordinator.connectClient({
            turnEvents: wire => { events.push(...decodeBatch(wire).events); }
        });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        host.emit('turn/diff/updated', { threadId: 'thread-1', turnId: 'turn-1', diff: '+line' });
        host.emit('turn/diff/updated', { threadId: 'thread-1', turnId: 'turn-1', diff: '' });
        host.emit('turn/plan/updated', {
            threadId: 'thread-1', turnId: 'turn-1', explanation: 'invalid',
            plan: [{ step: 'must-not-appear', status: 'futureStatus' }]
        });
        host.emit('turn/plan/updated', {
            threadId: 'thread-1', turnId: 'turn-1', explanation: '',
            plan: [{ step: '', status: 'inProgress' }]
        });
        host.emit('turn/plan/updated', {
            threadId: 'thread-1', turnId: 'turn-1', explanation: null,
            plan: [{ step: '', status: 'pending' }]
        });
        while (scheduler.callbacks.length > 0) {
            scheduler.flushOne();
            await Promise.resolve();
        }

        const diffs = events.filter((event): event is Extract<RideCodexUiEvent, { type: 'turn-diff' }> =>
            event.type === 'turn-diff'
        );
        assert.deepEqual(diffs.map(event => event.diff), ['+line', '']);
        const plans = events.filter((event): event is Extract<RideCodexUiEvent, { type: 'turn-plan' }> =>
            event.type === 'turn-plan'
        );
        assert.equal(plans.length, 2);
        assert.deepEqual(plans[0], {
            type: 'turn-plan', explanation: '', steps: [{ step: '', status: 'in-progress' }]
        });
        assert.deepEqual(plans[1], {
            type: 'turn-plan', steps: [{ step: '', status: 'pending' }]
        });
    });
});
