/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { CommandContribution, type Command, type CommandRegistry } from '@theia/core/lib/common/command';
import type { interfaces } from '@theia/core/shared/inversify';
import { RideCodexActivation, type RideCodexFeature } from './ride-codex-activation';

export const RIDE_CODEX_OPEN_COMMAND: Command = {
    id: 'ride.codex.open',
    label: 'Open Codex',
};

export const RIDE_CODEX_AGENT_ID = 'Codex';

/** A startup-safe entry point that activates Codex only on an explicit user action. */
export class RideCodexChatAgentProxy implements CommandContribution {
    constructor(protected readonly activation: RideCodexActivation) { }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(RIDE_CODEX_OPEN_COMMAND, {
            execute: () => this.open(),
        });
    }

    open(): Promise<void> {
        return this.activation.activate();
    }

    retry(): Promise<void> {
        return this.activation.retry();
    }
}

export function bindRideCodexFrontend(
    bind: interfaces.Bind,
    loadFeature: () => Promise<RideCodexFeature>
): void {
    bind(RideCodexActivation).toDynamicValue(() => new RideCodexActivation(loadFeature)).inSingletonScope();
    bind(RideCodexChatAgentProxy).toDynamicValue(context =>
        new RideCodexChatAgentProxy(context.container.get(RideCodexActivation))
    ).inSingletonScope();
    bind(CommandContribution).toService(RideCodexChatAgentProxy);
    bind(FrontendApplicationContribution).toService(RideCodexActivation);
}
