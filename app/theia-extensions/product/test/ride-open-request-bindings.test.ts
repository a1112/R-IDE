/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Container, ContainerModule } from '@theia/core/shared/inversify';
import type { ApplicationShell } from '@theia/core/lib/browser';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import type { OpenerService } from '@theia/core/lib/browser/opener-service';
import { StatusBar, type StatusBar as StatusBarService } from '@theia/core/lib/browser/status-bar/status-bar-types';
import type { MessageService } from '@theia/core/lib/common/message-service';
import type { HostedPluginSupport } from '@theia/plugin-ext/lib/hosted/browser/hosted-plugin';
import { PluginServer } from '@theia/plugin-ext/lib/common/plugin-protocol';
import type { WorkspaceService } from '@theia/workspace/lib/browser';
import {
    bindRideOpenRequestContribution,
    RideOpenRequestBindingIdentifiers
} from '../src/browser/ride-open-request-bindings';
import { RideDeferredWorkScheduler, RideOpenRequestContribution } from '../src/browser/ride-open-request';
import { RideNativeChrome } from '../src/browser/ride-native-chrome';
import {
    bindRidePerformanceContribution,
    RidePerformanceContribution
} from '../src/browser/ride-performance-contribution';

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
            workspaceService: Symbol('WorkspaceService'),
            deferredWorkScheduler: Symbol('RideDeferredWorkScheduler')
        };
        const deferredWorkScheduler: RideDeferredWorkScheduler = {
            yield: async () => undefined,
            setTimeout: () => ({ kind: 'test-timer' }),
            clearTimeout: () => undefined
        };
        container.bind(identifiers.deferredWorkScheduler!).toConstantValue(deferredWorkScheduler);
        const bindSynchronousDependencies = (
            target: Container,
            applicationState: FrontendApplicationStateService
        ): void => {
            target.bind(identifiers.workspaceService).toConstantValue({ ready: Promise.resolve() } as WorkspaceService);
            target.bind(identifiers.openerService).toConstantValue({} as OpenerService);
            target.bind(identifiers.messageService).toConstantValue({} as MessageService);
            target.bind(identifiers.applicationShell).toConstantValue({} as ApplicationShell);
            target.bind(identifiers.applicationState).toConstantValue(applicationState);
        };
        let attachShell!: () => void;
        const attachedShell = new Promise<void>(resolve => {
            attachShell = resolve;
        });
        bindSynchronousDependencies(container, {
            reachedState: () => attachedShell
        } as unknown as FrontendApplicationStateService);

        let resolveHostedPlugins!: (value: HostedPluginSupport) => void;
        const hostedPlugins = new Promise<HostedPluginSupport>(resolve => {
            resolveHostedPlugins = resolve;
        });
        let hostedResolutionStarts = 0;
        let pluginServerResolutionStarts = 0;
        container.bind(identifiers.hostedPlugins).toDynamicValue(() => {
            hostedResolutionStarts++;
            return hostedPlugins;
        });
        container.bind(PluginServer).toDynamicValue(() => {
            pluginServerResolutionStarts++;
            return { install: async () => undefined } as unknown as PluginServer;
        });
        container.load(new ContainerModule(bind => bindRideOpenRequestContribution(bind, identifiers)));

        let contributions: FrontendApplicationContribution[] = [];
        assert.doesNotThrow(() => {
            contributions = container.getAll(identifiers.contribution);
        });
        assert.equal(contributions.length, 1);
        assert.ok(contributions[0] instanceof RideOpenRequestContribution);
        assert.strictEqual(
            (contributions[0] as unknown as { deferredWorkScheduler: RideDeferredWorkScheduler }).deferredWorkScheduler,
            deferredWorkScheduler,
            'the binding must inject the configured scheduler'
        );
        assert.equal(
            hostedResolutionStarts,
            0,
            'the synchronous contribution factory must not start asynchronous container resolution'
        );
        assert.equal(pluginServerResolutionStarts, 0);

        await new Promise<void>(resolve => queueMicrotask(resolve));
        await new Promise<void>(resolve => queueMicrotask(resolve));
        assert.equal(
            hostedResolutionStarts,
            0,
            'microtasks between Theia startup phases must not start shared-container async resolution'
        );
        assert.equal(pluginServerResolutionStarts, 0);

        (contributions[0] as RideOpenRequestContribution).onStart();
        (contributions[0] as RideOpenRequestContribution).onStart();
        await new Promise<void>(resolve => queueMicrotask(resolve));
        assert.equal(hostedResolutionStarts, 0, 'plugin resolution must wait for the attached shell');
        assert.equal(pluginServerResolutionStarts, 0, 'plugin server resolution must wait for the attached shell');
        attachShell();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(hostedResolutionStarts, 0, 'attached_shell alone must not resolve hosted plugins');
        assert.equal(
            pluginServerResolutionStarts,
            0,
            'plugin server resolution must wait for target, demand, or the no-file timer'
        );
        await (contributions[0] as RideOpenRequestContribution).requestPluginDeployment();
        assert.equal(hostedResolutionStarts, 1, 'plugin demand must resolve hosted plugins immediately');
        assert.equal(pluginServerResolutionStarts, 1);

        resolveHostedPlugins({
            willStart: Promise.resolve(),
            didStart: Promise.resolve()
        } as HostedPluginSupport);
        await hostedPlugins;
        (contributions[0] as RideOpenRequestContribution).dispose();

        for (const [expectedFailure, getAsyncFailure] of [
            ['synchronous getAsync failure', () => { throw new Error('synchronous getAsync failure'); }],
            ['asynchronous getAsync failure', () => Promise.reject(new Error('asynchronous getAsync failure'))]
        ] as const) {
            const failingContainer = new Container();
            bindSynchronousDependencies(failingContainer, {
                reachedState: () => Promise.resolve()
            } as unknown as FrontendApplicationStateService);
            Object.defineProperty(failingContainer, 'getAsync', {
                configurable: true,
                value: getAsyncFailure
            });
            failingContainer.load(new ContainerModule(bind => bindRideOpenRequestContribution(bind, identifiers)));

            let failingContribution!: RideOpenRequestContribution;
            assert.doesNotThrow(() => {
                failingContribution = failingContainer.get(identifiers.contribution) as RideOpenRequestContribution;
            });
            failingContribution.onStart();
            await failingContribution.requestPluginDeployment();
            const observations = failingContribution as unknown as {
                pluginWillStart: Promise<{ succeeded: boolean; error?: unknown }>;
                pluginDidStart: Promise<{ succeeded: boolean; error?: unknown }>;
            };
            const results = await Promise.all([observations.pluginWillStart, observations.pluginDidStart]);
            assert.deepEqual(results.map(result => result.succeeded), [false, false]);
            for (const result of results) {
                assert.match(String(result.error), new RegExp(expectedFailure));
            }
            failingContribution.dispose();
        }

        const disposedContainer = new Container();
        let attachDisposedShell!: () => void;
        const disposedShell = new Promise<void>(resolve => {
            attachDisposedShell = resolve;
        });
        bindSynchronousDependencies(disposedContainer, {
            reachedState: () => disposedShell
        } as unknown as FrontendApplicationStateService);
        let disposedResolutionStarts = 0;
        disposedContainer.bind(identifiers.hostedPlugins).toDynamicValue(() => {
            disposedResolutionStarts++;
            return hostedPlugins;
        });
        disposedContainer.bind(PluginServer).toConstantValue(
            { install: async () => undefined } as unknown as PluginServer
        );
        disposedContainer.load(new ContainerModule(bind => bindRideOpenRequestContribution(bind, identifiers)));
        const disposedContribution = disposedContainer.get(identifiers.contribution) as RideOpenRequestContribution;
        disposedContribution.onStart();
        disposedContribution.dispose();
        attachDisposedShell();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(disposedResolutionStarts, 0);
    } finally {
        Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator });
    }
});

test('open-request and performance contributions share one native chrome binding', context => {
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { sessionStorage: new MemoryStorage() }
    });
    context.after(() => {
        Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
    });
    const container = new Container();
    const identifiers: RideOpenRequestBindingIdentifiers = {
        applicationShell: Symbol('ApplicationShell'),
        applicationState: Symbol('FrontendApplicationStateService'),
        contribution: FrontendApplicationContribution,
        hostedPlugins: Symbol('HostedPluginSupport'),
        messageService: Symbol('MessageService'),
        openerService: Symbol('OpenerService'),
        workspaceService: Symbol('WorkspaceService')
    };
    const applicationState = {
        reachedState: async () => undefined
    } as unknown as FrontendApplicationStateService;
    const statusBar = {
        setBackgroundColor: async () => undefined,
        setColor: async () => undefined,
        setElement: async () => undefined,
        removeElement: async () => undefined
    } as StatusBarService;

    container.bind(identifiers.workspaceService).toConstantValue({ ready: Promise.resolve() } as WorkspaceService);
    container.bind(identifiers.openerService).toConstantValue({} as OpenerService);
    container.bind(identifiers.messageService).toConstantValue({} as MessageService);
    container.bind(identifiers.applicationShell).toConstantValue({} as ApplicationShell);
    container.bind(identifiers.applicationState).toConstantValue(applicationState);
    container.bind(identifiers.hostedPlugins).toConstantValue({
        willStart: Promise.resolve(),
        didStart: Promise.resolve()
    } as HostedPluginSupport);
    container.bind(PluginServer).toConstantValue({ install: async () => undefined } as unknown as PluginServer);
    container.bind(StatusBar).toConstantValue(statusBar);
    container.bind(FrontendApplicationStateService).toConstantValue(applicationState);
    container.load(new ContainerModule(bind => {
        bindRidePerformanceContribution(bind);
        bindRideOpenRequestContribution(bind, identifiers);
    }));

    const nativeBindings = container.getAll(RideNativeChrome);
    assert.equal(nativeBindings.length, 1);
    const performanceContribution = container.get(RidePerformanceContribution);
    const openRequestContribution = container.get(RideOpenRequestContribution);
    assert.ok(performanceContribution instanceof RidePerformanceContribution);
    const defaultScheduler = (openRequestContribution as unknown as {
        deferredWorkScheduler: RideDeferredWorkScheduler;
    }).deferredWorkScheduler;
    assert.equal(typeof defaultScheduler.yield, 'function');
    assert.equal(typeof defaultScheduler.setTimeout, 'function');
    assert.equal(typeof defaultScheduler.clearTimeout, 'function');
    assert.strictEqual(
        (performanceContribution as unknown as { nativeChrome: RideNativeChrome }).nativeChrome,
        nativeBindings[0]
    );
    assert.strictEqual(
        (openRequestContribution as unknown as { nativeChrome: RideNativeChrome }).nativeChrome,
        nativeBindings[0]
    );
});
