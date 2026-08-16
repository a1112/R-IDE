/********************************************************************************
 * Copyright (C) 2020 TypeFox, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import '../../src/browser/style/index.css';

import { ApplicationShell } from '@theia/core/lib/browser';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { AboutDialog } from '@theia/core/lib/browser/about-dialog';
import { applyBranding } from './theia-ide-config';
import { CommandContribution } from '@theia/core/lib/common/command';
import { ContainerModule } from '@theia/core/shared/inversify';
import { MessageService } from '@theia/core/lib/common/message-service';
import { MenuContribution } from '@theia/core/lib/common/menu';
import { OpenerService } from '@theia/core/lib/browser/opener-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { HostedPluginSupport } from '@theia/plugin-ext/lib/hosted/browser/hosted-plugin';
import { TheiaIDEAboutDialog } from './theia-ide-about-dialog';
import { TheiaIDEContribution } from './theia-ide-contribution';
import { bindRideOpenRequestContribution } from './ride-open-request-bindings';
import { RideWorkbenchContribution } from './ride-workbench-contribution';
import { bindRidePerformanceContribution } from './ride-performance-contribution';

export default new ContainerModule((bind, _unbind, isBound, rebind) => {
    applyBranding();

    if (isBound(AboutDialog)) {
        rebind(AboutDialog).to(TheiaIDEAboutDialog).inSingletonScope();
    } else {
        bind(AboutDialog).to(TheiaIDEAboutDialog).inSingletonScope();
    }

    bind(TheiaIDEContribution).toSelf().inSingletonScope();
    [CommandContribution, MenuContribution].forEach(serviceIdentifier =>
        bind(serviceIdentifier).toService(TheiaIDEContribution)
    );

    bind(RideWorkbenchContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(RideWorkbenchContribution);
    bind(CommandContribution).toService(RideWorkbenchContribution);

    bindRidePerformanceContribution(bind);

    bindRideOpenRequestContribution(bind, {
        applicationShell: ApplicationShell,
        applicationState: FrontendApplicationStateService,
        contribution: FrontendApplicationContribution,
        hostedPlugins: HostedPluginSupport,
        messageService: MessageService,
        openerService: OpenerService,
        workspaceService: WorkspaceService
    });
});
