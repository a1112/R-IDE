/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ContainerModule } from '@theia/core/shared/inversify';
import { RideCodexActivation } from 'theia-ide-codex-ext/lib/browser/ride-codex-activation';
import { RideCodexChatAgentProxy } from 'theia-ide-codex-ext/lib/browser/ride-codex-chat-agent-proxy';

export default new ContainerModule(bind => {
    bind(RideCodexActivation).toDynamicValue(() => new RideCodexActivation(
        () => import('./codex-feature').then(module => module.createCodexFeature())
    )).inSingletonScope();
    bind(RideCodexChatAgentProxy).toDynamicValue(context =>
        new RideCodexChatAgentProxy(context.container.get(RideCodexActivation))
    ).inSingletonScope();
});
