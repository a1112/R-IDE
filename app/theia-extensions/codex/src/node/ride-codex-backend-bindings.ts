/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { interfaces } from '@theia/core/shared/inversify';
import { RideCodexAppServerHost } from './ride-codex-app-server-host';
import { RideCodexApprovalBroker } from './ride-codex-approval-broker';
import { RideCodexAuthBroker } from './ride-codex-auth-broker';
import { RideCodexAppServerDiagnostics } from './ride-codex-diagnostics';
import {
    createRideCodexPackagedSmokeResolver,
    createRideCodexPackagedSmokeSpawn,
    isRideCodexPackagedSmokeEnvironment
} from './ride-codex-packaged-smoke';
import { RideCodexRuntimeResolver } from './ride-codex-runtime-resolver';
import { RideCodexThreadCoordinator } from './ride-codex-thread-coordinator';
import { RideCodexTurnCoordinator } from './ride-codex-turn-coordinator';

export function RIDE_CODEX_0_144_APPROVAL_POLICY(kind: 'command' | 'file-change'): boolean {
    return kind === 'command' || kind === 'file-change';
}

export function bindRideCodexBackendServices(bind: interfaces.Bind): void {
    bind(RideCodexRuntimeResolver).toSelf().inSingletonScope();
    bind(RideCodexAppServerDiagnostics).toSelf().inSingletonScope();
    bind(RideCodexAppServerHost).toDynamicValue(context => {
        const environment = process.env;
        const packagedSmoke = isRideCodexPackagedSmokeEnvironment(environment);
        return new RideCodexAppServerHost({
            resolver: createRideCodexPackagedSmokeResolver(
                context.container.get(RideCodexRuntimeResolver),
                environment
            ),
            spawn: createRideCodexPackagedSmokeSpawn(environment),
            diagnostics: context.container.get(RideCodexAppServerDiagnostics),
            ...(packagedSmoke ? { idleTimeoutMs: 250, shutdownGraceMs: 500 } : {})
        });
    }).inSingletonScope();
    bind(RideCodexAuthBroker).toDynamicValue(context => new RideCodexAuthBroker({
        host: context.container.get(RideCodexAppServerHost),
        diagnostics: context.container.get(RideCodexAppServerDiagnostics)
    })).inSingletonScope();
    bind(RideCodexThreadCoordinator).toDynamicValue(context => new RideCodexThreadCoordinator({
        host: context.container.get(RideCodexAppServerHost)
    })).inSingletonScope();
    bind(RideCodexTurnCoordinator).toDynamicValue(context => new RideCodexTurnCoordinator({
        host: context.container.get(RideCodexAppServerHost)
    })).inSingletonScope();
    bind(RideCodexApprovalBroker).toDynamicValue(context => new RideCodexApprovalBroker({
        host: context.container.get(RideCodexAppServerHost),
        allowAcceptForSession: RIDE_CODEX_0_144_APPROVAL_POLICY
    })).inSingletonScope();
}
