/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export interface RideDemoWorkbenchHost {
    readonly RIDE_RESTORE_DEMO_WORKBENCH?: boolean;
    readonly location: Pick<Location, 'search'>;
}

export function shouldRestoreDemoWorkbench(host: RideDemoWorkbenchHost): boolean {
    if (host.RIDE_RESTORE_DEMO_WORKBENCH) {
        return true;
    }
    return new URLSearchParams(host.location.search).get('rideDemoWorkbench') === '1';
}
