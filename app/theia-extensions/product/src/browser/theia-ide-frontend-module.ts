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
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { AboutDialog } from '@theia/core/lib/browser/about-dialog';
import { applyBranding } from './theia-ide-config';
import { CommandContribution } from '@theia/core/lib/common/command';
import { ContainerModule } from '@theia/core/shared/inversify';
import { MessageService } from '@theia/core/lib/common/message-service';
import { MenuContribution } from '@theia/core/lib/common/menu';
import { OpenerService } from '@theia/core/lib/browser/opener-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { TheiaIDEAboutDialog } from './theia-ide-about-dialog';
import { TheiaIDEContribution } from './theia-ide-contribution';
import { RideNativeChrome } from './ride-native-chrome';
import { RideOpenRequestContribution } from './ride-open-request';
import { RideWorkbenchContribution } from './ride-workbench-contribution';

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

    bind(RideNativeChrome).toDynamicValue(() => new RideNativeChrome()).inSingletonScope();
    bind(RideOpenRequestContribution).toDynamicValue(context => new RideOpenRequestContribution(
        context.container.get(WorkspaceService),
        context.container.get(OpenerService),
        context.container.get(MessageService),
        context.container.get(ApplicationShell),
        context.container.get(RideNativeChrome)
    )).inSingletonScope();
    bind(FrontendApplicationContribution).toService(RideOpenRequestContribution);
});
