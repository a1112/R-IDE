/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { types as utilTypes } from 'node:util';
import {
    deepFreezeRideCodex,
    freezeRideCodexEventBatch,
    RideCodexEventBatch,
    RideCodexFileChange,
    RideCodexItemKind,
    RideCodexPlanStep,
    RideCodexSafeError,
    RideCodexTurnClient,
    RideCodexTurnInterruptRequest,
    RideCodexTurnResult,
    RideCodexTurnStartRequest,
    RideCodexTurnSteerRequest,
    RideCodexTurnTerminalStatus,
    RideCodexUiEvent,
    truncateUtf8,
    utf8ByteLength
} from '../common/ride-codex-events';
import type { RideCodexTurnsService } from '../common/ride-codex-protocol';
import type { RideCodexDisposable, RideCodexNotification, StableClientMethod } from './ride-codex-jsonl-client';

export interface RideCodexTurnHostLease {
    readonly generation: number;
    request(method: StableClientMethod, params: unknown, timeoutMs?: number): unknown | Promise<unknown>;
    release(): void;
}

export type RideCodexTurnHostState =
    | 'stopped' | 'starting' | 'ready' | 'restarting'
    | 'stopping' | 'circuit-open' | 'disposed';

export interface RideCodexTurnHostStateEvent {
    readonly state: RideCodexTurnHostState;
    readonly generation: number;
}

export interface RideCodexTurnHost {
    acquire(kind: 'active-turn' | 'foreground-panel'): Promise<RideCodexTurnHostLease>;
    onNotification(listener: (notification: RideCodexNotification, generation: number) => void): RideCodexDisposable;
    onStateChange(listener: (event: RideCodexTurnHostStateEvent) => void): RideCodexDisposable;
    snapshot(): RideCodexTurnHostStateEvent;
    restartForRecovery(expectedGeneration: number): Promise<number>;
}

export interface RideCodexTurnScheduler {
    schedule(callback: () => void): RideCodexDisposable;
}

export interface RideCodexTurnTimers {
    setTimeout(callback: () => void, milliseconds: number): unknown;
    clearTimeout(handle: unknown): void;
}

export interface RideCodexTurnCoordinatorOptions {
    readonly host: RideCodexTurnHost;
    readonly scheduler?: RideCodexTurnScheduler;
    readonly timers?: RideCodexTurnTimers;
    readonly interruptTimeoutMs?: number;
    readonly recoveryTimeoutMs?: number;
    readonly maxQueuedBytes?: number;
    readonly maxBatchEvents?: number;
    readonly maxItemBytes?: number;
    readonly maxRetainedItems?: number;
    readonly maxDiagnosticHistory?: number;
}

export type RideCodexTurnErrorCode =
    | 'invalid-data' | 'operation-failed' | 'operation-superseded'
    | 'turn-active' | 'turn-unavailable' | 'client-disconnected' | 'disposed';

const TURN_ERROR_MESSAGES: Readonly<Record<RideCodexTurnErrorCode, string>> = Object.freeze({
    'invalid-data': 'Codex turn data is invalid.',
    'operation-failed': 'Codex turn operation failed.',
    'operation-superseded': 'Codex turn operation was superseded.',
    'turn-active': 'A Codex turn is already active.',
    'turn-unavailable': 'The requested Codex turn is not active.',
    'client-disconnected': 'The Codex turn client disconnected.',
    'disposed': 'Codex turns are disposed.'
});

export class RideCodexTurnError extends Error {
    constructor(readonly code: RideCodexTurnErrorCode) {
        super(TURN_ERROR_MESSAGES[code]);
        this.name = 'RideCodexTurnError';
    }
}

interface ClientRecord {
    readonly id: number;
    readonly client: RideCodexTurnClient;
    connected: boolean;
    inFlight: boolean;
    inFlightIdentity: QueueIdentity | undefined;
    deliveryVersion: number;
    pending: RideCodexEventBatch[];
    pendingBytes: number;
    droppedEvents: number;
    droppedBytes: number;
}

interface ActiveTurn {
    readonly owner: ClientRecord;
    readonly threadId: string;
    readonly lifecycle: number;
    readonly invalidated: Promise<never>;
    readonly invalidate: (error: RideCodexTurnError) => void;
    lease: RideCodexTurnHostLease | undefined;
    generation: number | undefined;
    turnId: string | undefined;
    terminalResult: RideCodexTurnResult | undefined;
    released: boolean;
    terminal: boolean;
    controlPending: boolean;
}

interface QueueIdentity {
    readonly generation: number;
    readonly threadId: string;
    readonly turnId: string;
}

interface QueuedEvent {
    readonly identity: QueueIdentity;
    readonly event: RideCodexUiEvent;
    readonly bytes: number;
}

interface QueueMetadata {
    readonly identity: QueueIdentity;
    droppedEvents: number;
    droppedBytes: number;
    truncated: boolean;
}

interface RetainedItem {
    readonly kind: RideCodexItemKind;
    state: 'started' | 'completed';
}

interface RawBudget {
    nodes: number;
    bytes: number;
}

const DEFAULT_INTERRUPT_TIMEOUT_MS = 5_000;
const DEFAULT_RECOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_QUEUED_BYTES = 256 * 1024;
const DEFAULT_MAX_BATCH_EVENTS = 256;
const DEFAULT_MAX_ITEM_BYTES = 64 * 1024;
const DEFAULT_MAX_RETAINED_ITEMS = 256;
const DEFAULT_MAX_DIAGNOSTIC_HISTORY = 64;
const MAX_IDENTIFIER_BYTES = 512;
const MAX_INPUT_ITEMS = 32;
const MAX_INPUT_TEXT_BYTES = 64 * 1024;
const MAX_LOCAL_PATH_BYTES = 32 * 1024;
const MAX_RAW_DEPTH = 20;
const MAX_RAW_NODES = 8_192;
const MAX_RAW_BYTES = 512 * 1024;
const MAX_RAW_KEYS = 128;
const MAX_RAW_ARRAY = 1_024;
const MAX_CLIENT_PENDING_BATCHES = 4;
const MAX_CLIENTS = 64;
const MAX_QUEUE_METADATA_IDENTITIES = 64;
const SAFE_FAILURE: RideCodexSafeError = Object.freeze({
    code: 'operation-failed',
    message: 'Codex turn operation failed.'
});

export class RideCodexTurnCoordinator {
    readonly #host: RideCodexTurnHost;
    readonly #scheduler: RideCodexTurnScheduler;
    readonly #timers: RideCodexTurnTimers;
    readonly #interruptTimeoutMs: number;
    readonly #recoveryTimeoutMs: number;
    readonly #maxQueuedBytes: number;
    readonly #maxBatchEvents: number;
    readonly #maxItemBytes: number;
    readonly #maxRetainedItems: number;
    readonly #maxDiagnosticHistory: number;
    readonly #listeners: RideCodexDisposable[] = [];
    readonly #clients = new Set<ClientRecord>();
    readonly #retainedItems = new Map<string, RetainedItem>();
    readonly #diagnostics: RideCodexUiEvent[] = [];
    readonly #queue: QueuedEvent[] = [];
    readonly #queueMetadata = new Map<string, QueueMetadata>();
    readonly #releasedLeases = new WeakSet<object>();
    readonly #disposedSignal: Promise<never>;
    readonly #rejectDisposed: (error: RideCodexTurnError) => void;
    #queueIdentity: QueueIdentity | undefined;
    #queuedBytes = 0;
    #flushHandle: RideCodexDisposable | undefined;
    #active: ActiveTurn | undefined;
    #generation: number;
    #lifecycle = 0;
    #nextClientId = 1;
    #disposed = false;

    constructor(options: RideCodexTurnCoordinatorOptions) {
        if (!options.host || typeof options.host.acquire !== 'function'
            || typeof options.host.onNotification !== 'function'
            || typeof options.host.onStateChange !== 'function'
            || typeof options.host.snapshot !== 'function') {
            throw new RideCodexTurnError('operation-failed');
        }
        this.#host = options.host;
        this.#scheduler = options.scheduler ?? defaultScheduler;
        this.#timers = options.timers ?? defaultTimers;
        this.#interruptTimeoutMs = positiveLimit(options.interruptTimeoutMs, DEFAULT_INTERRUPT_TIMEOUT_MS);
        this.#recoveryTimeoutMs = positiveLimit(options.recoveryTimeoutMs, DEFAULT_RECOVERY_TIMEOUT_MS);
        this.#maxQueuedBytes = positiveLimit(options.maxQueuedBytes, DEFAULT_MAX_QUEUED_BYTES);
        this.#maxBatchEvents = positiveLimit(options.maxBatchEvents, DEFAULT_MAX_BATCH_EVENTS);
        this.#maxItemBytes = positiveLimit(options.maxItemBytes, DEFAULT_MAX_ITEM_BYTES);
        this.#maxRetainedItems = positiveLimit(options.maxRetainedItems, DEFAULT_MAX_RETAINED_ITEMS);
        this.#maxDiagnosticHistory = positiveLimit(options.maxDiagnosticHistory, DEFAULT_MAX_DIAGNOSTIC_HISTORY);
        let rejectDisposed!: (error: RideCodexTurnError) => void;
        this.#disposedSignal = new Promise<never>((_resolve, reject) => {
            rejectDisposed = reject;
        });
        this.#disposedSignal.catch(() => undefined);
        this.#rejectDisposed = rejectDisposed;
        try {
            this.#generation = requireGeneration(this.#host.snapshot().generation);
            this.#listeners.push(this.#host.onNotification((notification, generation) => {
                this.#onNotification(notification, generation);
            }));
            this.#listeners.push(this.#host.onStateChange(event => this.#onHostStateChange(event)));
        } catch {
            for (const listener of this.#listeners.splice(0)) {
                disposeSafely(listener);
            }
            throw new RideCodexTurnError('operation-failed');
        }
    }

    connectClient(client: RideCodexTurnClient): RideCodexTurnsService {
        this.#requireUsable();
        if (!client || typeof client.turnEvents !== 'function') {
            throw new RideCodexTurnError('invalid-data');
        }
        if (this.#clients.size >= MAX_CLIENTS) {
            throw new RideCodexTurnError('operation-failed');
        }
        const record: ClientRecord = {
            id: this.#nextClientId++, client, connected: true, inFlight: false,
            inFlightIdentity: undefined, deliveryVersion: 0, pending: [], pendingBytes: 0,
            droppedEvents: 0, droppedBytes: 0
        };
        this.#clients.add(record);
        let disposed = false;
        return Object.freeze({
            setClient: () => undefined,
            startTurn: (request: RideCodexTurnStartRequest) => this.#startTurn(record, request),
            steerTurn: (request: RideCodexTurnSteerRequest) => this.#steerTurn(record, request),
            interruptTurn: (request: RideCodexTurnInterruptRequest) => this.#interruptTurn(record, request),
            disconnectClient: () => this.#disconnect(record),
            dispose: () => {
                if (!disposed) {
                    disposed = true;
                    this.#disconnect(record);
                }
            }
        });
    }

    disconnectClient(client: RideCodexTurnClient): void {
        const record = [...this.#clients].find(candidate => candidate.client === client);
        if (record) {
            this.#disconnect(record);
        }
    }

    async dispose(): Promise<void> {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        this.#lifecycle += 1;
        this.#rejectDisposed(new RideCodexTurnError('disposed'));
        this.#finishActive('failed', SAFE_FAILURE, new RideCodexTurnError('disposed'), false);
        this.#flushHandle?.dispose();
        this.#flushHandle = undefined;
        this.#queue.length = 0;
        this.#queuedBytes = 0;
        this.#queueIdentity = undefined;
        this.#queueMetadata.clear();
        for (const listener of this.#listeners.splice(0)) {
            disposeSafely(listener);
        }
        for (const client of [...this.#clients]) {
            this.#disconnect(client, false);
        }
        this.#clients.clear();
    }

    onStop(): Promise<void> {
        return this.dispose();
    }

    async #startTurn(owner: ClientRecord, input: RideCodexTurnStartRequest): Promise<RideCodexTurnResult> {
        this.#requireClient(owner);
        if (this.#active) {
            throw new RideCodexTurnError('turn-active');
        }
        const request = normalizeStartRequest(input);
        const active = this.#newActive(owner, request.threadId);
        this.#active = active;
        try {
            const acquiring = this.#acquireForActive(active);
            const lease = await Promise.race([acquiring, active.invalidated]);
            const params = Object.freeze({
                threadId: request.threadId,
                ...(request.clientMessageId === undefined ? {} : { clientUserMessageId: request.clientMessageId }),
                input: Object.freeze(request.input.map(toServerInput))
            });
            const pending = safePromise(lease.request('turn/start', params));
            const raw = await Promise.race([pending, active.invalidated]);
            const response = requireRecord(raw);
            const turn = requireRecord(ownValue(response, 'turn'));
            const turnId = requireIdentifier(ownValue(turn, 'id'));
            const status = normalizeServerTurnStatus(ownValue(turn, 'status'));
            this.#establishTurn(active, turnId);
            if (status !== 'in-progress') {
                this.#finishActive(status, status === 'failed' ? SAFE_FAILURE : undefined, undefined, true, true);
            }
            return Object.freeze({ threadId: request.threadId, turnId, status });
        } catch (error) {
            if (active.terminalResult) {
                return active.terminalResult;
            }
            if (this.#active === active) {
                this.#finishActive('failed', SAFE_FAILURE, undefined, active.turnId !== undefined);
            }
            throw stableTurnError(error, this.#disposed ? 'disposed' : 'operation-failed');
        }
    }

    async #steerTurn(owner: ClientRecord, input: RideCodexTurnSteerRequest): Promise<RideCodexTurnResult> {
        this.#requireClient(owner);
        const request = normalizeSteerRequest(input);
        const active = this.#requireActive(owner, request.threadId, request.expectedTurnId);
        if (active.controlPending) {
            throw new RideCodexTurnError('operation-superseded');
        }
        active.controlPending = true;
        try {
            const lease = active.lease;
            if (!lease) {
                throw new RideCodexTurnError('turn-unavailable');
            }
            const params = Object.freeze({
                threadId: request.threadId,
                ...(request.clientMessageId === undefined ? {} : { clientUserMessageId: request.clientMessageId }),
                input: Object.freeze(request.input.map(toServerInput)),
                expectedTurnId: request.expectedTurnId
            });
            const raw = await Promise.race([safePromise(lease.request('turn/steer', params)), active.invalidated]);
            const response = requireRecord(raw);
            const responseTurnId = requireIdentifier(ownValue(response, 'turnId'));
            if (responseTurnId !== request.expectedTurnId || this.#active !== active || active.terminal) {
                throw new RideCodexTurnError('operation-superseded');
            }
            return Object.freeze({ threadId: active.threadId, turnId: responseTurnId, status: 'in-progress' });
        } catch (error) {
            if (active.terminalResult) {
                return active.terminalResult;
            }
            if (this.#active === active) {
                this.#finishActive('failed', SAFE_FAILURE);
            }
            throw stableTurnError(error, 'operation-failed');
        } finally {
            if (this.#active === active) {
                active.controlPending = false;
            }
        }
    }

    async #interruptTurn(owner: ClientRecord, input: RideCodexTurnInterruptRequest): Promise<RideCodexTurnResult> {
        this.#requireClient(owner);
        const request = normalizeInterruptRequest(input);
        const active = this.#requireActive(owner, request.threadId, request.turnId);
        if (active.controlPending) {
            throw new RideCodexTurnError('operation-superseded');
        }
        const lease = active.lease;
        if (!lease || active.generation === undefined) {
            throw new RideCodexTurnError('turn-unavailable');
        }
        active.controlPending = true;
        const expectedGeneration = active.generation;
        let timer: unknown;
        let timedOut = false;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = this.#timers.setTimeout(() => {
                if (this.#active === active && !active.terminal) {
                    timedOut = true;
                    this.#finishActive('interrupt-uncertain', Object.freeze({
                        code: 'interrupt-timeout', message: 'Codex turn interrupt could not be confirmed.'
                    }), undefined, true, true);
                }
                reject(new RideCodexInterruptTimeout());
            }, this.#interruptTimeoutMs);
        });
        timeout.catch(() => undefined);
        try {
            await Promise.race([
                safePromise(lease.request('turn/interrupt', Object.freeze({
                    threadId: request.threadId,
                    turnId: request.turnId
                }), this.#interruptTimeoutMs)),
                active.invalidated,
                timeout
            ]);
            return Object.freeze({
                threadId: active.threadId,
                turnId: request.turnId,
                status: 'in-progress'
            });
        } catch (error) {
            if (timedOut) {
                await this.#recoverPersistentThread(request.threadId, expectedGeneration);
                return active.terminalResult ?? Object.freeze({
                    threadId: request.threadId,
                    turnId: request.turnId,
                    status: 'interrupt-uncertain'
                });
            }
            if (active.terminalResult) {
                return active.terminalResult;
            }
            if (this.#disposed) {
                throw new RideCodexTurnError('disposed');
            }
            if (this.#active === active) {
                this.#finishActive('failed', SAFE_FAILURE);
            }
            throw stableTurnError(error, 'operation-failed');
        } finally {
            if (timer !== undefined) {
                this.#timers.clearTimeout(timer);
            }
            if (this.#active === active) {
                active.controlPending = false;
            }
        }
    }

    async #recoverPersistentThread(threadId: string, expectedGeneration: number): Promise<void> {
        const lifecycle = this.#lifecycle;
        try {
            const restarting = Promise.resolve(this.#host.restartForRecovery(expectedGeneration));
            restarting.catch(() => undefined);
            const generation = requireGeneration(await Promise.race([restarting, this.#disposedSignal]));
            if (this.#disposed || lifecycle !== this.#lifecycle) {
                throw new RideCodexTurnError(this.#disposed ? 'disposed' : 'operation-superseded');
            }
            const acquiring = Promise.resolve(this.#host.acquire('foreground-panel'));
            acquiring.then(acquiredLease => {
                if (this.#disposed || lifecycle !== this.#lifecycle) {
                    this.#releaseLease(acquiredLease);
                }
            }, () => undefined);
            const lease = await Promise.race([acquiring, this.#disposedSignal]);
            try {
                if (lease.generation !== generation || this.#disposed || lifecycle !== this.#lifecycle) {
                    throw new RideCodexTurnError('operation-superseded');
                }
                const raw = await Promise.race([
                    safePromise(lease.request('thread/resume', Object.freeze({
                        threadId
                    }), this.#recoveryTimeoutMs)),
                    this.#disposedSignal
                ]);
                const response = requireRecord(raw);
                const resumedThread = requireRecord(ownValue(response, 'thread'));
                if (requireIdentifier(ownValue(resumedThread, 'id')) !== threadId) {
                    throw new RideCodexTurnError('invalid-data');
                }
            } finally {
                this.#releaseLease(lease);
            }
        } catch (error) {
            if (!this.#disposed) {
                this.#enqueueDiagnostic(Object.freeze({
                    type: 'error', code: 'recovery-failed',
                    message: 'Codex thread recovery failed.', retryable: false
                }));
            }
            if (error instanceof RideCodexTurnError && error.code === 'disposed') {
                throw error;
            }
        }
    }

    #newActive(owner: ClientRecord, threadId: string): ActiveTurn {
        let invalidated = false;
        let rejectInvalidated!: (error: RideCodexTurnError) => void;
        const invalidation = new Promise<never>((_resolve, reject) => {
            rejectInvalidated = reject;
        });
        invalidation.catch(() => undefined);
        return {
            owner, threadId, lifecycle: this.#lifecycle, invalidated: invalidation,
            invalidate: error => {
                if (!invalidated) {
                    invalidated = true;
                    rejectInvalidated(error);
                }
            },
            lease: undefined, generation: undefined, turnId: undefined,
            terminalResult: undefined,
            released: false, terminal: false, controlPending: false
        };
    }

    async #acquireForActive(active: ActiveTurn): Promise<RideCodexTurnHostLease> {
        let acquiring: Promise<RideCodexTurnHostLease>;
        try {
            acquiring = Promise.resolve(this.#host.acquire('active-turn'));
        } catch {
            throw new RideCodexTurnError('operation-failed');
        }
        acquiring.then(acquiredLease => {
            if (this.#active !== active || active.terminal || this.#disposed) {
                this.#releaseLease(acquiredLease);
            }
        }, () => undefined);
        const lease = await acquiring;
        const generation = requireGeneration(lease.generation);
        if (this.#active !== active || active.terminal || this.#disposed) {
            this.#releaseLease(lease);
            throw new RideCodexTurnError(this.#disposed ? 'disposed' : 'operation-superseded');
        }
        active.lease = lease;
        active.generation = generation;
        return lease;
    }

    #establishTurn(active: ActiveTurn, turnId: string): void {
        if (this.#active !== active || active.terminal || active.generation === undefined) {
            throw new RideCodexTurnError('operation-superseded');
        }
        if (active.turnId !== undefined && active.turnId !== turnId) {
            throw new RideCodexTurnError('invalid-data');
        }
        if (active.turnId === undefined) {
            active.turnId = turnId;
            this.#queueIdentity = Object.freeze({
                generation: active.generation,
                threadId: active.threadId,
                turnId
            });
            this.#enqueue(Object.freeze({ type: 'turn-started' }));
        }
    }

    #requireActive(owner: ClientRecord, threadId: string, turnId: string): ActiveTurn {
        const active = this.#active;
        if (!active || active.terminal || active.owner !== owner
            || active.threadId !== threadId || active.turnId !== turnId) {
            throw new RideCodexTurnError('turn-unavailable');
        }
        return active;
    }

    #finishActive(
        status: RideCodexTurnTerminalStatus,
        error?: RideCodexSafeError,
        invalidation = new RideCodexTurnError('operation-superseded'),
        emit = true,
        linearize = false
    ): void {
        const active = this.#active;
        if (!active || active.terminal) {
            return;
        }
        active.terminal = true;
        if (linearize && active.turnId !== undefined) {
            active.terminalResult = Object.freeze({
                threadId: active.threadId,
                turnId: active.turnId,
                status
            });
        }
        if (emit && active.turnId !== undefined) {
            this.#queueIdentity = Object.freeze({
                generation: active.generation ?? this.#generation,
                threadId: active.threadId,
                turnId: active.turnId
            });
            this.#enqueue(Object.freeze({
                type: 'turn-terminal', status,
                ...(error === undefined ? {} : { error })
            }));
        }
        active.invalidate(invalidation);
        this.#releaseActive(active);
        if (this.#active === active) {
            this.#active = undefined;
        }
        this.#retainedItems.clear();
    }

    #releaseActive(active: ActiveTurn): void {
        if (active.released) {
            return;
        }
        active.released = true;
        if (active.lease) {
            this.#releaseLease(active.lease);
        }
    }

    #onNotification(notification: RideCodexNotification, generation: number): void {
        const active = this.#active;
        if (this.#disposed || !active || active.terminal || !Number.isSafeInteger(generation)
            || active.generation !== generation || generation !== this.#generation) {
            return;
        }
        try {
            if (!notification || utilTypes.isProxy(notification)) {
                return;
            }
            switch (notification.method) {
                case 'turn/started':
                    this.#onTurnStarted(active, notification.params);
                    return;
                case 'turn/completed':
                    this.#onTurnCompleted(active, notification.params);
                    return;
                case 'warning':
                    this.#onWarning(active, notification.params);
                    return;
                default:
                    this.#onActiveNotification(active, notification.method, notification.params);
            }
        } catch {
            // Untrusted App Server data never mutates trusted turn state.
        }
    }

    #onTurnStarted(active: ActiveTurn, raw: unknown): void {
        const params = requireRecord(raw);
        if (requireIdentifier(ownValue(params, 'threadId')) !== active.threadId) {
            return;
        }
        const turn = requireRecord(ownValue(params, 'turn'));
        this.#establishTurn(active, requireIdentifier(ownValue(turn, 'id')));
    }

    #onTurnCompleted(active: ActiveTurn, raw: unknown): void {
        const params = requireRecord(raw);
        if (requireIdentifier(ownValue(params, 'threadId')) !== active.threadId) {
            return;
        }
        const turn = requireRecord(ownValue(params, 'turn'));
        const turnId = requireIdentifier(ownValue(turn, 'id'));
        if (active.turnId !== turnId) {
            return;
        }
        const status = normalizeServerTurnStatus(ownValue(turn, 'status'));
        if (status === 'in-progress') {
            return;
        }
        this.#finishActive(status, status === 'failed' ? Object.freeze({
            code: 'turn-error', message: 'Codex turn failed.'
        }) : undefined, undefined, true, true);
    }

    #onWarning(active: ActiveTurn, raw: unknown): void {
        const params = requireRecord(raw);
        const target = ownValue(params, 'threadId');
        if (!isNullish(target) && requireIdentifier(target) !== active.threadId) {
            return;
        }
        this.#enqueueDiagnostic(Object.freeze({
            type: 'warning', code: 'server-warning',
            message: sanitizeMessage(requireString(ownValue(params, 'message'), this.#maxItemBytes))
        }));
    }

    #onActiveNotification(active: ActiveTurn, method: string, raw: unknown): void {
        const params = requireRecord(raw);
        const threadId = requireIdentifier(ownValue(params, 'threadId'));
        const turnId = requireIdentifier(ownValue(params, 'turnId'));
        if (threadId !== active.threadId || turnId !== active.turnId) {
            return;
        }
        switch (method) {
            case 'item/started':
            case 'item/completed': {
                const item = requireRecord(ownValue(params, 'item'));
                const itemId = requireIdentifier(ownValue(item, 'id'));
                const itemKind = normalizeItemKind(ownValue(item, 'type'));
                if (method === 'item/started') {
                    if (this.#retainedItems.has(itemId)) {
                        return;
                    }
                    this.#retainedItems.set(itemId, { kind: itemKind, state: 'started' });
                    this.#trimRetainedItems();
                } else {
                    const retained = this.#retainedItems.get(itemId);
                    if (retained?.state === 'completed') {
                        return;
                    }
                    this.#retainedItems.set(itemId, {
                        kind: retained?.kind ?? itemKind,
                        state: 'completed'
                    });
                    this.#trimRetainedItems();
                }
                this.#enqueue(Object.freeze({
                    type: method === 'item/started' ? 'item-started' : 'item-completed',
                    itemId, itemKind
                }));
                return;
            }
            case 'item/agentMessage/delta':
                if (!this.#isItemOpen(params)) {
                    return;
                }
                this.#enqueueDelta('agent-delta', params);
                return;
            case 'item/plan/delta':
                if (!this.#isItemOpen(params)) {
                    return;
                }
                this.#enqueueDelta('plan-delta', params);
                return;
            case 'item/commandExecution/outputDelta':
                if (!this.#isItemOpen(params)) {
                    return;
                }
                this.#enqueueDelta('command-output', params);
                return;
            case 'item/fileChange/outputDelta':
                if (!this.#isItemOpen(params)) {
                    return;
                }
                this.#enqueueDelta('file-output', params);
                return;
            case 'item/reasoning/summaryTextDelta': {
                const itemId = requireIdentifier(ownValue(params, 'itemId'));
                if (this.#retainedItems.get(itemId)?.state !== 'started') {
                    return;
                }
                const summaryIndex = requireIndex(ownValue(params, 'summaryIndex'));
                const delta = this.#boundedStreamText(ownValue(params, 'delta'));
                this.#enqueueCoalesced(Object.freeze({
                    type: 'reasoning-summary-delta', itemId, summaryIndex, delta
                }));
                return;
            }
            case 'item/reasoning/summaryPartAdded':
                if (!this.#isItemOpen(params)) {
                    return;
                }
                this.#enqueue(Object.freeze({
                    type: 'reasoning-summary-part',
                    itemId: requireIdentifier(ownValue(params, 'itemId')),
                    summaryIndex: requireIndex(ownValue(params, 'summaryIndex'))
                }));
                return;
            case 'item/reasoning/textDelta': {
                const itemId = requireIdentifier(ownValue(params, 'itemId'));
                if (this.#retainedItems.get(itemId)?.state !== 'started') {
                    return;
                }
                const contentIndex = requireIndex(ownValue(params, 'contentIndex'));
                const delta = this.#boundedStreamText(ownValue(params, 'delta'));
                this.#enqueueCoalesced(Object.freeze({
                    type: 'reasoning-delta', itemId, contentIndex, delta
                }));
                return;
            }
            case 'item/fileChange/patchUpdated': {
                const patchParams = requireOptions(params, ['threadId', 'turnId', 'itemId', 'changes']);
                if (!this.#isItemOpen(patchParams)) {
                    return;
                }
                this.#enqueue(Object.freeze({
                    type: 'file-patch',
                    itemId: requireIdentifier(ownValue(patchParams, 'itemId')),
                    changes: normalizeFileChanges(ownValue(patchParams, 'changes'), this.#maxRetainedItems)
                }));
                return;
            }
            case 'turn/plan/updated':
                this.#enqueue(Object.freeze({
                    type: 'turn-plan',
                    ...normalizeExplanation(params, this.#maxItemBytes),
                    steps: normalizePlan(ownValue(params, 'plan'), this.#maxRetainedItems)
                }));
                return;
            case 'turn/diff/updated':
                this.#enqueue(Object.freeze({
                    type: 'turn-diff', diff: requireString(ownValue(params, 'diff'), this.#maxItemBytes)
                }));
                return;
            case 'thread/tokenUsage/updated':
                this.#enqueue(normalizeTokenUsage(ownValue(params, 'tokenUsage')));
                return;
            case 'error':
                this.#enqueueDiagnostic(Object.freeze({
                    type: 'error', code: 'turn-error', message: 'Codex turn failed.',
                    retryable: ownValue(params, 'willRetry') === true
                }));
                return;
            default:
                return;
        }
    }

    #enqueueDelta(type: 'agent-delta' | 'plan-delta' | 'command-output' | 'file-output', params: Record<string, unknown>): void {
        this.#enqueueCoalesced(Object.freeze({
            type,
            itemId: requireIdentifier(ownValue(params, 'itemId')),
            delta: this.#boundedStreamText(ownValue(params, 'delta'))
        }));
    }

    #boundedStreamText(value: unknown): string {
        const raw = requireString(value, MAX_INPUT_TEXT_BYTES);
        const bounded = truncateUtf8(raw, this.#maxItemBytes);
        if (bounded !== raw) {
            this.#enqueueDiagnostic(Object.freeze({
                type: 'warning',
                code: 'data-truncated',
                message: 'A Codex streaming item was truncated to preserve responsiveness.'
            }));
        }
        return bounded;
    }

    #isItemOpen(params: Record<string, unknown>): boolean {
        const itemId = requireIdentifier(ownValue(params, 'itemId'));
        return this.#retainedItems.get(itemId)?.state === 'started';
    }

    #enqueueCoalesced(event: Extract<RideCodexUiEvent, { delta: string }>): void {
        const previous = this.#queue[this.#queue.length - 1];
        const identity = this.#queueIdentity;
        if (previous && identity && sameIdentity(previous.identity, identity)
            && 'delta' in previous.event && previous.event.type === event.type
            && previous.event.itemId === event.itemId
            && (event.type !== 'reasoning-summary-delta'
                || ('summaryIndex' in previous.event && previous.event.summaryIndex === event.summaryIndex))
            && (event.type !== 'reasoning-delta'
                || ('contentIndex' in previous.event && previous.event.contentIndex === event.contentIndex))) {
            const combined = previous.event.delta + event.delta;
            const merged = truncateUtf8(combined, this.#maxItemBytes);
            const replacement = Object.freeze({ ...previous.event, delta: merged }) as RideCodexUiEvent;
            const replacementBytes = queueEventBytes(replacement);
            if (this.#queuedBytes - previous.bytes + replacementBytes < this.#maxQueuedBytes) {
                this.#queue[this.#queue.length - 1] = Object.freeze({
                    identity: previous.identity,
                    event: replacement,
                    bytes: replacementBytes
                });
                this.#queuedBytes = this.#queuedBytes - previous.bytes + replacementBytes;
                if (merged !== combined) {
                    this.#recordTruncation(identity);
                }
                this.#scheduleFlush();
                return;
            }
        }
        this.#enqueue(event);
    }

    #enqueueDiagnostic(event: Extract<RideCodexUiEvent, { type: 'warning' | 'error' }>): void {
        this.#diagnostics.push(event);
        this.#diagnostics.splice(0, Math.max(0, this.#diagnostics.length - this.#maxDiagnosticHistory));
        this.#enqueue(event);
    }

    #enqueue(event: RideCodexUiEvent): void {
        if (!this.#queueIdentity) {
            return;
        }
        const bounded = boundEvent(event, this.#maxItemBytes, this.#maxRetainedItems);
        const bytes = queueEventBytes(bounded);
        if (bounded.type === 'turn-terminal') {
            this.#makeRoomForTerminal(bytes);
        }
        if (bytes >= this.#maxQueuedBytes || this.#queuedBytes + bytes >= this.#maxQueuedBytes) {
            this.#recordDrop(this.#queueIdentity, bytes);
            this.#scheduleFlush();
            return;
        }
        this.#queue.push(Object.freeze({ identity: this.#queueIdentity, event: bounded, bytes }));
        this.#queuedBytes += bytes;
        this.#scheduleFlush();
    }

    #makeRoomForTerminal(bytes: number): void {
        while (this.#queuedBytes + bytes >= this.#maxQueuedBytes) {
            const index = this.#queue.findIndex(entry =>
                entry.event.type !== 'turn-started' && entry.event.type !== 'turn-terminal'
            );
            if (index < 0) {
                break;
            }
            const [removed] = this.#queue.splice(index, 1);
            this.#queuedBytes -= removed.bytes;
            this.#recordDrop(removed.identity, removed.bytes);
        }
    }

    #recordDrop(identity: QueueIdentity, bytes: number): void {
        const metadata = this.#metadataFor(identity);
        metadata.droppedEvents = Math.min(Number.MAX_SAFE_INTEGER, metadata.droppedEvents + 1);
        metadata.droppedBytes = Math.min(
            Number.MAX_SAFE_INTEGER,
            metadata.droppedBytes + Math.min(bytes, this.#maxQueuedBytes)
        );
    }

    #recordTruncation(identity: QueueIdentity): void {
        this.#metadataFor(identity).truncated = true;
    }

    #metadataFor(identity: QueueIdentity): QueueMetadata {
        const key = queueIdentityKey(identity);
        const existing = this.#queueMetadata.get(key);
        if (existing) {
            return existing;
        }
        if (this.#queueMetadata.size >= MAX_QUEUE_METADATA_IDENTITIES) {
            const oldest = this.#queueMetadata.keys().next().value as string | undefined;
            if (oldest !== undefined) {
                this.#queueMetadata.delete(oldest);
            }
        }
        const metadata: QueueMetadata = {
            identity, droppedEvents: 0, droppedBytes: 0, truncated: false
        };
        this.#queueMetadata.set(key, metadata);
        return metadata;
    }

    #scheduleFlush(): void {
        if (!this.#flushHandle && this.#queueIdentity) {
            this.#flushHandle = this.#scheduler.schedule(() => this.#flush());
        }
    }

    #flush(): void {
        this.#flushHandle = undefined;
        const first = this.#queue[0];
        const firstMetadata = this.#queueMetadata.values().next().value as QueueMetadata | undefined;
        const identity = first?.identity ?? firstMetadata?.identity;
        if (!identity) {
            return;
        }
        const metadataKey = queueIdentityKey(identity);
        const metadata = this.#queueMetadata.get(metadataKey);
        const events: RideCodexUiEvent[] = [];
        while (events.length < this.#maxBatchEvents && this.#queue.length > 0
            && sameIdentity(this.#queue[0].identity, identity)) {
            const entry = this.#queue.shift() as QueuedEvent;
            this.#queuedBytes -= entry.bytes;
            events.push(entry.event);
        }
        if (metadata && metadata.droppedEvents > 0 && events.length < this.#maxBatchEvents) {
            const warning = Object.freeze({
                type: 'warning', code: 'events-dropped',
                message: 'Some Codex streaming events were dropped to preserve responsiveness.',
                droppedEvents: metadata.droppedEvents,
                droppedBytes: metadata.droppedBytes
            } as const);
            if (eventArrayBytes([...events, warning]) <= this.#maxQueuedBytes) {
                events.push(warning);
                metadata.droppedEvents = 0;
                metadata.droppedBytes = 0;
            }
        }
        if (metadata?.truncated && events.length < this.#maxBatchEvents) {
            const warning = Object.freeze({
                type: 'warning', code: 'data-truncated',
                message: 'A Codex streaming item was truncated to preserve responsiveness.'
            } as const);
            if (eventArrayBytes([...events, warning]) <= this.#maxQueuedBytes) {
                events.push(warning);
                metadata.truncated = false;
            }
        }
        if (metadata && metadata.droppedEvents === 0 && !metadata.truncated) {
            this.#queueMetadata.delete(metadataKey);
        }
        const batch = freezeRideCodexEventBatch({ ...identity, events });
        for (const client of [...this.#clients]) {
            this.#deliver(client, batch);
        }
        if (this.#queue.length > 0 || this.#queueMetadata.size > 0) {
            this.#scheduleFlush();
        }
    }

    #deliver(client: ClientRecord, batch: RideCodexEventBatch): void {
        if (!client.connected) {
            return;
        }
        if (client.inFlight) {
            this.#queueClientDelivery(client, batch);
            return;
        }
        let delivery: void | Promise<void>;
        client.inFlightIdentity = Object.freeze({
            generation: batch.generation, threadId: batch.threadId, turnId: batch.turnId
        });
        try {
            delivery = client.client.turnEvents(batch);
        } catch {
            this.#disconnect(client);
            return;
        }
        if (!delivery) {
            client.inFlightIdentity = undefined;
            this.#drainClient(client);
            return;
        }
        let then: ((resolve: () => void, reject: (error: unknown) => void) => unknown) | undefined;
        try {
            if (typeof delivery !== 'object' || utilTypes.isProxy(delivery)) {
                this.#disconnect(client);
                return;
            }
            const candidate = (delivery as Promise<void>).then;
            if (typeof candidate !== 'function') {
                client.inFlightIdentity = undefined;
                this.#drainClient(client);
                return;
            }
            then = candidate.bind(delivery);
        } catch {
            this.#disconnect(client);
            return;
        }
        client.inFlight = true;
        const version = ++client.deliveryVersion;
        const settled = new Promise<void>((resolve, reject) => {
            try {
                then?.(resolve, reject);
            } catch (error) {
                reject(error);
            }
        });
        settled.then(
            () => this.#finishDelivery(client, version),
            () => this.#disconnect(client)
        );
    }

    #finishDelivery(client: ClientRecord, version: number): void {
        if (!client.connected || client.deliveryVersion !== version) {
            return;
        }
        client.inFlight = false;
        client.inFlightIdentity = undefined;
        this.#drainClient(client);
    }

    #queueClientDelivery(client: ClientRecord, batch: RideCodexEventBatch): void {
        const previous = client.pending[client.pending.length - 1];
        if (previous && previous.generation === batch.generation
            && previous.threadId === batch.threadId && previous.turnId === batch.turnId) {
            const merged = mergeBatches(previous, batch, this.#maxBatchEvents, this.#maxQueuedBytes);
            client.pendingBytes -= batchBytes(previous);
            client.pending[client.pending.length - 1] = merged;
            client.pendingBytes += batchBytes(merged);
        } else {
            client.pending.push(batch);
            client.pendingBytes += batchBytes(batch);
        }
        while (client.pending.length > MAX_CLIENT_PENDING_BATCHES
            || client.pendingBytes > this.#maxQueuedBytes) {
            const removable = client.pending.findIndex(candidate =>
                !client.inFlightIdentity || !sameBatchIdentity(candidate, client.inFlightIdentity)
            );
            if (removable < 0) {
                break;
            }
            const identity = client.pending[removable];
            for (let index = client.pending.length - 1; index >= 0; index -= 1) {
                const candidate = client.pending[index];
                if (candidate.generation !== identity.generation
                    || candidate.threadId !== identity.threadId || candidate.turnId !== identity.turnId) {
                    continue;
                }
                const [removed] = client.pending.splice(index, 1);
                const removedBytes = batchBytes(removed);
                client.pendingBytes -= removedBytes;
                client.droppedEvents = Math.min(
                    Number.MAX_SAFE_INTEGER,
                    client.droppedEvents + removed.events.reduce((sum, event) =>
                        sum + (event.type === 'warning' && event.code === 'events-dropped'
                            ? event.droppedEvents ?? 1 : 1), 0)
                );
                client.droppedBytes = Math.min(
                    Number.MAX_SAFE_INTEGER,
                    client.droppedBytes + Math.min(removedBytes, this.#maxQueuedBytes)
                );
            }
        }
    }

    #drainClient(client: ClientRecord): void {
        while (client.connected && !client.inFlight && client.pending.length > 0) {
            const pending = client.pending.shift() as RideCodexEventBatch;
            client.pendingBytes -= batchBytes(pending);
            const batch = this.#withClientDropWarning(client, pending);
            this.#deliver(client, batch);
        }
    }

    #withClientDropWarning(client: ClientRecord, batch: RideCodexEventBatch): RideCodexEventBatch {
        if (client.droppedEvents === 0) {
            return batch;
        }
        const events = [...batch.events];
        const warningFor = (): Extract<RideCodexUiEvent, { type: 'warning' }> => Object.freeze({
            type: 'warning', code: 'events-dropped',
            message: 'Some Codex frontend deliveries were dropped to preserve responsiveness.',
            droppedEvents: client.droppedEvents,
            droppedBytes: client.droppedBytes
        });
        let warning = warningFor();
        while (events.length >= this.#maxBatchEvents
            || batchBytes({ ...batch, events: [...events, warning] }) > this.#maxQueuedBytes) {
            const removable = findLastIndex(events, event =>
                event.type !== 'turn-started' && event.type !== 'turn-terminal'
            );
            if (removable < 0) {
                return batch;
            }
            const [removed] = events.splice(removable, 1);
            client.droppedEvents = Math.min(Number.MAX_SAFE_INTEGER, client.droppedEvents + 1);
            client.droppedBytes = Math.min(
                Number.MAX_SAFE_INTEGER,
                client.droppedBytes + Math.min(eventBytes(removed), this.#maxQueuedBytes)
            );
            warning = warningFor();
        }
        const terminalIndex = events.findIndex(event => event.type === 'turn-terminal');
        events.splice(terminalIndex < 0 ? events.length : terminalIndex, 0, warning);
        client.droppedEvents = 0;
        client.droppedBytes = 0;
        return freezeRideCodexEventBatch({ ...batch, events });
    }

    #disconnect(client: ClientRecord, terminateOwnedTurn = true): void {
        if (!client.connected) {
            return;
        }
        client.connected = false;
        client.deliveryVersion += 1;
        client.pending.length = 0;
        client.pendingBytes = 0;
        client.droppedEvents = 0;
        client.droppedBytes = 0;
        client.inFlight = false;
        client.inFlightIdentity = undefined;
        this.#clients.delete(client);
        if (terminateOwnedTurn && this.#active?.owner === client) {
            this.#finishActive('interrupted', undefined, new RideCodexTurnError('client-disconnected'));
        }
    }

    #onHostStateChange(event: RideCodexTurnHostStateEvent): void {
        if (this.#disposed || !Number.isSafeInteger(event.generation) || event.generation < this.#generation) {
            return;
        }
        if (event.generation > this.#generation) {
            this.#generation = event.generation;
        }
        const active = this.#active;
        if (!active) {
            return;
        }
        const terminalHost = event.state === 'stopped' || event.state === 'restarting'
            || event.state === 'stopping' || event.state === 'circuit-open' || event.state === 'disposed';
        if (terminalHost || (active.generation !== undefined && active.generation !== event.generation)) {
            this.#finishActive('failed', SAFE_FAILURE, new RideCodexTurnError(
                event.state === 'disposed' ? 'disposed' : 'operation-superseded'
            ));
        }
    }

    #trimRetainedItems(): void {
        while (this.#retainedItems.size > this.#maxRetainedItems) {
            const oldest = this.#retainedItems.keys().next().value;
            if (oldest === undefined) {
                return;
            }
            this.#retainedItems.delete(oldest);
        }
    }

    #releaseLease(lease: RideCodexTurnHostLease): void {
        if (this.#releasedLeases.has(lease)) {
            return;
        }
        this.#releasedLeases.add(lease);
        releaseSafely(lease);
    }

    #requireClient(client: ClientRecord): void {
        this.#requireUsable();
        if (!client.connected || !this.#clients.has(client)) {
            throw new RideCodexTurnError('client-disconnected');
        }
    }

    #requireUsable(): void {
        if (this.#disposed) {
            throw new RideCodexTurnError('disposed');
        }
    }
}

class RideCodexInterruptTimeout extends Error { }

function normalizeStartRequest(value: RideCodexTurnStartRequest): RideCodexTurnStartRequest {
    const record = requireOptions(value, ['threadId', 'clientMessageId', 'input']);
    return Object.freeze({
        threadId: requireIdentifier(ownValue(record, 'threadId')),
        ...normalizeClientMessageId(record),
        input: normalizeInputs(ownValue(record, 'input'))
    });
}

function normalizeSteerRequest(value: RideCodexTurnSteerRequest): RideCodexTurnSteerRequest {
    const record = requireOptions(value, ['threadId', 'expectedTurnId', 'clientMessageId', 'input']);
    return Object.freeze({
        threadId: requireIdentifier(ownValue(record, 'threadId')),
        expectedTurnId: requireIdentifier(ownValue(record, 'expectedTurnId')),
        ...normalizeClientMessageId(record),
        input: normalizeInputs(ownValue(record, 'input'))
    });
}

function normalizeInterruptRequest(value: RideCodexTurnInterruptRequest): RideCodexTurnInterruptRequest {
    const record = requireOptions(value, ['threadId', 'turnId']);
    return Object.freeze({
        threadId: requireIdentifier(ownValue(record, 'threadId')),
        turnId: requireIdentifier(ownValue(record, 'turnId'))
    });
}

function normalizeClientMessageId(record: Record<string, unknown>): { clientMessageId?: string } {
    const value = ownValue(record, 'clientMessageId');
    return value === undefined ? {} : { clientMessageId: requireIdentifier(value) };
}

function normalizeInputs(value: unknown): RideCodexTurnStartRequest['input'] {
    if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length === 0 || value.length > MAX_INPUT_ITEMS) {
        throw new RideCodexTurnError('invalid-data');
    }
    return Object.freeze(value.map(raw => {
        const record = requireOptions(raw, ['type', 'text', 'path']);
        const type = ownValue(record, 'type');
        if (type === 'text') {
            return Object.freeze({ type, text: requireString(ownValue(record, 'text'), MAX_INPUT_TEXT_BYTES) });
        }
        if (type === 'local-image') {
            return Object.freeze({ type, path: requireString(ownValue(record, 'path'), MAX_LOCAL_PATH_BYTES) });
        }
        throw new RideCodexTurnError('invalid-data');
    }));
}

function toServerInput(input: RideCodexTurnStartRequest['input'][number]): Readonly<Record<string, unknown>> {
    return input.type === 'text'
        ? Object.freeze({ type: 'text', text: input.text, text_elements: Object.freeze([]) })
        : Object.freeze({ type: 'localImage', path: input.path });
}

function requireOptions(value: unknown, keys: readonly string[]): Record<string, unknown> {
    const record = requireRecord(value);
    const descriptors = Object.getOwnPropertyDescriptors(record);
    for (const key of Object.keys(descriptors)) {
        if (!keys.includes(key)) {
            throw new RideCodexTurnError('invalid-data');
        }
    }
    return record;
}

function requireRecord(value: unknown): Record<string, unknown> {
    const budget: RawBudget = { nodes: 0, bytes: 0 };
    validateRaw(value, 0, budget);
    if (!isPlainObject(value)) {
        throw new RideCodexTurnError('invalid-data');
    }
    return value;
}

function validateRaw(value: unknown, depth: number, budget: RawBudget): void {
    budget.nodes += 1;
    if (budget.nodes > MAX_RAW_NODES || depth > MAX_RAW_DEPTH) {
        throw new RideCodexTurnError('invalid-data');
    }
    if (typeof value === 'string') {
        budget.bytes += utf8ByteLength(value);
        if (budget.bytes > MAX_RAW_BYTES) {
            throw new RideCodexTurnError('invalid-data');
        }
        return;
    }
    if (!value || typeof value === 'boolean' || typeof value === 'undefined') {
        return;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new RideCodexTurnError('invalid-data');
        }
        return;
    }
    if (typeof value !== 'object' || utilTypes.isProxy(value)) {
        throw new RideCodexTurnError('invalid-data');
    }
    if (Array.isArray(value)) {
        if (value.length > MAX_RAW_ARRAY) {
            throw new RideCodexTurnError('invalid-data');
        }
        const arrayDescriptors = Object.getOwnPropertyDescriptors(value);
        if (Object.getOwnPropertySymbols(value).length > 0
            || Object.keys(arrayDescriptors).some(key => key !== 'length' && !/^(?:0|[1-9]\d*)$/.test(key))
            || Object.values(arrayDescriptors).some(descriptor => descriptor.get || descriptor.set)) {
            throw new RideCodexTurnError('invalid-data');
        }
        for (let index = 0; index < value.length; index += 1) {
            const descriptor = arrayDescriptors[String(index)];
            if (!descriptor || descriptor.get || descriptor.set) {
                throw new RideCodexTurnError('invalid-data');
            }
            validateRaw(descriptor.value, depth + 1, budget);
        }
        return;
    }
    if (!isPlainObject(value)) {
        throw new RideCodexTurnError('invalid-data');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length > MAX_RAW_KEYS || Object.getOwnPropertySymbols(value).length > 0) {
        throw new RideCodexTurnError('invalid-data');
    }
    for (const key of keys) {
        const descriptor = descriptors[key];
        if (descriptor.get || descriptor.set) {
            throw new RideCodexTurnError('invalid-data');
        }
        budget.bytes += utf8ByteLength(key);
        validateRaw(descriptor.value, depth + 1, budget);
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || !prototype;
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
    return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function requireIdentifier(value: unknown): string {
    return requireString(value, MAX_IDENTIFIER_BYTES);
}

function requireString(value: unknown, maxBytes: number): string {
    if (typeof value !== 'string' || value.length === 0 || utf8ByteLength(value) > maxBytes) {
        throw new RideCodexTurnError('invalid-data');
    }
    return value;
}

function requireBoundedText(value: unknown, maxBytes: number): string {
    if (typeof value !== 'string' || utf8ByteLength(value) > maxBytes) {
        throw new RideCodexTurnError('invalid-data');
    }
    return value;
}

function requireIndex(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_024) {
        throw new RideCodexTurnError('invalid-data');
    }
    return value as number;
}

function normalizeServerTurnStatus(value: unknown): 'in-progress' | RideCodexTurnTerminalStatus {
    switch (value) {
        case 'inProgress': return 'in-progress';
        case 'completed': return 'completed';
        case 'interrupted': return 'interrupted';
        case 'failed': return 'failed';
        default: throw new RideCodexTurnError('invalid-data');
    }
}

function normalizeItemKind(value: unknown): RideCodexItemKind {
    switch (value) {
        case 'userMessage': return 'user-message';
        case 'agentMessage': return 'agent-message';
        case 'plan': return 'plan';
        case 'reasoning': return 'reasoning';
        case 'commandExecution': return 'command';
        case 'fileChange': return 'file-change';
        default: return 'other';
    }
}

function normalizeFileChanges(value: unknown, limit: number): readonly RideCodexFileChange[] {
    if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > limit) {
        throw new RideCodexTurnError('invalid-data');
    }
    return Object.freeze(value.map(raw => {
        const record = requireOptions(raw, ['path', 'kind', 'diff']);
        const path = requireDisplayPath(ownValue(record, 'path'));
        const diff = requireBoundedText(ownValue(record, 'diff'), MAX_INPUT_TEXT_BYTES);
        const kindRecord = requireRecord(ownValue(record, 'kind'));
        const kind = ownValue(kindRecord, 'type');
        if (kind === 'add' || kind === 'delete') {
            requireOptions(kindRecord, ['type']);
            return Object.freeze({ path, kind, diff });
        }
        if (kind !== 'update') {
            throw new RideCodexTurnError('invalid-data');
        }
        requireOptions(kindRecord, ['type', 'move_path']);
        const moveDescriptor = Object.getOwnPropertyDescriptor(kindRecord, 'move_path');
        if (!moveDescriptor) {
            throw new RideCodexTurnError('invalid-data');
        }
        if (moveDescriptor.value === undefined) {
            throw new RideCodexTurnError('invalid-data');
        }
        const movePath = isNullish(moveDescriptor.value)
            ? moveDescriptor.value
            : requireDisplayPath(moveDescriptor.value);
        return Object.freeze({ path, kind, diff, movePath });
    }));
}

function requireDisplayPath(value: unknown): string {
    const path = requireString(value, MAX_LOCAL_PATH_BYTES);
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(path)) {
        throw new RideCodexTurnError('invalid-data');
    }
    return path;
}

function normalizePlan(value: unknown, limit: number): readonly RideCodexPlanStep[] {
    if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > limit) {
        throw new RideCodexTurnError('invalid-data');
    }
    return Object.freeze(value.map(raw => {
        const record = requireRecord(raw);
        const status = ownValue(record, 'status');
        return Object.freeze({
            step: requireString(ownValue(record, 'step'), MAX_INPUT_TEXT_BYTES),
            status: status === 'completed' ? 'completed' as const
                : status === 'inProgress' || status === 'in-progress' ? 'in-progress' as const
                    : 'pending' as const
        });
    }));
}

function normalizeExplanation(record: Record<string, unknown>, maxBytes: number): { explanation?: string } {
    const value = ownValue(record, 'explanation');
    return isNullish(value) ? {} : { explanation: requireString(value, maxBytes) };
}

function normalizeTokenUsage(value: unknown): Extract<RideCodexUiEvent, { type: 'token-usage' }> {
    const usage = requireRecord(value);
    const total = requireRecord(ownValue(usage, 'total'));
    return Object.freeze({
        type: 'token-usage',
        totalTokens: requireNonNegativeInteger(ownValue(total, 'totalTokens')),
        inputTokens: requireNonNegativeInteger(ownValue(total, 'inputTokens')),
        outputTokens: requireNonNegativeInteger(ownValue(total, 'outputTokens'))
    });
}

function requireNonNegativeInteger(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new RideCodexTurnError('invalid-data');
    }
    return value as number;
}

function boundEvent(event: RideCodexUiEvent, maxBytes: number, maxItems: number): RideCodexUiEvent {
    switch (event.type) {
        case 'agent-delta':
        case 'plan-delta':
        case 'command-output':
        case 'file-output':
        case 'reasoning-summary-delta':
        case 'reasoning-delta':
            return Object.freeze({ ...event, delta: truncateUtf8(event.delta, maxBytes) });
        case 'turn-diff':
            return Object.freeze({ ...event, diff: truncateUtf8(event.diff, maxBytes) });
        case 'turn-plan':
            return deepFreezeRideCodex({
                ...event,
                ...(event.explanation === undefined ? {} : { explanation: truncateUtf8(event.explanation, maxBytes) }),
                steps: event.steps.slice(0, maxItems).map(step => ({
                    ...step, step: truncateUtf8(step.step, maxBytes)
                }))
            }) as RideCodexUiEvent;
        case 'file-patch':
            return deepFreezeRideCodex({
                ...event,
                changes: event.changes.slice(0, maxItems).map(change => ({
                    path: truncateUtf8(change.path, maxBytes),
                    kind: change.kind,
                    diff: truncateUtf8(change.diff, maxBytes),
                    ...(change.kind === 'update' && change.movePath !== undefined
                        ? { movePath: isNullish(change.movePath) ? change.movePath : truncateUtf8(change.movePath, maxBytes) }
                        : {})
                }))
            }) as RideCodexUiEvent;
        case 'warning':
        case 'error':
            return Object.freeze({ ...event, message: truncateUtf8(event.message, maxBytes) });
        default:
            return deepFreezeRideCodex({ ...event }) as RideCodexUiEvent;
    }
}

function eventBytes(event: RideCodexUiEvent): number {
    try {
        return utf8ByteLength(JSON.stringify(event));
    } catch {
        return Number.MAX_SAFE_INTEGER;
    }
}

function queueEventBytes(event: RideCodexUiEvent): number {
    return eventBytes(event) + 1;
}

function eventArrayBytes(events: readonly RideCodexUiEvent[]): number {
    if (events.length === 0) {
        return 2;
    }
    return 2 + events.reduce((sum, event) => sum + eventBytes(event), 0) + events.length - 1;
}

function mergeBatches(
    current: RideCodexEventBatch | undefined,
    incoming: RideCodexEventBatch,
    maxEvents: number,
    maxBytes: number
): RideCodexEventBatch {
    if (!current || current.generation !== incoming.generation
        || current.threadId !== incoming.threadId || current.turnId !== incoming.turnId) {
        return incoming;
    }
    const combined = [...current.events, ...incoming.events];
    let dropped = 0;
    for (const event of combined) {
        if (event.type === 'warning' && event.code === 'events-dropped') {
            dropped += event.droppedEvents ?? 1;
        }
    }
    const candidates = combined.filter(event =>
        event.type !== 'warning' || event.code !== 'events-dropped'
    );
    const events: RideCodexUiEvent[] = [];
    let bytes = 0;
    for (const event of candidates) {
        const size = eventBytes(event);
        if (events.length >= maxEvents || bytes + size > maxBytes) {
            dropped += 1;
            continue;
        }
        events.push(event);
        bytes += size;
    }
    for (const terminal of candidates.filter(event => event.type === 'turn-terminal')) {
        if (events.includes(terminal)) {
            continue;
        }
        const removable = findLastIndex(events, event =>
            event.type !== 'turn-started' && event.type !== 'turn-terminal'
        );
        if (removable >= 0) {
            bytes -= eventBytes(events[removable]);
            events.splice(removable, 1);
            dropped += 1;
        }
        if (events.length < maxEvents && bytes + eventBytes(terminal) <= maxBytes) {
            events.push(terminal);
            bytes += eventBytes(terminal);
            dropped = Math.max(0, dropped - 1);
        }
    }
    if (dropped > 0) {
        const warning: RideCodexUiEvent = Object.freeze({
            type: 'warning', code: 'events-dropped',
            message: 'Some Codex frontend deliveries were dropped to preserve responsiveness.',
            droppedEvents: dropped
        });
        while (events.length >= maxEvents || bytes + eventBytes(warning) > maxBytes) {
            const removable = findLastIndex(events, event =>
                event.type !== 'turn-started' && event.type !== 'turn-terminal'
            );
            if (removable < 0) {
                break;
            }
            bytes -= eventBytes(events[removable]);
            events.splice(removable, 1);
            dropped += 1;
        }
        if (events.length < maxEvents && bytes + eventBytes(warning) <= maxBytes) {
            events.push(Object.freeze({ ...warning, droppedEvents: dropped }));
        }
    }
    return freezeRideCodexEventBatch({
        generation: incoming.generation,
        threadId: incoming.threadId,
        turnId: incoming.turnId,
        events
    });
}

function findLastIndex<T>(values: readonly T[], predicate: (value: T) => boolean): number {
    for (let index = values.length - 1; index >= 0; index -= 1) {
        if (predicate(values[index])) {
            return index;
        }
    }
    return -1;
}

function sameIdentity(left: QueueIdentity, right: QueueIdentity): boolean {
    return left.generation === right.generation
        && left.threadId === right.threadId && left.turnId === right.turnId;
}

function sameBatchIdentity(batch: RideCodexEventBatch, identity: QueueIdentity): boolean {
    return batch.generation === identity.generation
        && batch.threadId === identity.threadId && batch.turnId === identity.turnId;
}

function queueIdentityKey(identity: QueueIdentity): string {
    return JSON.stringify([identity.generation, identity.threadId, identity.turnId]);
}

function batchBytes(batch: RideCodexEventBatch): number {
    return utf8ByteLength(batch.threadId) + utf8ByteLength(batch.turnId)
        + batch.events.reduce((sum, event) => sum + eventBytes(event), 0);
}

function sanitizeMessage(value: string): string {
    const redacted = value
        .replace(/(?:[A-Za-z]:\\|\\\\|\/)[^\s"']+/g, '[path]')
        .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '[secret]');
    return redacted.length === 0 ? 'Codex warning.' : redacted;
}

function stableTurnError(error: unknown, fallback: RideCodexTurnErrorCode): RideCodexTurnError {
    return error instanceof RideCodexTurnError ? error : new RideCodexTurnError(fallback);
}

function safePromise(value: unknown): Promise<unknown> {
    if (value && typeof value === 'object' && utilTypes.isProxy(value)) {
        return Promise.reject(new RideCodexTurnError('invalid-data'));
    }
    if (value && typeof value === 'object') {
        try {
            const descriptor = Object.getOwnPropertyDescriptor(value, 'then');
            if (descriptor?.get || descriptor?.set) {
                return Promise.reject(new RideCodexTurnError('invalid-data'));
            }
        } catch {
            return Promise.reject(new RideCodexTurnError('invalid-data'));
        }
    }
    return Promise.resolve(value);
}

function isNullish(value: unknown): value is null | undefined {
    return value === undefined || (!value && typeof value === 'object');
}

function requireGeneration(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new RideCodexTurnError('operation-failed');
    }
    return value as number;
}

function positiveLimit(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback;
}

function releaseSafely(lease: RideCodexTurnHostLease): void {
    try {
        lease.release();
    } catch {
        // Lease release is idempotent and never leaks host details.
    }
}

function disposeSafely(disposable: RideCodexDisposable): void {
    try {
        disposable.dispose();
    } catch {
        // Listener cleanup is best effort and bounded.
    }
}

const defaultScheduler: RideCodexTurnScheduler = Object.freeze({
    schedule: (callback: () => void) => {
        const handle = setTimeout(callback, 16);
        handle.unref?.();
        return { dispose: () => clearTimeout(handle) };
    }
});

const defaultTimers: RideCodexTurnTimers = Object.freeze({
    setTimeout: (callback: () => void, milliseconds: number) => {
        const handle = setTimeout(callback, milliseconds);
        handle.unref?.();
        return handle;
    },
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)
});
