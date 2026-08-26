/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RideCodexEventBatch, RideCodexUiEvent } from '../src/common/ride-codex-events';
import type { RideCodexNotification } from '../src/node/ride-codex-jsonl-client';
import {
    RideCodexTurnCoordinator,
    RideCodexTurnHost,
    RideCodexTurnHostLease,
    RideCodexTurnScheduler
} from '../src/node/ride-codex-turn-coordinator';

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
    resumeResponse: unknown = { thread: { id: 'thread-1' } };
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
                    return { turn: { id: this.nextTurnId, status: 'inProgress', items: [] } };
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
        await service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });

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
        const batches: unknown[] = [];
        const coordinator = new RideCodexTurnCoordinator({
            host,
            scheduler,
            maxQueuedBytes: 4_096,
            maxItemBytes: 2_048
        });
        const service = coordinator.connectClient({ turnEvents: batch => { batches.push(batch); } });
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

        assert.equal(batches.length, 0);
        assert.equal(scheduler.callbacks.length, 1);
        scheduler.flushOne();
        await Promise.resolve();

        assert.equal(batches.length, 1);
        const batch = batches[0] as { events: Array<{ type: string; delta?: string }> };
        const delta = batch.events.find(event => event.type === 'agent-delta');
        assert.equal(delta?.delta, 'x'.repeat(1_000));
        assert.ok(Object.isFrozen(batch));
        assert.ok(Object.isFrozen(batch.events));
    });

    it('normalizes the reviewed turn, item, reasoning, plan, command, file, usage, warning, and error families', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const eventTypes: string[] = [];
        const normalizedEvents: RideCodexUiEvent[] = [];
        const coordinator = new RideCodexTurnCoordinator({ host, scheduler });
        const service = coordinator.connectClient({
            turnEvents: batch => {
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
            changes: [{ path: 'src/a.ts', kind: 'update', diff: '@@ -1 +1 @@' }]
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
        assert.equal(patchEvent?.changes[0].diff, '@@ -1 +1 @@');
        assert.deepEqual(normalizedEvents.find(event => event.type === 'reasoning-delta'), {
            type: 'reasoning-delta', itemId: 'item-1', contentIndex: 0, delta: 'details'
        });
    });

    it('keeps reasoning summary, part, and text streams distinct at UTF-8 boundaries', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const events: RideCodexUiEvent[] = [];
        const coordinator = new RideCodexTurnCoordinator({ host, scheduler, maxItemBytes: 8 });
        const service = coordinator.connectClient({ turnEvents: batch => { events.push(...batch.events); } });
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
        const service = coordinator.connectClient({ turnEvents: batch => { types.push(...batch.events.map(event => event.type)); } });
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
        host.interruptPromise = new Promise(() => undefined);
        const coordinator = new RideCodexTurnCoordinator({
            host,
            scheduler,
            interruptTimeoutMs: 25,
            timers: {
                setTimeout: callback => { timeoutCallbacks.push(callback); return callback; },
                clearTimeout: () => undefined
            }
        });
        const service = coordinator.connectClient({ turnEvents: () => undefined });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }] });
        const interrupting = service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });
        timeoutCallbacks.shift()?.();

        const result = await interrupting;

        assert.equal(result.status, 'interrupt-uncertain');
        assert.deepEqual(host.restartCalls, [1]);
        assert.equal(host.releases, 2);
        assert.deepEqual(host.calls[host.calls.length - 1], {
            method: 'thread/resume',
            params: { threadId: 'thread-1' }
        });
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
        for (const response of [{}, { thread: { id: 'wrong-thread' } }, proxied, accessor]) {
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
                turnEvents: batch => { events.push(...batch.events); }
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
        const service = coordinator.connectClient({ turnEvents: batch => { batches.push(batch); } });
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

    it('retains truncation metadata for each rapid turn identity before a flush', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const batches: RideCodexEventBatch[] = [];
        const coordinator = new RideCodexTurnCoordinator({
            host, scheduler, maxQueuedBytes: 4_096, maxItemBytes: 8
        });
        const service = coordinator.connectClient({ turnEvents: batch => { batches.push(batch); } });

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
            turnEvents: batch => {
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
            host, scheduler, maxQueuedBytes: 256, maxItemBytes: 2_048, maxBatchEvents: 64
        });
        const service = coordinator.connectClient({
            turnEvents: batch => { types.push(...batch.events.map(event => event.type)); }
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

    it('keeps terminal then next-start ordering for a slow frontend with a bounded pending queue', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        let resolveFirst!: () => void;
        const firstDelivery = new Promise<void>(resolve => { resolveFirst = resolve; });
        const deliveries: Array<{ turnId: string; types: string[] }> = [];
        const coordinator = new RideCodexTurnCoordinator({ host, scheduler });
        let call = 0;
        const service = coordinator.connectClient({
            turnEvents: batch => {
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
            host, scheduler, maxQueuedBytes: 512, maxBatchEvents: 8
        });
        const service = coordinator.connectClient({
            turnEvents: batch => {
                delivered.push(batch);
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
            assert.ok(Buffer.byteLength(JSON.stringify(batch), 'utf8') <= 512);
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
            host, scheduler, maxQueuedBytes: 512, maxBatchEvents: 8, maxItemBytes: 128
        });
        const service = coordinator.connectClient({
            turnEvents: batch => {
                delivered.push(batch);
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

    it('normal interrupt confirmation waits for exact terminal before releasing once', async () => {
        const host = new FakeTurnHost();
        const scheduler = new FakeScheduler();
        const coordinator = new RideCodexTurnCoordinator({ host, scheduler });
        const service = coordinator.connectClient({ turnEvents: () => undefined });
        await service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        const result = await service.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' });
        assert.equal(result.status, 'in-progress');
        assert.equal(host.releases, 0);
        host.emit('turn/completed', {
            threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted', items: [] }
        });
        assert.equal(host.releases, 1);
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
            turnEvents: batch => { types.push(...batch.events.map(event => event.type)); }
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
            maxQueuedBytes: 4_096,
            maxItemBytes: 2_048,
            maxBatchEvents: 16,
            maxRetainedItems: 2,
            maxDiagnosticHistory: 2
        });
        const service = coordinator.connectClient({ turnEvents: batch => { batches.push(batch); } });
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
        assert.ok(batches.every(batch => Buffer.byteLength(JSON.stringify(batch.events), 'utf8') <= 4_096));
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
        resolveStart({ turn: { id: 'turn-1', status: 'inProgress', items: [] } });
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
            turnEvents: batch => { events.push(...batch.events); }
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
            host, scheduler, maxQueuedBytes: 4_096, maxItemBytes: 2_048
        });
        const service = coordinator.connectClient({
            turnEvents: batch => { events.push(...batch.events); }
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
            turnEvents: batch => {
                delivered.push(...batch.events);
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
            turnEvents: batch => { types.push(...batch.events.map(event => event.type)); }
        });
        const starting = service.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'one' }] });
        await Promise.resolve();
        await Promise.resolve();
        host.emit('turn/started', {
            threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [] }
        });
        resolveStart({ turn: { id: 'turn-1', status: 'inProgress', items: [] } });
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
});
