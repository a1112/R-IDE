/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import URI from '@theia/core/lib/common/uri';
import { Container, ContainerModule } from '@theia/core/shared/inversify';
import { RidePackagedSmokeActions } from '../src/browser/ride-packaged-smoke';
import type { RideSmokeAction, RideSmokePlan } from '../src/browser/ride-packaged-smoke';
import { bindRidePackagedSmokeContribution } from '../src/browser/ride-packaged-smoke-bindings';
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

function editorServices(options: { activeUri?: URI; persist?: boolean; persistedInitial?: string } = {}): {
    services: RidePackagedSmokeActionServices;
    getBuffer: () => string;
    getPersisted: () => string;
    replaceCalls: unknown[];
    saveCalls: number;
} {
    let buffer = 'x <- 1\n';
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
            buffer += request.replaceOperations[0].text;
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
    await new RidePackagedSmokeActionService(fixture.services).terminalSentinel(plan({ workspace: 'secret/path' }));

    assert.equal(fixture.starts, 1);
    assert.deepEqual(fixture.commands, [RIDE_SMOKE_WINDOWS_COMMAND]);
    assert.equal(fixture.commands[0].includes('secret/path'), false);
    assert.equal(fixture.commands[0].includes('startup.R'), false);
    assert.equal((fixture.options[0] as { cwd: URI }).cwd.isEqual(ROOT), true);
    assert.equal(fixture.disposals, 1);
});

test('smoke action terminal-sentinel selects the fixed Unix command', async () => {
    const fixture = terminalFixture(false);
    await new RidePackagedSmokeActionService(fixture.services).terminalSentinel(plan());
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

test('smoke action scm-status rejects wrong repositories, resources, and missing refresh', async t => {
    await t.test('wrong repository', async () => {
        await assert.rejects(
            new RidePackagedSmokeActionService(scmServices(new URI('file:///C:/other'), EXPECTED)).scmStatus(plan()),
            /Smoke action unavailable\./
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
            new RidePackagedSmokeActionService(workspaceServices({ scmService: { repositories: [] } })).scmStatus(plan()),
            /Smoke action unavailable\./
        );
    });
});

test('smoke action service dispose prevents new side effects', async () => {
    const fixture = editorServices();
    const actions = new RidePackagedSmokeActionService(fixture.services);
    actions.dispose();

    await assert.rejects(actions.editorSave(plan()), /Smoke action disposed\./);
    assert.equal(fixture.replaceCalls.length, 0);
    assert.equal(fixture.saveCalls, 0);
});

test('smoke action Task 5 methods fail explicitly without resolving unrelated services', async () => {
    const actions = new RidePackagedSmokeActionService(workspaceServices());
    await assert.rejects(actions.packagedPluginCommand(plan()), /Smoke action not ready\./);
    await assert.rejects(actions.secondaryWindow(plan()), /Smoke action not ready\./);
    await assert.rejects(actions.waitForSecondFile(plan()), /Smoke action not ready\./);
});

test('smoke action production binding lazily resolves every explicit adapter once as a singleton', () => {
    const container = new Container();
    const identifiers = {
        applicationState: Symbol('applicationState'),
        contribution: Symbol('contribution'),
        workspaceService: Symbol('workspaceService'),
        editorManager: Symbol('editorManager'),
        fileService: Symbol('fileService'),
        terminalService: Symbol('terminalService'),
        searchService: Symbol('searchService'),
        scmService: Symbol('scmService')
    };
    const resolutions = new Map<symbol, number>();
    const services = new Map<symbol, unknown>([
        [identifiers.workspaceService, { roots: Promise.resolve([{ resource: ROOT }]) }],
        [identifiers.editorManager, { activeEditor: undefined }],
        [identifiers.fileService, { read: async () => ({ value: '' }), exists: async () => false }],
        [identifiers.terminalService, { newTerminal: async () => assert.fail('not executed') }],
        [identifiers.searchService, { searchWithCallback: async () => 1, cancel: () => undefined }],
        [identifiers.scmService, { repositories: [] }]
    ]);
    for (const [identifier, service] of services) {
        container.bind(identifier).toDynamicValue(() => {
            resolutions.set(identifier, (resolutions.get(identifier) ?? 0) + 1);
            return service;
        }).inSingletonScope();
    }
    container.load(new ContainerModule(bind => bindRidePackagedSmokeContribution(bind, identifiers)));
    assert.equal(resolutions.size, 0);

    const first = container.get<RidePackagedSmokeActions>(RidePackagedSmokeActions);
    const second = container.get<RidePackagedSmokeActions>(RidePackagedSmokeActions);

    assert.strictEqual(first, second);
    assert.equal(first instanceof RidePackagedSmokeActionService, true);
    assert.deepEqual([...resolutions.values()], [1, 1, 1, 1, 1, 1]);
});
