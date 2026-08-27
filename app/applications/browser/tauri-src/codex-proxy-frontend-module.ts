/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ContainerModule } from '@theia/core/shared/inversify';
import { bindRideCodexFrontend } from 'theia-ide-codex-ext/lib/browser/ride-codex-chat-agent-proxy';

export default new ContainerModule(bind => {
    bindRideCodexFrontend(bind,
        container => import('./codex-feature').then(module => module.createCodexFeature(container!))
    );
});
