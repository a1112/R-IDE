/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export type RideCodexRuntimeSource = 'override' | 'system' | 'managed';

export interface RideCodexLaunchSpec {
    readonly executable: string;
    readonly version: string;
    readonly target: string;
    readonly source: RideCodexRuntimeSource;
    /**
     * Channel-neutral environment overlay shared by App Server and SDK launches.
     * Authentication is deliberately brokered elsewhere and never stored here.
     */
    readonly environment: Readonly<Record<string, string>>;
    readonly diagnostics: readonly string[];
}

export interface RideCodexLaunchSpecInit {
    readonly executable: string;
    readonly version: string;
    readonly target: string;
    readonly source: RideCodexRuntimeSource;
    readonly diagnostics?: readonly string[];
}

const MAX_DIAGNOSTICS = 8;
const MAX_DIAGNOSTIC_LENGTH = 160;

export function createRideCodexLaunchSpec(init: RideCodexLaunchSpecInit): RideCodexLaunchSpec {
    const diagnostics = Object.freeze((init.diagnostics ?? [])
        .slice(0, MAX_DIAGNOSTICS)
        .map(diagnostic => diagnostic.slice(0, MAX_DIAGNOSTIC_LENGTH)));
    const environment = Object.freeze({}) as Readonly<Record<string, string>>;
    return Object.freeze({
        executable: init.executable,
        version: init.version,
        target: init.target,
        source: init.source,
        environment,
        diagnostics
    });
}
