/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { CommandContribution, type Command, type CommandRegistry } from '@theia/core/lib/common/command';
import type { interfaces } from '@theia/core/shared/inversify';
import { ChatAgent } from '@theia/ai-chat';
import type { ChatAgentLocation, ChatAgentService, ChatMode, MutableChatRequestModel } from '@theia/ai-chat';
import { RideCodexActivation, type RideCodexFeature, type RideCodexFeatureAgent } from './ride-codex-activation';

export const RIDE_CODEX_OPEN_COMMAND: Command = {
    id: 'ride.codex.open',
    label: 'Open Codex',
};

export const RIDE_CODEX_AGENT_ID = 'Codex';

/** A startup-safe entry point that activates Codex only on an explicit user action. */
export class RideCodexChatAgentProxy implements CommandContribution, RideCodexFeatureAgent {
    readonly id = RIDE_CODEX_AGENT_ID;
    readonly name = RIDE_CODEX_AGENT_ID;
    readonly description = 'Use the R-IDE Codex App Server for workspace-aware coding tasks.';
    readonly variables: string[] = [];
    readonly prompts = [];
    readonly languageModelRequirements = [];
    readonly agentSpecificVariables = [];
    readonly functions: string[] = [];
    readonly tags = ['codex', 'workspace'];
    readonly locations: ChatAgentLocation[] = ['panel', 'terminal', 'notebook', 'editor'] as ChatAgentLocation[];
    readonly iconClass = 'codicon codicon-hubot';
    readonly modes: ChatMode[] = [{ id: 'default', name: 'Default', isDefault: true }];

    constructor(protected readonly activation: RideCodexActivation) { }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(RIDE_CODEX_OPEN_COMMAND, {
            execute: () => this.open(),
        });
    }

    async open(): Promise<void> {
        await this.activation.activate();
        await this.activation.loadedFeature?.open?.();
    }

    async retry(): Promise<void> {
        await this.activation.retry();
        await this.activation.loadedFeature?.open?.();
    }

    async invoke(request: MutableChatRequestModel, chatAgentService?: ChatAgentService): Promise<void> {
        try {
            await this.activation.activate();
            const agent = this.activation.loadedFeature?.agent;
            if (!agent) {
                throw new Error('Codex agent is unavailable.');
            }
            await agent.invoke(request, chatAgentService);
        } catch {
            request.response.error(new Error('Codex could not be activated safely.'));
        }
    }
}

export function bindRideCodexFrontend(
    bind: interfaces.Bind,
    loadFeature: (container?: interfaces.Container) => Promise<RideCodexFeature>
): void {
    bind(RideCodexActivation).toDynamicValue(context =>
        new RideCodexActivation(() => loadFeature(context.container))
    ).inSingletonScope();
    bind(RideCodexChatAgentProxy).toDynamicValue(context =>
        new RideCodexChatAgentProxy(context.container.get(RideCodexActivation))
    ).inSingletonScope();
    bind(ChatAgent).toService(RideCodexChatAgentProxy);
    bind(CommandContribution).toService(RideCodexChatAgentProxy);
    bind(FrontendApplicationContribution).toService(RideCodexActivation);
}
