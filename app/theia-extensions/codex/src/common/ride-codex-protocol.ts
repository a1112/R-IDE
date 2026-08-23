/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export const RideCodexServicePath = '/services/ride-codex';
export const RideCodexService = Symbol('RideCodexService');

export interface RideCodexService {
    status(): Promise<{ state: 'inactive' | 'activating' | 'ready' | 'error' }>;
    activate(): Promise<void>;
}
