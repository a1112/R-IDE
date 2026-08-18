/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { interfaces } from '@theia/core/shared/inversify';
import {
    RidePackagedSmokeActions,
    RidePackagedSmokeContribution,
    RidePackagedSmokeProtocol,
    RideTauriPackagedSmokeProtocol
} from './ride-packaged-smoke';

export interface RidePackagedSmokeBindingIdentifiers {
    readonly applicationState: interfaces.ServiceIdentifier<FrontendApplicationStateService>;
    readonly contribution: interfaces.ServiceIdentifier<FrontendApplicationContribution>;
    readonly actions?: interfaces.ServiceIdentifier<RidePackagedSmokeActions>;
    readonly protocol?: interfaces.ServiceIdentifier<RidePackagedSmokeProtocol>;
}

export function bindRidePackagedSmokeContribution(
    bind: interfaces.Bind,
    identifiers: RidePackagedSmokeBindingIdentifiers
): void {
    const actionIdentifier = identifiers.actions ?? RidePackagedSmokeActions;
    let protocolIdentifier = identifiers.protocol;
    if (protocolIdentifier === undefined) {
        bind(RideTauriPackagedSmokeProtocol).toSelf().inSingletonScope();
        bind(RidePackagedSmokeProtocol).toService(RideTauriPackagedSmokeProtocol);
        protocolIdentifier = RidePackagedSmokeProtocol;
    }
    const smokeProtocolIdentifier = protocolIdentifier;

    bind(RidePackagedSmokeContribution).toDynamicValue(context => new RidePackagedSmokeContribution(
        context.container.get(identifiers.applicationState),
        context.container.get(smokeProtocolIdentifier),
        () => context.container.get(actionIdentifier)
    )).inSingletonScope();
    bind(identifiers.contribution).toService(RidePackagedSmokeContribution);
}
