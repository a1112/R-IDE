/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export const INITIALIZE_CAPABILITIES = Object.freeze({
    experimentalApi: false,
    requestAttestation: false
});

export const CLIENT_METHODS = Object.freeze([
    'initialize',
    'account/read',
    'account/login/start',
    'account/login/cancel',
    'account/logout',
    'account/rateLimits/read',
    'model/list',
    'modelProvider/capabilities/read',
    'thread/list',
    'thread/read',
    'thread/start',
    'thread/resume',
    'thread/archive',
    'turn/start',
    'turn/steer',
    'turn/interrupt'
] as const);

export const CLIENT_NOTIFICATION_METHODS = Object.freeze([
    'initialized'
] as const);

export const SERVER_NOTIFICATION_METHODS = Object.freeze([
    'error',
    'account/updated',
    'account/login/completed',
    'account/rateLimits/updated',
    'model/rerouted',
    'model/verification',
    'thread/started',
    'thread/status/changed',
    'thread/archived',
    'thread/tokenUsage/updated',
    'turn/started',
    'turn/completed',
    'turn/diff/updated',
    'turn/plan/updated',
    'item/started',
    'item/completed',
    'item/agentMessage/delta',
    'item/plan/delta',
    'item/reasoning/summaryTextDelta',
    'item/reasoning/summaryPartAdded',
    'item/reasoning/textDelta',
    'item/commandExecution/outputDelta',
    'item/fileChange/outputDelta',
    'item/fileChange/patchUpdated',
    'serverRequest/resolved',
    'warning',
    'deprecationNotice'
] as const);

export const SERVER_REQUEST_METHODS = Object.freeze([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval'
] as const);

export function classifyServerNotification(method: string): { kind: 'reviewed' | 'unknown'; fatal: false } {
    return SERVER_NOTIFICATION_METHODS.includes(method as never)
        ? { kind: 'reviewed', fatal: false }
        : { kind: 'unknown', fatal: false };
}

export function classifyServerRequest(method: string): { kind: 'approved' | 'unsupported' } {
    return SERVER_REQUEST_METHODS.includes(method as never)
        ? { kind: 'approved' }
        : { kind: 'unsupported' };
}
