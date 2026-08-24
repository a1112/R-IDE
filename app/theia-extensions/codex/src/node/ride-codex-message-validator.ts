/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    CLIENT_METHODS,
    classifyServerNotification,
    classifyServerRequest
} from '../common/ride-codex-methods';

export type StableClientMethod = typeof CLIENT_METHODS[number];
export type RideCodexRequestId = string | number;

export interface RideCodexRpcError {
    code: number;
    message: string;
    data?: unknown;
}

export interface RideCodexResponse {
    kind: 'response';
    id: RideCodexRequestId;
    result?: unknown;
    error?: RideCodexRpcError;
}

export interface RideCodexServerNotification {
    kind: 'notification';
    method: string;
    params: unknown;
    reviewed: boolean;
}

export interface RideCodexServerRequest {
    kind: 'server-request';
    id: RideCodexRequestId;
    method: string;
    params: unknown;
    approved: boolean;
}

export type RideCodexIncomingMessage = RideCodexResponse | RideCodexServerNotification | RideCodexServerRequest;

const hasOwn = (value: object, property: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, property);

export function isStableClientMethod(method: string): method is StableClientMethod {
    return (CLIENT_METHODS as readonly string[]).includes(method);
}

export function validateRideCodexIncomingMessage(value: unknown): RideCodexIncomingMessage {
    if (!isRecord(value)) {
        throw envelopeError('message must be a JSON object');
    }

    const hasId = hasOwn(value, 'id');
    const hasMethod = hasOwn(value, 'method');
    if (hasMethod) {
        if (typeof value.method !== 'string') {
            throw envelopeError('method must be a string');
        }
        if (hasOwn(value, 'result') || hasOwn(value, 'error')) {
            throw envelopeError('request and notification messages cannot contain response payloads');
        }

        const params = hasOwn(value, 'params') ? value.params : undefined;
        if (hasId) {
            if (!isRequestId(value.id)) {
                throw envelopeError('server request ID must be a string or safe integer');
            }
            return {
                kind: 'server-request',
                id: value.id,
                method: value.method,
                params,
                approved: classifyServerRequest(value.method).kind === 'approved'
            };
        }

        return {
            kind: 'notification',
            method: value.method,
            params,
            reviewed: classifyServerNotification(value.method).kind === 'reviewed'
        };
    }

    if (!hasId || !isRequestId(value.id)) {
        throw envelopeError('response ID must be a string or safe integer');
    }
    if (hasOwn(value, 'params')) {
        throw envelopeError('response messages cannot contain params');
    }

    const hasResult = hasOwn(value, 'result');
    const hasError = hasOwn(value, 'error');
    if (hasResult === hasError) {
        throw envelopeError('response must contain exactly one of result or error');
    }
    if (hasError) {
        if (!isRecord(value.error)
            || !Number.isInteger(value.error.code)
            || typeof value.error.message !== 'string') {
            throw envelopeError('response error must contain an integer code and string message');
        }
        return {
            kind: 'response',
            id: value.id,
            error: {
                code: value.error.code as number,
                message: value.error.message,
                ...(hasOwn(value.error, 'data') ? { data: value.error.data } : {})
            }
        };
    }

    return { kind: 'response', id: value.id, result: value.result };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RideCodexRequestId {
    return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}

function envelopeError(message: string): Error {
    return new Error(`Invalid Codex App Server protocol envelope: ${message}`);
}
