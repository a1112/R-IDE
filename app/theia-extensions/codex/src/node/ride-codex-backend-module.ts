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
    RideCodexAuthServicePath,
    RideCodexApprovalClient,
    RideCodexApprovalsServicePath,
    RideCodexConversationsClient,
    RideCodexConversationsService,
    RideCodexConversationsServicePath,
    RideCodexTurnClient,
    RideCodexTurnsServicePath
} from '../common/ride-codex-protocol';
import { RideCodexAppServerHost } from './ride-codex-app-server-host';
import { RideCodexAuthBroker } from './ride-codex-auth-broker';
import { RideCodexThreadCoordinator } from './ride-codex-thread-coordinator';
import { RideCodexTurnCoordinator } from './ride-codex-turn-coordinator';
import { RideCodexApprovalBroker } from './ride-codex-approval-broker';
import { bindRideCodexBackendServices } from './ride-codex-backend-bindings';

export { RIDE_CODEX_0_144_APPROVAL_POLICY } from './ride-codex-backend-bindings';

export default new ContainerModule(bind => {
    bindRideCodexBackendServices(bind);
    bind(BackendApplicationContribution).toService(RideCodexAppServerHost);
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
    bind(RideCodexConversationsService).toService(RideCodexThreadCoordinator);
    bind(BackendApplicationContribution).toService(RideCodexThreadCoordinator);
    bind(ConnectionHandler).toDynamicValue(context =>
        new JsonRpcConnectionHandler<RideCodexConversationsClient>(RideCodexConversationsServicePath, client => {
            const coordinator = context.container.get(RideCodexThreadCoordinator);
            coordinator.setClient(client);
            client.onDidCloseConnection(() => coordinator.disconnectClient(client));
            return coordinator;
        })
    ).inSingletonScope();
    bind(BackendApplicationContribution).toService(RideCodexTurnCoordinator);
    bind(ConnectionHandler).toDynamicValue(context =>
        new JsonRpcConnectionHandler<RideCodexTurnClient>(RideCodexTurnsServicePath, client => {
            const coordinator = context.container.get(RideCodexTurnCoordinator);
            const session = coordinator.connectClient(client);
            client.onDidCloseConnection(() => session.disconnectClient());
            return session;
        })
    ).inSingletonScope();
    bind(BackendApplicationContribution).toService(RideCodexApprovalBroker);
    bind(ConnectionHandler).toDynamicValue(context =>
        new JsonRpcConnectionHandler<RideCodexApprovalClient>(RideCodexApprovalsServicePath, client => {
            const session = context.container.get(RideCodexApprovalBroker).connectClient(client);
            client.onDidCloseConnection(() => session.dispose());
            return session;
        })
    ).inSingletonScope();
});
