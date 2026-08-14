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
import { RideNativeChrome } from '../src/browser/ride-native-chrome';
import {
    RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY,
    RIDE_OPEN_REQUEST_PENDING_KEY,
    RideOpenRequest,
    RideOpenRequestContribution
} from '../src/browser/ride-open-request';

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

    constructor(protected readonly beforeOpen: (uri: URI) => void = () => undefined) { }

    async getOpeners(): Promise<OpenHandler[]> {
        return [await this.getOpener()];
    }

    async getOpener(): Promise<OpenHandler> {
        return {
            id: 'test-editor',
            canHandle: () => 100,
            open: async (uri, options) => {
                this.beforeOpen(uri);
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

    async error(message: string): Promise<undefined> {
        this.errors.push(message);
        return undefined;
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

    async listenForOpenRequests(handler: (request: RideOpenRequest) => void): Promise<() => void> {
        this.registrations++;
        this.handler = handler;
        return () => {
            this.unlistenCalls++;
            this.handler = undefined;
        };
    }

    emit(payload: unknown): void {
        assert.ok(this.handler, 'native listener must be registered before emitting');
        this.handler(payload as RideOpenRequest);
    }
}

function pendingEnvelope(...requests: object[]): object {
    return { version: 1, requests };
}

async function flushRequestChain(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
}

function createContribution(
    workspacePath = String.raw`C:\project`,
    storage = new MemoryStorage(),
    beforeOpen: (uri: URI) => void = () => undefined
): {
    contribution: RideOpenRequestContribution;
    workspace: FakeWorkspaceService;
    openers: FakeOpenerService;
    messages: FakeMessageService;
    shell: FakeShell;
    native: FakeNativeChrome;
    storage: MemoryStorage;
} {
    const workspace = new FakeWorkspaceService({ resource: FileUri.create(workspacePath) });
    const openers = new FakeOpenerService(beforeOpen);
    const messages = new FakeMessageService();
    const shell = new FakeShell();
    const native = new FakeNativeChrome();
    const contribution = new RideOpenRequestContribution(
        workspace as never,
        openers,
        messages as never,
        shell as never,
        native as never,
        storage
    );
    return { contribution, workspace, openers, messages, shell, native, storage };
}

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
    assert.deepEqual(JSON.parse(storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY)!), pendingEnvelope({
        ...request,
        workspace: 'D:/new-project',
        files: ['D:/new-project/analysis.R']
    }));
    assert.equal(workspace.opened.length, 1);
    assert.equal(FileUri.fsPath(workspace.opened[0].uri).toLowerCase(), String.raw`d:\new-project`);
    assert.deepEqual(workspace.opened[0].options, { preserveWindow: true });
    assert.deepEqual(messages.errors, []);
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
    assert.notEqual(storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY), null);

    const reloadedWindow = createContribution(request.workspace, storage, () => {
        assert.equal(storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY), null);
    });
    await reloadedWindow.contribution.restorePendingRequest();
    await reloadedWindow.contribution.restorePendingRequest();

    assert.equal(reloadedWindow.openers.opened.length, 1);
    assert.deepEqual(reloadedWindow.shell.activated, ['editor-1']);
    assert.equal(storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY), null);

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
    await firstWindow.contribution.onStart();

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
    assert.deepEqual(JSON.parse(storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY)!), pendingEnvelope(requestA, requestB, requestC));
    assert.equal(storage.getItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY), '22');
    assert.equal(firstWindow.messages.errors.length, 1);

    const windowA = createContribution('/workspace-a', storage, () => {
        assert.deepEqual(JSON.parse(storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY)!), pendingEnvelope(requestB, requestC));
    });
    await windowA.contribution.restorePendingRequest();
    assert.deepEqual(windowA.openers.opened.map(entry => entry.uri.toString()), ['file:///workspace-a/a.R']);
    assert.deepEqual(windowA.workspace.opened.map(entry => entry.uri.toString()), ['file:///workspace-b']);
    assert.deepEqual(JSON.parse(storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY)!), pendingEnvelope(requestB, requestC));

    const windowB = createContribution('/workspace-b', storage, () => {
        assert.deepEqual(JSON.parse(storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY)!), pendingEnvelope(requestC));
    });
    await windowB.contribution.restorePendingRequest();
    assert.deepEqual(windowB.openers.opened.map(entry => entry.uri.toString()), ['file:///workspace-b/b.R']);
    assert.deepEqual(windowB.workspace.opened.map(entry => entry.uri.toString()), ['file:///workspace-c']);
    assert.deepEqual(JSON.parse(storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY)!), pendingEnvelope(requestC));

    const windowC = createContribution('/workspace-c', storage, () => {
        assert.equal(storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY), null);
    });
    await windowC.contribution.restorePendingRequest();
    assert.deepEqual(windowC.openers.opened.map(entry => entry.uri.toString()), ['file:///workspace-c/c.R']);
    assert.deepEqual(windowC.workspace.opened, []);
    assert.equal(storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY), null);
    assert.equal(storage.getItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY), '22');
});

test('reload rejects corrupt, non-increasing, invalid, or tail-unauthorized pending queues atomically', async () => {
    const request = (id: string, file: string): RideOpenRequest => ({
        id, source: 'singleInstance', workspace: '/project', files: [`/project/${file}`]
    });
    const cases = [
        { serialized: '{not-json', last: '30' },
        { serialized: JSON.stringify(pendingEnvelope(request('31', 'a.R'), request('30', 'b.R'))), last: '30' },
        { serialized: JSON.stringify(pendingEnvelope(request('18446744073709551616', 'overflow.R'))), last: '18446744073709551616' },
        { serialized: JSON.stringify(pendingEnvelope(request('31', 'a.R'))), last: '32' }
    ];

    for (const { serialized, last } of cases) {
        const storage = new MemoryStorage();
        storage.setItem(RIDE_OPEN_REQUEST_PENDING_KEY, serialized);
        storage.setItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY, last);
        const context = createContribution('/project', storage);

        await context.contribution.restorePendingRequest();

        assert.equal(storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY), null);
        assert.equal(storage.getItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY), last);
        assert.deepEqual(context.openers.opened, []);
        assert.deepEqual(context.workspace.opened, []);
        assert.equal(context.messages.errors.length, 1);
    }
});

test('reload rejects pending requests that are not exactly authorized by last-consumed', async () => {
    const pending = {
        id: '99',
        source: 'singleInstance',
        workspace: '/project',
        files: ['/project/analysis.R']
    };
    const cases = [
        { lastConsumed: undefined, expectedLast: null },
        { lastConsumed: 'not-an-id', expectedLast: 'not-an-id' },
        { lastConsumed: '98', expectedLast: '98' },
        { lastConsumed: '100', expectedLast: '100' }
    ];

    for (const { lastConsumed, expectedLast } of cases) {
        const storage = new MemoryStorage();
        storage.setItem(RIDE_OPEN_REQUEST_PENDING_KEY, JSON.stringify(pendingEnvelope(pending)));
        if (lastConsumed) {
            storage.setItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY, lastConsumed);
        }
        const context = createContribution('/project', storage);

        await context.contribution.restorePendingRequest();

        assert.equal(storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY), null);
        assert.equal(storage.getItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY), expectedLast);
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

    assert.deepEqual(JSON.parse(context.storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY)!), pendingEnvelope({
        id: '5', source: 'singleInstance', workspace: 'D:/other', files: ['D:/other/file.R']
    }));
    assert.equal(context.storage.getItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY), '5');
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
    assert.deepEqual(JSON.parse(context.storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY)!), pendingEnvelope(
        { id: '5', source: 'singleInstance', workspace: 'D:/other', files: ['D:/other/file.R'] },
        { id: '6', source: 'singleInstance', workspace: 'C:/project', files: ['C:/project/later.R'] }
    ));
    assert.equal(context.storage.getItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY), '6');

    const restarted = createContribution(String.raw`D:\other`, context.storage);
    await restarted.contribution.restorePendingRequest();
    assert.deepEqual(restarted.openers.opened.map(entry => FileUri.fsPath(entry.uri).toLowerCase()), [String.raw`d:\other\file.r`]);
    assert.equal(restarted.workspace.opened.length, 1);
    assert.equal(FileUri.fsPath(restarted.workspace.opened[0].uri).toLowerCase(), String.raw`c:\project`);
    assert.deepEqual(JSON.parse(context.storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY)!), pendingEnvelope(
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
    storage.setItem(RIDE_OPEN_REQUEST_PENDING_KEY, JSON.stringify(pendingEnvelope(requestA, requestB, requestC)));
    storage.setItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY, requestC.id);
    const windowA = createContribution(requestA.workspace, storage);
    windowA.workspace.openError = new Error('queued switch failed');

    await windowA.contribution.restorePendingRequest();

    assert.deepEqual(windowA.openers.opened.map(entry => entry.uri.toString()), ['file:///workspace-a/a.R']);
    assert.deepEqual(JSON.parse(storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY)!), pendingEnvelope(requestB, requestC));
    assert.equal(storage.getItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY), requestC.id);
    assert.equal(windowA.workspace.opened.length, 0);
    assert.match(windowA.messages.errors[0], /queued switch failed/);

    const windowB = createContribution(requestB.workspace, storage);
    await windowB.contribution.restorePendingRequest();
    assert.deepEqual(windowB.openers.opened.map(entry => entry.uri.toString()), ['file:///workspace-b/b.R']);
    assert.deepEqual(windowB.workspace.opened.map(entry => entry.uri.toString()), ['file:///workspace-c']);
    assert.deepEqual(JSON.parse(storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY)!), pendingEnvelope(requestC));
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
    assert.equal(context.storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY), null);
    assert.equal(context.storage.getItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY), null);
    assert.equal(context.messages.errors.length, invalidPayloads.length);
});

test('corrupt or legacy pending JSON is removed and cannot trigger a restore loop', async () => {
    const corruptStorage = new MemoryStorage();
    corruptStorage.setItem(RIDE_OPEN_REQUEST_PENDING_KEY, '{not-json');
    const corrupt = createContribution('/project', corruptStorage);
    await corrupt.contribution.restorePendingRequest();
    assert.equal(corruptStorage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY), null);
    assert.equal(corrupt.messages.errors.length, 1);

    const legacyStorage = new MemoryStorage();
    legacyStorage.setItem(RIDE_OPEN_REQUEST_PENDING_KEY, JSON.stringify({
        id: '8',
        source: 'singleInstance',
        workspace: '/other',
        files: ['/other/file.R']
    }));
    legacyStorage.setItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY, '8');
    const legacy = createContribution('/project', legacyStorage);
    await legacy.contribution.restorePendingRequest();

    assert.equal(legacyStorage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY), null);
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
    assert.equal(context.storage.getItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY), '10');
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
    assert.equal(context.storage.getItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY), '11');
    assert.deepEqual(context.messages.errors, []);

    await context.contribution.handleOpenRequest({
        id: '12', source: 'initial', workspace: '/project', files: ['']
    });
    assert.equal(context.storage.getItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY), '11');
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
        assert.equal(context.storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY), null);
        assert.deepEqual(context.messages.errors, []);
    }
});

test('redundant drive-root separators are canonical across handoff and reload', async () => {
    const storage = new MemoryStorage();
    const firstWindow = createContribution('D:\\', storage);

    await firstWindow.contribution.handleOpenRequest({
        id: '13', source: 'singleInstance', workspace: 'C:////', files: [String.raw`C:\root.R`]
    });

    assert.deepEqual(JSON.parse(storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY)!), pendingEnvelope({
        id: '13', source: 'singleInstance', workspace: 'C:/', files: ['C:/root.R']
    }));
    assert.equal(storage.getItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY), '13');
    assert.equal(FileUri.fsPath(firstWindow.workspace.opened[0].uri).toLowerCase(), 'c:\\');
    assert.deepEqual(firstWindow.workspace.opened[0].options, { preserveWindow: true });
    assert.deepEqual(firstWindow.openers.opened, []);

    const reloadedWindow = createContribution('C:\\', storage);
    await reloadedWindow.contribution.restorePendingRequest();

    assert.deepEqual(reloadedWindow.openers.opened.map(entry => FileUri.fsPath(entry.uri).toLowerCase()), [String.raw`c:\root.r`]);
    assert.equal(storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY), null);
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
    assert.equal(context.storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY), null);
    assert.equal(context.storage.getItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY), null);
    assert.equal(context.messages.errors.length, invalidRequests.length);
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
    assert.equal(invalid.storage.getItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY), null);
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

test('frontend lifecycle restores and registers once, then unlistens once on cleanup', async () => {
    const storage = new MemoryStorage();
    storage.setItem(RIDE_OPEN_REQUEST_PENDING_KEY, JSON.stringify(pendingEnvelope({
        id: '12',
        source: 'initial',
        workspace: '/project',
        files: ['/project/startup.R']
    })));
    storage.setItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY, '12');
    const context = createContribution('/project', storage);

    await context.contribution.onStart();
    await context.contribution.onStart();

    assert.equal(context.openers.opened.length, 1);
    assert.equal(context.native.registrations, 1);

    context.contribution.onStop();
    context.contribution.onStop();
    assert.equal(context.native.unlistenCalls, 1);
});

test('frontend startup waits for the workspace before restoring pending files', async () => {
    const storage = new MemoryStorage();
    storage.setItem(RIDE_OPEN_REQUEST_PENDING_KEY, JSON.stringify(pendingEnvelope({
        id: '14',
        source: 'initial',
        workspace: '/project',
        files: ['/project/ready.R']
    })));
    storage.setItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY, '14');
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
    assert.notEqual(storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY), null);
    assert.deepEqual(context.openers.opened, []);

    markReady!();
    await started;
    assert.equal(storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY), null);
    assert.equal(context.openers.opened.length, 1);
});
