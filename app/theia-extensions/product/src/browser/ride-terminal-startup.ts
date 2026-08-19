/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { interfaces } from '@theia/core/shared/inversify';

export interface RideTerminalStartupFlags {
    readonly RIDE_DISABLE_DEFAULT_TERMINAL?: boolean;
    readonly RIDE_TAURI?: boolean;
}

export function shouldInitializeDefaultTerminal(
    flags: RideTerminalStartupFlags,
    isTauri: () => boolean
): boolean {
    return !flags.RIDE_DISABLE_DEFAULT_TERMINAL && !flags.RIDE_TAURI && !isTauri();
}

export function bindReplacementSingleton<T>(
    bind: interfaces.Bind,
    isBound: (serviceIdentifier: interfaces.ServiceIdentifier<unknown>) => boolean,
    rebind: interfaces.Bind,
    serviceIdentifier: interfaces.ServiceIdentifier<T>,
    implementation: interfaces.Newable<T>
): void {
    const binding = isBound(serviceIdentifier) ? rebind : bind;
    binding(serviceIdentifier).to(implementation).inSingletonScope();
}
