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
import type { WorkspaceService } from '@theia/workspace/lib/browser';
import { RideNativeChrome } from './ride-native-chrome';
import { RideOpenRequestContribution } from './ride-open-request';

export interface RideOpenRequestBindingIdentifiers {
    readonly applicationShell: interfaces.ServiceIdentifier<ApplicationShell>;
    readonly applicationState: interfaces.ServiceIdentifier<FrontendApplicationStateService>;
    readonly contribution: interfaces.ServiceIdentifier<FrontendApplicationContribution>;
    readonly hostedPlugins: interfaces.ServiceIdentifier<HostedPluginSupport>;
    readonly messageService: interfaces.ServiceIdentifier<MessageService>;
    readonly openerService: interfaces.ServiceIdentifier<OpenerService>;
    readonly workspaceService: interfaces.ServiceIdentifier<WorkspaceService>;
}

function resolveAfterSynchronousContribution<T>(
    container: interfaces.Container,
    identifier: interfaces.ServiceIdentifier<T>
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        // Starting getAsync while Inversify is still building the synchronous
        // contribution makes that entire contribution resolution asynchronous.
        // Defer it until the current resolution stack has unwound instead.
        queueMicrotask(() => {
            try {
                Promise.resolve(container.getAsync(identifier)).then(resolve, reject);
            } catch (error) {
                reject(error);
            }
        });
    });
}

export function bindRideOpenRequestContribution(
    bind: interfaces.Bind,
    identifiers: RideOpenRequestBindingIdentifiers
): void {
    bind(RideNativeChrome).toDynamicValue(() => new RideNativeChrome()).inSingletonScope();
    bind(RideOpenRequestContribution).toDynamicValue(context => new RideOpenRequestContribution(
        context.container.get(identifiers.workspaceService),
        context.container.get(identifiers.openerService),
        context.container.get(identifiers.messageService),
        context.container.get(identifiers.applicationShell),
        context.container.get(RideNativeChrome),
        context.container.get(identifiers.applicationState),
        resolveAfterSynchronousContribution(context.container, identifiers.hostedPlugins)
    )).inSingletonScope();
    bind(identifiers.contribution).toService(RideOpenRequestContribution);
}
