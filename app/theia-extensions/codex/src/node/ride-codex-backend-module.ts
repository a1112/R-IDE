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
import { RideCodexAppServerDiagnostics } from './ride-codex-diagnostics';
import { RideCodexRuntimeResolver } from './ride-codex-runtime-resolver';
import { RideCodexThreadCoordinator } from './ride-codex-thread-coordinator';
import { RideCodexTurnCoordinator } from './ride-codex-turn-coordinator';
import { RideCodexApprovalBroker } from './ride-codex-approval-broker';

export function RIDE_CODEX_0_144_APPROVAL_POLICY(kind: 'command' | 'file-change'): boolean {
    return kind === 'command' || kind === 'file-change';
}

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
    bind(RideCodexThreadCoordinator).toDynamicValue(context => new RideCodexThreadCoordinator({
        host: context.container.get(RideCodexAppServerHost)
    })).inSingletonScope();
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
    bind(RideCodexTurnCoordinator).toDynamicValue(context => new RideCodexTurnCoordinator({
        host: context.container.get(RideCodexAppServerHost)
    })).inSingletonScope();
    bind(BackendApplicationContribution).toService(RideCodexTurnCoordinator);
    bind(ConnectionHandler).toDynamicValue(context =>
        new JsonRpcConnectionHandler<RideCodexTurnClient>(RideCodexTurnsServicePath, client => {
            const coordinator = context.container.get(RideCodexTurnCoordinator);
            const session = coordinator.connectClient(client);
            client.onDidCloseConnection(() => session.disconnectClient());
            return session;
        })
    ).inSingletonScope();
    bind(RideCodexApprovalBroker).toDynamicValue(context => new RideCodexApprovalBroker({
        host: context.container.get(RideCodexAppServerHost),
        allowAcceptForSession: RIDE_CODEX_0_144_APPROVAL_POLICY
    })).inSingletonScope();
    bind(BackendApplicationContribution).toService(RideCodexApprovalBroker);
    bind(ConnectionHandler).toDynamicValue(context =>
        new JsonRpcConnectionHandler<RideCodexApprovalClient>(RideCodexApprovalsServicePath, client => {
            const session = context.container.get(RideCodexApprovalBroker).connectClient(client);
            client.onDidCloseConnection(() => session.dispose());
            return session;
        })
    ).inSingletonScope();
});
