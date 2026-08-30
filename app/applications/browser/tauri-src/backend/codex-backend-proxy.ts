// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import { BackendApplicationContribution, RootContainer } from '@theia/core/lib/node/backend-application';
import { ConnectionHandler } from '@theia/core/lib/common/messaging/handler';
import { JsonRpcConnectionHandler, RpcProxy } from '@theia/core/lib/common/messaging/proxy-factory';
import { Container, ContainerModule } from '@theia/core/shared/inversify';
import {
    RideCodexApprovalClient,
    RideCodexApprovalsServicePath,
    RideCodexAuthClient,
    RideCodexAuthServicePath,
    RideCodexConversationsClient,
    RideCodexConversationsServicePath,
    RideCodexTurnClient,
    RideCodexTurnsServicePath
} from 'theia-ide-codex-ext/lib/common/ride-codex-protocol';

interface RideCodexDeferredFeatureRuntime {
    connectAuth(client: RpcProxy<RideCodexAuthClient>): object;
    connectConversations(client: RpcProxy<RideCodexConversationsClient>): object;
    connectTurns(client: RpcProxy<RideCodexTurnClient>): object;
    connectApprovals(client: RpcProxy<RideCodexApprovalClient>): object;
    onStop(): Promise<void>;
}

interface RideCodexDeferredFeature {
    createRideCodexDeferredRuntime(rootContainer: Container): RideCodexDeferredFeatureRuntime;
}

const codexBackendFeatureModule = './codex-backend-feature.cjs';

function loadRideCodexDeferredFeature(): RideCodexDeferredFeature {
    const request = codexBackendFeatureModule;
    return require(request) as RideCodexDeferredFeature;
}

export class RideCodexDeferredBackend implements BackendApplicationContribution {
    protected runtime: RideCodexDeferredFeatureRuntime | undefined;
    protected activationError: Error | undefined;
    protected stopping: Promise<void> | undefined;
    protected stopped = false;

    constructor(protected readonly rootContainer: Container) { }

    connectAuth(client: RpcProxy<RideCodexAuthClient>): object {
        return this.activate().connectAuth(client);
    }

    connectConversations(client: RpcProxy<RideCodexConversationsClient>): object {
        return this.activate().connectConversations(client);
    }

    connectTurns(client: RpcProxy<RideCodexTurnClient>): object {
        return this.activate().connectTurns(client);
    }

    connectApprovals(client: RpcProxy<RideCodexApprovalClient>): object {
        return this.activate().connectApprovals(client);
    }

    onStop(): Promise<void> {
        if (!this.stopping) {
            this.stopped = true;
            try {
                this.stopping = this.runtime?.onStop() ?? Promise.resolve();
            } catch (error) {
                this.stopping = Promise.reject(error);
            }
        }
        return this.stopping;
    }

    protected activate(): RideCodexDeferredFeatureRuntime {
        if (this.stopped) {
            throw new Error('Deferred Codex backend is stopped.');
        }
        if (this.runtime) {
            return this.runtime;
        }
        if (this.activationError) {
            throw this.activationError;
        }
        try {
            const feature = loadRideCodexDeferredFeature();
            this.runtime = feature.createRideCodexDeferredRuntime(this.rootContainer);
            return this.runtime;
        } catch {
            const error = new Error('Codex backend feature is unavailable.');
            this.activationError = error;
            throw error;
        }
    }
}

export default new ContainerModule(bind => {
    bind(RideCodexDeferredBackend).toDynamicValue(context =>
        new RideCodexDeferredBackend(context.container.get(RootContainer))
    ).inSingletonScope();
    bind(BackendApplicationContribution).toService(RideCodexDeferredBackend);
    bind(ConnectionHandler).toDynamicValue(context =>
        new JsonRpcConnectionHandler<RideCodexAuthClient>(RideCodexAuthServicePath, client =>
            context.container.get(RideCodexDeferredBackend).connectAuth(client)
        )
    ).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(context =>
        new JsonRpcConnectionHandler<RideCodexConversationsClient>(RideCodexConversationsServicePath, client =>
            context.container.get(RideCodexDeferredBackend).connectConversations(client)
        )
    ).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(context =>
        new JsonRpcConnectionHandler<RideCodexTurnClient>(RideCodexTurnsServicePath, client =>
            context.container.get(RideCodexDeferredBackend).connectTurns(client)
        )
    ).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(context =>
        new JsonRpcConnectionHandler<RideCodexApprovalClient>(RideCodexApprovalsServicePath, client =>
            context.container.get(RideCodexDeferredBackend).connectApprovals(client)
        )
    ).inSingletonScope();
});
