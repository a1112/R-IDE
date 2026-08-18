/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { Container, ContainerModule } from '@theia/core/shared/inversify';
import {
    bindRidePackagedSmokeContribution,
    RidePackagedSmokeActionShutdownContribution,
    RidePackagedSmokeBindingIdentifiers
} from '../src/browser/ride-packaged-smoke-bindings';
import {
    RidePackagedSmokeActions,
    RidePackagedSmokeContribution,
    RidePackagedSmokeProtocol
} from '../src/browser/ride-packaged-smoke';

test('packaged smoke binding exposes one singleton frontend contribution with lazy actions', async () => {
    const container = new Container();
    const protocolIdentifier = Symbol('RidePackagedSmokeProtocol');
    const actionIdentifier = Symbol('RidePackagedSmokeActions');
    const identifiers: RidePackagedSmokeBindingIdentifiers = {
        applicationState: FrontendApplicationStateService,
        contribution: FrontendApplicationContribution,
        protocol: protocolIdentifier,
        actions: actionIdentifier
    };
    const protocol: RidePackagedSmokeProtocol = {
        isTauri: () => true,
        plan: async () => ({ mode: 'disabled', plan: null, sessionProof: null, diagnostic: null }),
        recordStep: async () => assert.fail('disabled smoke must not record'),
        complete: async () => assert.fail('disabled smoke must not complete')
    };
    let actionResolutions = 0;
    container.bind(FrontendApplicationStateService).toConstantValue({
        reachedState: async () => undefined
    } as unknown as FrontendApplicationStateService);
    container.bind(protocolIdentifier).toConstantValue(protocol);
    container.bind(actionIdentifier).toDynamicValue(() => {
        actionResolutions++;
        return {} as RidePackagedSmokeActions;
    });
    container.load(new ContainerModule(bind => bindRidePackagedSmokeContribution(bind, identifiers)));

    const direct = container.get<RidePackagedSmokeContribution>(RidePackagedSmokeContribution);
    const contributions = container.getAll<FrontendApplicationContribution>(FrontendApplicationContribution);
    assert.equal(contributions.length, 2);
    assert.equal(contributions.includes(direct), true);
    const shutdown = contributions.find(contribution => contribution !== direct) as { onStop?(): void } | undefined;
    assert.strictEqual(container.get(RidePackagedSmokeContribution), direct);
    assert.equal(actionResolutions, 0);
    shutdown?.onStop?.();
    assert.equal(actionResolutions, 0, 'shutdown hook must not resolve actions');

    direct.onStart();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(actionResolutions, 0, 'disabled protocol must retain lazy action resolution');
});

test('packaged smoke binding is installed by the product frontend module', async () => {
    const moduleSource = await readFile(
        resolve(process.cwd(), 'src/browser/theia-ide-frontend-module.ts'),
        'utf8'
    );
    assert.match(moduleSource, /bindRidePackagedSmokeContribution\(bind,/);
    assert.match(moduleSource, /applicationState:\s*FrontendApplicationStateService/);
    assert.match(moduleSource, /contribution:\s*FrontendApplicationContribution/);
});

test('packaged smoke shutdown keeps late default action resolution lightweight and disposed', async () => {
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
    for (const identifier of [
        identifiers.workspaceService,
        identifiers.editorManager,
        identifiers.fileService,
        identifiers.terminalService,
        identifiers.searchService,
        identifiers.scmService
    ]) {
        resolutions.set(identifier, 0);
        container.bind(identifier).toDynamicValue(() => {
            resolutions.set(identifier, (resolutions.get(identifier) ?? 0) + 1);
            return {};
        });
    }
    container.load(new ContainerModule(bind => bindRidePackagedSmokeContribution(bind, identifiers)));

    container.get<RidePackagedSmokeActionShutdownContribution>(
        RidePackagedSmokeActionShutdownContribution
    ).onStop();
    const first = container.get<RidePackagedSmokeActions>(RidePackagedSmokeActions);
    const second = container.get<RidePackagedSmokeActions>(RidePackagedSmokeActions);

    assert.strictEqual(first, second);
    assert.deepEqual([...resolutions.values()], [0, 0, 0, 0, 0, 0]);
    await assert.rejects(first.editorSave({} as never), /Smoke action disposed\./);
});
