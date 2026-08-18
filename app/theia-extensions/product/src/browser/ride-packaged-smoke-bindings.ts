/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import type { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import type { CommandRegistry } from '@theia/core/lib/common/command';
import { OS } from '@theia/core/lib/common/os';
import { interfaces } from '@theia/core/shared/inversify';
import type { EditorManager } from '@theia/editor/lib/browser';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { ScmService } from '@theia/scm/lib/browser/scm-service';
import type { SearchInWorkspaceService } from '@theia/search-in-workspace/lib/browser/search-in-workspace-service';
import type { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import type { HostedPluginSupport } from '@theia/plugin-ext/lib/hosted/browser/hosted-plugin';
import type { WorkspaceService } from '@theia/workspace/lib/browser';
import {
    RidePackagedSmokeActions,
    RidePackagedSmokeContribution,
    RidePackagedSmokeProtocol,
    RideTauriPackagedSmokeProtocol
} from './ride-packaged-smoke';
import { RidePackagedSmokeActionService } from './ride-packaged-smoke-actions';
import { RideOpenRequestContribution } from './ride-open-request';

declare const require: (moduleName: string) => Record<string, interfaces.ServiceIdentifier<unknown>>;

export class RidePackagedSmokeActionShutdownContribution implements FrontendApplicationContribution {
    protected stopped = false;

    constructor(protected readonly shutdown: () => void) { }

    onStop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.shutdown();
    }
}

export interface RidePackagedSmokeBindingIdentifiers {
    readonly applicationState: interfaces.ServiceIdentifier<FrontendApplicationStateService>;
    readonly contribution: interfaces.ServiceIdentifier<FrontendApplicationContribution>;
    readonly actions?: interfaces.ServiceIdentifier<RidePackagedSmokeActions>;
    readonly protocol?: interfaces.ServiceIdentifier<RidePackagedSmokeProtocol>;
    readonly workspaceService?: interfaces.ServiceIdentifier<WorkspaceService>;
    readonly editorManager?: interfaces.ServiceIdentifier<EditorManager>;
    readonly fileService?: interfaces.ServiceIdentifier<FileService>;
    readonly terminalService?: interfaces.ServiceIdentifier<TerminalService>;
    readonly searchService?: interfaces.ServiceIdentifier<SearchInWorkspaceService>;
    readonly scmService?: interfaces.ServiceIdentifier<ScmService>;
    readonly hostedPlugins?: interfaces.ServiceIdentifier<HostedPluginSupport>;
    readonly commandRegistry?: interfaces.ServiceIdentifier<CommandRegistry>;
    readonly applicationShell?: interfaces.ServiceIdentifier<ApplicationShell>;
    readonly openRequests?: interfaces.ServiceIdentifier<RideOpenRequestContribution>;
}

export function bindRidePackagedSmokeContribution(
    bind: interfaces.Bind,
    identifiers: RidePackagedSmokeBindingIdentifiers
): void {
    let resolvedActions: RidePackagedSmokeActionService | undefined;
    let actionsShutdown = false;
    let actionIdentifier = identifiers.actions;
    if (actionIdentifier === undefined) {
        bind(RidePackagedSmokeActionService).toDynamicValue(context => {
            if (actionsShutdown) {
                const disposedActions = new RidePackagedSmokeActionService({});
                disposedActions.dispose();
                resolvedActions = disposedActions;
                return disposedActions;
            }
            // Keep browser/disabled startup free of editor, terminal, search, and SCM module initialization.
            const workspaceService = identifiers.workspaceService
                ?? require('@theia/workspace/lib/browser').WorkspaceService;
            const editorManager = identifiers.editorManager
                ?? require('@theia/editor/lib/browser/editor-manager').EditorManager;
            const fileService = identifiers.fileService
                ?? require('@theia/filesystem/lib/browser/file-service').FileService;
            const terminalService = identifiers.terminalService
                ?? require('@theia/terminal/lib/browser/base/terminal-service').TerminalService;
            const searchService = identifiers.searchService
                ?? require('@theia/search-in-workspace/lib/browser/search-in-workspace-service').SearchInWorkspaceService;
            const scmService = identifiers.scmService
                ?? require('@theia/scm/lib/browser/scm-service').ScmService;
            const hostedPlugins = identifiers.hostedPlugins
                ?? require('@theia/plugin-ext/lib/hosted/browser/hosted-plugin').HostedPluginSupport;
            const commandRegistry = identifiers.commandRegistry
                ?? require('@theia/core/lib/common/command').CommandRegistry;
            const applicationShell = identifiers.applicationShell
                ?? require('@theia/core/lib/browser/shell/application-shell').ApplicationShell;
            const openRequests = identifiers.openRequests ?? RideOpenRequestContribution;
            const actions = new RidePackagedSmokeActionService({
                workspaceService: context.container.get(workspaceService) as WorkspaceService,
                editorManager: context.container.get(editorManager) as EditorManager,
                fileService: context.container.get(fileService) as FileService,
                terminalService: context.container.get(terminalService) as TerminalService,
                searchService: context.container.get(searchService) as SearchInWorkspaceService,
                scmService: context.container.get(scmService) as ScmService,
                hostedPlugins: context.container.get(hostedPlugins) as HostedPluginSupport,
                commandRegistry: context.container.get(commandRegistry) as CommandRegistry,
                applicationShell: context.container.get(applicationShell) as ApplicationShell,
                openRequests: context.container.get(openRequests) as RideOpenRequestContribution,
                backendIsWindows: OS.backend.isWindows
            });
            resolvedActions = actions;
            return actions;
        }).inSingletonScope();
        bind(RidePackagedSmokeActions).toService(RidePackagedSmokeActionService);
        actionIdentifier = RidePackagedSmokeActions;
    }
    const smokeActionIdentifier = actionIdentifier;
    bind(RidePackagedSmokeActionShutdownContribution).toDynamicValue(() =>
        new RidePackagedSmokeActionShutdownContribution(() => {
            actionsShutdown = true;
            resolvedActions?.dispose();
        })
    ).inSingletonScope();
    bind(identifiers.contribution).toService(RidePackagedSmokeActionShutdownContribution);
    let protocolIdentifier = identifiers.protocol;
    if (protocolIdentifier === undefined) {
        bind(RideTauriPackagedSmokeProtocol).toSelf().inSingletonScope();
        bind(RidePackagedSmokeProtocol).toService(RideTauriPackagedSmokeProtocol);
        protocolIdentifier = RidePackagedSmokeProtocol;
    }
    const smokeProtocolIdentifier = protocolIdentifier;

    bind(RidePackagedSmokeContribution).toDynamicValue(context => new RidePackagedSmokeContribution(
        context.container.get(identifiers.applicationState),
        context.container.get(smokeProtocolIdentifier),
        () => context.container.get(smokeActionIdentifier)
    )).inSingletonScope();
    bind(identifiers.contribution).toService(RidePackagedSmokeContribution);
}
