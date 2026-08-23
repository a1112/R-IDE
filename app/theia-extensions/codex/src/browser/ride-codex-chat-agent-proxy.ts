/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { RideCodexActivation } from './ride-codex-activation';

/** A startup-safe entry point that activates Codex only on an explicit user action. */
export class RideCodexChatAgentProxy {
    constructor(protected readonly activation: RideCodexActivation) { }

    open(): Promise<void> {
        return this.activation.activate();
    }

    retry(): Promise<void> {
        return this.activation.retry();
    }
}
