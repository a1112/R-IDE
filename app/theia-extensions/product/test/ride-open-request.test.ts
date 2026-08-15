/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenerService, OpenHandler, OpenerOptions } from '@theia/core/lib/browser/opener-service';
import type { WidgetOpenerOptions } from '@theia/core/lib/browser/widget-open-handler';
import { FileUri } from '@theia/core/lib/common/file-uri';
import URI from '@theia/core/lib/common/uri';
import { PluginType } from '@theia/plugin-ext/lib/common/plugin-protocol';
import { RideNativeChrome } from '../src/browser/ride-native-chrome';
import {
    RIDE_OPEN_REQUEST_STATE_KEY,
    RideOpenRequest,
    RideOpenRequestContribution,
    RidePluginDeploymentScheduler,
    RideStartupMilestone
} from '../src/browser/ride-open-request';

const LEGACY_PENDING_KEY = 'r-ide.open-request.pending.v1';
const LEGACY_LAST_CONSUMED_KEY = 'r-ide.open-request.last-consumed.v1';
const MAX_PENDING_REQUESTS = 64;
const MAX_STATE_CHARS = 262_144;

class MemoryStorage implements Storage {
    protected readonly values = new Map<string, string>();

    get length(): number {
        return this.values.size;
    }

    clear(): void {
        this.values.clear();
    }

    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }

    key(index: number): string | null {
        return [...this.values.keys()][index] ?? null;
    }

    removeItem(key: string): void {
        this.values.delete(key);
    }

    setItem(key: string, value: string): void {
        this.values.set(key, value);
    }
}

class FaultyStorage extends MemoryStorage {
    failNextSet = false;
    failNextRemove = false;

    override removeItem(key: string): void {
        if (this.failNextRemove) {
            this.failNextRemove = false;
            throw new DOMException('storage remove failed', 'QuotaExceededError');
        }
        super.removeItem(key);
    }

    override setItem(key: string, value: string): void {
        if (this.failNextSet) {
            this.failNextSet = false;
            throw new DOMException('storage commit failed', 'QuotaExceededError');
        }
        super.setItem(key, value);
    }
}

class FakeWorkspaceService {
    readonly opened: Array<{ uri: URI; options: { preserveWindow?: boolean } | undefined }> = [];
    openError: Error | undefined;
    ready: Promise<void> = Promise.resolve();
    workspace: { resource: URI } | undefined;

    constructor(workspace: { resource: URI } | undefined) {
        this.workspace = workspace;
    }

    open(uri: URI, options?: { preserveWindow?: boolean }): void {
        if (this.openError) {
            throw this.openError;
        }
        this.opened.push({ uri, options });
    }
}

class FakeOpenerService implements OpenerService {
    readonly opened: Array<{ uri: URI; options: OpenerOptions | undefined }> = [];
    readonly handlerActivations: string[] = [];

    constructor(protected readonly beforeOpen: (uri: URI) => void | Promise<void> = () => undefined) { }

    async getOpeners(): Promise<OpenHandler[]> {
        return [await this.getOpener()];
    }

    async getOpener(): Promise<OpenHandler> {
        return {
            id: 'test-editor',
            canHandle: () => 100,
            open: async (uri, options) => {
                await this.beforeOpen(uri);
                this.opened.push({ uri, options });
                const widget = { id: `editor-${this.opened.length}` };
                const mode = (options as WidgetOpenerOptions | undefined)?.mode ?? 'activate';
                if (mode === 'activate') {
                    this.handlerActivations.push(widget.id);
                }
                return widget;
            }
        };
    }
}

class FakeMessageService {
    readonly errors: string[] = [];
    errorToThrow: Error | undefined;

    error(message: string): Promise<undefined> {
        this.errors.push(message);
        if (this.errorToThrow) {
            throw this.errorToThrow;
        }
        return Promise.resolve(undefined);
    }
}

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T | PromiseLike<T>): void;
    reject(reason?: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

class FakePluginDeploymentTimer {
    readonly scheduledDelays: number[] = [];
    readonly cleared: unknown[] = [];
    protected callback: (() => void) | undefined;
    protected readonly handle = { kind: 'plugin-deployment-timer' };

    set = (callback: () => void, delay: number): unknown => {
        this.callback = callback;
        this.scheduledDelays.push(delay);
        return this.handle;
    };

    clear = (handle: unknown): void => {
        this.cleared.push(handle);
        if (handle === this.handle) {
            this.callback = undefined;
        }
    };

    fire(): void {
        const callback = this.callback;
        this.callback = undefined;
        callback?.();
    }
}

function createPluginDeploymentScheduler(
    events: string[],
    timer = new FakePluginDeploymentTimer(),
    install: (entry: string, type?: PluginType) => Promise<void> = async (entry, type) => {
        events.push(`install:${entry}:${type}`);
    }
): { scheduler: RidePluginDeploymentScheduler; timer: FakePluginDeploymentTimer } {
    const scheduler = new RidePluginDeploymentScheduler(
        { install } as never,
        async () => ['C:\\R-IDE\\plugins'],
        {
            delayMs: 250,
            setTimeout: timer.set,
            clearTimeout: timer.clear
        }
    );
    return { scheduler, timer };
}

class FakeApplicationStateService {
    readonly reachedStates: string[] = [];
    protected readonly attached = deferred<void>();

    constructor(attached = true) {
        if (attached) {
            this.attached.resolve();
        }
    }

    reachedState(state: string): Promise<void> {
        this.reachedStates.push(state);
        assert.equal(state, 'attached_shell');
        return this.attached.promise;
    }

    attach(): void {
        this.attached.resolve();
    }

    reject(error: Error): void {
        this.attached.reject(error);
    }
}

class FakeHostedPluginSupport {
    protected readonly willStartDeferred = deferred<void>();
    protected readonly didStartDeferred = deferred<void>();

    get willStart(): Promise<void> {
        return this.willStartDeferred.promise;
    }

    get didStart(): Promise<void> {
        return this.didStartDeferred.promise;
    }

    resolveWillStart(): void {
        this.willStartDeferred.resolve();
    }

    rejectWillStart(error: Error): void {
        this.willStartDeferred.reject(error);
    }

    resolveDidStart(): void {
        this.didStartDeferred.resolve();
    }

    rejectDidStart(error: Error): void {
        this.didStartDeferred.reject(error);
    }
}

class FakeShell {
    readonly activated: string[] = [];

    async activateWidget(id: string): Promise<undefined> {
        this.activated.push(id);
        return undefined;
    }
}

class FakeNativeChrome {
    registrations = 0;
    unlistenCalls = 0;
    protected handler: ((request: RideOpenRequest) => void) | undefined;

    constructor(
        protected readonly onListen: () => void = () => undefined,
        protected readonly frontendReady: Promise<void> = Promise.resolve()
    ) { }

    async listenForOpenRequests(handler: (request: RideOpenRequest) => void): Promise<() => void> {
        this.onListen();
        this.registrations++;
        this.handler = handler;
        return () => {
            this.unlistenCalls++;
            this.handler = undefined;
        };
    }

    waitForFrontendReadyNotification(): Promise<void> {
        return this.frontendReady;
    }

    emit(payload: unknown): void {
        assert.ok(this.handler, 'native listener must be registered before emitting');
        this.handler(payload as RideOpenRequest);
    }
}

class TestRideOpenRequestContribution extends RideOpenRequestContribution {
    async settlePluginObservations(): Promise<void> {
        await Promise.all([this.pluginWillStart, this.pluginDidStart]);
    }
}

function stateEnvelope(lastConsumed: string, ...requests: object[]): object {
    return { version: 2, lastConsumed, requests };
}

function readState(storage: Storage): { version: 2; lastConsumed: string; requests: RideOpenRequest[] } | undefined {
    const serialized = storage.getItem(RIDE_OPEN_REQUEST_STATE_KEY);
    return serialized === null ? undefined : JSON.parse(serialized);
}

async function flushRequestChain(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
}

async function flushLifecycle(): Promise<void> {
    await Promise.resolve();
    await flushRequestChain();
}

function createContribution(
    workspacePath = String.raw`C:\project`,
    storage = new MemoryStorage(),
    beforeOpen: (uri: URI) => void | Promise<void> = () => undefined,
    reportStartupMilestone: (milestone: RideStartupMilestone) => Promise<void>
        = async () => undefined,
    applicationState = new FakeApplicationStateService(),
    hostedPlugins: FakeHostedPluginSupport | Promise<FakeHostedPluginSupport> = new FakeHostedPluginSupport(),
    pluginDeployment?: RidePluginDeploymentScheduler,
    nativeChrome?: FakeNativeChrome
): {
    contribution: TestRideOpenRequestContribution;
    workspace: FakeWorkspaceService;
    openers: FakeOpenerService;
    messages: FakeMessageService;
    shell: FakeShell;
    native: FakeNativeChrome;
    storage: MemoryStorage;
    milestones: RideStartupMilestone[];
    applicationState: FakeApplicationStateService;
    hostedPlugins: FakeHostedPluginSupport | Promise<FakeHostedPluginSupport>;
    events: string[];
} {
    const workspace = new FakeWorkspaceService({ resource: FileUri.create(workspacePath) });
    const events: string[] = [];
    const openers = new FakeOpenerService(async uri => {
        events.push(`open:${uri.path.toString()}`);
        await beforeOpen(uri);
    });
    const messages = new FakeMessageService();
    const shell = new FakeShell();
    const native = nativeChrome ?? new FakeNativeChrome(() => events.push('listen'));
    const milestones: RideStartupMilestone[] = [];
    const contribution = new TestRideOpenRequestContribution(
        workspace as never,
        openers,
        messages as never,
        shell as never,
        native as never,
        applicationState as never,
        hostedPlugins as never,
        storage,
        async milestone => {
            milestones.push(milestone);
            events.push(`milestone:${milestone}`);
            await reportStartupMilestone(milestone);
        },
        () => undefined,
        pluginDeployment
    );
    return {
        contribution,
        workspace,
        openers,
        messages,
        shell,
        native,
        storage,
        milestones,
        applicationState,
        hostedPlugins,
        events
    };
}

test('target file opens before deferred plugin installation begins', async () => {
    const events: string[] = [];
    const { scheduler } = createPluginDeploymentScheduler(events);
    const context = createContribution(
        '/project',
        new MemoryStorage(),
        () => { events.push('open'); },
        async () => undefined,
        new FakeApplicationStateService(),
        new FakeHostedPluginSupport(),
        scheduler
    );

    await context.contribution.handleOpenRequest({
        id: '49', source: 'initial', workspace: '/project', files: ['/project/deferred-plugin.R']
    });
    await flushLifecycle();

    assert.deepEqual(events, [
        'open',
        `install:local-dir:C:\\R-IDE\\plugins:${PluginType.System}`
    ]);
});

test('no-file startup schedules plugin deployment after a bounded delay', async () => {
    const events: string[] = [];
    const { scheduler, timer } = createPluginDeploymentScheduler(events);
    const context = createContribution(
        '/project', new MemoryStorage(), () => undefined, async () => undefined,
        new FakeApplicationStateService(), new FakeHostedPluginSupport(), scheduler
    );

    context.contribution.onStart();
    await flushLifecycle();
    assert.deepEqual(timer.scheduledDelays, [250]);
    assert.deepEqual(events, []);

    timer.fire();
    await flushLifecycle();
    assert.deepEqual(events, [`install:local-dir:C:\\R-IDE\\plugins:${PluginType.System}`]);
});

test('no-file fallback waits until the native initial-intent window has closed', async () => {
    const frontendReady = deferred<void>();
    const events: string[] = [];
    const { scheduler, timer } = createPluginDeploymentScheduler(events);
    const native = new FakeNativeChrome(() => events.push('listen'), frontendReady.promise);
    const context = createContribution(
        '/project', new MemoryStorage(), () => undefined, async () => undefined,
        new FakeApplicationStateService(), new FakeHostedPluginSupport(), scheduler, native
    );

    context.contribution.onStart();
    await flushLifecycle();
    assert.equal(native.registrations, 1, 'the listener must be active before native intent delivery');
    assert.deepEqual(timer.scheduledDelays, []);
    timer.fire();
    await flushLifecycle();
    assert.deepEqual(events, ['listen']);

    frontendReady.resolve();
    await flushLifecycle();
    assert.deepEqual(timer.scheduledDelays, [250]);
});

test('an initial native target received before frontend-ready suppresses the fallback timer', async () => {
    const frontendReady = deferred<void>();
    const opened = deferred<void>();
    const events: string[] = [];
    const { scheduler, timer } = createPluginDeploymentScheduler(events);
    const native = new FakeNativeChrome(() => events.push('listen'), frontendReady.promise);
    const context = createContribution(
        '/project', new MemoryStorage(), async () => {
            events.push('opening');
            await opened.promise;
        }, async () => undefined, new FakeApplicationStateService(), new FakeHostedPluginSupport(), scheduler, native
    );

    context.contribution.onStart();
    await flushLifecycle();
    native.emit({
        id: '53', source: 'initial', workspace: '/project', files: ['/project/initial-before-ready.R']
    });
    await flushLifecycle();
    assert.deepEqual(events, ['listen', 'opening']);

    frontendReady.resolve();
    await flushLifecycle();
    assert.deepEqual(timer.scheduledDelays, []);
    opened.resolve();
    await flushLifecycle();
    assert.deepEqual(events, [
        'listen',
        'opening',
        `install:local-dir:C:\\R-IDE\\plugins:${PluginType.System}`
    ]);
});

test('restored target opening suppresses the no-file timer until the editor is active', async () => {
    const storage = new MemoryStorage();
    storage.setItem(RIDE_OPEN_REQUEST_STATE_KEY, JSON.stringify(stateEnvelope('51', {
        id: '51', source: 'initial', workspace: '/project', files: ['/project/slow-restore.R']
    })));
    const opened = deferred<void>();
    const events: string[] = [];
    const { scheduler, timer } = createPluginDeploymentScheduler(events);
    const context = createContribution(
        '/project', storage, async () => {
            events.push('opening');
            await opened.promise;
        }, async () => undefined, new FakeApplicationStateService(), new FakeHostedPluginSupport(), scheduler
    );

    context.contribution.onStart();
    await flushLifecycle();
    assert.deepEqual(events, ['opening']);
    assert.equal(context.native.registrations, 1, 'native intents must be buffered while a stored target restores');
    assert.deepEqual(timer.scheduledDelays, [], 'a pending target must not race the no-file timer');

    opened.resolve();
    await flushLifecycle();
    assert.deepEqual(events, [
        'opening',
        `install:local-dir:C:\\R-IDE\\plugins:${PluginType.System}`
    ]);
});

test('a native target request cancels an already scheduled no-file fallback while opening', async () => {
    const opened = deferred<void>();
    const events: string[] = [];
    const { scheduler, timer } = createPluginDeploymentScheduler(events);
    const context = createContribution(
        '/project', new MemoryStorage(), async () => {
            events.push('opening');
            await opened.promise;
        }, async () => undefined, new FakeApplicationStateService(), new FakeHostedPluginSupport(), scheduler
    );

    context.contribution.onStart();
    await flushLifecycle();
    assert.deepEqual(timer.scheduledDelays, [250]);
    context.native.emit({
        id: '52', source: 'singleInstance', workspace: '/project', files: ['/project/slow-native.R']
    });
    await flushLifecycle();
    assert.deepEqual(events, ['opening']);
    assert.equal(timer.cleared.length, 1);

    timer.fire();
    await flushLifecycle();
    assert.deepEqual(events, ['opening']);
    opened.resolve();
    await flushLifecycle();
    assert.deepEqual(events, [
        'opening',
        `install:local-dir:C:\\R-IDE\\plugins:${PluginType.System}`
    ]);
});

test('a duplicate request does not cancel the no-file fallback', async () => {
    const storage = new MemoryStorage();
    storage.setItem(RIDE_OPEN_REQUEST_STATE_KEY, JSON.stringify(stateEnvelope('52')));
    const events: string[] = [];
    const { scheduler, timer } = createPluginDeploymentScheduler(events);
    const context = createContribution(
        '/project', storage, () => undefined, async () => undefined,
        new FakeApplicationStateService(), new FakeHostedPluginSupport(), scheduler
    );

    context.contribution.onStart();
    await flushLifecycle();
    context.native.emit({
        id: '52', source: 'singleInstance', workspace: '/project', files: ['/project/duplicate.R']
    });
    await flushLifecycle();

    assert.equal(timer.cleared.length, 0);
    timer.fire();
    await flushLifecycle();
    assert.deepEqual(events, [`install:local-dir:C:\\R-IDE\\plugins:${PluginType.System}`]);
});

test('plugin-dependent demand deploys immediately and cancels the fallback timer', async () => {
    const events: string[] = [];
    const { scheduler, timer } = createPluginDeploymentScheduler(events);
    const context = createContribution(
        '/project', new MemoryStorage(), () => undefined, async () => undefined,
        new FakeApplicationStateService(), new FakeHostedPluginSupport(), scheduler
    );

    context.contribution.onStart();
    await flushLifecycle();
    await context.contribution.requestPluginDeployment();

    assert.equal(timer.cleared.length, 1);
    assert.deepEqual(events, [`install:local-dir:C:\\R-IDE\\plugins:${PluginType.System}`]);
});

test('plugin deployment is idempotent across concurrent and repeated demand', async () => {
    const installs: Array<{ entry: string; type: PluginType | undefined }> = [];
    const release = deferred<void>();
    const { scheduler } = createPluginDeploymentScheduler([], new FakePluginDeploymentTimer(), async (entry, type) => {
        installs.push({ entry, type });
        await release.promise;
    });

    const first = scheduler.deployNow();
    const second = scheduler.deployNow();
    await flushRequestChain();
    assert.deepEqual(installs, [{ entry: 'local-dir:C:\\R-IDE\\plugins', type: PluginType.System }]);

    release.resolve();
    await Promise.all([first, second]);
    await scheduler.deployNow();
    assert.equal(installs.length, 1);
});

test('plugin deployment failure remains non-blocking and leaves the editor open', async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...values: unknown[]) => warnings.push(values);
    try {
        const { scheduler } = createPluginDeploymentScheduler([], new FakePluginDeploymentTimer(), async () => {
            throw new Error('deployment unavailable');
        });
        const context = createContribution(
            '/project', new MemoryStorage(), () => undefined, async () => undefined,
            new FakeApplicationStateService(), new FakeHostedPluginSupport(), scheduler
        );

        await context.contribution.handleOpenRequest({
            id: '50', source: 'initial', workspace: '/project', files: ['/project/still-open.R']
        });
        await flushLifecycle();

        assert.equal(context.openers.opened.length, 1);
        assert.deepEqual(context.shell.activated, ['editor-1']);
        assert.equal(context.messages.errors.length, 0);
        assert.equal(warnings.length, 1);
        assert.match(String(warnings[0][1]), /deployment unavailable/);
    } finally {
        console.warn = originalWarn;
    }
});

test('same-workspace requests open files in order, activate the target editor, and consume duplicate IDs once', async () => {
    const { contribution, workspace, openers, messages, shell } = createContribution();
    const request = {
        id: '1',
        source: 'singleInstance',
        workspace: 'C:\\PROJECT\\',
        files: [String.raw`C:\project\first.R`, String.raw`C:/project/second.R`]
    };

    await contribution.handleOpenRequest(request);
    await contribution.handleOpenRequest(request);

    assert.deepEqual(openers.opened.map(entry => FileUri.fsPath(entry.uri).toLowerCase()), [
        String.raw`c:\project\first.r`,
        String.raw`c:\project\second.r`
    ]);
    assert.deepEqual(openers.handlerActivations, []);
    assert.deepEqual(shell.activated, ['editor-2']);
    assert.deepEqual(workspace.opened, []);
    assert.deepEqual(messages.errors, []);
});

test('same-workspace requests preserve later files from other directories', async () => {
    const context = createContribution('/first');

    await context.contribution.handleOpenRequest({
        id: '2',
        source: 'initial',
        workspace: '/first',
        files: ['/first/one.R', '/second/two.R']
    });

    assert.deepEqual(context.openers.opened.map(entry => entry.uri.toString()), [
        'file:///first/one.R',
        'file:///second/two.R'
    ]);
    assert.deepEqual(context.shell.activated, ['editor-2']);
    assert.deepEqual(context.messages.errors, []);
});

test('different-workspace requests persist only the typed handoff and switch without opening files early', async () => {
    const { contribution, workspace, openers, messages, storage } = createContribution(String.raw`C:\old-project`);
    const request = {
        id: '2',
        source: 'openedUrl',
        workspace: String.raw`D:\new-project`,
        files: [String.raw`D:\new-project\analysis.R`]
    };

    await contribution.handleOpenRequest(request);

    assert.deepEqual(openers.opened, []);
    assert.deepEqual(readState(storage), stateEnvelope('2', {
        ...request,
        workspace: 'D:/new-project',
        files: ['D:/new-project/analysis.R']
    }));
    assert.equal(workspace.opened.length, 1);
    assert.equal(FileUri.fsPath(workspace.opened[0].uri).toLowerCase(), String.raw`d:\new-project`);
    assert.deepEqual(workspace.opened[0].options, { preserveWindow: true });
    assert.deepEqual(messages.errors, []);
});

test('an initial state commit failure consumes nothing and performs no open or switch', async () => {
    const storage = new FaultyStorage();
    storage.failNextSet = true;
    const context = createContribution('/project', storage);
    const request: RideOpenRequest = {
        id: '1', source: 'initial', workspace: '/project', files: ['/project/file.R']
    };

    await context.contribution.handleOpenRequest(request);

    assert.equal(storage.getItem(RIDE_OPEN_REQUEST_STATE_KEY), null);
    assert.deepEqual(context.openers.opened, []);
    assert.deepEqual(context.workspace.opened, []);
    assert.equal(context.messages.errors.length, 1);

    const retry = createContribution('/project', storage);
    await retry.contribution.handleOpenRequest(request);
    assert.deepEqual(readState(storage), stateEnvelope('1'));
    assert.equal(retry.openers.opened.length, 1);
});

test('an append commit failure preserves the previous state byte-for-byte and remains retryable', async () => {
    const storage = new FaultyStorage();
    const requestA: RideOpenRequest = {
        id: '1', source: 'singleInstance', workspace: '/workspace-a', files: ['/workspace-a/a.R']
    };
    const requestB: RideOpenRequest = {
        id: '2', source: 'singleInstance', workspace: '/workspace-b', files: ['/workspace-b/b.R']
    };
    const original = JSON.stringify(stateEnvelope('1', requestA));
    storage.setItem(RIDE_OPEN_REQUEST_STATE_KEY, original);
    storage.failNextSet = true;
    const context = createContribution('/workspace-x', storage);

    await context.contribution.handleOpenRequest(requestB);

    assert.equal(storage.getItem(RIDE_OPEN_REQUEST_STATE_KEY), original);
    assert.deepEqual(context.openers.opened, []);
    assert.deepEqual(context.workspace.opened, []);
    assert.equal(context.messages.errors.length, 1);

    const retry = createContribution('/workspace-x', storage);
    await retry.contribution.handleOpenRequest(requestB);
    assert.deepEqual(readState(storage), stateEnvelope('2', requestA, requestB));
    assert.deepEqual(retry.workspace.opened, []);
});

test('a remainder commit failure leaves the head intact and prevents premature open or switch', async () => {
    const storage = new FaultyStorage();
    const requestA: RideOpenRequest = {
        id: '1', source: 'singleInstance', workspace: '/workspace-a', files: ['/workspace-a/a.R']
    };
    const requestB: RideOpenRequest = {
        id: '2', source: 'singleInstance', workspace: '/workspace-b', files: ['/workspace-b/b.R']
    };
    const original = JSON.stringify(stateEnvelope('2', requestA, requestB));
    storage.setItem(RIDE_OPEN_REQUEST_STATE_KEY, original);
    storage.failNextSet = true;
    const context = createContribution('/workspace-a', storage);

    await context.contribution.restorePendingRequest();

    assert.equal(storage.getItem(RIDE_OPEN_REQUEST_STATE_KEY), original);
    assert.deepEqual(context.openers.opened, []);
    assert.deepEqual(context.workspace.opened, []);
    assert.equal(context.messages.errors.length, 1);

    const retry = createContribution('/workspace-a', storage);
    await retry.contribution.restorePendingRequest();
    assert.deepEqual(retry.openers.opened.map(entry => entry.uri.toString()), ['file:///workspace-a/a.R']);
    assert.deepEqual(retry.workspace.opened.map(entry => entry.uri.toString()), ['file:///workspace-b']);
    assert.deepEqual(readState(storage), stateEnvelope('2', requestB));
});

test('an invalid-state removal failure reports the fault without executing or changing stored bytes', async () => {
    const storage = new FaultyStorage();
    const invalid = '{not-json';
    storage.setItem(RIDE_OPEN_REQUEST_STATE_KEY, invalid);
    storage.failNextRemove = true;
    const context = createContribution('/project', storage);

    await context.contribution.restorePendingRequest();

    assert.equal(storage.getItem(RIDE_OPEN_REQUEST_STATE_KEY), invalid);
    assert.deepEqual(context.openers.opened, []);
    assert.deepEqual(context.workspace.opened, []);
    assert.equal(context.messages.errors.length, 1);

    const retry = createContribution('/project', storage);
    await retry.contribution.restorePendingRequest();
    assert.equal(storage.getItem(RIDE_OPEN_REQUEST_STATE_KEY), null);
    assert.equal(retry.messages.errors.length, 1);
});

test('pending state accepts item 64 but rejects item 65 without consuming its ID', async () => {
    const storage = new MemoryStorage();
    const request = (id: number): RideOpenRequest => ({
        id: String(id), source: 'singleInstance', workspace: '/queue', files: [`/queue/file-${id}.R`]
    });
    const first63 = Array.from({ length: 63 }, (_, index) => request(index + 1));
    storage.setItem(RIDE_OPEN_REQUEST_STATE_KEY, JSON.stringify(stateEnvelope('63', ...first63)));
    const context = createContribution('/elsewhere', storage);

    await context.contribution.handleOpenRequest(request(64));

    assert.deepEqual(readState(storage), stateEnvelope('64', ...first63, request(64)));
    assert.equal(readState(storage)!.requests.length, MAX_PENDING_REQUESTS);
    const stateAt64 = storage.getItem(RIDE_OPEN_REQUEST_STATE_KEY);

    await context.contribution.handleOpenRequest(request(65));

    assert.equal(storage.getItem(RIDE_OPEN_REQUEST_STATE_KEY), stateAt64);
    assert.equal(readState(storage)!.lastConsumed, '64');
    assert.deepEqual(context.openers.opened, []);
    assert.deepEqual(context.workspace.opened, []);
    assert.equal(context.messages.errors.length, 1);
});

test('reload rejects a stored queue with 65 requests before switching workspaces', async () => {
    const storage = new MemoryStorage();
    const requests = Array.from({ length: 65 }, (_, index): RideOpenRequest => ({
        id: String(index + 1), source: 'singleInstance', workspace: '/queue', files: [`/queue/file-${index + 1}.R`]
    }));
    storage.setItem(RIDE_OPEN_REQUEST_STATE_KEY, JSON.stringify(stateEnvelope('65', ...requests)));
    const context = createContribution('/elsewhere', storage);

    await context.contribution.restorePendingRequest();

    assert.equal(storage.getItem(RIDE_OPEN_REQUEST_STATE_KEY), null);
    assert.deepEqual(context.openers.opened, []);
    assert.deepEqual(context.workspace.opened, []);
    assert.equal(context.messages.errors.length, 1);
});

test('oversized append and stored state are rejected without replacing valid bytes or executing requests', async () => {
    const requestA: RideOpenRequest = {
        id: '1', source: 'singleInstance', workspace: '/queue', files: ['/queue/a.R']
    };
    const storage = new MemoryStorage();
    const original = JSON.stringify(stateEnvelope('1', requestA));
    storage.setItem(RIDE_OPEN_REQUEST_STATE_KEY, original);
    const context = createContribution('/elsewhere', storage);

    await context.contribution.handleOpenRequest({
        id: '2',
        source: 'singleInstance',
        workspace: '/queue',
        files: [`/queue/${'x'.repeat(MAX_STATE_CHARS)}.R`]
    });

    assert.ok(storage.getItem(RIDE_OPEN_REQUEST_STATE_KEY) === original, 'oversized append must preserve exact state bytes');
    assert.deepEqual(context.openers.opened, []);
    assert.deepEqual(context.workspace.opened, []);
    assert.equal(context.messages.errors.length, 1);

    const oversizedStorage = new MemoryStorage();
    const oversizedStoredState = JSON.stringify({
        ...stateEnvelope('1'),
        padding: 'x'.repeat(MAX_STATE_CHARS)
    });
    assert.ok(oversizedStoredState.length > MAX_STATE_CHARS);
    oversizedStorage.setItem(RIDE_OPEN_REQUEST_STATE_KEY, oversizedStoredState);
    const reload = createContribution('/project', oversizedStorage);

    await reload.contribution.restorePendingRequest();

    assert.equal(oversizedStorage.getItem(RIDE_OPEN_REQUEST_STATE_KEY), null);
    assert.deepEqual(reload.openers.opened, []);
    assert.deepEqual(reload.workspace.opened, []);
    assert.equal(reload.messages.errors.length, 1);
});

test('reload restores a removed pending request exactly once, including the maximum u64 ID', async () => {
    const storage = new MemoryStorage();
    const request = {
        id: '18446744073709551615',
        source: 'singleInstance',
        workspace: String.raw`D:\new-project`,
        files: [String.raw`D:\new-project\analysis.R`]
    };
    const firstWindow = createContribution(String.raw`C:\old-project`, storage);
    await firstWindow.contribution.handleOpenRequest(request);
    assert.deepEqual(readState(storage), stateEnvelope(request.id, {
        ...request,
        workspace: 'D:/new-project',
        files: ['D:/new-project/analysis.R']
    }));

    const reloadedWindow = createContribution(request.workspace, storage, () => {
        assert.deepEqual(readState(storage), stateEnvelope(request.id));
    });
    await reloadedWindow.contribution.restorePendingRequest();
    await reloadedWindow.contribution.restorePendingRequest();

    assert.equal(reloadedWindow.openers.opened.length, 1);
    assert.deepEqual(reloadedWindow.shell.activated, ['editor-1']);
    assert.deepEqual(readState(storage), stateEnvelope(request.id));

    const restartedContribution = createContribution(request.workspace, storage);
    await restartedContribution.contribution.restorePendingRequest();
    assert.deepEqual(restartedContribution.openers.opened, []);
});

test('native listener preserves consecutive cross-workspace requests across ordered reloads', async () => {
    const storage = new MemoryStorage();
    const requestA: RideOpenRequest = {
        id: '20', source: 'singleInstance', workspace: '/workspace-a', files: ['/workspace-a/a.R']
    };
    const requestB: RideOpenRequest = {
        id: '21', source: 'singleInstance', workspace: '/workspace-b', files: ['/workspace-b/b.R']
    };
    const requestC: RideOpenRequest = {
        id: '22', source: 'singleInstance', workspace: '/workspace-c', files: ['/workspace-c/c.R']
    };
    const firstWindow = createContribution('/workspace-x', storage);
    firstWindow.contribution.onStart();
    await flushLifecycle();

    firstWindow.native.emit(requestA);
    firstWindow.native.emit(requestB);
    firstWindow.native.emit(requestB);
    firstWindow.native.emit({
        ...requestC,
        id: '18446744073709551616'
    });
    firstWindow.native.emit(requestC);
    await flushRequestChain();

    assert.equal(firstWindow.workspace.opened.length, 1);
    assert.equal(firstWindow.workspace.opened[0].uri.toString(), 'file:///workspace-a');
    assert.deepEqual(firstWindow.openers.opened, []);
    assert.deepEqual(readState(storage), stateEnvelope('22', requestA, requestB, requestC));
    assert.equal(firstWindow.messages.errors.length, 1);

    const windowA = createContribution('/workspace-a', storage, () => {
        assert.deepEqual(readState(storage), stateEnvelope('22', requestB, requestC));
    });
    await windowA.contribution.restorePendingRequest();
    assert.deepEqual(windowA.openers.opened.map(entry => entry.uri.toString()), ['file:///workspace-a/a.R']);
    assert.deepEqual(windowA.workspace.opened.map(entry => entry.uri.toString()), ['file:///workspace-b']);
    assert.deepEqual(readState(storage), stateEnvelope('22', requestB, requestC));

    const windowB = createContribution('/workspace-b', storage, () => {
        assert.deepEqual(readState(storage), stateEnvelope('22', requestC));
    });
    await windowB.contribution.restorePendingRequest();
    assert.deepEqual(windowB.openers.opened.map(entry => entry.uri.toString()), ['file:///workspace-b/b.R']);
    assert.deepEqual(windowB.workspace.opened.map(entry => entry.uri.toString()), ['file:///workspace-c']);
    assert.deepEqual(readState(storage), stateEnvelope('22', requestC));

    const windowC = createContribution('/workspace-c', storage, () => {
        assert.deepEqual(readState(storage), stateEnvelope('22'));
    });
    await windowC.contribution.restorePendingRequest();
    assert.deepEqual(windowC.openers.opened.map(entry => entry.uri.toString()), ['file:///workspace-c/c.R']);
    assert.deepEqual(windowC.workspace.opened, []);
    assert.deepEqual(readState(storage), stateEnvelope('22'));
});

test('reload removes corrupt, non-increasing, invalid, or tail-unauthorized state without executing it', async () => {
    const request = (id: string, file: string): RideOpenRequest => ({
        id, source: 'singleInstance', workspace: '/project', files: [`/project/${file}`]
    });
    const cases = [
        '{not-json',
        JSON.stringify(stateEnvelope('30', request('31', 'a.R'), request('30', 'b.R'))),
        JSON.stringify(stateEnvelope('18446744073709551616', request('18446744073709551616', 'overflow.R'))),
        JSON.stringify(stateEnvelope('32', request('31', 'a.R')))
    ];

    for (const serialized of cases) {
        const storage = new MemoryStorage();
        storage.setItem(RIDE_OPEN_REQUEST_STATE_KEY, serialized);
        const context = createContribution('/project', storage);

        await context.contribution.restorePendingRequest();

        assert.equal(storage.getItem(RIDE_OPEN_REQUEST_STATE_KEY), null);
        assert.deepEqual(context.openers.opened, []);
        assert.deepEqual(context.workspace.opened, []);
        assert.equal(context.messages.errors.length, 1);
    }
});

test('reload rejects request queues that are not exactly authorized by their embedded last-consumed ID', async () => {
    const pending = {
        id: '99',
        source: 'singleInstance',
        workspace: '/project',
        files: ['/project/analysis.R']
    };
    const cases = [
        { version: 2, requests: [pending] },
        stateEnvelope('not-an-id', pending),
        stateEnvelope('98', pending),
        stateEnvelope('100', pending)
    ];

    for (const state of cases) {
        const storage = new MemoryStorage();
        storage.setItem(RIDE_OPEN_REQUEST_STATE_KEY, JSON.stringify(state));
        const context = createContribution('/project', storage);

        await context.contribution.restorePendingRequest();

        assert.equal(storage.getItem(RIDE_OPEN_REQUEST_STATE_KEY), null);
        assert.deepEqual(context.openers.opened, []);
        assert.equal(context.messages.errors.length, 1);
    }
});

test('a failed file reports an error, continues opening, and does not poison later requests', async () => {
    const context = createContribution(String.raw`C:\project`, new MemoryStorage(), uri => {
        if (FileUri.fsPath(uri).toLowerCase().endsWith('broken.r')) {
            throw new Error('editor failed');
        }
    });

    await context.contribution.handleOpenRequest({
        id: '3',
        source: 'singleInstance',
        workspace: String.raw`C:\project`,
        files: [String.raw`C:\project\healthy.R`, String.raw`C:\project\broken.R`]
    });
    await context.contribution.handleOpenRequest({
        id: '4',
        source: 'singleInstance',
        workspace: String.raw`C:\project`,
        files: [String.raw`C:\project\later.R`]
    });

    assert.deepEqual(context.openers.opened.map(entry => FileUri.fsPath(entry.uri).toLowerCase()), [
        String.raw`c:\project\healthy.r`,
        String.raw`c:\project\later.r`
    ]);
    assert.deepEqual(context.openers.handlerActivations, []);
    assert.deepEqual(context.shell.activated, ['editor-1', 'editor-2']);
    assert.equal(context.messages.errors.length, 1);
    assert.match(context.messages.errors[0], /broken\.R.*editor failed/);
});

test('an observable workspace switch failure retains the ordered handoff without retrying in the same lifecycle', async () => {
    const context = createContribution(String.raw`C:\project`);
    await context.contribution.handleOpenRequest({
        id: '4',
        source: 'singleInstance',
        workspace: String.raw`C:\project`,
        files: [String.raw`C:\project\before.R`]
    });
    context.workspace.openError = new Error('window switch failed');

    await context.contribution.handleOpenRequest({
        id: '5',
        source: 'singleInstance',
        workspace: String.raw`D:\other`,
        files: [String.raw`D:\other\file.R`]
    });

    assert.deepEqual(readState(context.storage), stateEnvelope('5', {
        id: '5', source: 'singleInstance', workspace: 'D:/other', files: ['D:/other/file.R']
    }));
    assert.deepEqual(context.workspace.opened, []);
    assert.equal(context.messages.errors.length, 1);
    assert.match(context.messages.errors[0], /window switch failed/);

    context.workspace.openError = undefined;
    await context.contribution.handleOpenRequest({
        id: '6',
        source: 'singleInstance',
        workspace: String.raw`C:\project`,
        files: [String.raw`C:\project\later.R`]
    });
    assert.equal(context.openers.opened.length, 1);
    assert.deepEqual(context.workspace.opened, []);
    assert.deepEqual(readState(context.storage), stateEnvelope('6',
        { id: '5', source: 'singleInstance', workspace: 'D:/other', files: ['D:/other/file.R'] },
        { id: '6', source: 'singleInstance', workspace: 'C:/project', files: ['C:/project/later.R'] }
    ));

    const restarted = createContribution(String.raw`D:\other`, context.storage);
    await restarted.contribution.restorePendingRequest();
    assert.deepEqual(restarted.openers.opened.map(entry => FileUri.fsPath(entry.uri).toLowerCase()), [String.raw`d:\other\file.r`]);
    assert.equal(restarted.workspace.opened.length, 1);
    assert.equal(FileUri.fsPath(restarted.workspace.opened[0].uri).toLowerCase(), String.raw`c:\project`);
    assert.deepEqual(readState(context.storage), stateEnvelope('6',
        { id: '6', source: 'singleInstance', workspace: 'C:/project', files: ['C:/project/later.R'] }
    ));
});

test('a queued workspace switch failure keeps the failed head and tail for a later instance', async () => {
    const storage = new MemoryStorage();
    const requestA: RideOpenRequest = {
        id: '40', source: 'singleInstance', workspace: '/workspace-a', files: ['/workspace-a/a.R']
    };
    const requestB: RideOpenRequest = {
        id: '41', source: 'singleInstance', workspace: '/workspace-b', files: ['/workspace-b/b.R']
    };
    const requestC: RideOpenRequest = {
        id: '42', source: 'singleInstance', workspace: '/workspace-c', files: ['/workspace-c/c.R']
    };
    storage.setItem(RIDE_OPEN_REQUEST_STATE_KEY, JSON.stringify(stateEnvelope(requestC.id, requestA, requestB, requestC)));
    const windowA = createContribution(requestA.workspace, storage);
    windowA.workspace.openError = new Error('queued switch failed');

    await windowA.contribution.restorePendingRequest();

    assert.deepEqual(windowA.openers.opened.map(entry => entry.uri.toString()), ['file:///workspace-a/a.R']);
    assert.deepEqual(readState(storage), stateEnvelope(requestC.id, requestB, requestC));
    assert.equal(windowA.workspace.opened.length, 0);
    assert.match(windowA.messages.errors[0], /queued switch failed/);

    const windowB = createContribution(requestB.workspace, storage);
    await windowB.contribution.restorePendingRequest();
    assert.deepEqual(windowB.openers.opened.map(entry => entry.uri.toString()), ['file:///workspace-b/b.R']);
    assert.deepEqual(windowB.workspace.opened.map(entry => entry.uri.toString()), ['file:///workspace-c']);
    assert.deepEqual(readState(storage), stateEnvelope(requestC.id, requestC));
});

test('invalid payloads never consume IDs, write storage, open files, or switch workspaces', async () => {
    const context = createContribution('/project');
    const sparseFiles = new Array<string>(1);
    const invalidPayloads: unknown[] = [
        undefined,
        {},
        { id: '7', source: 'initial', workspace: '/project' },
        { id: '7', source: 'initial', workspace: '/project', files: [] },
        { id: '7', source: 'initial', workspace: '/project', files: sparseFiles },
        { id: 7, source: 'initial', workspace: '/project', files: ['/project/file.R'] },
        { id: Number.NaN, source: 'initial', workspace: '/project', files: ['/project/file.R'] },
        { id: Number.MAX_SAFE_INTEGER + 1, source: 'initial', workspace: '/project', files: ['/project/file.R'] },
        { id: '0', source: 'initial', workspace: '/project', files: ['/project/file.R'] },
        { id: '01', source: 'initial', workspace: '/project', files: ['/project/file.R'] },
        { id: '18446744073709551616', source: 'initial', workspace: '/project', files: ['/project/file.R'] },
        { id: '7', source: 'unknown', workspace: '/project', files: ['/project/file.R'] },
        { id: '7', source: 'initial', workspace: 'file:///project', files: ['/project/file.R'] },
        { id: '7', source: 'initial', workspace: '/project', files: ['relative.R'] },
        { id: '7', source: 'initial', workspace: '/project', files: ['/outside/file.R'] },
        { id: '7', source: 'initial', workspace: '/project', files: ['/project'] },
        { id: '7', source: 'initial', workspace: '/project', files: ['/project/folder/'] }
    ];

    for (const payload of invalidPayloads) {
        await context.contribution.handleOpenRequest(payload);
    }

    assert.deepEqual(context.openers.opened, []);
    assert.deepEqual(context.workspace.opened, []);
    assert.equal(context.storage.getItem(RIDE_OPEN_REQUEST_STATE_KEY), null);
    assert.equal(context.messages.errors.length, invalidPayloads.length);
});

test('corrupt v2 state and unpublished v1 keys are removed without triggering a restore loop', async () => {
    const corruptStorage = new MemoryStorage();
    corruptStorage.setItem(RIDE_OPEN_REQUEST_STATE_KEY, '{not-json');
    const corrupt = createContribution('/project', corruptStorage);
    await corrupt.contribution.restorePendingRequest();
    assert.equal(corruptStorage.getItem(RIDE_OPEN_REQUEST_STATE_KEY), null);
    assert.equal(corrupt.messages.errors.length, 1);

    const legacyStorage = new MemoryStorage();
    legacyStorage.setItem(LEGACY_PENDING_KEY, JSON.stringify({
        id: '8',
        source: 'singleInstance',
        workspace: '/other',
        files: ['/other/file.R']
    }));
    legacyStorage.setItem(LEGACY_LAST_CONSUMED_KEY, '8');
    const legacy = createContribution('/project', legacyStorage);
    await legacy.contribution.restorePendingRequest();

    assert.equal(legacyStorage.getItem(LEGACY_PENDING_KEY), null);
    assert.equal(legacyStorage.getItem(LEGACY_LAST_CONSUMED_KEY), null);
    assert.equal(legacyStorage.getItem(RIDE_OPEN_REQUEST_STATE_KEY), null);
    assert.deepEqual(legacy.openers.opened, []);
    assert.deepEqual(legacy.workspace.opened, []);
    assert.equal(legacy.messages.errors.length, 1);
});

test('last-consumed decimal IDs are monotonic without Number conversion', async () => {
    const context = createContribution('/project');
    await context.contribution.handleOpenRequest({
        id: '10', source: 'initial', workspace: '/project', files: ['/project/newer.R']
    });
    await context.contribution.handleOpenRequest({
        id: '9', source: 'initial', workspace: '/project', files: ['/project/older.R']
    });

    assert.equal(context.openers.opened.length, 1);
    assert.deepEqual(readState(context.storage), stateEnvelope('10'));
});

test('Unix root is a valid workspace boundary without weakening descendant checks', async () => {
    const context = createContribution('/');

    await context.contribution.handleOpenRequest({
        id: '11', source: 'initial', workspace: '/', files: ['/analysis.R']
    });

    assert.deepEqual(context.openers.opened.map(entry => entry.uri.toString()), ['file:///analysis.R']);
    assert.deepEqual(context.workspace.opened, []);
    assert.deepEqual(context.messages.errors, []);
});

test('Unix file components preserve legal leading and trailing spaces', async () => {
    const context = createContribution('/project');

    await context.contribution.handleOpenRequest({
        id: '11', source: 'initial', workspace: '/project', files: ['/project/ report .R ']
    });

    assert.deepEqual(context.openers.opened.map(entry => entry.uri.path.toString()), ['/project/ report .R ']);
    assert.deepEqual(readState(context.storage), stateEnvelope('11'));
    assert.deepEqual(context.messages.errors, []);

    await context.contribution.handleOpenRequest({
        id: '12', source: 'initial', workspace: '/project', files: ['']
    });
    assert.deepEqual(readState(context.storage), stateEnvelope('11'));
    assert.equal(context.openers.opened.length, 1);
    assert.equal(context.messages.errors.length, 1);
});

test('Windows drive root is a valid workspace for a root-level file', async () => {
    const context = createContribution('C:\\');

    await context.contribution.handleOpenRequest({
        id: '11', source: 'initial', workspace: 'C:/', files: [String.raw`C:\root.R`]
    });

    assert.deepEqual(context.openers.opened.map(entry => FileUri.fsPath(entry.uri).toLowerCase()), [String.raw`c:\root.r`]);
    assert.deepEqual(context.workspace.opened, []);
    assert.deepEqual(context.messages.errors, []);
});

test('Windows drive roots with redundant separators remain same-workspace requests', async () => {
    for (const workspace of ['C:////', String.raw`C:\\\\`]) {
        const context = createContribution('C:\\');

        await context.contribution.handleOpenRequest({
            id: '12', source: 'initial', workspace, files: [String.raw`C:\root.R`]
        });

        assert.deepEqual(context.openers.opened.map(entry => FileUri.fsPath(entry.uri).toLowerCase()), [String.raw`c:\root.r`]);
        assert.deepEqual(context.workspace.opened, []);
        assert.deepEqual(readState(context.storage), stateEnvelope('12'));
        assert.deepEqual(context.messages.errors, []);
    }
});

test('redundant drive-root separators are canonical across handoff and reload', async () => {
    const storage = new MemoryStorage();
    const firstWindow = createContribution('D:\\', storage);

    await firstWindow.contribution.handleOpenRequest({
        id: '13', source: 'singleInstance', workspace: 'C:////', files: [String.raw`C:\root.R`]
    });

    assert.deepEqual(readState(storage), stateEnvelope('13', {
        id: '13', source: 'singleInstance', workspace: 'C:/', files: ['C:/root.R']
    }));
    assert.equal(FileUri.fsPath(firstWindow.workspace.opened[0].uri).toLowerCase(), 'c:\\');
    assert.deepEqual(firstWindow.workspace.opened[0].options, { preserveWindow: true });
    assert.deepEqual(firstWindow.openers.opened, []);

    const reloadedWindow = createContribution('C:\\', storage);
    await reloadedWindow.contribution.restorePendingRequest();

    assert.deepEqual(reloadedWindow.openers.opened.map(entry => FileUri.fsPath(entry.uri).toLowerCase()), [String.raw`c:\root.r`]);
    assert.deepEqual(readState(storage), stateEnvelope('13'));
});

test('drive-relative and malformed Windows paths remain rejected without consuming the request ID', async () => {
    const context = createContribution('C:\\');
    const invalidRequests = [
        { workspace: 'C:', files: [String.raw`C:\root.R`] },
        { workspace: 'C:foo', files: [String.raw`C:\root.R`] },
        { workspace: 'C:/bad//segment', files: ['C:/bad/segment/root.R'] },
        { workspace: 'C:/bad/../segment', files: ['C:/bad/segment/root.R'] },
        { workspace: 'C:/', files: ['C://root.R'] },
        { workspace: 'C:/', files: ['C:/../root.R'] }
    ];

    for (const { workspace, files } of invalidRequests) {
        await context.contribution.handleOpenRequest({
            id: '14', source: 'initial', workspace, files
        });
    }

    assert.deepEqual(context.openers.opened, []);
    assert.deepEqual(context.workspace.opened, []);
    assert.equal(context.storage.getItem(RIDE_OPEN_REQUEST_STATE_KEY), null);
    assert.equal(context.messages.errors.length, invalidRequests.length);
});

test('Windows current-drive-rooted workspace and file paths are rejected without state or side effects', async () => {
    const cases = [
        {
            current: String.raw`C:\project`,
            workspace: String.raw`\project`,
            files: [String.raw`\project\file.R`]
        },
        {
            current: String.raw`D:\elsewhere`,
            workspace: String.raw`\project`,
            files: [String.raw`\project\file.R`]
        },
        {
            current: String.raw`C:\project`,
            workspace: String.raw`C:\project`,
            files: [String.raw`\project\file.R`]
        }
    ];

    for (const { current, workspace, files } of cases) {
        const context = createContribution(current);
        await context.contribution.handleOpenRequest({
            id: '15', source: 'initial', workspace, files
        });

        assert.equal(context.storage.getItem(RIDE_OPEN_REQUEST_STATE_KEY), null);
        assert.deepEqual(context.openers.opened, []);
        assert.deepEqual(context.workspace.opened, []);
        assert.equal(context.messages.errors.length, 1);
    }
});

test('reload removes a current-drive-rooted request without navigating or looping', async () => {
    const storage = new MemoryStorage();
    storage.setItem(RIDE_OPEN_REQUEST_STATE_KEY, JSON.stringify(stateEnvelope('15', {
        id: '15',
        source: 'singleInstance',
        workspace: String.raw`\project`,
        files: [String.raw`\project\file.R`]
    })));
    const first = createContribution(String.raw`C:\project`, storage);

    await first.contribution.restorePendingRequest();

    assert.equal(storage.getItem(RIDE_OPEN_REQUEST_STATE_KEY), null);
    assert.deepEqual(first.openers.opened, []);
    assert.deepEqual(first.workspace.opened, []);
    assert.equal(first.messages.errors.length, 1);

    const restarted = createContribution(String.raw`C:\project`, storage);
    await restarted.contribution.restorePendingRequest();
    assert.deepEqual(restarted.openers.opened, []);
    assert.deepEqual(restarted.workspace.opened, []);
    assert.deepEqual(restarted.messages.errors, []);
});

test('Unix absolute paths preserve backslashes as literal filename characters', async () => {
    const context = createContribution('/project');
    const file = String.raw`/project/name\part.R`;

    await context.contribution.handleOpenRequest({
        id: '16', source: 'initial', workspace: '/project', files: [file]
    });

    assert.equal(context.openers.opened.length, 1);
    assert.deepEqual(context.workspace.opened, []);
    assert.deepEqual(readState(context.storage), stateEnvelope('16'));
    assert.deepEqual(context.messages.errors, []);

    const handoff = createContribution('/elsewhere');
    await handoff.contribution.handleOpenRequest({
        id: '17', source: 'singleInstance', workspace: '/project', files: [file]
    });
    assert.deepEqual(readState(handoff.storage), stateEnvelope('17', {
        id: '17', source: 'singleInstance', workspace: '/project', files: [file]
    }));
    assert.equal(handoff.workspace.opened.length, 1);
});

test('Unix files may end with a literal backslash across same-workspace open and handoff restore', async () => {
    const file = '/project/name\\';
    const sameWorkspace = createContribution('/project');

    await sameWorkspace.contribution.handleOpenRequest({
        id: '18', source: 'initial', workspace: '/project', files: [file]
    });

    assert.equal(sameWorkspace.openers.opened.length, 1);
    assert.deepEqual(sameWorkspace.openers.handlerActivations, []);
    assert.deepEqual(sameWorkspace.shell.activated, ['editor-1']);
    assert.deepEqual(readState(sameWorkspace.storage), stateEnvelope('18'));
    assert.deepEqual(sameWorkspace.messages.errors, []);

    const storage = new MemoryStorage();
    const handoff = createContribution('/elsewhere', storage);
    const request: RideOpenRequest = {
        id: '19', source: 'singleInstance', workspace: '/project', files: [file]
    };

    await handoff.contribution.handleOpenRequest(request);

    assert.deepEqual(readState(storage), stateEnvelope('19', request));
    assert.deepEqual(handoff.openers.opened, []);
    assert.equal(handoff.workspace.opened.length, 1);

    const reloaded = createContribution('/project', storage);
    await reloaded.contribution.restorePendingRequest();

    assert.equal(reloaded.openers.opened.length, 1);
    assert.deepEqual(reloaded.openers.handlerActivations, []);
    assert.deepEqual(reloaded.shell.activated, ['editor-1']);
    assert.deepEqual(readState(storage), stateEnvelope('19'));
    assert.deepEqual(reloaded.messages.errors, []);
});

test('directory-style trailing separators remain invalid for Windows, UNC, and slash paths', async () => {
    const cases = [
        { workspace: String.raw`C:\foo`, file: 'C:\\foo\\folder\\' },
        { workspace: String.raw`\\server\share`, file: String.raw`\\server\share\folder` + '\\' },
        { workspace: '/project', file: '/project/file/' }
    ];

    for (const { workspace, file } of cases) {
        const context = createContribution(workspace);
        await context.contribution.handleOpenRequest({
            id: '20', source: 'initial', workspace, files: [file]
        });

        assert.equal(context.storage.getItem(RIDE_OPEN_REQUEST_STATE_KEY), null);
        assert.deepEqual(context.openers.opened, []);
        assert.deepEqual(context.workspace.opened, []);
        assert.equal(context.messages.errors.length, 1);
    }
});

test('UNC share root is valid while empty segments and traversal remain rejected', async () => {
    const workspace = String.raw`\\server\share`;
    const valid = createContribution(workspace);

    await valid.contribution.handleOpenRequest({
        id: '11', source: 'initial', workspace: String.raw`\\SERVER\SHARE`, files: [String.raw`\\server\share\root.R`]
    });

    assert.deepEqual(valid.openers.opened.map(entry => FileUri.fsPath(entry.uri).toLowerCase()), [String.raw`\\server\share\root.r`]);
    assert.deepEqual(valid.workspace.opened, []);

    const invalid = createContribution(workspace);
    await invalid.contribution.handleOpenRequest({
        id: '12', source: 'initial', workspace, files: [String.raw`\\server\\share\root.R`]
    });
    await invalid.contribution.handleOpenRequest({
        id: '12', source: 'initial', workspace, files: [String.raw`\\server\share\..\escape.R`]
    });

    assert.deepEqual(invalid.openers.opened, []);
    assert.equal(invalid.storage.getItem(RIDE_OPEN_REQUEST_STATE_KEY), null);
    assert.equal(invalid.messages.errors.length, 2);
});

test('native open-request listener delivers the typed payload and returns its unlisten cleanup', async () => {
    let eventName: string | undefined;
    let eventHandler: ((event: { payload: unknown }) => void) | undefined;
    let unlistenCalls = 0;
    const native = new RideNativeChrome({
        isTauri: true,
        platform: 'windows',
        listen: async (name, handler) => {
            eventName = name;
            eventHandler = handler as (event: { payload: unknown }) => void;
            return () => {
                unlistenCalls++;
            };
        }
    });
    const delivered: unknown[] = [];
    const request = {
        id: '13',
        source: 'openedUrl' as const,
        workspace: String.raw`C:\project`,
        files: [String.raw`C:\project\file.R`]
    };

    const unlisten = await native.listenForOpenRequests(payload => delivered.push(payload));
    assert.equal(eventName, 'ride-open-request');
    eventHandler!({ payload: request });
    assert.deepEqual(delivered, [request]);

    unlisten();
    assert.equal(unlistenCalls, 1);
});

test('browser-preview open-request listener is a no-op', async () => {
    let registrations = 0;
    const native = new RideNativeChrome({
        isTauri: false,
        platform: 'linux',
        listen: async () => {
            registrations++;
            return () => undefined;
        }
    });

    const unlisten = await native.listenForOpenRequests(() => assert.fail('browser preview must not deliver native events'));
    unlisten();

    assert.equal(registrations, 0);
});

test('frontend contribution start schedules initialization without returning its attached-shell wait', async () => {
    const context = createContribution('/project');

    const returned = context.contribution.onStart();

    assert.equal(returned, undefined);
    await flushLifecycle();
    context.contribution.onStop();
});

test('frontend initialization waits for attached shell before reporting, restoring, and listening', async () => {
    const storage = new MemoryStorage();
    storage.setItem(RIDE_OPEN_REQUEST_STATE_KEY, JSON.stringify(stateEnvelope('31', {
        id: '31',
        source: 'initial',
        workspace: '/project',
        files: ['/project/attached.R']
    })));
    const applicationState = new FakeApplicationStateService(false);
    const context = createContribution(
        '/project',
        storage,
        () => undefined,
        async () => undefined,
        applicationState
    );

    assert.equal(context.contribution.onStart(), undefined);
    assert.equal(context.contribution.onStart(), undefined);
    await flushLifecycle();
    assert.deepEqual(applicationState.reachedStates, ['attached_shell']);
    assert.deepEqual(context.milestones, []);
    assert.deepEqual(context.openers.opened, []);
    assert.equal(context.native.registrations, 0);

    applicationState.attach();
    await flushLifecycle();
    assert.deepEqual(context.events, [
        'milestone:frontend_shell_attached',
        'listen',
        'open:/project/attached.R',
        'milestone:target_file_opened'
    ]);
    assert.equal(context.native.registrations, 1);
});

test('attached-shell rejection is reported without restoring, listening, or leaking initialization', async () => {
    const applicationState = new FakeApplicationStateService(false);
    const context = createContribution(
        '/project',
        new MemoryStorage(),
        () => undefined,
        async () => undefined,
        applicationState
    );

    context.contribution.onStart();
    applicationState.reject(new Error('shell attachment failed'));
    await flushLifecycle();

    assert.equal(context.native.registrations, 0);
    assert.deepEqual(context.milestones, []);
    assert.equal(context.openers.opened.length, 0);
    assert.match(context.messages.errors[0], /shell attachment failed/);
});

test('a synchronous notification failure is caught without an unhandled initialization rejection', async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...values: unknown[]) => {
        warnings.push(values);
    };
    try {
        const applicationState = new FakeApplicationStateService(false);
        const context = createContribution(
            '/project', new MemoryStorage(), () => undefined, async () => undefined, applicationState
        );
        context.messages.errorToThrow = new Error('notification unavailable');

        context.contribution.onStart();
        applicationState.reject(new Error('shell attachment failed'));
        await flushLifecycle();

        assert.equal(warnings.length, 1);
        assert.match(String(warnings[0][1]), /notification unavailable/);
    } finally {
        console.warn = originalWarn;
    }
});

test('disposing before shell attachment cancels deferred initialization', async () => {
    const applicationState = new FakeApplicationStateService(false);
    const context = createContribution(
        '/project',
        new MemoryStorage(),
        () => undefined,
        async () => undefined,
        applicationState
    );

    context.contribution.onStart();
    context.contribution.onStop();
    applicationState.attach();
    await flushLifecycle();

    assert.deepEqual(context.milestones, []);
    assert.equal(context.native.registrations, 0);
    assert.equal(context.openers.opened.length, 0);
});

test('frontend lifecycle restores and registers once, then unlistens once on cleanup', async () => {
    const storage = new MemoryStorage();
    storage.setItem(RIDE_OPEN_REQUEST_STATE_KEY, JSON.stringify(stateEnvelope('12', {
        id: '12',
        source: 'initial',
        workspace: '/project',
        files: ['/project/startup.R']
    })));
    const context = createContribution('/project', storage);

    await context.contribution.onStart();
    await context.contribution.onStart();
    await flushLifecycle();

    assert.equal(context.openers.opened.length, 1);
    assert.equal(context.native.registrations, 1);
    assert.deepEqual(context.milestones, ['frontend_shell_attached', 'target_file_opened']);

    context.contribution.onStop();
    context.contribution.onStop();
    assert.equal(context.native.unlistenCalls, 1);
});

test('target-file milestone is emitted only after a target opens successfully', async () => {
    const failed = createContribution('/project', new MemoryStorage(), () => {
        throw new Error('editor unavailable');
    });
    await failed.contribution.handleOpenRequest({
        id: '21',
        source: 'initial',
        workspace: '/project',
        files: ['/project/fail.R']
    });
    assert.deepEqual(failed.milestones, []);
    assert.equal(failed.messages.errors.length, 1);

    const succeeded = createContribution('/project');
    await succeeded.contribution.handleOpenRequest({
        id: '22',
        source: 'initial',
        workspace: '/project',
        files: ['/project/success.R']
    });
    assert.deepEqual(succeeded.milestones, ['target_file_opened']);
});

test('already-resolved plugin lifecycle is reported after the target in canonical order', async () => {
    const hostedPlugins = new FakeHostedPluginSupport();
    hostedPlugins.resolveDidStart();
    hostedPlugins.resolveWillStart();
    const context = createContribution(
        '/project',
        new MemoryStorage(),
        () => undefined,
        async () => undefined,
        new FakeApplicationStateService(),
        hostedPlugins
    );

    await context.contribution.handleOpenRequest({
        id: '41', source: 'initial', workspace: '/project', files: ['/project/early-plugin.R']
    });
    await flushLifecycle();

    assert.deepEqual(context.milestones, [
        'target_file_opened',
        'plugins_started',
        'plugins_ready'
    ]);
});

test('late plugin lifecycle is observed in the background without blocking target opening', async () => {
    const hostedPlugins = new FakeHostedPluginSupport();
    const context = createContribution(
        '/project',
        new MemoryStorage(),
        () => undefined,
        async () => undefined,
        new FakeApplicationStateService(),
        hostedPlugins
    );

    await context.contribution.handleOpenRequest({
        id: '42', source: 'initial', workspace: '/project', files: ['/project/late-plugin.R']
    });
    assert.deepEqual(context.milestones, ['target_file_opened']);

    hostedPlugins.resolveWillStart();
    await flushLifecycle();
    assert.deepEqual(context.milestones, ['target_file_opened', 'plugins_started']);

    hostedPlugins.resolveDidStart();
    await flushLifecycle();
    assert.deepEqual(context.milestones, [
        'target_file_opened',
        'plugins_started',
        'plugins_ready'
    ]);
});

test('plugin lifecycle rejection warns once without blocking files or producing false milestones', async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...values: unknown[]) => {
        warnings.push(values);
    };
    try {
        const rejectedWill = new FakeHostedPluginSupport();
        rejectedWill.rejectWillStart(new Error('willStart failed'));
        const first = createContribution(
            '/project', new MemoryStorage(), () => undefined, async () => undefined,
            new FakeApplicationStateService(), rejectedWill
        );
        await first.contribution.handleOpenRequest({
            id: '43', source: 'initial', workspace: '/project', files: ['/project/will-reject.R']
        });
        await flushLifecycle();
        assert.deepEqual(first.milestones, ['target_file_opened']);

        const rejectedDid = new FakeHostedPluginSupport();
        rejectedDid.resolveWillStart();
        rejectedDid.rejectDidStart(new Error('didStart failed'));
        const second = createContribution(
            '/project', new MemoryStorage(), () => undefined, async () => undefined,
            new FakeApplicationStateService(), rejectedDid
        );
        await second.contribution.handleOpenRequest({
            id: '44', source: 'initial', workspace: '/project', files: ['/project/did-reject.R']
        });
        await flushLifecycle();
        assert.deepEqual(second.milestones, ['target_file_opened', 'plugins_started']);
        assert.equal(warnings.length, 2);
    } finally {
        console.warn = originalWarn;
    }
});

test('plugin lifecycle reports once and stops after contribution disposal', async () => {
    const hostedPlugins = new FakeHostedPluginSupport();
    const context = createContribution(
        '/project', new MemoryStorage(), () => undefined, async () => undefined,
        new FakeApplicationStateService(), hostedPlugins
    );
    await context.contribution.handleOpenRequest({
        id: '45', source: 'initial', workspace: '/project', files: ['/project/dispose-plugin.R']
    });
    context.contribution.dispose();
    hostedPlugins.resolveWillStart();
    hostedPlugins.resolveDidStart();
    await flushLifecycle();
    assert.deepEqual(context.milestones, ['target_file_opened']);

    const oncePlugins = new FakeHostedPluginSupport();
    oncePlugins.resolveWillStart();
    oncePlugins.resolveDidStart();
    const once = createContribution(
        '/project', new MemoryStorage(), () => undefined, async () => undefined,
        new FakeApplicationStateService(), oncePlugins
    );
    await once.contribution.handleOpenRequest({
        id: '46', source: 'initial', workspace: '/project', files: ['/project/once-a.R']
    });
    await once.contribution.handleOpenRequest({
        id: '47', source: 'singleInstance', workspace: '/project', files: ['/project/once-b.R']
    });
    await flushLifecycle();
    assert.deepEqual(once.milestones.filter(milestone => milestone === 'plugins_started'), ['plugins_started']);
    assert.deepEqual(once.milestones.filter(milestone => milestone === 'plugins_ready'), ['plugins_ready']);
});

test('deferred hosted plugin resolution rejection is consumed after disposal', async () => {
    const hostedPlugins = deferred<FakeHostedPluginSupport>();
    const context = createContribution(
        '/project', new MemoryStorage(), () => undefined, async () => undefined,
        new FakeApplicationStateService(), hostedPlugins.promise
    );

    context.contribution.dispose();
    hostedPlugins.reject(new Error('hosted plugin resolution failed'));

    await context.contribution.settlePluginObservations();
    await flushLifecycle();
    assert.deepEqual(context.milestones, []);
});

test('unresolved hosted plugin provider does not block shell initialization or target opening', async () => {
    const hostedPlugins = deferred<FakeHostedPluginSupport>();
    const context = createContribution(
        '/project', new MemoryStorage(), () => undefined, async () => undefined,
        new FakeApplicationStateService(), hostedPlugins.promise
    );

    context.contribution.onStart();
    await flushLifecycle();
    assert.equal(context.native.registrations, 1);

    await context.contribution.handleOpenRequest({
        id: '48', source: 'initial', workspace: '/project', files: ['/project/provider-pending.R']
    });
    assert.deepEqual(context.milestones, ['frontend_shell_attached', 'target_file_opened']);

    context.contribution.dispose();
    hostedPlugins.reject(new Error('provider rejected after disposal'));
    await context.contribution.settlePluginObservations();
});

test('startup reporting failures do not prevent lifecycle registration or opening', async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...values: unknown[]) => {
        warnings.push(values);
    };
    try {
        const context = createContribution(
            '/project',
            new MemoryStorage(),
            () => undefined,
            async () => {
                throw new Error('metrics unavailable');
            }
        );

        context.contribution.onStart();
        await flushLifecycle();
        await context.contribution.handleOpenRequest({
            id: '23',
            source: 'initial',
            workspace: '/project',
            files: ['/project/report-failure.R']
        });

        assert.equal(context.native.registrations, 1);
        assert.equal(context.openers.opened.length, 1);
        assert.equal(context.messages.errors.length, 0);
        assert.equal(warnings.length, 2);
    } finally {
        console.warn = originalWarn;
    }
});

test('frontend startup waits for the workspace before restoring pending files', async () => {
    const storage = new MemoryStorage();
    storage.setItem(RIDE_OPEN_REQUEST_STATE_KEY, JSON.stringify(stateEnvelope('14', {
        id: '14',
        source: 'initial',
        workspace: '/project',
        files: ['/project/ready.R']
    })));
    const context = createContribution('/project', storage);
    const readyWorkspace = context.workspace.workspace;
    context.workspace.workspace = undefined;
    let markReady: (() => void) | undefined;
    context.workspace.ready = new Promise(resolve => {
        markReady = () => {
            context.workspace.workspace = readyWorkspace;
            resolve();
        };
    });

    const started = context.contribution.onStart();
    await Promise.resolve();
    assert.deepEqual(readState(storage), stateEnvelope('14', {
        id: '14', source: 'initial', workspace: '/project', files: ['/project/ready.R']
    }));
    assert.deepEqual(context.openers.opened, []);

    markReady!();
    assert.equal(started, undefined);
    await flushLifecycle();
    assert.deepEqual(readState(storage), stateEnvelope('14'));
    assert.equal(context.openers.opened.length, 1);
});
