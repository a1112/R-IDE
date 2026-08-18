/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { ApplicationShell } from '@theia/core/lib/browser';
import type { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import type { OpenerService } from '@theia/core/lib/browser/opener-service';
import type { MessageService } from '@theia/core/lib/common/message-service';
import { interfaces } from '@theia/core/shared/inversify';
import type { HostedPluginSupport } from '@theia/plugin-ext/lib/hosted/browser/hosted-plugin';
import { PluginServer } from '@theia/plugin-ext/lib/common/plugin-protocol';
import type { WorkspaceService } from '@theia/workspace/lib/browser';
import { RideNativeChrome } from './ride-native-chrome';
import {
    DEFAULT_RIDE_DEFERRED_WORK_SCHEDULER,
    RideDeferredWorkScheduler,
    RideOpenRequestContribution,
    RidePluginDeploymentScheduler
} from './ride-open-request';

export interface RideOpenRequestBindingIdentifiers {
    readonly applicationShell: interfaces.ServiceIdentifier<ApplicationShell>;
    readonly applicationState: interfaces.ServiceIdentifier<FrontendApplicationStateService>;
    readonly contribution: interfaces.ServiceIdentifier<FrontendApplicationContribution>;
    readonly hostedPlugins: interfaces.ServiceIdentifier<HostedPluginSupport>;
    readonly messageService: interfaces.ServiceIdentifier<MessageService>;
    readonly openerService: interfaces.ServiceIdentifier<OpenerService>;
    readonly workspaceService: interfaces.ServiceIdentifier<WorkspaceService>;
    readonly deferredWorkScheduler?: interfaces.ServiceIdentifier<RideDeferredWorkScheduler>;
}

interface DeferredContainerResolution<T> {
    readonly promise: Promise<T>;
    readonly start: () => void;
}

function prepareContainerResolution<T>(
    container: interfaces.Container,
    identifier: interfaces.ServiceIdentifier<T>
): DeferredContainerResolution<T> {
    let resolvePromise!: (value: T | PromiseLike<T>) => void;
    let rejectPromise!: (reason?: unknown) => void;
    let started = false;
    const promise = new Promise<T>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return {
        promise,
        start: () => {
            if (started) {
                return;
            }
            started = true;
            // The promise is observed by the contribution before this runs.
            // Waiting for attached_shell keeps this shared-container getAsync
            // out of every synchronous Theia contribution registry.
            queueMicrotask(() => {
                try {
                    Promise.resolve(container.getAsync(identifier)).then(resolvePromise, rejectPromise);
                } catch (error) {
                    rejectPromise(error);
                }
            });
        }
    };
}

export function bindRideOpenRequestContribution(
    bind: interfaces.Bind,
    identifiers: RideOpenRequestBindingIdentifiers
): void {
    bind(RideNativeChrome).toDynamicValue(() => new RideNativeChrome()).inSingletonScope();
    bind(RideOpenRequestContribution).toDynamicValue(context => {
        const hostedPlugins = prepareContainerResolution(context.container, identifiers.hostedPlugins);
        const pluginServer = prepareContainerResolution<PluginServer>(context.container, PluginServer);
        const nativeChrome = context.container.get(RideNativeChrome);
        const deferredWorkScheduler = identifiers.deferredWorkScheduler
            && context.container.isBound(identifiers.deferredWorkScheduler)
            ? context.container.get(identifiers.deferredWorkScheduler)
            : DEFAULT_RIDE_DEFERRED_WORK_SCHEDULER;
        const pluginDeployment = new RidePluginDeploymentScheduler(
            pluginServer.promise,
            () => nativeChrome.getPluginDirectories(),
            pluginServer.start
        );
        return new RideOpenRequestContribution(
            context.container.get(identifiers.workspaceService),
            context.container.get(identifiers.openerService),
            context.container.get(identifiers.messageService),
            context.container.get(identifiers.applicationShell),
            nativeChrome,
            context.container.get(identifiers.applicationState),
            hostedPlugins.promise,
            undefined,
            undefined,
            hostedPlugins.start,
            pluginDeployment,
            deferredWorkScheduler
        );
    }).inSingletonScope();
    bind(identifiers.contribution).toService(RideOpenRequestContribution);
}
