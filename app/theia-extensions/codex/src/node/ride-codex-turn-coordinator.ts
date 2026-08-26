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
    RIDE_CODEX_MIN_QUEUED_BYTES,
    RideCodexSafeError,
    RideCodexTurnClient,
    RideCodexTurnInterruptRequest,
    RideCodexTurnResult,
    RideCodexTurnStartRequest,
    RideCodexTurnSteerRequest,
    RideCodexTurnTerminalStatus,
    RideCodexUiEvent,
    serializeRideCodexEventBatch,
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
        this.#maxQueuedBytes = requireQueueLimit(options.maxQueuedBytes, DEFAULT_MAX_QUEUED_BYTES);
        this.#maxBatchEvents = requireBatchLimit(options.maxBatchEvents, DEFAULT_MAX_BATCH_EVENTS);
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
            const response = requireExactOptions(raw, ['turn']);
            const turn = requireTurn(ownValue(response, 'turn'));
            const turnId = turn.id;
            const status = turn.status;
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
            const response = requireExactOptions(raw, ['turnId']);
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
            const rawAck = await Promise.race([
                safePromise(lease.request('turn/interrupt', Object.freeze({
                    threadId: request.threadId,
                    turnId: request.turnId
                }), this.#interruptTimeoutMs)),
                active.invalidated,
                timeout
            ]);
            requireOptions(rawAck, []);
            await Promise.race([active.invalidated, timeout]);
            throw new RideCodexTurnError('operation-superseded');
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
                requireThreadResumeResponse(raw, threadId);
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
            case 'turn/plan/updated': {
                const planParams = requireExactOptions(params, ['threadId', 'turnId', 'explanation', 'plan']);
                this.#enqueue(Object.freeze({
                    type: 'turn-plan',
                    ...normalizeExplanation(planParams, this.#maxItemBytes),
                    steps: normalizePlan(ownValue(planParams, 'plan'), this.#maxRetainedItems)
                }));
                return;
            }
            case 'turn/diff/updated': {
                const diffParams = requireExactOptions(params, ['threadId', 'turnId', 'diff']);
                this.#enqueue(Object.freeze({
                    type: 'turn-diff', diff: requireBoundedText(ownValue(diffParams, 'diff'), this.#maxItemBytes)
                }));
                return;
            }
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
            const replacementBytes = eventBytes(replacement);
            const replacementEntry = Object.freeze({
                identity: previous.identity,
                event: replacement,
                bytes: replacementBytes
            });
            const candidate = [...this.#queue.slice(0, -1), replacementEntry];
            const candidateBytes = this.#queuedBytes(candidate);
            if (candidateBytes <= this.#maxQueuedBytes) {
                this.#queue[this.#queue.length - 1] = Object.freeze({
                    identity: previous.identity,
                    event: replacement,
                    bytes: replacementBytes
                });
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
        const entry = Object.freeze({
            identity: this.#queueIdentity,
            event: bounded,
            bytes: eventBytes(bounded)
        });
        if (bounded.type === 'turn-started' || bounded.type === 'turn-terminal') {
            this.#makeRoomForBoundary(entry);
        }
        const candidateBytes = this.#queuedBytes([...this.#queue, entry]);
        if (candidateBytes > this.#maxQueuedBytes) {
            this.#recordDrop(this.#queueIdentity, entry.bytes);
            this.#scheduleFlush();
            return;
        }
        this.#queue.push(entry);
        this.#scheduleFlush();
    }

    #makeRoomForBoundary(incoming: QueuedEvent): void {
        while (this.#queuedBytes([...this.#queue, incoming]) > this.#maxQueuedBytes) {
            const index = this.#queue.findIndex(entry =>
                entry.event.type !== 'turn-started' && entry.event.type !== 'turn-terminal'
            );
            if (index >= 0) {
                const [removed] = this.#queue.splice(index, 1);
                this.#addDropMetadata(removed.identity, removed.bytes);
                continue;
            }
            const oldestOther = this.#queue.find(entry => !sameIdentity(entry.identity, incoming.identity));
            if (!oldestOther) {
                break;
            }
            for (let queueIndex = this.#queue.length - 1; queueIndex >= 0; queueIndex -= 1) {
                const candidate = this.#queue[queueIndex];
                if (sameIdentity(candidate.identity, oldestOther.identity)) {
                    this.#queue.splice(queueIndex, 1);
                }
            }
            this.#queueMetadata.delete(queueIdentityKey(oldestOther.identity));
        }
    }

    #recordDrop(identity: QueueIdentity, bytes: number): void {
        this.#addDropMetadata(identity, bytes);
        this.#trimQueueToBudget();
    }

    #addDropMetadata(identity: QueueIdentity, bytes: number): void {
        const metadata = this.#metadataFor(identity);
        metadata.droppedEvents = Math.min(Number.MAX_SAFE_INTEGER, metadata.droppedEvents + 1);
        metadata.droppedBytes = Math.min(
            Number.MAX_SAFE_INTEGER,
            metadata.droppedBytes + Math.min(bytes, this.#maxQueuedBytes)
        );
    }

    #recordTruncation(identity: QueueIdentity): void {
        this.#metadataFor(identity).truncated = true;
        this.#trimQueueToBudget();
    }

    #queuedBytes(entries: readonly QueuedEvent[] = this.#queue): number {
        return queuedEntriesBytes(entries, this.#maxBatchEvents, this.#queueMetadata);
    }

    #trimQueueToBudget(): void {
        while (this.#queuedBytes() > this.#maxQueuedBytes) {
            const ordinary = this.#queue.findIndex(entry =>
                entry.event.type !== 'turn-started' && entry.event.type !== 'turn-terminal'
            );
            if (ordinary >= 0) {
                const [removed] = this.#queue.splice(ordinary, 1);
                this.#addDropMetadata(removed.identity, removed.bytes);
                continue;
            }
            const metadata = [...this.#queueMetadata.values()].find(candidate =>
                this.#queue.some(entry => sameIdentity(entry.identity, candidate.identity))
            );
            if (!metadata) {
                break;
            }
            metadata.droppedEvents = 0;
            metadata.droppedBytes = 0;
            metadata.truncated = false;
            this.#queueMetadata.delete(queueIdentityKey(metadata.identity));
        }
        for (const [key, metadata] of [...this.#queueMetadata]) {
            if (!this.#queue.some(entry => sameIdentity(entry.identity, metadata.identity))) {
                this.#queueMetadata.delete(key);
            }
        }
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
        const identity = first?.identity;
        if (!identity) {
            this.#queueMetadata.clear();
            return;
        }
        const metadataKey = queueIdentityKey(identity);
        const metadata = this.#queueMetadata.get(metadataKey);
        const events: RideCodexUiEvent[] = [];
        while (events.length < this.#maxBatchEvents && this.#queue.length > 0
            && sameIdentity(this.#queue[0].identity, identity)) {
            const entry = this.#queue.shift() as QueuedEvent;
            events.push(entry.event);
        }
        if (metadata && metadata.droppedEvents > 0 && events.length < this.#maxBatchEvents) {
            const warning = Object.freeze({
                type: 'warning', code: 'events-dropped',
                message: 'Some Codex streaming events were dropped to preserve responsiveness.',
                droppedEvents: metadata.droppedEvents,
                droppedBytes: metadata.droppedBytes
            } as const);
            if (batchBytes({ ...identity, events: [...events, warning] }) <= this.#maxQueuedBytes) {
                events.push(warning);
                metadata.droppedEvents = 0;
                metadata.droppedBytes = 0;
            } else if (events.length === 0) {
                metadata.droppedEvents = 0;
                metadata.droppedBytes = 0;
            }
        }
        if (metadata?.truncated && events.length < this.#maxBatchEvents) {
            const warning = Object.freeze({
                type: 'warning', code: 'data-truncated',
                message: 'A Codex streaming item was truncated to preserve responsiveness.'
            } as const);
            if (batchBytes({ ...identity, events: [...events, warning] }) <= this.#maxQueuedBytes) {
                events.push(warning);
                metadata.truncated = false;
            } else if (events.length === 0) {
                metadata.truncated = false;
            }
        }
        if (metadata && metadata.droppedEvents === 0 && !metadata.truncated) {
            this.#queueMetadata.delete(metadataKey);
        }
        while (events.length > 0
            && batchBytes({ ...identity, events }) > this.#maxQueuedBytes) {
            const removable = findLastIndex(events, event =>
                event.type !== 'turn-started' && event.type !== 'turn-terminal'
            );
            if (removable < 0) {
                break;
            }
            const [removed] = events.splice(removable, 1);
            this.#recordDrop(identity, eventBytes(removed));
        }
        if (events.length === 0) {
            this.#queueMetadata.delete(metadataKey);
            if (this.#queue.length > 0) {
                this.#scheduleFlush();
            }
            return;
        }
        const batch = freezeRideCodexEventBatch({ ...identity, events });
        for (const client of [...this.#clients]) {
            this.#deliver(client, batch);
        }
        if (!this.#queue.some(entry => sameIdentity(entry.identity, identity))) {
            this.#queueMetadata.delete(metadataKey);
        }
        if (this.#queue.length > 0) {
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
        const wire = serializeValidatedRideCodexEventBatch(batch, this.#maxQueuedBytes);
        if (wire === undefined) {
            this.#disconnect(client);
            return;
        }
        let delivery: void | Promise<void>;
        client.inFlightIdentity = Object.freeze({
            generation: batch.generation, threadId: batch.threadId, turnId: batch.turnId
        });
        try {
            delivery = client.client.turnEvents(wire);
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

function requireExactOptions(value: unknown, keys: readonly string[]): Record<string, unknown> {
    const record = requireOptions(value, keys);
    const descriptors = Object.getOwnPropertyDescriptors(record);
    if (Object.keys(descriptors).length !== keys.length
        || keys.some(key => !Object.prototype.hasOwnProperty.call(descriptors, key))) {
        throw new RideCodexTurnError('invalid-data');
    }
    return record;
}

function requireTurn(value: unknown): Readonly<{
    id: string;
    status: 'in-progress' | RideCodexTurnTerminalStatus;
}> {
    const turn = requireExactOptions(value, [
        'id', 'items', 'itemsView', 'status', 'error', 'startedAt', 'completedAt', 'durationMs'
    ]);
    const items = ownValue(turn, 'items');
    if (!Array.isArray(items) || utilTypes.isProxy(items) || items.length > MAX_RAW_ARRAY) {
        throw new RideCodexTurnError('invalid-data');
    }
    for (const item of items) {
        requireStableThreadItem(item);
    }
    if (!['notLoaded', 'summary', 'full'].includes(ownValue(turn, 'itemsView') as string)) {
        throw new RideCodexTurnError('invalid-data');
    }
    requireTurnError(ownValue(turn, 'error'));
    requireNullableNonNegativeNumber(ownValue(turn, 'startedAt'));
    requireNullableNonNegativeNumber(ownValue(turn, 'completedAt'));
    requireNullableNonNegativeNumber(ownValue(turn, 'durationMs'));
    return Object.freeze({
        id: requireIdentifier(ownValue(turn, 'id')),
        status: normalizeServerTurnStatus(ownValue(turn, 'status'))
    });
}

function requireStableThreadItem(value: unknown): void {
    const record = requireRecord(value);
    const type = ownValue(record, 'type');
    switch (type) {
        case 'contextCompaction': {
            const item = requireExactOptions(record, ['type', 'id']);
            requireIdentifier(ownValue(item, 'id'));
            return;
        }
        case 'agentMessage': {
            const item = requireExactOptions(record, ['type', 'id', 'text', 'phase', 'memoryCitation']);
            requireIdentifier(ownValue(item, 'id'));
            requireBoundedText(ownValue(item, 'text'), MAX_INPUT_TEXT_BYTES);
            const phase = ownValue(item, 'phase');
            if (!isNullish(phase) && phase !== 'commentary' && phase !== 'final_answer') {
                throw new RideCodexTurnError('invalid-data');
            }
            const citation = ownValue(item, 'memoryCitation');
            if (!isNullish(citation)) {
                requireRecord(citation);
            }
            return;
        }
        case 'plan': {
            const item = requireExactOptions(record, ['type', 'id', 'text']);
            requireIdentifier(ownValue(item, 'id'));
            requireBoundedText(ownValue(item, 'text'), MAX_INPUT_TEXT_BYTES);
            return;
        }
        case 'reasoning': {
            const item = requireExactOptions(record, ['type', 'id', 'summary', 'content']);
            requireIdentifier(ownValue(item, 'id'));
            requireStringArray(ownValue(item, 'summary'), MAX_RAW_ARRAY, MAX_INPUT_TEXT_BYTES, true);
            requireStringArray(ownValue(item, 'content'), MAX_RAW_ARRAY, MAX_INPUT_TEXT_BYTES, true);
            return;
        }
        case 'commandExecution': {
            const item = requireExactOptions(record, [
                'type', 'id', 'command', 'cwd', 'processId', 'source', 'status', 'commandActions',
                'aggregatedOutput', 'exitCode', 'durationMs'
            ]);
            requireIdentifier(ownValue(item, 'id'));
            requireBoundedText(ownValue(item, 'command'), MAX_INPUT_TEXT_BYTES);
            requireString(ownValue(item, 'cwd'), MAX_LOCAL_PATH_BYTES);
            requireNullableIdentifier(ownValue(item, 'processId'));
            if (!['agent', 'userShell', 'unifiedExecStartup', 'unifiedExecInteraction']
                .includes(ownValue(item, 'source') as string)
                || !['inProgress', 'completed', 'failed', 'declined']
                    .includes(ownValue(item, 'status') as string)) {
                throw new RideCodexTurnError('invalid-data');
            }
            requireBoundedArray(ownValue(item, 'commandActions'));
            requireNullableText(ownValue(item, 'aggregatedOutput'), MAX_INPUT_TEXT_BYTES);
            requireNullableSafeInteger(ownValue(item, 'exitCode'));
            requireNullableNonNegativeNumber(ownValue(item, 'durationMs'));
            return;
        }
        case 'fileChange': {
            const item = requireExactOptions(record, ['type', 'id', 'changes', 'status']);
            requireIdentifier(ownValue(item, 'id'));
            normalizeFileChanges(ownValue(item, 'changes'), MAX_RAW_ARRAY);
            if (!['inProgress', 'completed', 'failed', 'declined'].includes(ownValue(item, 'status') as string)) {
                throw new RideCodexTurnError('invalid-data');
            }
            return;
        }
        case 'userMessage': {
            const item = requireExactOptions(record, ['type', 'id', 'clientId', 'content']);
            requireIdentifier(ownValue(item, 'id'));
            requireNullableIdentifier(ownValue(item, 'clientId'));
            const content = ownValue(item, 'content');
            if (!Array.isArray(content) || utilTypes.isProxy(content) || content.length > MAX_INPUT_ITEMS) {
                throw new RideCodexTurnError('invalid-data');
            }
            for (const input of content) {
                requireStableUserInput(input);
            }
            return;
        }
        default:
            throw new RideCodexTurnError('invalid-data');
    }
}

function requireStableUserInput(value: unknown): void {
    const input = requireRecord(value);
    switch (ownValue(input, 'type')) {
        case 'text': {
            const textInput = requireExactOptions(input, ['type', 'text', 'text_elements']);
            requireBoundedText(ownValue(textInput, 'text'), MAX_INPUT_TEXT_BYTES);
            requireBoundedArray(ownValue(textInput, 'text_elements'));
            return;
        }
        case 'image': {
            const image = requireOptions(input, ['type', 'detail', 'url']);
            requireRequiredKeys(image, ['type', 'url']);
            requireString(ownValue(image, 'url'), MAX_LOCAL_PATH_BYTES);
            requireOptionalImageDetail(image);
            return;
        }
        case 'localImage': {
            const image = requireOptions(input, ['type', 'detail', 'path']);
            requireRequiredKeys(image, ['type', 'path']);
            requireString(ownValue(image, 'path'), MAX_LOCAL_PATH_BYTES);
            requireOptionalImageDetail(image);
            return;
        }
        case 'skill':
        case 'mention': {
            const reference = requireExactOptions(input, ['type', 'name', 'path']);
            requireString(ownValue(reference, 'name'), MAX_IDENTIFIER_BYTES);
            requireString(ownValue(reference, 'path'), MAX_LOCAL_PATH_BYTES);
            return;
        }
        default:
            throw new RideCodexTurnError('invalid-data');
    }
}

function requireOptionalImageDetail(record: Record<string, unknown>): void {
    if (!Object.prototype.hasOwnProperty.call(record, 'detail')) {
        return;
    }
    if (!['auto', 'low', 'high', 'original'].includes(ownValue(record, 'detail') as string)) {
        throw new RideCodexTurnError('invalid-data');
    }
}

function requireTurnError(value: unknown): void {
    if (isNullish(value)) {
        if (value === undefined) {
            throw new RideCodexTurnError('invalid-data');
        }
        return;
    }
    const error = requireExactOptions(value, ['message', 'codexErrorInfo', 'additionalDetails']);
    requireBoundedText(ownValue(error, 'message'), MAX_INPUT_TEXT_BYTES);
    requireNullableText(ownValue(error, 'additionalDetails'), MAX_INPUT_TEXT_BYTES);
    const info = ownValue(error, 'codexErrorInfo');
    if (!isNullish(info)) {
        requireCodexErrorInfo(info);
    }
}

function requireCodexErrorInfo(value: unknown): void {
    if (typeof value === 'string') {
        if (![
            'contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'serverOverloaded',
            'cyberPolicy', 'internalServerError', 'unauthorized', 'badRequest', 'threadRollbackFailed',
            'sandboxError', 'other'
        ].includes(value)) {
            throw new RideCodexTurnError('invalid-data');
        }
        return;
    }
    const tagged = requireRecord(value);
    const keys = Object.keys(tagged);
    if (keys.length !== 1 || ![
        'httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected',
        'responseTooManyFailedAttempts', 'activeTurnNotSteerable'
    ].includes(keys[0])) {
        throw new RideCodexTurnError('invalid-data');
    }
    const payload = ownValue(tagged, keys[0]);
    if (keys[0] === 'activeTurnNotSteerable') {
        const active = requireExactOptions(payload, ['turnKind']);
        if (!['review', 'compact'].includes(ownValue(active, 'turnKind') as string)) {
            throw new RideCodexTurnError('invalid-data');
        }
        return;
    }
    const connection = requireExactOptions(payload, ['httpStatusCode']);
    const httpStatusCode = ownValue(connection, 'httpStatusCode');
    if (isNullish(httpStatusCode)) {
        if (httpStatusCode === undefined) {
            throw new RideCodexTurnError('invalid-data');
        }
        return;
    }
    if (!Number.isSafeInteger(httpStatusCode) || (httpStatusCode as number) < 0) {
        throw new RideCodexTurnError('invalid-data');
    }
}

function requireThreadResumeResponse(value: unknown, expectedThreadId: string): void {
    const response = requireExactOptions(value, [
        'thread', 'model', 'modelProvider', 'serviceTier', 'cwd', 'instructionSources',
        'approvalPolicy', 'approvalsReviewer', 'sandbox', 'reasoningEffort'
    ]);
    const threadId = requireThread(ownValue(response, 'thread'));
    if (threadId !== expectedThreadId) {
        throw new RideCodexTurnError('invalid-data');
    }
    requireString(ownValue(response, 'model'), MAX_IDENTIFIER_BYTES);
    requireString(ownValue(response, 'modelProvider'), MAX_IDENTIFIER_BYTES);
    requireNullableText(ownValue(response, 'serviceTier'), MAX_IDENTIFIER_BYTES);
    requireString(ownValue(response, 'cwd'), MAX_LOCAL_PATH_BYTES);
    requireStringArray(ownValue(response, 'instructionSources'), MAX_RAW_ARRAY, MAX_LOCAL_PATH_BYTES, true);
    requireApprovalPolicy(ownValue(response, 'approvalPolicy'));
    if (!['user', 'auto_review', 'guardian_subagent'].includes(ownValue(response, 'approvalsReviewer') as string)) {
        throw new RideCodexTurnError('invalid-data');
    }
    requireSandboxPolicy(ownValue(response, 'sandbox'));
    requireNullableText(ownValue(response, 'reasoningEffort'), MAX_IDENTIFIER_BYTES);
}

function requireThread(value: unknown): string {
    const thread = requireExactOptions(value, [
        'id', 'sessionId', 'forkedFromId', 'parentThreadId', 'preview', 'ephemeral', 'modelProvider',
        'createdAt', 'updatedAt', 'recencyAt', 'status', 'path', 'cwd', 'cliVersion', 'source',
        'threadSource', 'agentNickname', 'agentRole', 'gitInfo', 'name', 'turns'
    ]);
    const id = requireIdentifier(ownValue(thread, 'id'));
    requireIdentifier(ownValue(thread, 'sessionId'));
    requireNullableIdentifier(ownValue(thread, 'forkedFromId'));
    requireNullableIdentifier(ownValue(thread, 'parentThreadId'));
    requireBoundedText(ownValue(thread, 'preview'), MAX_INPUT_TEXT_BYTES);
    if (typeof ownValue(thread, 'ephemeral') !== 'boolean') {
        throw new RideCodexTurnError('invalid-data');
    }
    requireString(ownValue(thread, 'modelProvider'), MAX_IDENTIFIER_BYTES);
    requireNonNegativeFiniteNumber(ownValue(thread, 'createdAt'));
    requireNonNegativeFiniteNumber(ownValue(thread, 'updatedAt'));
    requireNullableNonNegativeNumber(ownValue(thread, 'recencyAt'));
    requireThreadStatus(ownValue(thread, 'status'));
    requireNullableText(ownValue(thread, 'path'), MAX_LOCAL_PATH_BYTES);
    requireString(ownValue(thread, 'cwd'), MAX_LOCAL_PATH_BYTES);
    requireString(ownValue(thread, 'cliVersion'), MAX_IDENTIFIER_BYTES);
    requireSessionSource(ownValue(thread, 'source'));
    requireNullableText(ownValue(thread, 'threadSource'), MAX_IDENTIFIER_BYTES);
    requireNullableText(ownValue(thread, 'agentNickname'), MAX_IDENTIFIER_BYTES);
    requireNullableText(ownValue(thread, 'agentRole'), MAX_IDENTIFIER_BYTES);
    requireGitInfo(ownValue(thread, 'gitInfo'));
    requireNullableText(ownValue(thread, 'name'), MAX_INPUT_TEXT_BYTES);
    const turns = ownValue(thread, 'turns');
    if (!Array.isArray(turns) || utilTypes.isProxy(turns) || turns.length > MAX_RAW_ARRAY) {
        throw new RideCodexTurnError('invalid-data');
    }
    for (const turn of turns) {
        requireTurn(turn);
    }
    return id;
}

function requireThreadStatus(value: unknown): void {
    const status = requireRecord(value);
    const type = ownValue(status, 'type');
    if (type === 'active') {
        const active = requireExactOptions(status, ['type', 'activeFlags']);
        const flags = ownValue(active, 'activeFlags');
        if (!Array.isArray(flags) || utilTypes.isProxy(flags) || flags.length > 2
            || flags.some(flag => flag !== 'waitingOnApproval' && flag !== 'waitingOnUserInput')) {
            throw new RideCodexTurnError('invalid-data');
        }
        return;
    }
    if (!['notLoaded', 'idle', 'systemError'].includes(type as string)) {
        throw new RideCodexTurnError('invalid-data');
    }
    requireExactOptions(status, ['type']);
}

function requireSessionSource(value: unknown): void {
    if (typeof value === 'string') {
        if (!['cli', 'vscode', 'exec', 'appServer', 'unknown'].includes(value)) {
            throw new RideCodexTurnError('invalid-data');
        }
        return;
    }
    const source = requireRecord(value);
    const keys = Object.keys(source);
    if (keys.length !== 1 || (keys[0] !== 'custom' && keys[0] !== 'subAgent')) {
        throw new RideCodexTurnError('invalid-data');
    }
    if (keys[0] === 'custom') {
        requireString(ownValue(source, 'custom'), MAX_IDENTIFIER_BYTES);
    } else {
        requireRecord(ownValue(source, 'subAgent'));
    }
}

function requireGitInfo(value: unknown): void {
    if (isNullish(value)) {
        if (value === undefined) {
            throw new RideCodexTurnError('invalid-data');
        }
        return;
    }
    const git = requireExactOptions(value, ['sha', 'branch', 'originUrl']);
    requireNullableText(ownValue(git, 'sha'), MAX_IDENTIFIER_BYTES);
    requireNullableText(ownValue(git, 'branch'), MAX_IDENTIFIER_BYTES);
    requireNullableText(ownValue(git, 'originUrl'), MAX_LOCAL_PATH_BYTES);
}

function requireApprovalPolicy(value: unknown): void {
    if (value === 'untrusted' || value === 'on-request' || value === 'never') {
        return;
    }
    const policy = requireExactOptions(value, ['granular']);
    const granular = requireExactOptions(ownValue(policy, 'granular'), [
        'sandbox_approval', 'rules', 'skill_approval', 'request_permissions', 'mcp_elicitations'
    ]);
    for (const key of Object.keys(granular)) {
        if (typeof ownValue(granular, key) !== 'boolean') {
            throw new RideCodexTurnError('invalid-data');
        }
    }
}

function requireSandboxPolicy(value: unknown): void {
    const policy = requireRecord(value);
    switch (ownValue(policy, 'type')) {
        case 'dangerFullAccess':
            requireExactOptions(policy, ['type']);
            return;
        case 'readOnly': {
            const readOnly = requireExactOptions(policy, ['type', 'networkAccess']);
            requireBoolean(ownValue(readOnly, 'networkAccess'));
            return;
        }
        case 'externalSandbox': {
            const external = requireExactOptions(policy, ['type', 'networkAccess']);
            if (!['restricted', 'enabled'].includes(ownValue(external, 'networkAccess') as string)) {
                throw new RideCodexTurnError('invalid-data');
            }
            return;
        }
        case 'workspaceWrite': {
            const workspace = requireExactOptions(policy, [
                'type', 'writableRoots', 'networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp'
            ]);
            requireStringArray(ownValue(workspace, 'writableRoots'), MAX_RAW_ARRAY, MAX_LOCAL_PATH_BYTES, true);
            requireBoolean(ownValue(workspace, 'networkAccess'));
            requireBoolean(ownValue(workspace, 'excludeTmpdirEnvVar'));
            requireBoolean(ownValue(workspace, 'excludeSlashTmp'));
            return;
        }
        default:
            throw new RideCodexTurnError('invalid-data');
    }
}

function requireRequiredKeys(record: Record<string, unknown>, keys: readonly string[]): void {
    if (keys.some(key => !Object.prototype.hasOwnProperty.call(record, key))) {
        throw new RideCodexTurnError('invalid-data');
    }
}

function requireBoundedArray(value: unknown): readonly unknown[] {
    if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > MAX_RAW_ARRAY) {
        throw new RideCodexTurnError('invalid-data');
    }
    return value;
}

function requireStringArray(
    value: unknown,
    maxItems: number,
    maxBytes: number,
    allowEmpty: boolean
): readonly string[] {
    if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > maxItems) {
        throw new RideCodexTurnError('invalid-data');
    }
    for (const entry of value) {
        if (allowEmpty) {
            requireBoundedText(entry, maxBytes);
        } else {
            requireString(entry, maxBytes);
        }
    }
    return value as readonly string[];
}

function requireNullableText(value: unknown, maxBytes: number): void {
    if (isNullish(value)) {
        if (value === undefined) {
            throw new RideCodexTurnError('invalid-data');
        }
        return;
    }
    requireBoundedText(value, maxBytes);
}

function requireNullableIdentifier(value: unknown): void {
    if (isNullish(value)) {
        if (value === undefined) {
            throw new RideCodexTurnError('invalid-data');
        }
        return;
    }
    requireIdentifier(value);
}

function requireNullableSafeInteger(value: unknown): void {
    if (isNullish(value)) {
        if (value === undefined) {
            throw new RideCodexTurnError('invalid-data');
        }
        return;
    }
    if (!Number.isSafeInteger(value)) {
        throw new RideCodexTurnError('invalid-data');
    }
}

function requireNonNegativeFiniteNumber(value: unknown): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new RideCodexTurnError('invalid-data');
    }
}

function requireNullableNonNegativeNumber(value: unknown): void {
    if (isNullish(value)) {
        if (value === undefined) {
            throw new RideCodexTurnError('invalid-data');
        }
        return;
    }
    requireNonNegativeFiniteNumber(value);
}

function requireBoolean(value: unknown): void {
    if (typeof value !== 'boolean') {
        throw new RideCodexTurnError('invalid-data');
    }
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
        const record = requireExactOptions(raw, ['step', 'status']);
        const status = ownValue(record, 'status');
        let normalizedStatus: RideCodexPlanStep['status'];
        switch (status) {
            case 'pending':
                normalizedStatus = 'pending';
                break;
            case 'inProgress':
                normalizedStatus = 'in-progress';
                break;
            case 'completed':
                normalizedStatus = 'completed';
                break;
            default:
                throw new RideCodexTurnError('invalid-data');
        }
        return Object.freeze({
            step: requireBoundedText(ownValue(record, 'step'), MAX_INPUT_TEXT_BYTES),
            status: normalizedStatus
        });
    }));
}

function normalizeExplanation(record: Record<string, unknown>, maxBytes: number): { explanation?: string } {
    const value = ownValue(record, 'explanation');
    if (value === undefined) {
        throw new RideCodexTurnError('invalid-data');
    }
    return isNullish(value) ? {} : { explanation: requireBoundedText(value, maxBytes) };
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
    const identity = {
        generation: incoming.generation,
        threadId: incoming.threadId,
        turnId: incoming.turnId
    };
    const fits = (candidateEvents: readonly RideCodexUiEvent[]): boolean =>
        batchBytes({ ...identity, events: candidateEvents }) <= maxBytes;
    for (const event of candidates) {
        if (events.length >= maxEvents || !fits([...events, event])) {
            dropped += 1;
            continue;
        }
        events.push(event);
    }
    for (const terminal of candidates.filter(event => event.type === 'turn-terminal')) {
        if (events.includes(terminal)) {
            continue;
        }
        while (events.length >= maxEvents || !fits([...events, terminal])) {
            const removable = findLastIndex(events, event =>
                event.type !== 'turn-started' && event.type !== 'turn-terminal'
            );
            if (removable < 0) {
                break;
            }
            events.splice(removable, 1);
            dropped += 1;
        }
        if (events.length < maxEvents && fits([...events, terminal])) {
            events.push(terminal);
            dropped = Math.max(0, dropped - 1);
        }
    }
    if (dropped > 0) {
        const warningFor = (): RideCodexUiEvent => Object.freeze({
            type: 'warning', code: 'events-dropped',
            message: 'Some Codex frontend deliveries were dropped to preserve responsiveness.',
            droppedEvents: dropped
        });
        let warning = warningFor();
        while (events.length >= maxEvents || !fits([...events, warning])) {
            const removable = findLastIndex(events, event =>
                event.type !== 'turn-started' && event.type !== 'turn-terminal'
            );
            if (removable < 0) {
                break;
            }
            events.splice(removable, 1);
            dropped += 1;
            warning = warningFor();
        }
        if (events.length < maxEvents && fits([...events, warning])) {
            const terminalIndex = events.findIndex(event => event.type === 'turn-terminal');
            events.splice(terminalIndex < 0 ? events.length : terminalIndex, 0, warning);
        }
    }
    return freezeRideCodexEventBatch({ ...identity, events });
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
    try {
        const emptyBatchBytes = utf8ByteLength(JSON.stringify({
            generation: batch.generation,
            threadId: batch.threadId,
            turnId: batch.turnId,
            events: []
        }));
        return emptyBatchBytes - 2 + eventArrayBytes(batch.events);
    } catch {
        return Number.MAX_SAFE_INTEGER;
    }
}

function queuedEntriesBytes(
    entries: readonly QueuedEvent[],
    maxBatchEvents: number,
    metadata: ReadonlyMap<string, QueueMetadata>
): number {
    let bytes = 0;
    let identity: QueueIdentity | undefined;
    let events: RideCodexUiEvent[] = [];
    const accountedMetadata = new Set<string>();
    const flush = (): void => {
        if (identity) {
            const key = queueIdentityKey(identity);
            const queuedEvents = [...events];
            const queuedMetadata = accountedMetadata.has(key) ? undefined : metadata.get(key);
            if (queuedMetadata) {
                accountedMetadata.add(key);
                const terminalIndex = queuedEvents.findIndex(event => event.type === 'turn-terminal');
                const insertionIndex = terminalIndex < 0 ? queuedEvents.length : terminalIndex;
                queuedEvents.splice(insertionIndex, 0, ...queueMetadataBudgetEvents(queuedMetadata));
            }
            for (let index = 0; index < queuedEvents.length; index += maxBatchEvents) {
                bytes += batchBytes({
                    ...identity,
                    events: queuedEvents.slice(index, index + maxBatchEvents)
                });
                if (!Number.isSafeInteger(bytes)) {
                    bytes = Number.MAX_SAFE_INTEGER;
                    break;
                }
            }
        }
        events = [];
    };
    for (const entry of entries) {
        if (!identity || !sameIdentity(identity, entry.identity)) {
            flush();
            identity = entry.identity;
        }
        events.push(entry.event);
    }
    flush();
    return bytes;
}

function queueMetadataBudgetEvents(metadata: QueueMetadata): RideCodexUiEvent[] {
    const events: RideCodexUiEvent[] = [];
    if (metadata.droppedEvents > 0) {
        events.push({
            type: 'warning',
            code: 'events-dropped',
            message: 'Some Codex streaming events were dropped to preserve responsiveness.',
            droppedEvents: Number.MAX_SAFE_INTEGER,
            droppedBytes: Number.MAX_SAFE_INTEGER
        });
    }
    if (metadata.truncated) {
        events.push({
            type: 'warning',
            code: 'data-truncated',
            message: 'A Codex streaming item was truncated to preserve responsiveness.'
        });
    }
    return events;
}

function serializeValidatedRideCodexEventBatch(
    batch: RideCodexEventBatch,
    maxBytes: number
): string | undefined {
    try {
        validateRaw(batch, 0, { nodes: 0, bytes: 0 });
        if (!isDeepFrozenRaw(batch, 0)) {
            return undefined;
        }
        return serializeRideCodexEventBatch(batch, maxBytes);
    } catch {
        return undefined;
    }
}

function isDeepFrozenRaw(value: unknown, depth: number): boolean {
    if (!value || typeof value !== 'object') {
        return true;
    }
    if (depth > MAX_RAW_DEPTH || !Object.isFrozen(value)) {
        return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.values(descriptors).every(descriptor =>
        !descriptor.get && !descriptor.set && isDeepFrozenRaw(descriptor.value, depth + 1)
    );
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

function requireBatchLimit(value: number | undefined, fallback: number): number {
    if (value === undefined) {
        return fallback;
    }
    if (!Number.isSafeInteger(value) || value < 2) {
        throw new RideCodexTurnError('invalid-data');
    }
    return value;
}

function requireQueueLimit(value: number | undefined, fallback: number): number {
    if (value === undefined) {
        return fallback;
    }
    if (!Number.isSafeInteger(value) || value < RIDE_CODEX_MIN_QUEUED_BYTES) {
        throw new RideCodexTurnError('invalid-data');
    }
    return value;
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
