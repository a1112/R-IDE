/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { deepFreezeRideCodex } from '../common/ride-codex-events';

export type RideCodexErrorLayer = 'runtime/install' | 'startup' | 'protocol' | 'auth' | 'turn';
export type RideCodexErrorAction =
    | 'install' | 'retry' | 'restart' | 'sign-in' | 'retry-later'
    | 'reduce-context' | 'review-sandbox' | 'none';

export interface RideCodexMappedError {
    readonly layer: RideCodexErrorLayer;
    readonly title: string;
    readonly message: string;
    readonly code: string;
    readonly retryable: boolean;
    readonly action: RideCodexErrorAction;
}

const KNOWN_ERRORS: Readonly<Record<string, RideCodexMappedError>> = deepFreezeRideCodex({
    'runtime-missing': {
        layer: 'runtime/install',
        title: 'Codex runtime unavailable',
        message: 'The Codex runtime is not installed.',
        code: 'runtime-missing',
        retryable: true,
        action: 'install'
    },
    'install-failed': {
        layer: 'runtime/install',
        title: 'Codex installation failed',
        message: 'The Codex runtime could not be installed safely.',
        code: 'install-failed',
        retryable: true,
        action: 'retry'
    },
    'startup-failed': {
        layer: 'startup',
        title: 'Codex could not start',
        message: 'Codex could not be started safely.',
        code: 'startup-failed',
        retryable: true,
        action: 'retry'
    },
    'protocol-error': {
        layer: 'protocol',
        title: 'Codex connection error',
        message: 'Codex returned data that could not be processed safely.',
        code: 'protocol-error',
        retryable: true,
        action: 'restart'
    },
    unauthorized: {
        layer: 'auth',
        title: 'Codex sign-in required',
        message: 'Sign in to continue using Codex.',
        code: 'unauthorized',
        retryable: true,
        action: 'sign-in'
    },
    'rate-limit': {
        layer: 'turn',
        title: 'Codex usage limit reached',
        message: 'Codex is temporarily unavailable. Try again later.',
        code: 'rate-limit',
        retryable: true,
        action: 'retry-later'
    },
    'context-limit': {
        layer: 'turn',
        title: 'Codex context limit reached',
        message: 'Reduce the conversation context and try again.',
        code: 'context-limit',
        retryable: true,
        action: 'reduce-context'
    },
    'sandbox-denied': {
        layer: 'turn',
        title: 'Codex action blocked',
        message: 'The requested action is not permitted by the current sandbox.',
        code: 'sandbox-denied',
        retryable: false,
        action: 'review-sandbox'
    },
    'service-error': {
        layer: 'turn',
        title: 'Codex service unavailable',
        message: 'The Codex service is temporarily unavailable. Try again later.',
        code: 'service-error',
        retryable: true,
        action: 'retry-later'
    },
    'stream-error': {
        layer: 'turn',
        title: 'Codex response interrupted',
        message: 'The Codex response stream ended unexpectedly.',
        code: 'stream-error',
        retryable: true,
        action: 'retry'
    },
    'transport-error': {
        layer: 'protocol',
        title: 'Codex connection lost',
        message: 'The Codex connection ended unexpectedly.',
        code: 'transport-error',
        retryable: true,
        action: 'restart'
    },
    interrupted: {
        layer: 'turn',
        title: 'Codex turn interrupted',
        message: 'The Codex turn was interrupted.',
        code: 'interrupted',
        retryable: true,
        action: 'retry'
    }
});

const FALLBACKS: Readonly<Record<RideCodexErrorLayer, RideCodexMappedError>> = deepFreezeRideCodex({
    'runtime/install': {
        layer: 'runtime/install',
        title: 'Codex runtime unavailable',
        message: 'The Codex runtime is unavailable.',
        code: 'runtime-error',
        retryable: true,
        action: 'retry'
    },
    startup: {
        layer: 'startup',
        title: 'Codex could not start',
        message: 'Codex could not be started safely.',
        code: 'startup-error',
        retryable: true,
        action: 'retry'
    },
    protocol: {
        layer: 'protocol',
        title: 'Codex connection error',
        message: 'The Codex connection could not be used safely.',
        code: 'protocol-error',
        retryable: true,
        action: 'restart'
    },
    auth: {
        layer: 'auth',
        title: 'Codex authentication error',
        message: 'Codex authentication could not be completed.',
        code: 'auth-error',
        retryable: true,
        action: 'sign-in'
    },
    turn: {
        layer: 'turn',
        title: 'Codex turn failed',
        message: 'The Codex turn could not be completed.',
        code: 'turn-error',
        retryable: true,
        action: 'retry'
    }
});

/**
 * Maps only trusted primitive signals. Unknown objects are deliberately not
 * inspected, so accessors, proxies, remote messages, and nested data cannot leak.
 */
export function mapRideCodexError(
    signal: unknown,
    fallbackLayer: RideCodexErrorLayer = 'turn'
): RideCodexMappedError {
    if (typeof signal === 'string' && Object.prototype.hasOwnProperty.call(KNOWN_ERRORS, signal)) {
        return KNOWN_ERRORS[signal];
    }
    const layer = typeof fallbackLayer === 'string'
        && Object.prototype.hasOwnProperty.call(FALLBACKS, fallbackLayer)
        ? fallbackLayer : 'turn';
    return FALLBACKS[layer];
}
