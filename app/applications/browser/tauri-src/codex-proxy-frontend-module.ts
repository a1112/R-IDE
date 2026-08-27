/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ContainerModule } from '@theia/core/shared/inversify';
import {
    bindRideCodexFrontend
} from 'theia-ide-codex-ext/lib/browser/ride-codex-chat-agent-proxy';
import { RideCodexActivation } from 'theia-ide-codex-ext/lib/browser/ride-codex-activation';
import type {
    RideCodexSmokeAction,
    RideSmokePlan
} from 'theia-ide-product-ext/lib/browser/ride-packaged-smoke';
import { RideCodexPackagedSmokeDriver } from 'theia-ide-product-ext/lib/browser/ride-packaged-smoke';

interface RideCodexSmokeFeature {
    smoke?: {
        run(action: RideCodexSmokeAction, plan: RideSmokePlan): Promise<void>;
    };
}

export default new ContainerModule(bind => {
    bindRideCodexFrontend(bind,
        container => import('./codex-feature').then(module => module.createCodexFeature(container!))
    );
    bind(RideCodexPackagedSmokeDriver).toDynamicValue(context => {
        const activation = context.container.get(RideCodexActivation);
        return Object.freeze({
            run: async (action: RideCodexSmokeAction, plan: RideSmokePlan): Promise<void> => {
                if (action === 'codex-inactive') {
                    if (activation.state !== 'inactive') {
                        throw new Error('Codex smoke expected an inactive feature.');
                    }
                    return;
                }
                await activation.activate();
                const feature = activation.loadedFeature as unknown as RideCodexSmokeFeature | undefined;
                if (!feature?.smoke) {
                    throw new Error('Codex packaged smoke driver is unavailable.');
                }
                await feature.smoke.run(action, plan);
                if (action === 'codex-idle-exit') {
                    activation.dispose();
                }
            }
        });
    }).inSingletonScope();
});
