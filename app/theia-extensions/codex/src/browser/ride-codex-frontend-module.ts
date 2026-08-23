/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ContainerModule } from '@theia/core/shared/inversify';
import { bindRideCodexFrontend } from './ride-codex-chat-agent-proxy';

export default new ContainerModule(bind => {
    bindRideCodexFrontend(bind, async () => ({
        activate: async () => undefined,
    }));
});
