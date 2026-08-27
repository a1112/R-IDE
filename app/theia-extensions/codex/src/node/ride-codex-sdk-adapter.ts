/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RideCodexLaunchSpec } from './ride-codex-launch-spec';

export const RIDE_CODEX_SDK_RUNTIME_FILENAME = 'codex-sdk-runtime.mjs';
export const RIDE_CODEX_SDK_LIMITS = Object.freeze({
    maxClients: 4,
    maxThreads: 32,
    maxThreadKeyLength: 256,
    maxThreadIdLength: 256,
    maxInputLength: 64 * 1024,
    maxModelLength: 256,
    maxApiKeyLength: 8 * 1024,
    maxEvents: 256,
    maxEventBytes: 512 * 1024,
    maxFinalResponseLength: 64 * 1024
});

export type RideCodexSdkSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface RideCodexSdkEvent {
    readonly type: string;
    readonly [key: string]: unknown;
}

export interface RideCodexSdkClientOptions {
    readonly codexPathOverride: string;
    readonly apiKey?: string;
    readonly baseUrl?: string;
}

export interface RideCodexSdkThreadOptions {
    readonly model?: string;
    readonly sandboxMode?: RideCodexSdkSandboxMode;
    readonly workingDirectory?: string;
    readonly skipGitRepoCheck?: boolean;
}

export interface RideCodexSdkThread {
    readonly id: string | null;
    runStreamed(input: string): Promise<{ readonly events: AsyncGenerator<RideCodexSdkEvent> }>;
}

export interface RideCodexSdkClient {
    startThread(options?: RideCodexSdkThreadOptions): RideCodexSdkThread;
    resumeThread(id: string, options?: RideCodexSdkThreadOptions): RideCodexSdkThread;
}

export interface RideCodexSdkRuntime {
    createCodexClient(options: RideCodexSdkClientOptions): RideCodexSdkClient;
}

export type RideCodexSdkDiagnosticCode =
    | 'runtime-unavailable'
    | 'capacity'
    | 'invalid-request'
    | 'cancelled'
    | 'app-server-turn-active'
    | 'turn-failed'
    | 'stream-failed'
    | 'listener-failed';

export interface RideCodexSdkDiagnostic {
    readonly channel: 'sdk';
    readonly code: RideCodexSdkDiagnosticCode;
}

export interface RideCodexSdkRunRequest {
    readonly channel: 'sdk';
    readonly threadKey: string;
    readonly threadId?: string;
    readonly input: string;
    readonly apiKey?: string;
    readonly model?: string;
    readonly sandboxMode?: RideCodexSdkSandboxMode;
    readonly workingDirectory?: string;
    readonly skipGitRepoCheck?: boolean;
    readonly appServerTurnActive?: boolean;
    readonly signal?: AbortSignal;
    readonly onEvent?: (event: RideCodexSdkEvent) => void;
}

export interface RideCodexSdkRunResult {
    readonly channel: 'sdk';
    readonly status: 'completed';
    readonly threadKey: string;
    readonly threadId?: string;
    readonly finalResponse: string;
    readonly events: readonly RideCodexSdkEvent[];
    readonly usage?: Readonly<Record<string, unknown>>;
}

export interface RideCodexSdkAdapterOptions {
    readonly resolveLaunchSpec: () => Promise<RideCodexLaunchSpec>;
    readonly loadRuntime?: () => Promise<RideCodexSdkRuntime>;
    readonly onDiagnostic?: (diagnostic: RideCodexSdkDiagnostic) => void;
    readonly maxClients?: number;
    readonly maxThreads?: number;
}

export class RideCodexSdkError extends Error {
    readonly channel = 'sdk';

    constructor(readonly code: RideCodexSdkDiagnosticCode) {
        super(messageForCode(code));
        this.name = 'RideCodexSdkError';
    }
}

interface ClientRecord {
    readonly executable: string;
    readonly apiKey?: string;
    readonly client: RideCodexSdkClient;
    readonly threads: Map<string, ThreadRecord>;
    activeRuns: number;
    lastUsed: number;
}

interface ThreadRecord {
    readonly key: string;
    readonly owner: ClientRecord;
    readonly thread: RideCodexSdkThread;
    activeRuns: number;
    lastUsed: number;
}

interface ConsumedEvents {
    readonly events: readonly RideCodexSdkEvent[];
    readonly finalResponse: string;
    readonly usage?: Readonly<Record<string, unknown>>;
}

export class RideCodexSdkAdapter {
    readonly #resolveLaunchSpec: () => Promise<RideCodexLaunchSpec>;
    readonly #loadRuntimeFactory: () => Promise<RideCodexSdkRuntime>;
    readonly #onDiagnostic: (diagnostic: RideCodexSdkDiagnostic) => void;
    readonly #maxClients: number;
    readonly #maxThreads: number;
    readonly #clients: ClientRecord[] = [];
    #runtime: Promise<RideCodexSdkRuntime> | undefined;
    #clock = 0;

    constructor(options: RideCodexSdkAdapterOptions) {
        this.#resolveLaunchSpec = options.resolveLaunchSpec;
        this.#loadRuntimeFactory = options.loadRuntime ?? loadBundledRuntime;
        this.#onDiagnostic = diagnostic => {
            try {
                options.onDiagnostic?.(diagnostic);
            } catch {
                // Diagnostics are observers and cannot affect the SDK channel.
            }
        };
        this.#maxClients = boundedLimit(options.maxClients, RIDE_CODEX_SDK_LIMITS.maxClients);
        this.#maxThreads = boundedLimit(options.maxThreads, RIDE_CODEX_SDK_LIMITS.maxThreads);
    }

    async run(request: RideCodexSdkRunRequest): Promise<RideCodexSdkRunResult> {
        try {
            validateRequest(request);
            if (request.appServerTurnActive === true) {
                throw new RideCodexSdkError('app-server-turn-active');
            }
            assertNotAborted(request.signal);

            const launchSpec = await withAbort(this.#resolveLaunchSpec(), request.signal);
            if (!launchSpec || typeof launchSpec.executable !== 'string' || !launchSpec.executable) {
                throw new RideCodexSdkError('runtime-unavailable');
            }
            const runtime = await withAbort(this.loadRuntime(), request.signal);
            const client = this.getClient(runtime, launchSpec, request.apiKey);
            const thread = this.getThread(client, request);
            try {
                const streamed = await withAbort(
                    Promise.resolve().then(() => thread.thread.runStreamed(request.input)),
                    request.signal
                );
                if (!streamed || typeof streamed.events?.next !== 'function') {
                    throw new RideCodexSdkError('stream-failed');
                }
                const consumed = await consumeEvents(streamed.events, request, thread.thread);
                const threadId = typeof thread.thread.id === 'string' ? thread.thread.id : undefined;
                return Object.freeze({
                    channel: 'sdk' as const,
                    status: 'completed' as const,
                    threadKey: request.threadKey,
                    ...(threadId === undefined ? {} : { threadId }),
                    finalResponse: consumed.finalResponse,
                    events: Object.freeze([...consumed.events]),
                    ...(consumed.usage === undefined ? {} : { usage: consumed.usage })
                });
            } finally {
                this.releaseThread(thread);
            }
        } catch (error) {
            const safe = error instanceof RideCodexSdkError
                ? error
                : new RideCodexSdkError('stream-failed');
            this.report(safe.code);
            throw safe;
        }
    }

    protected loadRuntime(): Promise<RideCodexSdkRuntime> {
        if (!this.#runtime) {
            this.#runtime = Promise.resolve()
                .then(() => this.#loadRuntimeFactory())
                .then(runtime => {
                    if (!runtime || typeof runtime.createCodexClient !== 'function') {
                        throw new RideCodexSdkError('runtime-unavailable');
                    }
                    return runtime;
                })
                .catch(error => {
                    this.#runtime = undefined;
                    if (error instanceof RideCodexSdkError) {
                        throw error;
                    }
                    throw new RideCodexSdkError('runtime-unavailable');
                });
        }
        return this.#runtime;
    }

    protected getClient(
        runtime: RideCodexSdkRuntime,
        launchSpec: RideCodexLaunchSpec,
        apiKey: string | undefined
    ): ClientRecord {
        const existing = this.#clients.find(candidate =>
            candidate.executable === launchSpec.executable && candidate.apiKey === apiKey);
        if (existing) {
            existing.lastUsed = ++this.#clock;
            return existing;
        }

        if (this.#clients.length >= this.#maxClients) {
            const evictable = this.#clients
                .filter(client => client.activeRuns === 0)
                .sort((left, right) => left.lastUsed - right.lastUsed)[0];
            if (!evictable) {
                throw new RideCodexSdkError('capacity');
            }
            this.#clients.splice(this.#clients.indexOf(evictable), 1);
        }

        let createdClient: RideCodexSdkClient;
        try {
            createdClient = runtime.createCodexClient(Object.freeze({
                codexPathOverride: launchSpec.executable,
                ...(apiKey === undefined ? {} : { apiKey })
            }));
        } catch {
            throw new RideCodexSdkError('runtime-unavailable');
        }
        if (!createdClient || typeof createdClient.startThread !== 'function' || typeof createdClient.resumeThread !== 'function') {
            throw new RideCodexSdkError('runtime-unavailable');
        }
        const record: ClientRecord = {
            executable: launchSpec.executable,
            ...(apiKey === undefined ? {} : { apiKey }),
            client: createdClient,
            threads: new Map(),
            activeRuns: 0,
            lastUsed: ++this.#clock
        };
        this.#clients.push(record);
        return record;
    }

    protected getThread(client: ClientRecord, request: RideCodexSdkRunRequest): ThreadRecord {
        const existing = client.threads.get(request.threadKey);
        if (existing) {
            existing.activeRuns += 1;
            existing.lastUsed = ++this.#clock;
            client.activeRuns += 1;
            client.lastUsed = existing.lastUsed;
            return existing;
        }

        this.evictThreadIfNeeded();
        const options = Object.freeze({
            ...(request.model === undefined ? {} : { model: request.model }),
            ...(request.sandboxMode === undefined ? {} : { sandboxMode: request.sandboxMode }),
            ...(request.workingDirectory === undefined ? {} : { workingDirectory: request.workingDirectory }),
            ...(request.skipGitRepoCheck === undefined ? {} : { skipGitRepoCheck: request.skipGitRepoCheck })
        });
        let thread: RideCodexSdkThread;
        try {
            thread = request.threadId === undefined
                ? client.client.startThread(options)
                : client.client.resumeThread(request.threadId, options);
        } catch {
            throw new RideCodexSdkError('stream-failed');
        }
        if (!thread || typeof thread.runStreamed !== 'function') {
            throw new RideCodexSdkError('stream-failed');
        }
        const record: ThreadRecord = {
            key: request.threadKey,
            owner: client,
            thread,
            activeRuns: 1,
            lastUsed: ++this.#clock
        };
        client.threads.set(record.key, record);
        client.activeRuns += 1;
        client.lastUsed = record.lastUsed;
        return record;
    }

    protected releaseThread(thread: ThreadRecord): void {
        thread.activeRuns = Math.max(0, thread.activeRuns - 1);
        thread.owner.activeRuns = Math.max(0, thread.owner.activeRuns - 1);
        thread.lastUsed = ++this.#clock;
        thread.owner.lastUsed = thread.lastUsed;
    }

    protected evictThreadIfNeeded(): void {
        const threads = this.#clients.flatMap(client => [...client.threads.values()]);
        if (threads.length < this.#maxThreads) {
            return;
        }
        const evictable = threads
            .filter(thread => thread.activeRuns === 0)
            .sort((left, right) => left.lastUsed - right.lastUsed)[0];
        if (!evictable) {
            throw new RideCodexSdkError('capacity');
        }
        evictable.owner.threads.delete(evictable.key);
    }

    protected report(code: RideCodexSdkDiagnosticCode): void {
        this.#onDiagnostic({ channel: 'sdk', code });
    }
}

async function consumeEvents(
    events: AsyncGenerator<RideCodexSdkEvent>,
    request: RideCodexSdkRunRequest,
    thread: RideCodexSdkThread
): Promise<ConsumedEvents> {
    const iterator = events[Symbol.asyncIterator]();
    const retained: RideCodexSdkEvent[] = [];
    let retainedBytes = 0;
    let finalResponse = '';
    let usage: Readonly<Record<string, unknown>> | undefined;
    let terminal = false;
    let iteratorClosed = false;
    const close = (): void => {
        if (iteratorClosed) {
            return;
        }
        iteratorClosed = true;
        closeIterator(iterator);
    };
    try {
        while (true) {
            const next = await nextWithAbort(iterator, request.signal, close);
            if (next.done) {
                break;
            }
            const event = next.value;
            if (!event || typeof event.type !== 'string') {
                throw new RideCodexSdkError('stream-failed');
            }
            try {
                request.onEvent?.(event);
            } catch {
                throw new RideCodexSdkError('listener-failed');
            }
            const bytes = eventBytes(event);
            if (bytes !== undefined && retained.length < RIDE_CODEX_SDK_LIMITS.maxEvents
                && retainedBytes + bytes <= RIDE_CODEX_SDK_LIMITS.maxEventBytes) {
                retained.push(event);
                retainedBytes += bytes;
            }
            if (event.type === 'item.completed' && isRecord(event.item)
                && event.item.type === 'agent_message' && typeof event.item.text === 'string') {
                finalResponse = boundText(event.item.text, RIDE_CODEX_SDK_LIMITS.maxFinalResponseLength);
            } else if (event.type === 'turn.completed') {
                usage = freezeRecord(event.usage);
                terminal = true;
                break;
            } else if (event.type === 'turn.failed') {
                throw new RideCodexSdkError('turn-failed');
            } else if (event.type === 'error') {
                throw new RideCodexSdkError('stream-failed');
            }
        }
        if (!terminal) {
            throw new RideCodexSdkError('stream-failed');
        }
        const threadId = typeof thread.id === 'string' ? thread.id : undefined;
        if (threadId !== undefined && threadId.length > RIDE_CODEX_SDK_LIMITS.maxThreadIdLength) {
            throw new RideCodexSdkError('stream-failed');
        }
        return {
            events: Object.freeze(retained),
            finalResponse,
            ...(usage === undefined ? {} : { usage })
        };
    } finally {
        if (!iteratorClosed) {
            iteratorClosed = true;
            try {
                const closing = iterator.return?.(undefined);
                if (closing) {
                    const closePromise = Promise.resolve(closing).catch(() => undefined);
                    if (!request.signal?.aborted) {
                        await closePromise;
                    }
                }
            } catch {
                // The SDK owns child cleanup; a late iterator-close failure is not exposed.
            }
        }
    }
}

function validateRequest(request: RideCodexSdkRunRequest): void {
    if (!request || request.channel !== 'sdk'
        || typeof request.threadKey !== 'string'
        || !request.threadKey.trim()
        || request.threadKey.length > RIDE_CODEX_SDK_LIMITS.maxThreadKeyLength
        || typeof request.input !== 'string'
        || request.input.length > RIDE_CODEX_SDK_LIMITS.maxInputLength
        || (request.threadId !== undefined && (typeof request.threadId !== 'string'
            || !request.threadId.trim() || request.threadId.length > RIDE_CODEX_SDK_LIMITS.maxThreadIdLength))
        || (request.model !== undefined && (typeof request.model !== 'string'
            || request.model.length > RIDE_CODEX_SDK_LIMITS.maxModelLength))
        || (request.workingDirectory !== undefined && typeof request.workingDirectory !== 'string')
        || (request.apiKey !== undefined && (typeof request.apiKey !== 'string'
            || !request.apiKey.trim() || request.apiKey.length > RIDE_CODEX_SDK_LIMITS.maxApiKeyLength))
        || (request.sandboxMode !== undefined && !isSandboxMode(request.sandboxMode))) {
        throw new RideCodexSdkError('invalid-request');
    }
}

function isSandboxMode(value: string): value is RideCodexSdkSandboxMode {
    return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access';
}

function assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw new RideCodexSdkError('cancelled');
    }
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) {
        return operation;
    }
    if (signal.aborted) {
        return Promise.reject(new RideCodexSdkError('cancelled'));
    }
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const onAbort = (): void => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(new RideCodexSdkError('cancelled'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        operation.then(value => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, error => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(error instanceof RideCodexSdkError ? error : new RideCodexSdkError('stream-failed'));
        });
        if (signal.aborted) {
            onAbort();
        }
    });
}

function nextWithAbort<T>(
    iterator: AsyncIterator<T>,
    signal: AbortSignal | undefined,
    close: () => void = () => closeIterator(iterator)
): Promise<IteratorResult<T>> {
    if (!signal) {
        return Promise.resolve(iterator.next());
    }
    if (signal.aborted) {
        close();
        return Promise.reject(new RideCodexSdkError('cancelled'));
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
        let settled = false;
        const onAbort = (): void => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            close();
            reject(new RideCodexSdkError('cancelled'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(iterator.next()).then(value => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, () => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(new RideCodexSdkError('stream-failed'));
        });
        if (signal.aborted) {
            onAbort();
        }
    });
}

function closeIterator(iterator: AsyncIterator<unknown>): void {
    try {
        const result = iterator.return?.(undefined);
        if (result) {
            Promise.resolve(result).catch(() => undefined);
        }
    } catch {
        // The active cancellation path has already settled safely.
    }
}

function eventBytes(event: RideCodexSdkEvent): number | undefined {
    try {
        const serialized = JSON.stringify(event);
        return serialized === undefined ? undefined : Buffer.byteLength(serialized, 'utf8');
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== undefined && Object(value) === value && !Array.isArray(value);
}

function freezeRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    return Object.freeze({ ...value });
}

function boundText(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function boundedLimit(value: number | undefined, fallback: number): number {
    return Number.isInteger(value) && (value as number) > 0
        ? Math.min(value as number, fallback)
        : fallback;
}

function messageForCode(code: RideCodexSdkDiagnosticCode): string {
    switch (code) {
        case 'runtime-unavailable': return 'The Codex SDK compatibility runtime is unavailable.';
        case 'capacity': return 'The Codex SDK compatibility channel is at capacity.';
        case 'invalid-request': return 'The Codex SDK compatibility request is invalid.';
        case 'cancelled': return 'The Codex SDK run was cancelled.';
        case 'app-server-turn-active': return 'The App Server turn is still active; start a separate SDK run.';
        case 'turn-failed': return 'The Codex SDK turn failed safely.';
        case 'listener-failed': return 'The Codex SDK response listener failed safely.';
        case 'stream-failed': return 'The Codex SDK stream failed safely.';
    }
}

async function loadBundledRuntime(): Promise<RideCodexSdkRuntime> {
    const runtimePath = path.join(__dirname, RIDE_CODEX_SDK_RUNTIME_FILENAME);
    // The runtime path is fixed to the adjacent build artifact; the rule does not
    // model this local-only dynamic import.
    // eslint-disable-next-line no-unsanitized/method
    const loaded = await import(pathToFileURL(runtimePath).href) as unknown as {
        readonly default?: unknown;
        readonly createCodexClient?: unknown;
    };
    const candidate = isRuntime(loaded) ? loaded : loaded.default;
    if (!isRuntime(candidate)) {
        throw new RideCodexSdkError('runtime-unavailable');
    }
    return candidate;
}

function isRuntime(value: unknown): value is RideCodexSdkRuntime {
    return isRecord(value) && typeof value.createCodexClient === 'function';
}
