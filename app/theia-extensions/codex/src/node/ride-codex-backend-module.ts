/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ContainerModule } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { ConnectionHandler } from '@theia/core/lib/common/messaging/handler';
import { JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging/proxy-factory';
import {
    RideCodexAuthClient,
    RideCodexAuthService,
    RideCodexAuthServicePath
} from '../common/ride-codex-protocol';
import { RideCodexAppServerHost } from './ride-codex-app-server-host';
import { RideCodexAuthBroker } from './ride-codex-auth-broker';
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
    bind(RideCodexAuthBroker).toDynamicValue(context => new RideCodexAuthBroker({
        host: context.container.get(RideCodexAppServerHost),
        diagnostics: context.container.get(RideCodexAppServerDiagnostics)
    })).inSingletonScope();
    bind(RideCodexAuthService).toService(RideCodexAuthBroker);
    bind(BackendApplicationContribution).toService(RideCodexAuthBroker);
    bind(ConnectionHandler).toDynamicValue(context =>
        new JsonRpcConnectionHandler<RideCodexAuthClient>(RideCodexAuthServicePath, client => {
            const broker = context.container.get(RideCodexAuthBroker);
            broker.setClient(client);
            client.onDidCloseConnection(() => broker.disconnectClient(client));
            return broker;
        })
    ).inSingletonScope();
});
