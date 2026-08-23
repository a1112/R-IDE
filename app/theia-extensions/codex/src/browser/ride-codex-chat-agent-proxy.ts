/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { RideCodexActivation } from './ride-codex-activation';

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
