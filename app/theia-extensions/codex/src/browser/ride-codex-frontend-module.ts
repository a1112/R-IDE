/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { MessageService } from '@theia/core/lib/common/message-service';
import { PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging/ws-connection-provider';
import { bindRideCodexFrontend } from './ride-codex-chat-agent-proxy';
import {
    RideCodexAuthClient,
    RideCodexAuthService,
    RideCodexAuthServicePath
} from '../common/ride-codex-protocol';
import { RideCodexAuthClientRelay, RideCodexAuthController } from './ride-codex-auth-controller';

export default new ContainerModule(bind => {
    bindRideCodexFrontend(bind, async () => ({
        activate: async () => undefined,
    }));
    bind(RideCodexAuthClientRelay).toSelf().inSingletonScope();
    bind(RideCodexAuthClient).toService(RideCodexAuthClientRelay);
    bind(RideCodexAuthService).toDynamicValue(context =>
        WebSocketConnectionProvider.createProxy(
            context.container,
            RideCodexAuthServicePath,
            context.container.get(RideCodexAuthClientRelay)
        )
    ).inSingletonScope();
    bind(RideCodexAuthController).toDynamicValue(context => {
        const preferences = context.container.get<PreferenceService>(PreferenceService);
        const messages = context.container.get(MessageService);
        const relay = context.container.get(RideCodexAuthClientRelay);
        const controller = new RideCodexAuthController({
            auth: context.container.get(RideCodexAuthService),
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
            relay,
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
        return controller;
    }).inSingletonScope();
    bind(FrontendApplicationContribution).toService(RideCodexAuthController);
});
