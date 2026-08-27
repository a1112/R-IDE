/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging/ws-connection-provider';
import { MessageService } from '@theia/core/lib/common/message-service';
import { PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import type { interfaces } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import {
    RideCodexAuthClientRelay,
    RideCodexAuthController
} from 'theia-ide-codex-ext/lib/browser/ride-codex-auth-controller';
import { RideCodexChatAgent } from 'theia-ide-codex-ext/lib/browser/ride-codex-chat-agent';
import {
    RideCodexControlModel,
    RideCodexControlServices
} from 'theia-ide-codex-ext/lib/browser/ride-codex-control-model';
import { RideCodexContribution } from 'theia-ide-codex-ext/lib/browser/ride-codex-contribution';
import {
    RideCodexApprovalClient,
    RideCodexApprovalsService,
    RideCodexApprovalsServicePath,
    RideCodexAuthService,
    RideCodexAuthServicePath,
    RideCodexConversationsClient,
    RideCodexConversationsService,
    RideCodexConversationsServicePath,
    RideCodexTurnClient,
    RideCodexTurnsService,
    RideCodexTurnsServicePath
} from 'theia-ide-codex-ext/lib/common/ride-codex-protocol';

export function createCodexFeature(container: interfaces.Container) {
    const authRelay = new RideCodexAuthClientRelay();
    let model: RideCodexControlModel | undefined;
    let disposed = false;

    const auth = WebSocketConnectionProvider.createProxy<RideCodexAuthService>(
        container,
        RideCodexAuthServicePath,
        authRelay
    );
    const conversationsClient: RideCodexConversationsClient = {
        conversationsChanged: snapshot => model?.conversationsChanged(snapshot)
    };
    const turnClient: RideCodexTurnClient = {
        turnEvents: wire => model?.notifyTurnEvents(wire)
    };
    const approvalClient: RideCodexApprovalClient = {
        approvalsChanged: approvals => model?.approvalsChanged(approvals)
    };
    const conversations = WebSocketConnectionProvider.createProxy<RideCodexConversationsService>(
        container,
        RideCodexConversationsServicePath,
        conversationsClient
    );
    const turns = WebSocketConnectionProvider.createProxy<RideCodexTurnsService>(
        container,
        RideCodexTurnsServicePath,
        turnClient
    );
    const approvals = WebSocketConnectionProvider.createProxy<RideCodexApprovalsService>(
        container,
        RideCodexApprovalsServicePath,
        approvalClient
    );

    const preferences = container.get<PreferenceService>(PreferenceService);
    const messages = container.get(MessageService);
    const authController = new RideCodexAuthController({
        auth,
        relay: authRelay,
        preferences: {
            read: name => preferences.get(name),
            remove: async (name, expectedValue) => {
                if (preferences.get(name) !== expectedValue) {
                    return false;
                }
                await preferences.updateValue(name, undefined);
                return preferences.get(name) === undefined;
            }
        },
        prompt: {
            confirmLegacyApiKeyMigration: async sources => {
                const action = await messages.info(
                    `R-IDE found legacy Codex API key settings in: ${sources.join(', ')}. Migrate them to Codex authentication?`,
                    'Migrate',
                    'Keep for manual handling'
                );
                return action === 'Migrate';
            }
        }
    });

    const workspace = container.get<WorkspaceService>(WorkspaceService);
    const workspaceRoot = () => workspace.tryGetRoots()[0]?.resource.path.fsPath() ?? '';
    const services: RideCodexControlServices = { auth, conversations, turns, approvals };
    model = new RideCodexControlModel({
        services,
        workspaceRoot
    });
    const authAttachment = authRelay.attach(model);
    const contribution = new RideCodexContribution(
        container.get<ApplicationShell>(ApplicationShell),
        model
    );
    const agent = new RideCodexChatAgent(model);

    return {
        agent,
        activate: async () => {
            if (disposed) {
                throw new Error('Codex feature is disposed.');
            }
            await authController.activate();
            await model?.initialize();
        },
        open: async () => {
            if (disposed) {
                throw new Error('Codex feature is disposed.');
            }
            await contribution.open();
        },
        dispose: () => {
            if (disposed) {
                return;
            }
            disposed = true;
            authAttachment.dispose();
            authController.dispose();
            contribution.dispose();
        }
    };
}
