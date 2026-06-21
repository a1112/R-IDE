/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { TerminalFrontendContribution } from '@theia/terminal/lib/browser/terminal-frontend-contribution';
import { injectable } from '@theia/core/shared/inversify';

interface RideWindow extends Window {
    RIDE_DISABLE_DEFAULT_TERMINAL?: boolean;
    RIDE_TAURI?: boolean;
}

@injectable()
export class RideTerminalFrontendContribution extends TerminalFrontendContribution {

    override async initializeLayout(): Promise<void> {
        const flags = window as RideWindow;
        if (flags.RIDE_DISABLE_DEFAULT_TERMINAL || flags.RIDE_TAURI) {
            return;
        }
        return super.initializeLayout();
    }
}
