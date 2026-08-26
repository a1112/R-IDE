/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ContainerModule } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { RideCodexAppServerHost } from './ride-codex-app-server-host';
import { RideCodexAppServerDiagnostics } from './ride-codex-diagnostics';
import { RideCodexRuntimeResolver } from './ride-codex-runtime-resolver';

export default new ContainerModule(bind => {
    bind(RideCodexRuntimeResolver).toSelf().inSingletonScope();
    bind(RideCodexAppServerDiagnostics).toSelf().inSingletonScope();
    bind(RideCodexAppServerHost).toDynamicValue(context => new RideCodexAppServerHost({
        resolver: context.container.get(RideCodexRuntimeResolver),
        diagnostics: context.container.get(RideCodexAppServerDiagnostics)
    })).inSingletonScope();
    bind(BackendApplicationContribution).toService(RideCodexAppServerHost);
});
