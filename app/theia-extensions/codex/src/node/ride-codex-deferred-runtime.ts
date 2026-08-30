/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Container, ContainerModule } from '@theia/core/shared/inversify';
import type { RpcProxy } from '@theia/core/lib/common/messaging/proxy-factory';
import type { RideCodexApprovalSession } from '../common/ride-codex-approvals';
import type {
    RideCodexApprovalClient,
    RideCodexAuthClient,
    RideCodexAuthService,
    RideCodexConversationsClient,
    RideCodexConversationsService,
    RideCodexTurnClient,
    RideCodexTurnsService
} from '../common/ride-codex-protocol';
import { RideCodexAppServerHost } from './ride-codex-app-server-host';
import { RideCodexApprovalBroker } from './ride-codex-approval-broker';
import { RideCodexAuthBroker } from './ride-codex-auth-broker';
import { bindRideCodexBackendServices } from './ride-codex-backend-bindings';
import { RideCodexThreadCoordinator } from './ride-codex-thread-coordinator';
import { RideCodexTurnCoordinator } from './ride-codex-turn-coordinator';

export interface RideCodexDeferredRuntimeServices {
    readonly host: RideCodexAppServerHost;
    readonly auth: RideCodexAuthBroker;
    readonly conversations: RideCodexThreadCoordinator;
    readonly turns: RideCodexTurnCoordinator;
    readonly approvals: RideCodexApprovalBroker;
    readonly dispose: () => Promise<void>;
}

export class RideCodexDeferredRuntimeStopError extends Error {
    constructor(readonly errors: readonly unknown[]) {
        super('One or more deferred Codex backend services failed to stop.');
        this.name = 'RideCodexDeferredRuntimeStopError';
    }
}

export class RideCodexDeferredRuntime {
    protected stopping: Promise<void> | undefined;
    protected stopped = false;

    constructor(readonly services: RideCodexDeferredRuntimeServices) { }

    connectAuth(client: RpcProxy<RideCodexAuthClient>): RideCodexAuthService {
        this.ensureRunning();
        const service = this.services.auth;
        service.setClient(client);
        client.onDidCloseConnection(() => service.disconnectClient(client));
        return service;
    }

    connectConversations(client: RpcProxy<RideCodexConversationsClient>): RideCodexConversationsService {
        this.ensureRunning();
        const service = this.services.conversations;
        service.setClient(client);
        client.onDidCloseConnection(() => service.disconnectClient(client));
        return service;
    }

    connectTurns(client: RpcProxy<RideCodexTurnClient>): RideCodexTurnsService {
        this.ensureRunning();
        const session = this.services.turns.connectClient(client);
        client.onDidCloseConnection(() => session.disconnectClient());
        return session;
    }

    connectApprovals(client: RpcProxy<RideCodexApprovalClient>): RideCodexApprovalSession {
        this.ensureRunning();
        const session = this.services.approvals.connectClient(client);
        client.onDidCloseConnection(() => session.dispose());
        return session;
    }

    onStop(): Promise<void> {
        if (!this.stopping) {
            this.stopped = true;
            this.stopping = this.stopServices();
        }
        return this.stopping;
    }

    protected async stopServices(): Promise<void> {
        const errors: unknown[] = [];
        const operations = [
            () => this.services.auth.onStop(),
            () => this.services.conversations.onStop(),
            () => this.services.turns.onStop(),
            () => this.services.approvals.onStop(),
            () => this.services.host.onStop()
        ].map(operation => {
            try {
                return Promise.resolve(operation());
            } catch (error) {
                return Promise.reject(error);
            }
        });
        await Promise.all(operations.map(operation => operation.catch(error => {
            errors.push(error);
        })));
        try {
            await this.services.dispose();
        } catch (error) {
            errors.push(error);
        }
        if (errors.length > 0) {
            throw new RideCodexDeferredRuntimeStopError(errors);
        }
    }

    protected ensureRunning(): void {
        if (this.stopped) {
            throw new Error('Deferred Codex backend runtime is stopped.');
        }
    }
}

export function createRideCodexDeferredRuntime(rootContainer: Container): RideCodexDeferredRuntime {
    const child = rootContainer.createChild();
    child.load(new ContainerModule(bind => bindRideCodexBackendServices(bind)));
    return new RideCodexDeferredRuntime({
        host: child.get(RideCodexAppServerHost),
        auth: child.get(RideCodexAuthBroker),
        conversations: child.get(RideCodexThreadCoordinator),
        turns: child.get(RideCodexTurnCoordinator),
        approvals: child.get(RideCodexApprovalBroker),
        dispose: () => child.unbindAllAsync()
    });
}
