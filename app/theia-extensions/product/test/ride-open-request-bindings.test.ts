/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Container, ContainerModule } from '@theia/core/shared/inversify';
import type { ApplicationShell } from '@theia/core/lib/browser';
import type { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import type { OpenerService } from '@theia/core/lib/browser/opener-service';
import type { MessageService } from '@theia/core/lib/common/message-service';
import type { HostedPluginSupport } from '@theia/plugin-ext/lib/hosted/browser/hosted-plugin';
import type { WorkspaceService } from '@theia/workspace/lib/browser';
import {
    bindRideOpenRequestContribution,
    RideOpenRequestBindingIdentifiers
} from '../src/browser/ride-open-request-bindings';
import { RideOpenRequestContribution } from '../src/browser/ride-open-request';

class MemoryStorage implements Storage {
    protected readonly values = new Map<string, string>();
    get length(): number { return this.values.size; }
    clear(): void { this.values.clear(); }
    getItem(key: string): string | null { return this.values.get(key) ?? null; }
    key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
    removeItem(key: string): void { this.values.delete(key); }
    setItem(key: string, value: string): void { this.values.set(key, value); }
}

test('frontend contribution remains synchronously constructible with async hosted plugin support', async () => {
    const previousWindow = globalThis.window;
    const previousNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { sessionStorage: new MemoryStorage() }
    });
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { platform: 'Win32' }
    });

    try {
        const container = new Container();
        const identifiers: RideOpenRequestBindingIdentifiers = {
            applicationShell: Symbol('ApplicationShell'),
            applicationState: Symbol('FrontendApplicationStateService'),
            contribution: Symbol('FrontendApplicationContribution'),
            hostedPlugins: Symbol('HostedPluginSupport'),
            messageService: Symbol('MessageService'),
            openerService: Symbol('OpenerService'),
            workspaceService: Symbol('WorkspaceService')
        };
        container.bind(identifiers.workspaceService).toConstantValue({ ready: Promise.resolve() } as WorkspaceService);
        container.bind(identifiers.openerService).toConstantValue({} as OpenerService);
        container.bind(identifiers.messageService).toConstantValue({} as MessageService);
        container.bind(identifiers.applicationShell).toConstantValue({} as ApplicationShell);
        container.bind(identifiers.applicationState).toConstantValue({} as FrontendApplicationStateService);

        let resolveHostedPlugins!: (value: HostedPluginSupport) => void;
        const hostedPlugins = new Promise<HostedPluginSupport>(resolve => {
            resolveHostedPlugins = resolve;
        });
        container.bind(identifiers.hostedPlugins).toDynamicValue(() => hostedPlugins);
        container.load(new ContainerModule(bind => bindRideOpenRequestContribution(bind, identifiers)));

        let contributions: FrontendApplicationContribution[] = [];
        assert.doesNotThrow(() => {
            contributions = container.getAll(identifiers.contribution);
        });
        assert.equal(contributions.length, 1);
        assert.ok(contributions[0] instanceof RideOpenRequestContribution);

        resolveHostedPlugins({
            willStart: Promise.resolve(),
            didStart: Promise.resolve()
        } as HostedPluginSupport);
        await hostedPlugins;
    } finally {
        Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator });
    }
});
