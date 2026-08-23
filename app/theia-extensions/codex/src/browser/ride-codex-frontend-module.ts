/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { CommandContribution } from '@theia/core/lib/common/command';
import { ContainerModule } from '@theia/core/shared/inversify';
import { RideCodexActivation } from './ride-codex-activation';
import { RideCodexChatAgentProxy } from './ride-codex-chat-agent-proxy';

export default new ContainerModule(bind => {
    bind(RideCodexActivation).toDynamicValue(() => new RideCodexActivation(async () => ({
        activate: async () => undefined,
    }))).inSingletonScope();
    bind(RideCodexChatAgentProxy).toDynamicValue(context =>
        new RideCodexChatAgentProxy(context.container.get(RideCodexActivation))
    ).inSingletonScope();
    bind(CommandContribution).toService(RideCodexChatAgentProxy);
});
