/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { TerminalFrontendContribution } from '@theia/terminal/lib/browser/terminal-frontend-contribution';
import { injectable, interfaces } from '@theia/core/shared/inversify';
import { isTauri as isTauriRuntime } from '@tauri-apps/api/core';
import {
    bindReplacementSingleton,
    RideTerminalStartupFlags,
    shouldInitializeDefaultTerminal
} from './ride-terminal-startup';

interface RideWindow extends Window, RideTerminalStartupFlags { }

export function bindRideTerminalFrontendContribution(
    bind: interfaces.Bind,
    isBound: (serviceIdentifier: interfaces.ServiceIdentifier<unknown>) => boolean,
    rebind: interfaces.Bind
): void {
    bindReplacementSingleton(
        bind,
        isBound,
        rebind,
        TerminalFrontendContribution,
        RideTerminalFrontendContribution
    );
}

@injectable()
export class RideTerminalFrontendContribution extends TerminalFrontendContribution {

    override async initializeLayout(): Promise<void> {
        const flags = window as RideWindow;
        if (!shouldInitializeDefaultTerminal(flags, isTauriRuntime)) {
            return;
        }
        return super.initializeLayout();
    }
}
