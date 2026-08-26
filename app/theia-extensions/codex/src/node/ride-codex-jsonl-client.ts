/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { RideCodexJsonlFramer } from './ride-codex-jsonl-framer';
import {
    isStableClientMethod,
    RideCodexRequestId,
    RideCodexResponse,
    RideCodexServerNotification,
    RideCodexServerRequest,
    StableClientMethod,
    validateRideCodexIncomingMessage
} from './ride-codex-message-validator';
import { CLIENT_NOTIFICATION_METHODS } from '../common/ride-codex-methods';

export { StableClientMethod } from './ride-codex-message-validator';

export interface RideCodexDisposable {
    dispose(): void;
}

export interface RideCodexJsonlTransport {
    write(data: string): void;
    writeConfirmed?(data: string): Promise<void>;
    onData(listener: (chunk: Uint8Array) => void): RideCodexDisposable;
    onExit(listener: (reason?: Error) => void): RideCodexDisposable;
    close(): void;
}

export interface RideCodexJsonlClientOptions {
    maxLineBytes?: number;
    maxPending?: number;
    maxDiagnostics?: number;
    initialRequestId?: number;
}

export interface RideCodexNotification {
    method: string;
    params: unknown;
}

export type RideCodexClientNotificationMethod = typeof CLIENT_NOTIFICATION_METHODS[number];

export interface RideCodexIncomingRequest extends RideCodexNotification {
    id: RideCodexRequestId;
}

export interface RideCodexDiagnostic {
    code: string;
    message: string;
}

interface PendingRequest {
    readonly resolve: (value: unknown) => void;
    readonly reject: (reason: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PENDING = 128;
const DEFAULT_MAX_DIAGNOSTICS = 32;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TIMER_MS = 0x7fffffff;
const MAX_REQUEST_ID_LENGTH = 1_024;
const MAX_ERROR_MESSAGE_LENGTH = 16 * 1_024;

export class RideCodexRemoteError extends Error {
    constructor(readonly code: number, message: string, readonly data?: unknown) {
        super(message);
        this.name = 'RideCodexRemoteError';
    }
}

export class RideCodexJsonlClient implements RideCodexDisposable {
    protected readonly framer: RideCodexJsonlFramer;
    protected readonly decoder = new TextDecoder('utf-8', { fatal: true });
    protected readonly pending = new Map<number, PendingRequest>();
    protected readonly notificationListeners = new Set<(notification: RideCodexNotification) => void>();
    protected readonly serverRequestListeners = new Set<(request: RideCodexIncomingRequest) => void>();
    protected readonly diagnosticListeners = new Set<(diagnostic: RideCodexDiagnostic) => void>();
    protected readonly transportListeners: RideCodexDisposable[] = [];
    protected readonly maxPending: number;
    protected readonly maxDiagnostics: number;
    protected nextRequestId: number | undefined;
    protected unknownNotificationDiagnosticCount = 0;
    protected closed = false;
    protected closeReason: Error | undefined;
    protected transportCloseRequested = false;

    constructor(protected readonly transport: RideCodexJsonlTransport, options: RideCodexJsonlClientOptions = {}) {
        const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
        this.maxPending = validateLimit(options.maxPending ?? DEFAULT_MAX_PENDING, 'maximum pending request count', 1);
        this.maxDiagnostics = validateLimit(options.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS, 'maximum diagnostic count', 0);
        const initialRequestId = options.initialRequestId ?? 1;
        if (!Number.isSafeInteger(initialRequestId) || initialRequestId < 0) {
            throw new RangeError('Initial request ID must be a non-negative safe integer');
        }
        this.nextRequestId = initialRequestId;
        this.framer = new RideCodexJsonlFramer(maxLineBytes);
        this.registerTransportListeners();
    }

    get pendingCount(): number {
        return this.pending.size;
    }

    readonly request = (method: StableClientMethod, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> => {
        if (this.closed) {
            return Promise.reject(this.closedRequestError());
        }
        if (!isStableClientMethod(method)) {
            return Promise.reject(new Error(`Unsupported client method: ${String(method)}`));
        }
        if (this.pending.size >= this.maxPending) {
            return Promise.reject(new Error(`Maximum pending request count of ${this.maxPending} reached`));
        }
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMER_MS) {
            return Promise.reject(new RangeError('Request timeout must be a non-negative safe timer duration'));
        }

        const id = this.nextRequestId;
        if (id === undefined) {
            return Promise.reject(new Error('Codex request ID space exhausted'));
        }

        let payload: string;
        try {
            payload = serializeEnvelope({ id, method, params }, ['id', 'method', 'params']);
        } catch {
            return Promise.reject(new Error('Unable to serialize Codex request'));
        }
        this.nextRequestId = id === Number.MAX_SAFE_INTEGER ? undefined : id + 1;

        const promise = new Promise<unknown>((resolve, reject) => {
            let entry: PendingRequest;
            const timer = setTimeout(() => {
                if (this.pending.get(id) !== entry) {
                    return;
                }
                this.pending.delete(id);
                reject(new Error(`Codex request ${id} timed out after ${timeoutMs} ms`));
            }, timeoutMs);
            timer.unref?.();
            entry = { resolve, reject, timer };
            this.pending.set(id, entry);
            this.writePayload(payload);
        });
        void promise.catch(() => undefined);
        return promise;
    };

    respond(id: RideCodexRequestId, result: unknown): void {
        if (this.closed) {
            return;
        }
        validateOutboundRequestId(id);
        this.writePayload(serializeEnvelope(
            { id, result: result === undefined ? null : result },
            ['id', 'result']
        ));
    }

    respondConfirmed(id: RideCodexRequestId, result: unknown): Promise<void> {
        if (this.closed) {
            return containedRejection(this.closedRequestError());
        }
        let payload: string;
        try {
            validateOutboundRequestId(id);
            payload = serializeEnvelope(
                { id, result: result === undefined ? null : result },
                ['id', 'result']
            );
        } catch {
            return containedRejection(new Error('Unable to serialize Codex response'));
        }
        return this.writePayloadConfirmed(payload);
    }

    notify(method: RideCodexClientNotificationMethod, params: unknown): void {
        if (this.closed) {
            throw this.closedRequestError();
        }
        if (!(CLIENT_NOTIFICATION_METHODS as readonly string[]).includes(method)) {
            throw new Error(`Unsupported client notification method: ${String(method)}`);
        }
        this.writePayload(serializeEnvelope({ method, params }, ['method', 'params']));
    }

    notifyConfirmed(method: RideCodexClientNotificationMethod, params: unknown): Promise<void> {
        if (this.closed) {
            return containedRejection(this.closedRequestError());
        }
        if (!(CLIENT_NOTIFICATION_METHODS as readonly string[]).includes(method)) {
            return containedRejection(new Error(`Unsupported client notification method: ${String(method)}`));
        }
        let payload: string;
        try {
            payload = serializeEnvelope({ method, params }, ['method', 'params']);
        } catch {
            return containedRejection(new Error('Unable to serialize Codex notification'));
        }
        return this.writePayloadConfirmed(payload);
    }

    respondError(id: RideCodexRequestId, code: number, message: string): void {
        if (this.closed) {
            return;
        }
        validateOutboundRequestId(id);
        if (!Number.isSafeInteger(code)) {
            throw new RangeError('Codex response error code must be a safe integer');
        }
        if (typeof message !== 'string' || message.length > MAX_ERROR_MESSAGE_LENGTH) {
            throw new RangeError(`Codex response error message must be a string of at most ${MAX_ERROR_MESSAGE_LENGTH} characters`);
        }
        this.writePayload(serializeEnvelope({ id, error: { code, message } }, ['id', 'error']));
    }

    onNotification(listener: (notification: RideCodexNotification) => void): RideCodexDisposable {
        return addListener(this.notificationListeners, listener);
    }

    onServerRequest(listener: (request: RideCodexIncomingRequest) => void): RideCodexDisposable {
        return addListener(this.serverRequestListeners, listener);
    }

    onDiagnostic(listener: (diagnostic: RideCodexDiagnostic) => void): RideCodexDisposable {
        return addListener(this.diagnosticListeners, listener);
    }

    dispose(): void {
        this.shutdown(new Error('Codex JSONL client disposed'), true);
    }

    protected handleData(chunk: Uint8Array): void {
        if (this.closed) {
            return;
        }
        try {
            for (const line of this.framer.push(chunk)) {
                if (this.closed) {
                    return;
                }
                let text: string;
                try {
                    text = this.decoder.decode(line);
                } catch {
                    throw new Error('Invalid UTF-8 in Codex App Server protocol data');
                }

                let value: unknown;
                try {
                    value = JSON.parse(text);
                } catch {
                    throw new Error('Malformed JSON in Codex App Server protocol data');
                }
                this.handleMessage(validateRideCodexIncomingMessage(value));
            }
        } catch (error) {
            this.shutdown(asError(error, 'Codex App Server protocol error'), true);
        }
    }

    protected handleMessage(message: RideCodexResponse | RideCodexServerNotification | RideCodexServerRequest): void {
        switch (message.kind) {
            case 'response':
                this.handleResponse(message);
                return;
            case 'notification':
                this.handleNotification(message);
                return;
            case 'server-request':
                this.handleServerRequest(message);
        }
    }

    protected handleResponse(response: RideCodexResponse): void {
        const entry = typeof response.id === 'number' ? this.pending.get(response.id) : undefined;
        if (!entry) {
            throw new Error(`Codex App Server protocol error: unknown or duplicate response ID ${String(response.id)}`);
        }
        this.pending.delete(response.id as number);
        clearTimeout(entry.timer);
        if (response.error) {
            entry.reject(new RideCodexRemoteError(response.error.code, response.error.message, response.error.data));
        } else {
            entry.resolve(response.result);
        }
    }

    protected handleNotification(notification: RideCodexServerNotification): void {
        if (!notification.reviewed) {
            this.diagnoseUnknownNotification();
            return;
        }
        this.emitSafely(this.notificationListeners, {
            method: notification.method,
            params: notification.params
        }, 'notification-listener-error', 'A Codex notification listener failed.');
    }

    protected handleServerRequest(request: RideCodexServerRequest): void {
        if (!request.approved) {
            this.respondError(request.id, -32601, 'Method not found');
            return;
        }
        this.emitSafely(this.serverRequestListeners, {
            id: request.id,
            method: request.method,
            params: request.params
        }, 'server-request-listener-error', 'A Codex server request listener failed.');
    }

    protected diagnoseUnknownNotification(): void {
        if (this.unknownNotificationDiagnosticCount >= this.maxDiagnostics) {
            return;
        }
        this.unknownNotificationDiagnosticCount += 1;
        this.emitDiagnostic({
            code: 'unknown-server-notification',
            message: 'Ignored an unsupported Codex App Server notification.'
        });
    }

    protected emitSafely<T>(
        listeners: ReadonlySet<(event: T) => void>,
        event: T,
        diagnosticCode: string,
        diagnosticMessage: string
    ): void {
        for (const listener of [...listeners]) {
            try {
                listener(event);
            } catch {
                this.emitDiagnostic({ code: diagnosticCode, message: diagnosticMessage });
            }
        }
    }

    protected emitDiagnostic(diagnostic: RideCodexDiagnostic): void {
        for (const listener of [...this.diagnosticListeners]) {
            try {
                listener(diagnostic);
            } catch {
                // Diagnostics must never turn protocol handling into a transport failure.
            }
        }
    }

    protected handleExit(reason?: Error): void {
        this.shutdown(reason ?? new Error('Codex App Server transport exited'), false);
    }

    protected registerTransportListeners(): void {
        try {
            if (!this.registerTransportListener(() => this.transport.onData(chunk => this.handleData(chunk)))) {
                return;
            }
            this.registerTransportListener(() => this.transport.onExit(reason => this.handleExit(reason)));
        } catch (error) {
            this.disposeTransportListeners();
            throw error;
        }
    }

    protected registerTransportListener(factory: () => RideCodexDisposable): boolean {
        const listener = factory();
        if (this.closed) {
            disposeSafely(listener);
            return false;
        }
        this.transportListeners.push(listener);
        return true;
    }

    protected writePayload(payload: string): void {
        if (this.closed) {
            return;
        }
        try {
            this.transport.write(`${payload}\n`);
        } catch {
            this.shutdown(new Error('Codex App Server transport write failed'), true);
        }
    }

    protected writePayloadConfirmed(payload: string): Promise<void> {
        if (this.closed) {
            return containedRejection(this.closedRequestError());
        }
        let write: Promise<void>;
        try {
            write = this.transport.writeConfirmed
                ? this.transport.writeConfirmed(`${payload}\n`)
                : (this.transport.write(`${payload}\n`), Promise.resolve());
        } catch {
            const failure = new Error('Codex App Server transport write failed');
            this.shutdown(failure, true);
            return containedRejection(failure);
        }
        const operation = Promise.resolve(write).then(
            () => {
                if (this.closed) {
                    throw this.closedRequestError();
                }
            },
            () => {
                const failure = new Error('Codex App Server transport write failed');
                this.shutdown(failure, true);
                throw failure;
            }
        );
        void operation.catch(() => undefined);
        return operation;
    }

    protected shutdown(reason: Error, closeTransport: boolean): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.closeReason = reason;

        this.disposeTransportListeners();

        const pending = [...this.pending.values()];
        this.pending.clear();
        for (const entry of pending) {
            clearTimeout(entry.timer);
            entry.reject(reason);
        }

        this.notificationListeners.clear();
        this.serverRequestListeners.clear();
        this.diagnosticListeners.clear();
        this.unknownNotificationDiagnosticCount = 0;

        if (closeTransport && !this.transportCloseRequested) {
            this.transportCloseRequested = true;
            try {
                this.transport.close();
            } catch {
                // The client is already closed and all owned resources have been released.
            }
        }
    }

    protected closedRequestError(): Error {
        const suffix = this.closeReason?.message ? `: ${this.closeReason.message}` : '';
        return new Error(`Codex JSONL client is closed${suffix}`);
    }

    protected disposeTransportListeners(): void {
        for (const listener of this.transportListeners.splice(0)) {
            disposeSafely(listener);
        }
    }
}

function addListener<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void): RideCodexDisposable {
    listeners.add(listener);
    let disposed = false;
    return {
        dispose: () => {
            if (!disposed) {
                disposed = true;
                listeners.delete(listener);
            }
        }
    };
}

function validateLimit(value: number, label: string, minimum: number): number {
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new RangeError(`${label} must be a safe integer greater than or equal to ${minimum}`);
    }
    return value;
}

function serializeEnvelope(value: unknown, requiredProperties: readonly string[]): string {
    try {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
            throw new TypeError();
        }
        const envelope: unknown = JSON.parse(serialized);
        if (
            typeof envelope === 'object'
            && envelope !== null
            && !Array.isArray(envelope)
            && requiredProperties.every(property => Object.prototype.hasOwnProperty.call(envelope, property))
        ) {
            return serialized;
        }
    } catch {
        // Payload details must not be exposed through serialization diagnostics.
    }
    throw new TypeError('Unable to serialize Codex JSONL envelope');
}

function validateOutboundRequestId(id: RideCodexRequestId): void {
    if (typeof id === 'number' && Number.isSafeInteger(id)) {
        return;
    }
    if (typeof id === 'string' && id.length > 0 && id.length <= MAX_REQUEST_ID_LENGTH) {
        return;
    }
    throw new RangeError(
        `Codex response request ID must be a safe integer or a non-empty string of at most ${MAX_REQUEST_ID_LENGTH} characters`
    );
}

function disposeSafely(disposable: RideCodexDisposable): void {
    try {
        disposable.dispose();
    } catch {
        // Listener cleanup is best effort; pending requests still need deterministic rejection.
    }
}

function containedRejection(error: Error): Promise<never> {
    const rejection = Promise.reject(error);
    void rejection.catch(() => undefined);
    return rejection;
}

function asError(value: unknown, fallbackMessage: string): Error {
    return value instanceof Error ? value : new Error(fallbackMessage);
}
