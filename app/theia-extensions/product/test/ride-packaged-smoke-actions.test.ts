/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import URI from '@theia/core/lib/common/uri';
import { Container, ContainerModule } from '@theia/core/shared/inversify';
import {
    RidePackagedSmokeActions,
    RidePackagedSmokeContribution
} from '../src/browser/ride-packaged-smoke';
import type { RideSmokeAction, RideSmokePlan } from '../src/browser/ride-packaged-smoke';
import { bindRidePackagedSmokeContribution } from '../src/browser/ride-packaged-smoke-bindings';
import { RIDE_SMOKE_PACKAGED_PLUGIN } from '../src/browser/ride-packaged-plugin-inventory';
import {
    RIDE_SMOKE_EDITOR_MARKER,
    RIDE_SMOKE_TERMINAL_SENTINEL,
    RIDE_SMOKE_UNIX_COMMAND,
    RIDE_SMOKE_WINDOWS_COMMAND,
    RidePackagedSmokeActionService,
    RidePackagedSmokeActionServices
} from '../src/browser/ride-packaged-smoke-actions';

const ROOT = new URI('file:///C:/ride-smoke/workspace');
const EXPECTED = ROOT.resolve('startup.R');

interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function outcomeWithin(operation: Promise<void>, timeoutMs: number = 100): Promise<unknown> {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(new Error('test guard elapsed')), timeoutMs);
        operation.then(
            () => { clearTimeout(timer); resolve(undefined); },
            error => { clearTimeout(timer); resolve(error); }
        );
    });
}

async function turn(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
}

function manualTimers(): {
    readonly setTimeout: (callback: () => void, timeoutMs: number) => unknown;
    readonly clearTimeout: (handle: unknown) => void;
    readonly pending: () => number;
    advanceTo(timeMs: number): Promise<void>;
} {
    let now = 0;
    let order = 0;
    const timers = new Map<object, { readonly callback: () => void; readonly due: number; readonly order: number }>();
    return {
        setTimeout: (callback, timeoutMs) => {
            const handle = {};
            timers.set(handle, { callback, due: now + timeoutMs, order: order++ });
            return handle;
        },
        clearTimeout: handle => {
            timers.delete(handle as object);
        },
        pending: () => timers.size,
        advanceTo: async timeMs => {
            assert.ok(timeMs >= now, 'manual time cannot move backwards');
            while (true) {
                await turn();
                const next = [...timers.entries()]
                    .filter(([, timer]) => timer.due <= timeMs)
                    .sort((left, right) => left[1].due - right[1].due || left[1].order - right[1].order)[0];
                if (!next) {
                    now = timeMs;
                    await turn();
                    return;
                }
                now = next[1].due;
                timers.delete(next[0]);
                next[1].callback();
            }
        }
    };
}

function plan(patch: Partial<RideSmokePlan> = {}): RideSmokePlan {
    return Object.freeze({
        specSha256: 'a'.repeat(64),
        scenario: 'critical-file',
        profile: 'tauri-critical',
        workspace: '.',
        files: Object.freeze(['startup.R']),
        actions: Object.freeze<RideSmokeAction[]>(['editor-save', 'terminal-sentinel', 'workspace-search', 'scm-status']),
        actionTimeoutMs: 10_000,
        ...patch
    });
}

function workspaceServices(overrides: Partial<RidePackagedSmokeActionServices> = {}): RidePackagedSmokeActionServices {
    return {
        workspaceService: { roots: Promise.resolve([{ resource: ROOT }]) },
        ...overrides
    };
}

function editorServices(options: {
    activeUri?: URI;
    persist?: boolean;
    persistedInitial?: string;
    normalizeInsertedEol?: boolean;
    initialContent?: string;
    mutateAfterReplace?: (content: string, inserted: string) => string;
} = {}): {
    services: RidePackagedSmokeActionServices;
    getBuffer: () => string;
    getPersisted: () => string;
    replaceCalls: unknown[];
    saveCalls: number;
} {
    let buffer = options.initialContent ?? 'x <- 1\n';
    let persisted = options.persistedInitial ?? buffer;
    let saveCalls = 0;
    const replaceCalls: unknown[] = [];
    const document = {
        getText: () => buffer,
        positionAt: (offset: number) => ({ line: 1, character: offset }),
        save: async () => {
            saveCalls++;
            if (options.persist !== false) {
                persisted = buffer;
            }
        }
    };
    const editor = {
        uri: options.activeUri ?? EXPECTED,
        document,
        replaceText: async (request: { replaceOperations: Array<{ text: string }> }) => {
            replaceCalls.push(request);
            const inserted = options.normalizeInsertedEol
                ? request.replaceOperations[0].text.replace(/\r?\n/gu, '\r\n')
                : request.replaceOperations[0].text;
            buffer = options.mutateAfterReplace?.(buffer, inserted) ?? buffer + inserted;
            return true;
        }
    };
    return {
        services: workspaceServices({
            editorManager: { activeEditor: { editor } },
            fileService: {
                read: async () => ({ value: persisted }),
                exists: async () => false
            }
        }),
        getBuffer: () => buffer,
        getPersisted: () => persisted,
        replaceCalls,
        get saveCalls() { return saveCalls; }
    };
}

test('smoke action editor-save appends the fixed marker, saves, and verifies persisted content', async () => {
    const fixture = editorServices();
    const actions = new RidePackagedSmokeActionService(fixture.services);

    await actions.editorSave(plan());

    assert.equal(fixture.replaceCalls.length, 1);
    assert.equal(fixture.saveCalls, 1);
    assert.match(fixture.getBuffer(), new RegExp(RIDE_SMOKE_EDITOR_MARKER));
    assert.match(fixture.getPersisted(), new RegExp(RIDE_SMOKE_EDITOR_MARKER));
});

test('smoke action editor-save rejects missing, wrong, and escaping active editors', async t => {
    const cases: Array<[string, RidePackagedSmokeActionServices, RideSmokePlan]> = [
        ['missing editor', workspaceServices({ fileService: { read: async () => ({ value: '' }), exists: async () => false } }), plan()],
        ['wrong editor', editorServices({ activeUri: ROOT.resolve('other.R') }).services, plan()],
        ['outside editor', editorServices({ activeUri: new URI('file:///C:/ride-smoke/outside.R') }).services, plan()],
        ['query-bearing editor', editorServices({ activeUri: EXPECTED.withQuery('other') }).services, plan()],
        ['escaping plan file', editorServices().services, plan({ files: Object.freeze(['../outside.R']) })]
    ];
    for (const [name, services, smokePlan] of cases) {
        await t.test(name, async () => {
            await assert.rejects(new RidePackagedSmokeActionService(services).editorSave(smokePlan), /Smoke action unavailable\./);
        });
    }
});

test('smoke action editor-save rejects a save that did not persist the marker', async () => {
    const fixture = editorServices({ persist: false });
    await assert.rejects(
        new RidePackagedSmokeActionService(fixture.services).editorSave(plan()),
        /Smoke action failed\./
    );
});

test('smoke action editor-save rejects a stale marker when the new append was not persisted', async () => {
    const fixture = editorServices({ persist: false, persistedInitial: `# ${RIDE_SMOKE_EDITOR_MARKER}\n` });
    await assert.rejects(
        new RidePackagedSmokeActionService(fixture.services).editorSave(plan()),
        /Smoke action failed\./
    );
});

test('smoke action editor-save verifies exact LF and Monaco-normalized CRLF appends', async t => {
    const cases = [
        ['LF', 'x <- 1\n', `x <- 1\n# ${RIDE_SMOKE_EDITOR_MARKER}\n`],
        ['CRLF', 'x <- 1\r\n', `x <- 1\r\n# ${RIDE_SMOKE_EDITOR_MARKER}\r\n`]
    ] as const;
    for (const [name, initialContent, expected] of cases) {
        await t.test(name, async () => {
            const fixture = editorServices({ initialContent, normalizeInsertedEol: name === 'CRLF' });
            await new RidePackagedSmokeActionService(fixture.services).editorSave(plan());
            assert.equal(fixture.getPersisted(), expected);
        });
    }
});

test('smoke action editor-save rejects non-append edits before saving', async t => {
    const initial = 'alpha\nbeta\n';
    const cases: Array<[string, (content: string, inserted: string) => string]> = [
        ['marker inserted in the middle', (content, inserted) => `${content.slice(0, 6)}${inserted}${content.slice(6)}`],
        ['original content replaced', (_content, inserted) => inserted],
        ['concurrent trailing text', (content, inserted) => `${content}${inserted}late mutation\n`]
    ];
    for (const [name, mutateAfterReplace] of cases) {
        await t.test(name, async () => {
            const fixture = editorServices({ initialContent: initial, mutateAfterReplace });
            await assert.rejects(
                new RidePackagedSmokeActionService(fixture.services).editorSave(plan()),
                /Smoke action failed\./
            );
            assert.equal(fixture.saveCalls, 0);
        });
    }
});

test('smoke action editor-save bounds every asynchronous editor stage and consumes late settlement', async t => {
    for (const stage of ['replace', 'save', 'read'] as const) {
        for (const late of ['resolve', 'reject'] as const) {
            await t.test(`${stage} ${late}`, async () => {
                const pending = deferred<unknown>();
                let buffer = 'x <- 1\n';
                let saves = 0;
                let reads = 0;
                const append = `# ${RIDE_SMOKE_EDITOR_MARKER}\n`;
                const services = workspaceServices({
                    pollTimeoutMs: 5,
                    editorManager: {
                        activeEditor: {
                            editor: {
                                uri: EXPECTED,
                                document: {
                                    getText: () => buffer,
                                    positionAt: () => ({ line: 1, character: 0 }),
                                    save: async () => {
                                        saves++;
                                        if (stage === 'save') {
                                            await pending.promise;
                                        }
                                    }
                                },
                                replaceText: async () => {
                                    if (stage === 'replace') {
                                        await pending.promise;
                                    }
                                    buffer += append;
                                    return true;
                                }
                            }
                        }
                    },
                    fileService: {
                        read: async () => {
                            reads++;
                            if (stage === 'read') {
                                await pending.promise;
                            }
                            return { value: buffer };
                        },
                        exists: async () => false
                    }
                });
                const result = await outcomeWithin(new RidePackagedSmokeActionService(services).editorSave(plan()));
                assert.equal((result as Error).message, 'Smoke action timed out.');
                if (late === 'resolve') {
                    pending.resolve(stage === 'replace' ? true : undefined);
                } else {
                    pending.reject(new Error(`sensitive late ${stage} failure`));
                }
                await turn();
                assert.equal(saves, stage === 'replace' ? 0 : 1);
                assert.equal(reads, stage === 'read' ? 1 : 0);
            });
        }
    }
});

function terminalFixture(windows: boolean, sentinelAppears: boolean = true): {
    services: RidePackagedSmokeActionServices;
    options: unknown[];
    commands: string[];
    starts: number;
    disposals: number;
} {
    const options: unknown[] = [];
    const commands: string[] = [];
    let starts = 0;
    let disposals = 0;
    let exists = false;
    return {
        options,
        commands,
        get starts() { return starts; },
        get disposals() { return disposals; },
        services: workspaceServices({
            backendIsWindows: windows,
            pollIntervalMs: 1,
            pollTimeoutMs: 8,
            fileService: {
                read: async () => ({ value: '' }),
                exists: async (uri: URI) => uri.isEqual(ROOT.resolve(RIDE_SMOKE_TERMINAL_SENTINEL)) && exists
            },
            terminalService: {
                newTerminal: async (terminalOptions: unknown) => {
                    options.push(terminalOptions);
                    return {
                        start: async () => { starts++; return 1; },
                        sendText: (command: string) => {
                            commands.push(command);
                            exists = sentinelAppears;
                        },
                        dispose: () => { disposals++; }
                    };
                }
            }
        })
    };
}

test('smoke action terminal-sentinel uses a fixed Windows command and workspace cwd', async () => {
    const fixture = terminalFixture(true);
    await new RidePackagedSmokeActionService(fixture.services).terminalSentinel(plan());

    assert.equal(fixture.starts, 1);
    assert.deepEqual(fixture.commands, [RIDE_SMOKE_WINDOWS_COMMAND]);
    assert.equal(fixture.commands[0].includes('startup.R'), false);
    assert.equal((fixture.options[0] as { cwd: URI }).cwd.isEqual(ROOT), true);
    assert.equal(fixture.disposals, 1);
});

test('smoke actions reject non-dot plan workspace before any workbench side effect', async () => {
    const sideEffects = { editor: 0, terminal: 0, search: 0, scm: 0 };
    const services = workspaceServices({
        editorManager: {
            activeEditor: {
                editor: {
                    uri: EXPECTED,
                    document: {
                        getText: () => 'x <- 1\n',
                        positionAt: () => ({ line: 1, character: 0 }),
                        save: async () => undefined
                    },
                    replaceText: async () => { sideEffects.editor++; return true; }
                }
            }
        },
        fileService: {
            read: async () => ({ value: '' }),
            exists: async () => false
        },
        terminalService: {
            newTerminal: async () => {
                sideEffects.terminal++;
                return { start: async () => 1, sendText: () => undefined, dispose: () => undefined };
            }
        },
        searchService: {
            searchWithCallback: async () => { sideEffects.search++; return 1; },
            cancel: () => undefined
        },
        scmService: {
            get repositories() {
                sideEffects.scm++;
                return [];
            }
        }
    });
    const mismatch = plan({ workspace: 'secret/path' });
    const actions = new RidePackagedSmokeActionService(services);

    await assert.rejects(actions.editorSave(mismatch), /Smoke action unavailable\./);
    await assert.rejects(actions.terminalSentinel(mismatch), /Smoke action unavailable\./);
    await assert.rejects(actions.workspaceSearch(mismatch), /Smoke action unavailable\./);
    await assert.rejects(actions.scmStatus(mismatch), /Smoke action unavailable\./);
    assert.deepEqual(sideEffects, { editor: 0, terminal: 0, search: 0, scm: 0 });
});

test('smoke action terminal-sentinel selects the fixed Unix command', async () => {
    const fixture = terminalFixture(false);
    await new RidePackagedSmokeActionService(fixture.services).terminalSentinel(plan());
    assert.deepEqual(fixture.commands, [RIDE_SMOKE_UNIX_COMMAND]);
});

test('critical-empty runs terminal-sentinel without a file and rejects file-dependent actions', async () => {
    const fixture = terminalFixture(false);
    const emptyPlan = plan({
        scenario: 'critical-empty',
        files: Object.freeze([]),
        actions: Object.freeze<RideSmokeAction[]>(['terminal-sentinel'])
    });

    await new RidePackagedSmokeActionService(fixture.services).terminalSentinel(emptyPlan);
    await assert.rejects(new RidePackagedSmokeActionService(editorServices().services).editorSave(emptyPlan), /Smoke action unavailable\./);
    await assert.rejects(new RidePackagedSmokeActionService(searchServices(EXPECTED).services).workspaceSearch(emptyPlan), /Smoke action unavailable\./);
    await assert.rejects(new RidePackagedSmokeActionService(scmServices(ROOT, EXPECTED)).scmStatus(emptyPlan), /Smoke action unavailable\./);
    assert.equal(fixture.starts, 1);
    assert.deepEqual(fixture.commands, [RIDE_SMOKE_UNIX_COMMAND]);
});

test('smoke action terminal-sentinel fails safely when the sentinel never appears', async () => {
    const fixture = terminalFixture(true, false);
    await assert.rejects(
        new RidePackagedSmokeActionService(fixture.services).terminalSentinel(plan()),
        /Smoke action timed out\./
    );
    assert.equal(fixture.disposals, 1);
});

test('smoke action terminal-sentinel rejects missing services and an invalid terminal cwd', async t => {
    await t.test('missing terminal service', async () => {
        await assert.rejects(
            new RidePackagedSmokeActionService(workspaceServices()).terminalSentinel(plan()),
            /Smoke action unavailable\./
        );
    });
    await t.test('terminal service rejects cwd', async () => {
        const services = workspaceServices({
            fileService: { read: async () => ({ value: '' }), exists: async () => false },
            terminalService: { newTerminal: async () => { throw new Error('sensitive cwd'); } }
        });
        await assert.rejects(
            new RidePackagedSmokeActionService(services).terminalSentinel(plan()),
            error => error instanceof Error && error.message === 'Smoke action failed.'
        );
    });
});

function lateTerminalFixture(create: Promise<{
    start(): Promise<number>;
    sendText(command: string): void;
    dispose(): void;
}>): {
    readonly services: RidePackagedSmokeActionServices;
    readonly commands: string[];
} {
    const commands: string[] = [];
    return {
        commands,
        services: workspaceServices({
            pollIntervalMs: 1,
            pollTimeoutMs: 10,
            fileService: { read: async () => ({ value: '' }), exists: async () => false },
            terminalService: { newTerminal: async () => create }
        })
    };
}

function theiaTerminalLifecycleFixture(
    start: () => Promise<number>,
    openBeforeReject: boolean = false
): {
    readonly services: RidePackagedSmokeActionServices;
    readonly commands: string[];
    readonly backendOpen: boolean;
    readonly backendCloses: number;
    readonly widgetDisposals: number;
    readonly exitEvents: number;
    readonly sends: number;
} {
    let terminalId: number | undefined;
    let backendOpen = false;
    let backendCloses = 0;
    let widgetDisposals = 0;
    let exitEvents = 0;
    let sends = 0;
    const fixture = lateTerminalFixture(Promise.resolve({
        start: async () => {
            try {
                const id = await start();
                terminalId = id;
                backendOpen = true;
                return id;
            } catch (error) {
                if (openBeforeReject) {
                    terminalId = 77;
                    backendOpen = true;
                }
                throw error;
            }
        },
        sendText: command => { sends++; fixture.commands.push(command); },
        dispose: () => {
            widgetDisposals++;
            if (terminalId !== undefined && backendOpen) {
                backendOpen = false;
                backendCloses++;
                exitEvents++;
            }
        }
    }));
    return {
        services: fixture.services,
        commands: fixture.commands,
        get backendOpen() { return backendOpen; },
        get backendCloses() { return backendCloses; },
        get widgetDisposals() { return widgetDisposals; },
        get exitEvents() { return exitEvents; },
        get sends() { return sends; }
    };
}

test('smoke action terminal-sentinel bounds pending creation and disposes a late terminal without starting it', async () => {
    const creation = deferred<{
        start(): Promise<number>;
        sendText(command: string): void;
        dispose(): void;
    }>();
    let starts = 0;
    let disposals = 0;
    const fixture = lateTerminalFixture(creation.promise);
    const operation = new RidePackagedSmokeActionService(fixture.services).terminalSentinel(plan());

    const result = await outcomeWithin(operation);
    creation.resolve({
        start: async () => { starts++; return 1; },
        sendText: command => fixture.commands.push(command),
        dispose: () => { disposals++; }
    });
    await turn();

    assert.equal((result as Error).message, 'Smoke action timed out.');
    assert.equal(starts, 0);
    assert.deepEqual(fixture.commands, []);
    assert.equal(disposals, 1);
});

test('smoke action terminal-sentinel consumes a late creation rejection after timeout', async () => {
    const creation = deferred<{
        start(): Promise<number>;
        sendText(command: string): void;
        dispose(): void;
    }>();
    const fixture = lateTerminalFixture(creation.promise);
    const operation = new RidePackagedSmokeActionService(fixture.services).terminalSentinel(plan());

    const result = await outcomeWithin(operation);
    creation.reject(new Error('sensitive late create failure'));
    await turn();

    assert.equal((result as Error).message, 'Smoke action timed out.');
    assert.deepEqual(fixture.commands, []);
});

test('smoke action terminal-sentinel closes a backend that opens after its first widget disposal', async () => {
    const start = deferred<number>();
    const fixture = theiaTerminalLifecycleFixture(() => start.promise);
    const operation = new RidePackagedSmokeActionService(fixture.services).terminalSentinel(plan());

    const result = await outcomeWithin(operation);
    assert.equal((result as Error).message, 'Smoke action timed out.');
    assert.equal(fixture.widgetDisposals, 1);
    assert.equal(fixture.backendOpen, false);
    assert.equal(fixture.backendCloses, 0);

    start.resolve(71);
    await turn();

    assert.equal(fixture.backendOpen, false);
    assert.equal(fixture.backendCloses, 1);
    assert.equal(fixture.exitEvents, 1);
    assert.equal(fixture.widgetDisposals, 2);
    assert.equal(fixture.sends, 0);
    assert.deepEqual(fixture.commands, []);
});

test('smoke action terminal-sentinel consumes a late start rejection without duplicate backend close', async () => {
    const start = deferred<number>();
    const fixture = theiaTerminalLifecycleFixture(() => start.promise, true);
    const operation = new RidePackagedSmokeActionService(fixture.services).terminalSentinel(plan());

    const result = await outcomeWithin(operation);
    start.reject(new Error('sensitive late start failure'));
    await turn();

    assert.equal((result as Error).message, 'Smoke action timed out.');
    assert.equal(fixture.backendOpen, false);
    assert.equal(fixture.widgetDisposals, 2);
    assert.equal(fixture.backendCloses, 1);
    assert.equal(fixture.exitEvents, 1);
    assert.equal(fixture.sends, 0);
});

test('smoke action terminal-sentinel safely cleans up an immediate start rejection', async () => {
    const fixture = theiaTerminalLifecycleFixture(() => Promise.reject(new Error('sensitive immediate start failure')));

    await assert.rejects(
        new RidePackagedSmokeActionService(fixture.services).terminalSentinel(plan()),
        /Smoke action failed\./
    );
    assert.equal(fixture.backendOpen, false);
    assert.equal(fixture.widgetDisposals, 1);
    assert.equal(fixture.backendCloses, 0);
    assert.equal(fixture.exitEvents, 0);
    assert.equal(fixture.sends, 0);
});

test('smoke action terminal-sentinel handles a synchronous timeout callback without TDZ failure', async () => {
    let creates = 0;
    const services = workspaceServices({
        pollTimeoutMs: 10,
        setTimeout: callback => { callback(); return 1; },
        clearTimeout: () => { throw new Error('clear failed'); },
        fileService: { read: async () => ({ value: '' }), exists: async () => false },
        terminalService: {
            newTerminal: async () => {
                creates++;
                return { start: async () => 1, sendText: () => undefined, dispose: () => undefined };
            }
        }
    });
    const result = await outcomeWithin(new RidePackagedSmokeActionService(services).terminalSentinel(plan()));
    assert.equal((result as Error).message, 'Smoke action timed out.');
    assert.equal(creates <= 1, true);
});

function searchServices(resultUri: URI | undefined): { services: RidePackagedSmokeActionServices; searches: unknown[][] } {
    const searches: unknown[][] = [];
    return {
        searches,
        services: workspaceServices({
            searchService: {
                searchWithCallback: async (
                    what: string,
                    roots: string[],
                    callbacks: {
                        onResult(searchId: number, result: {
                            root: string;
                            fileUri: string;
                            matches: unknown[];
                        }): void;
                        onDone(searchId: number, error?: string): void;
                    },
                    options: unknown
                ) => {
                    searches.push([what, roots, options]);
                    if (resultUri) {
                        callbacks.onResult(7, {
                            root: ROOT.toString(),
                            fileUri: resultUri.toString(),
                            matches: [{ line: 1, character: 1, length: 4, lineText: RIDE_SMOKE_EDITOR_MARKER }]
                        });
                    }
                    callbacks.onDone(7);
                    return 7;
                },
                cancel: () => undefined
            }
        })
    };
}

test('smoke action workspace-search uses the production callback shape and verifies the expected URI', async () => {
    const fixture = searchServices(EXPECTED);
    await new RidePackagedSmokeActionService(fixture.services).workspaceSearch(plan());
    assert.deepEqual(fixture.searches, [[RIDE_SMOKE_EDITOR_MARKER, [ROOT.toString()], { matchCase: true, maxResults: 20 }]]);
});

test('smoke action workspace-search rejects empty, wrong, and prefix-confusable results', async t => {
    for (const [name, uri] of [
        ['empty', undefined],
        ['wrong workspace file', ROOT.resolve('other.R')],
        ['outside', new URI('file:///C:/ride-smoke/workspace-evil/startup.R')]
    ] as const) {
        await t.test(name, async () => {
            await assert.rejects(
                new RidePackagedSmokeActionService(searchServices(uri).services).workspaceSearch(plan()),
                /Smoke action failed\./
            );
        });
    }
});

test('smoke action workspace-search times out and cancels an unfinished production search', async () => {
    let cancelled: number | undefined;
    const services = workspaceServices({
        pollTimeoutMs: 5,
        searchService: {
            searchWithCallback: async () => 19,
            cancel: searchId => { cancelled = searchId; }
        }
    });
    await assert.rejects(
        new RidePackagedSmokeActionService(services).workspaceSearch(plan()),
        /Smoke action timed out\./
    );
    assert.equal(cancelled, 19);
});

test('smoke action workspace-search cancels an ID that resolves after timeout exactly once', async () => {
    const id = deferred<number>();
    const cancelled: number[] = [];
    const services = workspaceServices({
        pollTimeoutMs: 5,
        searchService: {
            searchWithCallback: async () => id.promise,
            cancel: searchId => { cancelled.push(searchId); }
        }
    });
    const operation = new RidePackagedSmokeActionService(services).workspaceSearch(plan());

    await assert.rejects(operation, /Smoke action timed out\./);
    assert.deepEqual(cancelled, []);
    id.resolve(41);
    await turn();
    assert.deepEqual(cancelled, [41]);
});

test('smoke action workspace-search cancels a delayed ID after dispose and consumes late failures', async t => {
    await t.test('delayed resolve and throwing cancel', async () => {
        const id = deferred<number>();
        const cancelled: number[] = [];
        const services = workspaceServices({
            searchService: {
                searchWithCallback: async () => id.promise,
                cancel: searchId => { cancelled.push(searchId); throw new Error('cancel failed'); }
            }
        });
        const actions = new RidePackagedSmokeActionService(services);
        const operation = actions.workspaceSearch(plan());
        await turn();
        actions.dispose();
        await assert.rejects(operation, /Smoke action disposed\./);
        id.resolve(53);
        await turn();
        assert.deepEqual(cancelled, [53]);
    });
    await t.test('delayed reject', async () => {
        const id = deferred<number>();
        const services = workspaceServices({
            pollTimeoutMs: 5,
            searchService: { searchWithCallback: async () => id.promise, cancel: () => undefined }
        });
        const operation = new RidePackagedSmokeActionService(services).workspaceSearch(plan());
        await assert.rejects(operation, /Smoke action timed out\./);
        id.reject(new Error('sensitive delayed search failure'));
        await turn();
    });
});

function scmServices(root: URI, resource: URI): RidePackagedSmokeActionServices {
    return workspaceServices({
        pollIntervalMs: 1,
        pollTimeoutMs: 8,
        scmService: {
            repositories: [{
                provider: {
                    rootUri: root.toString(),
                    groups: [{ resources: [{ sourceUri: resource }] }]
                }
            }]
        }
    });
}

test('smoke action scm-status verifies the workspace repository changed resource', async () => {
    await new RidePackagedSmokeActionService(scmServices(ROOT, EXPECTED)).scmStatus(plan());
});

test('smoke action scm-status observes repositories and resources registered after polling starts', async () => {
    let reads = 0;
    const services = workspaceServices({
        pollIntervalMs: 1,
        pollTimeoutMs: 50,
        scmService: {
            get repositories() {
                reads++;
                if (reads === 1) {
                    return [];
                }
                return [{
                    provider: {
                        rootUri: ROOT.toString(),
                        groups: [{ resources: reads >= 3 ? [{ sourceUri: EXPECTED }] : [] }]
                    }
                }];
            }
        }
    });

    await new RidePackagedSmokeActionService(services).scmStatus(plan());
    assert.equal(reads >= 3, true);
});

test('smoke action scm-status rejects wrong repositories, resources, and missing refresh', async t => {
    await t.test('wrong repository', async () => {
        await assert.rejects(
            new RidePackagedSmokeActionService(scmServices(new URI('file:///C:/other'), EXPECTED)).scmStatus(plan()),
            /Smoke action timed out\./
        );
    });
    await t.test('wrong resource', async () => {
        await assert.rejects(
            new RidePackagedSmokeActionService(scmServices(ROOT, ROOT.resolve('other.R'))).scmStatus(plan()),
            /Smoke action timed out\./
        );
    });
    await t.test('no repository', async () => {
        await assert.rejects(
            new RidePackagedSmokeActionService(workspaceServices({
                pollIntervalMs: 1,
                pollTimeoutMs: 8,
                scmService: { repositories: [] }
            })).scmStatus(plan()),
            /Smoke action timed out\./
        );
    });
});

test('Task 4 action deadlines start before workspace roots and suppress every late side effect', async t => {
    for (const late of ['resolve', 'reject'] as const) {
        await t.test(late, async () => {
            const roots = deferred<readonly [{ readonly resource: URI }]>();
            const sideEffects = { editor: 0, terminal: 0, search: 0, scm: 0 };
            const services: RidePackagedSmokeActionServices = {
                workspaceService: { roots: roots.promise },
                pollIntervalMs: 1,
                pollTimeoutMs: 5,
                editorManager: {
                    activeEditor: {
                        editor: {
                            uri: EXPECTED,
                            document: {
                                getText: () => 'x <- 1\n',
                                positionAt: () => ({ line: 1, character: 0 }),
                                save: async () => undefined
                            },
                            replaceText: async () => { sideEffects.editor++; return true; }
                        }
                    }
                },
                fileService: {
                    read: async () => ({ value: '' }),
                    exists: async () => false
                },
                terminalService: {
                    newTerminal: async () => {
                        sideEffects.terminal++;
                        return { start: async () => 1, sendText: () => undefined, dispose: () => undefined };
                    }
                },
                searchService: {
                    searchWithCallback: async () => { sideEffects.search++; return 1; },
                    cancel: () => undefined
                },
                scmService: {
                    get repositories() {
                        sideEffects.scm++;
                        return [];
                    }
                }
            };
            const actions = new RidePackagedSmokeActionService(services);
            const outcomes = await Promise.all([
                outcomeWithin(actions.editorSave(plan())),
                outcomeWithin(actions.terminalSentinel(plan())),
                outcomeWithin(actions.workspaceSearch(plan())),
                outcomeWithin(actions.scmStatus(plan()))
            ]);

            assert.deepEqual(outcomes.map(outcome => (outcome as Error).message), [
                'Smoke action timed out.',
                'Smoke action timed out.',
                'Smoke action timed out.',
                'Smoke action timed out.'
            ]);
            if (late === 'resolve') {
                roots.resolve([{ resource: ROOT }]);
            } else {
                roots.reject(new Error('sensitive late roots failure'));
            }
            await turn();
            assert.deepEqual(sideEffects, { editor: 0, terminal: 0, search: 0, scm: 0 });
        });
    }
});

test('smoke action service dispose prevents new side effects', async () => {
    const fixture = editorServices();
    const actions = new RidePackagedSmokeActionService(fixture.services);
    actions.dispose();

    await assert.rejects(actions.editorSave(plan()), /Smoke action disposed\./);
    assert.equal(fixture.replaceCalls.length, 0);
    assert.equal(fixture.saveCalls, 0);
});

test('smoke action waits for hosted plugins before executing the canonical packaged command', async () => {
    const pluginsReady = deferred<void>();
    const lookups: string[] = [];
    const executions: string[] = [];
    let commandRegistered = false;
    const services = workspaceServices({
        ...({
            hostedPlugins: { didStart: pluginsReady.promise },
            commandRegistry: {
                getCommand: (id: string) => {
                    lookups.push(id);
                    return commandRegistered ? { id } : undefined;
                },
                getAllHandlers: () => [],
                executeCommand: async (id: string) => {
                    executions.push(id);
                }
            }
        } as unknown as Partial<RidePackagedSmokeActionServices>)
    });
    const operation = new RidePackagedSmokeActionService(services).packagedPluginCommand(plan());
    const outcome = outcomeWithin(operation);

    await turn();
    assert.deepEqual(lookups, []);
    assert.deepEqual(executions, []);

    commandRegistered = true;
    pluginsReady.resolve();
    assert.equal(await outcome, undefined);
    assert.deepEqual(lookups, [RIDE_SMOKE_PACKAGED_PLUGIN.commandId]);
    assert.deepEqual(executions, [RIDE_SMOKE_PACKAGED_PLUGIN.commandId]);
});

test('Task 5 actions can complete after five seconds but before the planned deadline', async t => {
    await t.test('hosted plugin readiness', async () => {
        const clock = manualTimers();
        const pluginsReady = deferred<void>();
        let executions = 0;
        const actions = new RidePackagedSmokeActionService({
            hostedPlugins: { didStart: pluginsReady.promise },
            commandRegistry: {
                getCommand: id => ({ id }),
                getAllHandlers: () => [],
                executeCommand: async () => { executions++; }
            },
            setTimeout: clock.setTimeout,
            clearTimeout: clock.clearTimeout
        });
        const operation = actions.packagedPluginCommand(plan({ actionTimeoutMs: 10_000 }));
        const outcome = outcomeWithin(operation);

        await clock.advanceTo(6_000);
        pluginsReady.resolve();

        assert.equal(await outcome, undefined);
        assert.equal(executions, 1);
        assert.equal(clock.pending(), 0);
    });

    await t.test('secondary window readiness', async () => {
        const clock = manualTimers();
        const proxyHandler = {};
        const realHandler = {};
        const widget = { isExtractable: true, secondaryWindow: undefined as object | undefined };
        let handlers = [proxyHandler];
        const actions = new RidePackagedSmokeActionService({
            applicationShell: { widgets: [widget] },
            commandRegistry: {
                getCommand: id => ({ id }),
                getAllHandlers: () => handlers,
                executeCommand: async () => { handlers = [realHandler]; }
            },
            pollIntervalMs: 1_000,
            setTimeout: clock.setTimeout,
            clearTimeout: clock.clearTimeout
        });
        const operation = actions.secondaryWindow(plan({ actionTimeoutMs: 10_000 }));
        const outcome = outcomeWithin(operation);

        await clock.advanceTo(6_000);
        widget.secondaryWindow = {};
        await clock.advanceTo(7_000);

        assert.equal(await outcome, undefined);
        assert.equal(clock.pending(), 0);
    });

    await t.test('single-instance forwarding', async () => {
        const clock = manualTimers();
        const listeners = new Set<(event: { source: 'singleInstance'; relativePath: string }) => void>();
        const actions = new RidePackagedSmokeActionService({
            openRequests: {
                onDidOpenRequest: listener => {
                    listeners.add(listener);
                    return { dispose: () => { listeners.delete(listener); } };
                }
            },
            setTimeout: clock.setTimeout,
            clearTimeout: clock.clearTimeout
        });
        const smokePlan = plan({ files: Object.freeze(['startup.R', 'forwarded.R']), actionTimeoutMs: 10_000 });
        actions.prepareSecondFile(smokePlan);
        const operation = actions.waitForSecondFile(smokePlan);
        const outcome = outcomeWithin(operation);

        await clock.advanceTo(6_000);
        for (const listener of [...listeners]) {
            listener({ source: 'singleInstance', relativePath: 'forwarded.R' });
        }

        assert.equal(await outcome, undefined);
        assert.equal(listeners.size, 0);
        assert.equal(clock.pending(), 0);
    });
});

test('smoke action executes extract-widget and proves the deferred proxy handler was replaced', async () => {
    const proxyHandler = { execute: () => undefined };
    const realHandler = { execute: () => undefined };
    const eligibleWidget = { id: 'scm-view', isExtractable: true, secondaryWindow: undefined as object | undefined };
    const executions: Array<{ id: string; widget: unknown }> = [];
    let handlers = [proxyHandler];
    const services = workspaceServices({
        ...({
            applicationShell: {
                widgets: [
                    { id: 'not-extractable', isExtractable: false },
                    eligibleWidget
                ]
            },
            commandRegistry: {
                getCommand: (id: string) => id === 'extract-widget' ? { id } : undefined,
                getAllHandlers: () => handlers,
                executeCommand: async (id: string, widget: unknown) => {
                    executions.push({ id, widget });
                    handlers = [realHandler];
                    eligibleWidget.secondaryWindow = {};
                }
            }
        } as unknown as Partial<RidePackagedSmokeActionServices>)
    });

    await new RidePackagedSmokeActionService(services).secondaryWindow(plan());

    assert.deepEqual(executions, [{ id: 'extract-widget', widget: eligibleWidget }]);
    assert.deepEqual(handlers, [realHandler]);
});

test('smoke action waits after handler replacement for a delayed secondary window', async () => {
    const proxyHandler = { execute: () => undefined };
    const realHandler = { execute: () => undefined };
    const eligibleWidget = { id: 'scm-view', isExtractable: true, secondaryWindow: undefined as object | undefined };
    const timers: Array<{ callback: () => void; timeoutMs: number; cleared: boolean }> = [];
    let handlers = [proxyHandler];
    let executions = 0;
    const actions = new RidePackagedSmokeActionService(workspaceServices({
        ...({
            applicationShell: { widgets: [eligibleWidget] },
            commandRegistry: {
                getCommand: (id: string) => id === 'extract-widget' ? { id } : undefined,
                getAllHandlers: () => handlers,
                executeCommand: async () => {
                    executions++;
                    handlers = [realHandler];
                }
            }
        } as unknown as Partial<RidePackagedSmokeActionServices>),
        pollIntervalMs: 10,
        setTimeout: (callback, timeoutMs) => {
            const timer = { callback, timeoutMs, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearTimeout: handle => {
            (handle as { cleared: boolean }).cleared = true;
        }
    }));
    const operation = actions.secondaryWindow(plan({ actionTimeoutMs: 1_000 }));
    const outcome = outcomeWithin(operation);

    await turn();
    await turn();
    assert.equal(executions, 1);
    assert.deepEqual(handlers, [realHandler]);
    assert.deepEqual(timers.map(timer => timer.timeoutMs), [1_000, 10]);

    eligibleWidget.secondaryWindow = {};
    timers[1].callback();

    assert.equal(await outcome, undefined);
    assert.equal(timers.every(timer => timer.cleared), true);
});

test('smoke action secondary-window timeout cancels polling without late side effects or timer leaks', async () => {
    const proxyHandler = { execute: () => undefined };
    const realHandler = { execute: () => undefined };
    const eligibleWidget = { id: 'scm-view', isExtractable: true, secondaryWindow: undefined as object | undefined };
    const timers: Array<{ callback: () => void; timeoutMs: number; cleared: boolean }> = [];
    let handlers = [proxyHandler];
    let executions = 0;
    const actions = new RidePackagedSmokeActionService(workspaceServices({
        ...({
            applicationShell: { widgets: [eligibleWidget] },
            commandRegistry: {
                getCommand: (id: string) => id === 'extract-widget' ? { id } : undefined,
                getAllHandlers: () => handlers,
                executeCommand: async () => {
                    executions++;
                    handlers = [realHandler];
                }
            }
        } as unknown as Partial<RidePackagedSmokeActionServices>),
        pollIntervalMs: 5,
        pollTimeoutMs: 20,
        setTimeout: (callback, timeoutMs) => {
            const timer = { callback, timeoutMs, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearTimeout: handle => {
            (handle as { cleared: boolean }).cleared = true;
        }
    }));
    const operation = actions.secondaryWindow(plan({ actionTimeoutMs: 20 }));

    await turn();
    await turn();
    assert.deepEqual(timers.map(timer => timer.timeoutMs), [20, 5]);
    timers[0].callback();
    await assert.rejects(operation, /Smoke action timed out\./);
    assert.equal(timers.every(timer => timer.cleared), true);

    eligibleWidget.secondaryWindow = {};
    timers[1].callback();
    await turn();
    assert.equal(executions, 1);
    assert.equal(timers.length, 2);
});

test('smoke action secondary-window dispose cancels polling without late side effects or timer leaks', async () => {
    const proxyHandler = { execute: () => undefined };
    const realHandler = { execute: () => undefined };
    const eligibleWidget = { id: 'scm-view', isExtractable: true, secondaryWindow: undefined as object | undefined };
    const timers: Array<{ callback: () => void; timeoutMs: number; cleared: boolean }> = [];
    let handlers = [proxyHandler];
    let executions = 0;
    const actions = new RidePackagedSmokeActionService(workspaceServices({
        ...({
            applicationShell: { widgets: [eligibleWidget] },
            commandRegistry: {
                getCommand: (id: string) => id === 'extract-widget' ? { id } : undefined,
                getAllHandlers: () => handlers,
                executeCommand: async () => {
                    executions++;
                    handlers = [realHandler];
                }
            }
        } as unknown as Partial<RidePackagedSmokeActionServices>),
        pollIntervalMs: 5,
        setTimeout: (callback, timeoutMs) => {
            const timer = { callback, timeoutMs, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearTimeout: handle => {
            (handle as { cleared: boolean }).cleared = true;
        }
    }));
    const operation = actions.secondaryWindow(plan());

    await turn();
    await turn();
    assert.equal(timers.length, 2);
    actions.dispose();
    await assert.rejects(operation, /Smoke action disposed\./);
    assert.equal(timers.every(timer => timer.cleared), true);

    eligibleWidget.secondaryWindow = {};
    timers[1].callback();
    await turn();
    assert.equal(executions, 1);
    assert.equal(timers.length, 2);
});

test('smoke action accepts only the planned second file from a single-instance open event', async () => {
    let listener: ((event: { source: string; relativePath: string }) => void) | undefined;
    let subscriptionDisposals = 0;
    const services = workspaceServices({
        ...({
            openRequests: {
                onDidOpenRequest: (candidate: (event: { source: string; relativePath: string }) => void) => {
                    listener = candidate;
                    return { dispose: () => subscriptionDisposals++ };
                }
            }
        } as unknown as Partial<RidePackagedSmokeActionServices>)
    });
    const smokePlan = plan({ files: Object.freeze(['startup.R', 'forwarded.R']) });
    const actions = new RidePackagedSmokeActionService(services);
    const preparation = actions.prepareSecondFile(smokePlan);
    const operation = actions.waitForSecondFile(smokePlan);
    const outcome = outcomeWithin(operation);

    await turn();
    assert.ok(listener, 'the forwarding observer must be installed while the action is active');
    listener({ source: 'initial', relativePath: 'forwarded.R' });
    listener({ source: 'singleInstance', relativePath: 'other.R' });
    await turn();
    assert.equal(subscriptionDisposals, 0);
    listener({ source: 'singleInstance', relativePath: 'forwarded.R' });

    assert.equal(await outcome, undefined);
    assert.equal(subscriptionDisposals, 1);
    preparation.dispose();
});

test('smoke action Task 5 methods fail safely when their production services are unavailable', async () => {
    const actions = new RidePackagedSmokeActionService(workspaceServices());
    await assert.rejects(actions.packagedPluginCommand(plan()), /Smoke action unavailable\./);
    await assert.rejects(actions.secondaryWindow(plan()), /Smoke action unavailable\./);
    await assert.rejects(actions.waitForSecondFile(plan({ files: Object.freeze(['startup.R', 'forwarded.R']) })), /Smoke action unavailable\./);
});

test('smoke action production shutdown is a no-op before the default actions service resolves', () => {
    const container = new Container();
    const identifiers = {
        applicationState: Symbol('applicationState'),
        contribution: Symbol('contribution'),
        workspaceService: Symbol('workspaceService'),
        editorManager: Symbol('editorManager'),
        fileService: Symbol('fileService'),
        terminalService: Symbol('terminalService'),
        searchService: Symbol('searchService'),
        scmService: Symbol('scmService'),
        hostedPlugins: Symbol('hostedPlugins'),
        commandRegistry: Symbol('commandRegistry'),
        applicationShell: Symbol('applicationShell'),
        openRequests: Symbol('openRequests')
    };
    let resolutions = 0;
    for (const identifier of [
        identifiers.workspaceService,
        identifiers.editorManager,
        identifiers.fileService,
        identifiers.terminalService,
        identifiers.searchService,
        identifiers.scmService,
        identifiers.hostedPlugins,
        identifiers.commandRegistry,
        identifiers.applicationShell,
        identifiers.openRequests
    ]) {
        container.bind(identifier).toDynamicValue(() => {
            resolutions++;
            return {};
        });
    }
    container.bind(identifiers.applicationState).toConstantValue({ reachedState: async () => undefined });
    container.load(new ContainerModule(bind => bindRidePackagedSmokeContribution(bind, identifiers)));

    const contributions = container.getAll<{ onStop?(): void }>(identifiers.contribution);
    const shutdown = contributions.find(candidate => !(candidate instanceof RidePackagedSmokeContribution));
    shutdown?.onStop?.();

    assert.equal(contributions.length, 2);
    assert.equal(resolutions, 0);
});

test('smoke action production binding lazily resolves every explicit adapter once as a singleton', async () => {
    const container = new Container();
    const identifiers = {
        applicationState: Symbol('applicationState'),
        contribution: Symbol('contribution'),
        workspaceService: Symbol('workspaceService'),
        editorManager: Symbol('editorManager'),
        fileService: Symbol('fileService'),
        terminalService: Symbol('terminalService'),
        searchService: Symbol('searchService'),
        scmService: Symbol('scmService'),
        hostedPlugins: Symbol('hostedPlugins'),
        commandRegistry: Symbol('commandRegistry'),
        applicationShell: Symbol('applicationShell'),
        openRequests: Symbol('openRequests')
    };
    const resolutions = new Map<symbol, number>();
    const services = new Map<symbol, unknown>([
        [identifiers.workspaceService, { roots: Promise.resolve([{ resource: ROOT }]) }],
        [identifiers.editorManager, { activeEditor: undefined }],
        [identifiers.fileService, { read: async () => ({ value: '' }), exists: async () => false }],
        [identifiers.terminalService, { newTerminal: async () => assert.fail('not executed') }],
        [identifiers.searchService, { searchWithCallback: async () => 1, cancel: () => undefined }],
        [identifiers.scmService, { repositories: [] }],
        [identifiers.hostedPlugins, { didStart: Promise.resolve() }],
        [identifiers.commandRegistry, {
            getCommand: () => undefined,
            getAllHandlers: () => [],
            executeCommand: async () => undefined
        }],
        [identifiers.applicationShell, { widgets: [] }],
        [identifiers.openRequests, { onDidOpenRequest: () => ({ dispose: () => undefined }) }]
    ]);
    for (const [identifier, service] of services) {
        container.bind(identifier).toDynamicValue(() => {
            resolutions.set(identifier, (resolutions.get(identifier) ?? 0) + 1);
            return service;
        }).inSingletonScope();
    }
    container.bind(identifiers.applicationState).toConstantValue({ reachedState: async () => undefined });
    container.load(new ContainerModule(bind => bindRidePackagedSmokeContribution(bind, identifiers)));
    assert.equal(resolutions.size, 0);

    const first = container.get<RidePackagedSmokeActions>(RidePackagedSmokeActions);
    const second = container.get<RidePackagedSmokeActions>(RidePackagedSmokeActions);
    const contributions = container.getAll<{ onStop?(): void }>(identifiers.contribution);
    const shutdown = contributions.find(candidate => !(candidate instanceof RidePackagedSmokeContribution));
    let disposals = 0;
    const originalDispose = (first as RidePackagedSmokeActionService).dispose.bind(first);
    (first as RidePackagedSmokeActionService).dispose = () => {
        disposals++;
        originalDispose();
    };
    shutdown?.onStop?.();
    shutdown?.onStop?.();

    assert.strictEqual(first, second);
    assert.equal(first instanceof RidePackagedSmokeActionService, true);
    assert.deepEqual([...resolutions.values()], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    assert.equal(contributions.length, 2);
    assert.equal(disposals, 1);
    await assert.rejects(first.editorSave(plan()), /Smoke action disposed\./);
});
