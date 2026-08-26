/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    RideCodexConversationsClient,
    RideCodexConversationsSnapshot,
    RideCodexModelPage
} from '../src/common/ride-codex-conversations';
import {
    RideCodexAuthServicePath,
    RideCodexConversationsClient as RideCodexConversationsClientToken,
    RideCodexConversationsService,
    RideCodexConversationsServicePath
} from '../src/common/ride-codex-protocol';
import {
    RideCodexThreadCoordinator,
    RideCodexThreadHost,
    RideCodexThreadHostStateEvent
} from '../src/node/ride-codex-thread-coordinator';
import type { RideCodexNotification, StableClientMethod } from '../src/node/ride-codex-jsonl-client';

interface RequestRecord {
    readonly method: string;
    readonly params: unknown;
}

class FakeThreadHost implements RideCodexThreadHost {
    readonly requests: RequestRecord[] = [];
    readonly notificationListeners = new Set<(notification: RideCodexNotification, generation: number) => void>();
    readonly stateListeners = new Set<(event: RideCodexThreadHostStateEvent) => void>();
    responder: (method: StableClientMethod, params: unknown) => unknown | Promise<unknown> = method => {
        if (method === 'model/list') {
            return { data: [], nextCursor: null };
        }
        if (method === 'thread/list') {
            return { data: [], nextCursor: null, backwardsCursor: null };
        }
        return {};
    };
    state: RideCodexThreadHostStateEvent['state'] = 'ready';
    generation = 1;
    acquireCount = 0;
    releaseCount = 0;
    activeLeases = 0;
    acquireFailure: Error | undefined;
    startGenerationOnAcquire: number | undefined;

    async acquire(): Promise<{
        readonly generation: number;
        request(method: StableClientMethod, params: unknown): unknown | Promise<unknown>;
        release(): void;
    }> {
        this.acquireCount += 1;
        if (this.acquireFailure) {
            throw this.acquireFailure;
        }
        if (this.startGenerationOnAcquire !== undefined) {
            const generation = this.startGenerationOnAcquire;
            this.startGenerationOnAcquire = undefined;
            this.changeState('ready', generation);
        }
        this.activeLeases += 1;
        let released = false;
        return {
            generation: this.generation,
            request: (method, params) => {
                this.requests.push({ method, params });
                return this.responder(method, params);
            },
            release: () => {
                if (!released) {
                    released = true;
                    this.releaseCount += 1;
                    this.activeLeases -= 1;
                }
            }
        };
    }

    onNotification(listener: (notification: RideCodexNotification, generation: number) => void): { dispose(): void } {
        this.notificationListeners.add(listener);
        return { dispose: () => this.notificationListeners.delete(listener) };
    }

    onStateChange(listener: (event: RideCodexThreadHostStateEvent) => void): { dispose(): void } {
        this.stateListeners.add(listener);
        return { dispose: () => this.stateListeners.delete(listener) };
    }

    snapshot(): RideCodexThreadHostStateEvent {
        return { state: this.state, generation: this.generation };
    }

    notify(method: string, params: unknown, generation = this.generation): void {
        for (const listener of [...this.notificationListeners]) {
            listener({ method, params }, generation);
        }
    }

    changeState(state: RideCodexThreadHostStateEvent['state'], generation: number): void {
        this.state = state;
        this.generation = generation;
        for (const listener of [...this.stateListeners]) {
            listener({ state, generation });
        }
    }
}

class RecordingClient implements RideCodexConversationsClient {
    readonly snapshots: RideCodexConversationsSnapshot[] = [];
    conversationsChanged(snapshot: RideCodexConversationsSnapshot): void {
        this.snapshots.push(snapshot);
    }
}

test('publishes a separate stable conversation RPC identity without transcript fields', () => {
    assert.equal(RideCodexConversationsServicePath, '/services/ride-codex-conversations');
    assert.notEqual(RideCodexConversationsServicePath, RideCodexAuthServicePath);
    assert.equal(typeof RideCodexConversationsService, 'symbol');
    assert.equal(typeof RideCodexConversationsClientToken, 'symbol');
});

test('maps model capabilities exactly, preserves opaque pagination, and deeply freezes output', async () => {
    const host = new FakeThreadHost();
    host.responder = () => ({
        data: [{
            id: 'gpt-5.4', model: 'gpt-5.4-codex', displayName: 'GPT-5.4', description: 'Coding model',
            hidden: false, isDefault: true, inputModalities: ['text', 'image'],
            supportedReasoningEfforts: [
                { reasoningEffort: 'minimal', description: 'Fast' },
                { reasoningEffort: 'xhigh', description: 'Deep' }
            ],
            defaultReasoningEffort: 'xhigh', supportsPersonality: true,
            serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Faster' }],
            defaultServiceTier: 'priority', upgrade: 'ignored', rawFutureField: { ignored: true }
        }],
        nextCursor: 'opaque-next'
    });
    const coordinator = new RideCodexThreadCoordinator({ host });

    const page: RideCodexModelPage = await coordinator.listModels({ cursor: 'opaque', limit: 25, includeHidden: true });

    assert.deepEqual(host.requests, [{ method: 'model/list', params: {
        cursor: 'opaque', limit: 25, includeHidden: true
    } }]);
    assert.deepEqual(page.data[0], {
        id: 'gpt-5.4', model: 'gpt-5.4-codex', displayName: 'GPT-5.4', description: 'Coding model',
        isDefault: true, hidden: false, inputModalities: ['text', 'image'],
        supportedReasoningEfforts: [
            { effort: 'minimal', description: 'Fast' },
            { effort: 'xhigh', description: 'Deep' }
        ],
        defaultReasoningEffort: 'xhigh', supportsPersonality: true,
        serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Faster' }],
        defaultServiceTier: 'priority'
    });
    assert.equal(page.nextCursor, 'opaque-next');
    assert.ok(Object.isFrozen(page));
    assert.ok(Object.isFrozen(page.data));
    assert.ok(Object.isFrozen(page.data[0].supportedReasoningEfforts));
    assert.equal(host.releaseCount, 1);
    await coordinator.dispose();
});

test('binds a request generation after a cold host acquire starts the shared process', async () => {
    const host = new FakeThreadHost();
    host.state = 'stopped';
    host.generation = 0;
    host.startGenerationOnAcquire = 1;
    const coordinator = new RideCodexThreadCoordinator({ host });

    const page = await coordinator.listModels();

    assert.deepEqual(page, { data: [], nextCursor: null });
    assert.deepEqual(await coordinator.status(), coordinator.snapshot());
    assert.equal(coordinator.snapshot().generation, 1);
    assert.equal(host.acquireCount, host.releaseCount);
    await coordinator.dispose();
});

test('maps persistent start, resume, read and archive without retaining transcript data', async () => {
    const host = new FakeThreadHost();
    host.responder = method => {
        if (method === 'thread/start') {
            return { thread: rawThread('started', { cwd: 'C:\\Work\\Repo\\pkg' }) };
        }
        if (method === 'thread/resume') {
            return { thread: rawThread('resumed', { cwd: 'C:\\Work\\Repo', turns: [{ id: 'history', items: [] }] }) };
        }
        if (method === 'thread/read') {
            return { thread: rawThread('resumed', { cwd: 'C:\\Work\\Repo', turns: [] }) };
        }
        assert.equal(method, 'thread/archive');
        return {};
    };
    const coordinator = new RideCodexThreadCoordinator({ host, pathStyle: 'win32' });

    await coordinator.startThread({
        workspaceRoot: 'C:\\Work\\Repo', cwd: 'C:\\Work\\Repo\\src\\..\\pkg', model: 'gpt-5.4-codex'
    });
    await coordinator.resumeThread({ threadId: 'resumed', workspaceRoot: 'C:\\Work\\Repo' });
    await coordinator.readThread('resumed');
    await coordinator.archiveThread('resumed');

    assert.deepEqual(host.requests, [
        { method: 'thread/start', params: {
            cwd: 'C:\\Work\\Repo\\pkg', model: 'gpt-5.4-codex', sandbox: 'workspace-write',
            approvalPolicy: 'on-request', ephemeral: false
        } },
        { method: 'thread/resume', params: {
            threadId: 'resumed', cwd: 'C:\\Work\\Repo', sandbox: 'workspace-write', approvalPolicy: 'on-request'
        } },
        { method: 'thread/read', params: { threadId: 'resumed', includeTurns: false } },
        { method: 'thread/archive', params: { threadId: 'resumed' } }
    ]);
    assert.equal(coordinator.snapshot().persistedTranscriptCount, 0);
    assert.equal(JSON.stringify(coordinator.snapshot()).includes('history'), false);
    assert.equal(host.acquireCount, host.releaseCount);
    await coordinator.dispose();
});

test('passes bounded thread pagination cursors and merges only the latest concurrent page', async () => {
    const host = new FakeThreadHost();
    const first = deferred<unknown>();
    host.responder = (_method, params) => (params as { cursor?: string }).cursor === 'old'
        ? first.promise
        : { data: [rawThread('new')], nextCursor: 'next', backwardsCursor: 'back' };
    const coordinator = new RideCodexThreadCoordinator({ host });
    const oldPage = coordinator.listThreads({ cursor: 'old', limit: 10 });
    const newPage = await coordinator.listThreads({ cursor: 'new', limit: 20 });
    first.resolve({ data: [rawThread('old')], nextCursor: null, backwardsCursor: null });
    await oldPage;

    assert.equal(newPage.nextCursor, 'next');
    assert.equal(newPage.backwardsCursor, 'back');
    assert.deepEqual(coordinator.snapshot().threads.map(thread => thread.id), ['new']);
    await assert.rejects(coordinator.listThreads({ limit: 101 }), /page size/i);
    assert.equal(host.acquireCount, host.releaseCount);
    await coordinator.dispose();
});

test('does not let an older list response clear a newer explicit selection', async () => {
    const host = new FakeThreadHost();
    host.responder = () => ({
        data: [rawThread('a'), rawThread('b')], nextCursor: null, backwardsCursor: null
    });
    const coordinator = new RideCodexThreadCoordinator({ host });
    await coordinator.listThreads();
    await coordinator.selectThread('b');

    const delayed = deferred<unknown>();
    host.responder = () => delayed.promise;
    const oldList = coordinator.listThreads();
    await tick();
    await coordinator.selectThread('a');
    delayed.resolve({ data: [], nextCursor: null, backwardsCursor: null });
    await oldList;

    assert.equal(coordinator.snapshot().selectedThreadId, 'a');
    assert.deepEqual(coordinator.snapshot().threads.map(thread => thread.id), ['a', 'b']);
    assert.equal(host.acquireCount, host.releaseCount);
    await coordinator.dispose();
});

test('treats repeated and empty explicit selections as newer user intent', async () => {
    const host = new FakeThreadHost();
    host.responder = () => ({
        data: [rawThread('selected')], nextCursor: null, backwardsCursor: null
    });
    const coordinator = new RideCodexThreadCoordinator({ host, pathStyle: 'posix' });
    await coordinator.listThreads();
    await coordinator.selectThread('selected');

    const delayedList = deferred<unknown>();
    host.responder = () => delayedList.promise;
    const listing = coordinator.listThreads();
    await tick();
    await coordinator.selectThread('selected');
    delayedList.resolve({ data: [], nextCursor: null, backwardsCursor: null });
    await listing;
    assert.equal(coordinator.snapshot().selectedThreadId, 'selected');

    await coordinator.selectThread(null);
    const delayedStart = deferred<unknown>();
    host.responder = () => delayedStart.promise;
    const starting = coordinator.startThread({ workspaceRoot: '/workspace' });
    await tick();
    await coordinator.selectThread(null);
    delayedStart.resolve({ thread: rawThread('late', { cwd: '/workspace' }) });
    await starting;
    assert.equal(coordinator.snapshot().selectedThreadId, undefined);
    await coordinator.dispose();
});

test('normalizes workspace cwd with platform semantics and rejects escapes and network shares', async () => {
    const windowsHost = new FakeThreadHost();
    windowsHost.responder = () => ({ thread: rawThread('win', { cwd: 'c:\\repo\\pkg' }) });
    const windows = new RideCodexThreadCoordinator({ host: windowsHost, pathStyle: 'win32' });
    await windows.startThread({ workspaceRoot: 'C:\\Repo', cwd: 'c:\\repo\\src\\..\\pkg' });
    assert.deepEqual(windowsHost.requests[0].params, {
        cwd: 'c:\\repo\\pkg', sandbox: 'workspace-write', approvalPolicy: 'on-request', ephemeral: false
    });
    await assert.rejects(windows.startThread({ workspaceRoot: 'C:\\Repo', cwd: 'C:\\escape' }), /workspace/i);
    await assert.rejects(windows.startThread({ workspaceRoot: '\\\\server\\share', cwd: '\\\\server\\share\\repo' }), /workspace/i);
    await assert.rejects(windows.startThread({ workspaceRoot: 'repo' }), /workspace/i);
    await assert.rejects(windows.startThread({ workspaceRoot: '/Work/Repo' }), /workspace/i);
    await assert.rejects(windows.startThread({ workspaceRoot: '\\Work\\Repo' }), /workspace/i);
    await assert.rejects(windows.startThread({ workspaceRoot: 'C:\\Work\\Repo', cwd: '/Work/Repo' }), /workspace/i);
    await assert.rejects(windows.startThread({ workspaceRoot: 'C:\\Work\\Repo', cwd: '\\Work\\Repo' }), /workspace/i);
    await assert.rejects(windows.startThread({ workspaceRoot: 'C:Work\\Repo' }), /workspace/i);
    await assert.rejects(windows.startThread({ workspaceRoot: '\\\\?\\C:\\Work\\Repo' }), /workspace/i);
    await assert.rejects(windows.startThread({ workspaceRoot: 'C:\\' }), /workspace/i);
    await assert.rejects(windows.startThread({ workspaceRoot: 'C:\\Work\0Repo' }), /invalid|workspace/i);

    const posixHost = new FakeThreadHost();
    posixHost.responder = () => ({ thread: rawThread('posix', { cwd: '/workspace/repo/pkg' }) });
    const posix = new RideCodexThreadCoordinator({ host: posixHost, pathStyle: 'posix' });
    await posix.startThread({ workspaceRoot: '/workspace/repo', cwd: '/workspace/repo/src/../pkg' });
    assert.equal((posixHost.requests[0].params as { cwd: string }).cwd, '/workspace/repo/pkg');
    await assert.rejects(posix.startThread({ workspaceRoot: '/workspace/repo', cwd: '/workspace/repository' }), /workspace/i);
    await windows.dispose();
    await posix.dispose();
});

test('clears stale selections and archived threads safely', async () => {
    const host = new FakeThreadHost();
    host.responder = method => method === 'thread/list'
        ? { data: [rawThread('one'), rawThread('two')], nextCursor: null, backwardsCursor: null }
        : {};
    const coordinator = new RideCodexThreadCoordinator({ host });
    await coordinator.listThreads();
    const selection = coordinator.selectThread('one');
    assert.ok(selection instanceof Promise);
    await selection;
    assert.equal(coordinator.snapshot().selectedThreadId, 'one');
    await assert.rejects(coordinator.selectThread('missing'), /not available/i);
    assert.equal(coordinator.snapshot().selectedThreadId, undefined);
    await coordinator.selectThread('one');
    host.notify('thread/archived', { threadId: 'one' });
    assert.equal(coordinator.snapshot().selectedThreadId, undefined);
    assert.deepEqual(coordinator.snapshot().threads.map(thread => thread.id), ['two']);
    await coordinator.dispose();
});

test('returns archived pages without making archived threads selectable', async () => {
    const host = new FakeThreadHost();
    host.responder = () => ({
        data: [rawThread('archived')], nextCursor: null, backwardsCursor: null
    });
    const coordinator = new RideCodexThreadCoordinator({ host });

    const page = await coordinator.listThreads({ archived: true });

    assert.deepEqual(page.data.map(thread => thread.id), ['archived']);
    assert.deepEqual(coordinator.snapshot().threads, []);
    await assert.rejects(coordinator.selectThread('archived'), /not available/i);
    await coordinator.dispose();
});

test('reconciles duplicate and out-of-order thread notifications by generation', async () => {
    const host = new FakeThreadHost();
    const coordinator = new RideCodexThreadCoordinator({ host });
    const started = { thread: rawThread('one', { status: { type: 'idle' } }) };
    host.notify('thread/started', started, 1);
    host.notify('thread/started', started, 1);
    host.notify('thread/status/changed', {
        threadId: 'one', status: { type: 'active', activeFlags: ['waitingOnApproval'] }
    }, 1);
    host.notify('thread/status/changed', {
        threadId: 'one', status: { type: 'active', activeFlags: ['waitingOnApproval'] }
    }, 1);
    host.notify('thread/started', started, 1);
    host.notify('thread/archived', { threadId: 'one' }, 0);

    assert.equal(coordinator.snapshot().threads.length, 1);
    assert.deepEqual(coordinator.snapshot().threads[0].status, {
        kind: 'active', activeFlags: ['waiting-on-approval']
    });

    host.notify('thread/started', { thread: rawThread('two', { status: { type: 'idle' } }) }, 1);
    host.notify('thread/started', {
        thread: rawThread('two', {
            updatedAt: 3,
            status: { type: 'active', activeFlags: ['waitingOnUserInput'] }
        })
    }, 1);
    assert.deepEqual(coordinator.snapshot().threads.find(thread => thread.id === 'two')?.status, {
        kind: 'active', activeFlags: ['waiting-on-user-input']
    });
    await coordinator.dispose();
});

test('keeps a newer started notification over an older list response with the same timestamp', async () => {
    const host = new FakeThreadHost();
    const delayed = deferred<unknown>();
    host.responder = () => delayed.promise;
    const coordinator = new RideCodexThreadCoordinator({ host });
    const listing = coordinator.listThreads();
    await tick();

    host.notify('thread/started', {
        thread: rawThread('same', {
            updatedAt: 7, preview: 'notification preview', name: 'notification name', status: { type: 'idle' }
        })
    });
    delayed.resolve({
        data: [rawThread('same', {
            updatedAt: 7, preview: 'stale list preview', name: 'stale list name', status: { type: 'systemError' }
        })],
        nextCursor: null,
        backwardsCursor: null
    });
    await listing;

    const summary = coordinator.snapshot().threads[0];
    assert.equal(summary.preview, 'notification preview');
    assert.equal(summary.name, 'notification name');
    assert.deepEqual(summary.status, { kind: 'idle', activeFlags: [] });
    await coordinator.dispose();
});

test('applies the latest status that arrives before thread started and clears it across generations', async () => {
    const host = new FakeThreadHost();
    const coordinator = new RideCodexThreadCoordinator({ host });
    host.notify('thread/status/changed', {
        threadId: 'pending', status: { type: 'active', activeFlags: ['waitingOnApproval'] }
    });
    host.notify('thread/status/changed', {
        threadId: 'pending', status: { type: 'active', activeFlags: ['waitingOnUserInput'] }
    });
    host.notify('thread/started', { thread: rawThread('pending', { status: { type: 'idle' } }) });
    host.notify('thread/started', { thread: rawThread('pending', { status: { type: 'systemError' } }) });

    assert.deepEqual(coordinator.snapshot().threads[0].status, {
        kind: 'active', activeFlags: ['waiting-on-user-input']
    });

    host.notify('thread/status/changed', {
        threadId: 'next-generation', status: { type: 'active', activeFlags: ['waitingOnApproval'] }
    });
    host.changeState('restarting', 2);
    host.notify('thread/started', { thread: rawThread('next-generation', { status: { type: 'idle' } }) }, 2);
    assert.deepEqual(coordinator.snapshot().threads.find(thread => thread.id === 'next-generation')?.status, {
        kind: 'idle', activeFlags: []
    });
    await coordinator.dispose();
});

test('bounds pending statuses during a multi-thread notification storm', async () => {
    const host = new FakeThreadHost();
    const coordinator = new RideCodexThreadCoordinator({ host });
    for (let index = 0; index < 513; index += 1) {
        host.notify('thread/status/changed', {
            threadId: `pending-${index}`,
            status: { type: 'active', activeFlags: ['waitingOnApproval'] }
        });
    }
    host.notify('thread/started', { thread: rawThread('pending-0', { status: { type: 'idle' } }) });
    host.notify('thread/started', { thread: rawThread('pending-512', { status: { type: 'idle' } }) });

    assert.deepEqual(coordinator.snapshot().threads.find(thread => thread.id === 'pending-0')?.status, {
        kind: 'idle', activeFlags: []
    });
    assert.deepEqual(coordinator.snapshot().threads.find(thread => thread.id === 'pending-512')?.status, {
        kind: 'active', activeFlags: ['waiting-on-approval']
    });
    await coordinator.dispose();
});

test('bounds cached thread revisions during a started notification storm', async () => {
    const host = new FakeThreadHost();
    const coordinator = new RideCodexThreadCoordinator({ host });
    for (let index = 0; index < 501; index += 1) {
        host.notify('thread/started', { thread: rawThread(`started-${index}`) });
    }

    assert.equal(coordinator.snapshot().threads.length, 500);
    assert.equal(coordinator.snapshot().threads.some(thread => thread.id === 'started-0'), false);
    assert.equal(coordinator.snapshot().threads.some(thread => thread.id === 'started-500'), true);
    await coordinator.dispose();
});

test('bounds archive reconciliation tombstones during a notification storm', async () => {
    const host = new FakeThreadHost();
    const coordinator = new RideCodexThreadCoordinator({ host });
    for (let index = 0; index < 513; index += 1) {
        host.notify('thread/archived', { threadId: `archived-${index}` });
    }
    host.notify('thread/started', { thread: rawThread('archived-0') });
    host.notify('thread/started', { thread: rawThread('archived-512') });

    assert.deepEqual(coordinator.snapshot().threads.map(thread => thread.id), ['archived-0']);
    await coordinator.dispose();
});

test('rejects an old-generation response before it can replace trusted thread state', async () => {
    const host = new FakeThreadHost();
    host.responder = () => ({
        data: [rawThread('selected')], nextCursor: null, backwardsCursor: null
    });
    const coordinator = new RideCodexThreadCoordinator({ host });
    await coordinator.listThreads();
    await coordinator.selectThread('selected');
    const pending = deferred<unknown>();
    host.responder = () => pending.promise;
    const reading = coordinator.readThread('selected').catch(error => error as Error);
    await tick();
    host.changeState('restarting', 2);
    pending.resolve({ thread: rawThread('selected', { updatedAt: 99 }) });
    const result = await reading;

    assert.ok(result instanceof Error);
    assert.match(result.message, /superseded/i);
    assert.equal(coordinator.snapshot().threads[0].updatedAt, 2);
    assert.equal(host.acquireCount, host.releaseCount);
    await coordinator.dispose();
});

test('refreshes the selected thread through the same host after a new ready generation', async () => {
    const host = new FakeThreadHost();
    host.responder = method => method === 'thread/list'
        ? { data: [rawThread('selected')], nextCursor: null, backwardsCursor: null }
        : { thread: rawThread('selected', { updatedAt: 9 }) };
    const coordinator = new RideCodexThreadCoordinator({ host });
    await coordinator.listThreads();
    await coordinator.selectThread('selected');
    host.changeState('restarting', 2);
    host.changeState('ready', 2);
    await waitFor(() => host.requests.some(request => request.method === 'thread/read'));

    assert.equal(coordinator.snapshot().generation, 2);
    assert.equal(coordinator.snapshot().selectedThreadId, 'selected');
    assert.equal(host.acquireCount, host.releaseCount);
    assert.deepEqual(host.requests[host.requests.length - 1], {
        method: 'thread/read', params: { threadId: 'selected', includeTurns: false }
    });
    await coordinator.dispose();
});

test('rejects Proxy, accessor and oversized server data without traps or state pollution', async () => {
    const host = new FakeThreadHost();
    const coordinator = new RideCodexThreadCoordinator({ host });
    const trapped = trapCountingProxy({ data: [], nextCursor: null });
    host.responder = () => trapped.proxy;
    await assert.rejects(coordinator.listModels(), /invalid/i);
    assert.equal(trapped.trapCount(), 0);

    let getterCalls = 0;
    const accessor: Record<string, unknown> = { nextCursor: null };
    Object.defineProperty(accessor, 'data', { get: () => { getterCalls += 1; return []; } });
    host.responder = () => accessor;
    await assert.rejects(coordinator.listModels(), /invalid/i);
    assert.equal(getterCalls, 0);

    host.responder = method => method === 'thread/list'
        ? { data: Array.from({ length: 101 }, (_, index) => rawThread(`thread-${index}`)), nextCursor: null, backwardsCursor: null }
        : {};
    await assert.rejects(coordinator.listThreads(), /invalid/i);
    const notification = trapCountingProxy({ threadId: 'secret-local-path-C:\\Users\\person' });
    host.notify('thread/archived', notification.proxy);
    assert.equal(notification.trapCount(), 0);
    assert.deepEqual(coordinator.snapshot().threads, []);
    await coordinator.dispose();
});

test('releases leases on failures and invalidates pending work on dispose', async () => {
    const host = new FakeThreadHost();
    host.responder = () => { throw new Error('raw C:\\Users\\secret'); };
    const coordinator = new RideCodexThreadCoordinator({ host });
    await assert.rejects(coordinator.listModels(), error => {
        assert.equal((error as Error).message.includes('C:\\Users\\secret'), false);
        return true;
    });
    assert.equal(host.acquireCount, host.releaseCount);

    const pending = deferred<unknown>();
    host.responder = () => pending.promise;
    const operation = coordinator.listThreads().catch(error => error as Error);
    await tick();
    await coordinator.dispose();
    pending.resolve({ data: [], nextCursor: null, backwardsCursor: null });
    const result = await operation;
    assert.ok(result instanceof Error);
    assert.match(result.message, /disposed|superseded/i);
    assert.equal(host.acquireCount, host.releaseCount);
    assert.equal(host.notificationListeners.size, 0);
    assert.equal(host.stateListeners.size, 0);
});

test('dispose immediately rejects a hung request and releases only its own lease', async () => {
    const host = new FakeThreadHost();
    const pending = deferred<unknown>();
    host.responder = () => pending.promise;
    const coordinator = new RideCodexThreadCoordinator({ host });
    const operation = coordinator.listThreads().catch(error => error as Error);
    await waitFor(() => host.activeLeases === 1);

    await coordinator.dispose();
    const immediate = await Promise.race([
        operation,
        tick().then(() => 'still-pending' as const)
    ]);
    const releasedAtDispose = host.releaseCount;
    const activeAtDispose = host.activeLeases;

    pending.reject(new Error('late request failure'));
    await operation;
    await tick();

    assert.ok(immediate instanceof Error);
    assert.match(immediate.message, /disposed|superseded/i);
    assert.equal(releasedAtDispose, 1);
    assert.equal(activeAtDispose, 0);
    assert.equal(host.acquireCount, host.releaseCount);
});

test('a newer explicit selection wins over an older start response and clients receive immutable state', async () => {
    const host = new FakeThreadHost();
    const start = deferred<unknown>();
    host.responder = method => method === 'thread/list'
        ? { data: [rawThread('existing')], nextCursor: null, backwardsCursor: null }
        : start.promise;
    const coordinator = new RideCodexThreadCoordinator({ host, pathStyle: 'posix' });
    const client = new RecordingClient();
    coordinator.setClient(client);
    await coordinator.listThreads();
    const starting = coordinator.startThread({ workspaceRoot: '/workspace' });
    await tick();
    await coordinator.selectThread('existing');
    start.resolve({ thread: rawThread('late', { cwd: '/workspace' }) });
    await starting;

    assert.equal(coordinator.snapshot().selectedThreadId, 'existing');
    assert.ok(client.snapshots.every(snapshot => Object.isFrozen(snapshot)));
    assert.ok(client.snapshots.every(snapshot => snapshot.persistedTranscriptCount === 0));
    coordinator.disconnectClient(client);
    await coordinator.dispose();
});

function rawThread(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id, preview: `Preview ${id}`, name: null, ephemeral: false, modelProvider: 'openai',
        createdAt: 1, updatedAt: 2, recencyAt: 2, status: { type: 'idle' },
        cwd: '/workspace', turns: [], ...overrides
    };
}

function trapCountingProxy<T extends object>(target: T): { proxy: T; trapCount(): number } {
    let traps = 0;
    return {
        proxy: new Proxy(target, {
            get: (object, key, receiver) => { traps += 1; return Reflect.get(object, key, receiver); },
            getOwnPropertyDescriptor: (object, key) => {
                traps += 1;
                return Reflect.getOwnPropertyDescriptor(object, key);
            },
            getPrototypeOf: object => { traps += 1; return Reflect.getPrototypeOf(object); },
            ownKeys: object => { traps += 1; return Reflect.ownKeys(object); }
        }),
        trapCount: () => traps
    };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function tick(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) {
            return;
        }
        await tick();
    }
    assert.fail('condition was not met');
}
