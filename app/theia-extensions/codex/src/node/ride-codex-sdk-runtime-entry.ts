/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Codex } from '@openai/codex-sdk';
import type { CodexOptions } from '@openai/codex-sdk';
import type {
    RideCodexSdkClient,
    RideCodexSdkClientOptions,
    RideCodexSdkRuntime,
    RideCodexSdkThreadOptions
} from './ride-codex-sdk-adapter';

export const createCodexClient = (options: RideCodexSdkClientOptions): RideCodexSdkClient =>
    new Codex(options as CodexOptions) as unknown as RideCodexSdkClient;

export const runtime: RideCodexSdkRuntime = { createCodexClient };

// Keep the entry's public shape explicit so an accidental SDK export change
// cannot silently become part of the compatibility contract.
export type { RideCodexSdkThreadOptions, RideCodexSdkClientOptions };
