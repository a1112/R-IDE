/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { posix, win32 } from 'node:path';
import { types as utilTypes } from 'node:util';
import {
    RideCodexConversationsClient,
    RideCodexConversationsSnapshot,
    RideCodexModel,
    RideCodexModelListRequest,
    RideCodexModelPage,
    RideCodexReasoningEffort,
    RideCodexServiceTier,
    RideCodexThreadActiveFlag,
    RideCodexThreadListRequest,
    RideCodexThreadPage,
    RideCodexThreadResumeRequest,
    RideCodexThreadStartRequest,
    RideCodexThreadStatus,
    RideCodexThreadSummary
} from '../common/ride-codex-conversations';
import type { RideCodexDisposable, RideCodexNotification, StableClientMethod } from './ride-codex-jsonl-client';

export interface RideCodexThreadHostLease {
    readonly generation: number;
    request(method: StableClientMethod, params: unknown, timeoutMs?: number): unknown | Promise<unknown>;
    release(): void;
}

export interface RideCodexThreadHostStateEvent {
    readonly state: 'stopped' | 'starting' | 'ready' | 'restarting' | 'stopping' | 'circuit-open' | 'disposed';
    readonly generation: number;
}

export interface RideCodexThreadHost {
    acquire(kind: 'foreground-panel'): Promise<RideCodexThreadHostLease>;
    onNotification(listener: (notification: RideCodexNotification, generation: number) => void): RideCodexDisposable;
    onStateChange(listener: (event: RideCodexThreadHostStateEvent) => void): RideCodexDisposable;
    snapshot(): RideCodexThreadHostStateEvent;
}

export interface RideCodexThreadCoordinatorOptions {
    readonly host: RideCodexThreadHost;
    readonly pathStyle?: 'win32' | 'posix';
}

export type RideCodexConversationsErrorCode =
    | 'invalid-data' | 'operation-failed' | 'operation-superseded' | 'thread-unavailable' | 'disposed';

export class RideCodexConversationsError extends Error {
    constructor(readonly code: RideCodexConversationsErrorCode) {
        super(ERROR_MESSAGES[code]);
        this.name = 'RideCodexConversationsError';
    }
}

const ERROR_MESSAGES: Readonly<Record<RideCodexConversationsErrorCode, string>> = Object.freeze({
    'invalid-data': 'Codex conversations returned invalid data.',
    'operation-failed': 'Codex conversations operation failed.',
    'operation-superseded': 'Codex conversations operation was superseded.',
    'thread-unavailable': 'The selected Codex thread is not available.',
    'disposed': 'Codex conversations are disposed.'
});
const MAX_PAGE_SIZE = 100;
const MAX_CACHED_THREADS = 500;
const MAX_ARCHIVE_TOMBSTONES = 512;
const MAX_PENDING_STATUSES = 512;
const MAX_ACTIVE_REQUESTS = 128;
const MAX_CURSOR_LENGTH = 4_096;
const MAX_ID_LENGTH = 256;
const MAX_MODEL_LENGTH = 256;
const MAX_NAME_LENGTH = 512;
const MAX_PREVIEW_LENGTH = 4_096;
const MAX_DESCRIPTION_LENGTH = 8_192;
const MAX_PATH_LENGTH = 32_768;
const MAX_RAW_ARRAY_LENGTH = 512;
const MAX_RAW_OBJECT_KEYS = 128;
const MAX_RAW_DEPTH = 24;
const MAX_RAW_NODES = 8_192;
const MODEL_OPTION_KEYS = Object.freeze(['cursor', 'limit', 'includeHidden'] as const);
const THREAD_LIST_KEYS = Object.freeze(['cursor', 'limit', 'archived'] as const);
const THREAD_START_KEYS = Object.freeze(['workspaceRoot', 'cwd', 'model', 'serviceTier'] as const);
const THREAD_RESUME_KEYS = Object.freeze(['threadId', ...THREAD_START_KEYS] as const);

interface RawBudget {
    remaining: number;
}

interface ThreadOperationContext {
    readonly lifecycle: number;
    readonly stateRevision: number;
    readonly selectionRevision: number;
}

interface PendingThreadStatus {
    readonly status: RideCodexThreadStatus;
    readonly revision: number;
}

interface ActiveThreadRequest {
    generation: number | undefined;
    readonly invalidated: Promise<never>;
    bind(lease: RideCodexThreadHostLease, generation: number): boolean;
    invalidate(error: RideCodexConversationsError): void;
    release(): void;
}

export class RideCodexThreadCoordinator {
    readonly #host: RideCodexThreadHost;
    readonly #pathStyle: 'win32' | 'posix';
    readonly #listeners: RideCodexDisposable[] = [];
    readonly #clients = new Set<RideCodexConversationsClient>();
    readonly #activeRequests = new Set<ActiveThreadRequest>();
    readonly #threads = new Map<string, RideCodexThreadSummary>();
    readonly #threadRevisions = new Map<string, number>();
    readonly #statusRevisions = new Map<string, number>();
    readonly #pendingStatuses = new Map<string, PendingThreadStatus>();
    readonly #archiveRevisions = new Map<string, number>();
    #generation: number;
    #stateRevision = 0;
    #metadataEvictionFloor = 0;
    #selectionRevision = 0;
    #threadListRevision = 0;
    #lifecycle = 0;
    #selectedThreadId: string | undefined;
    #restartRefreshGeneration = 0;
    #disposed = false;

    constructor(options: RideCodexThreadCoordinatorOptions) {
        const host = options.host;
        if (!host || typeof host.acquire !== 'function' || typeof host.snapshot !== 'function') {
            throw new RideCodexConversationsError('operation-failed');
        }
        this.#host = host;
        this.#pathStyle = options.pathStyle ?? (process.platform === 'win32' ? 'win32' : 'posix');
        let snapshot: RideCodexThreadHostStateEvent;
        try {
            snapshot = host.snapshot();
        } catch {
            throw new RideCodexConversationsError('operation-failed');
        }
        this.#generation = requireGeneration(snapshot.generation);
        try {
            this.#listeners.push(host.onNotification((notification, generation) => {
                this.#onNotification(notification, generation);
            }));
            this.#listeners.push(host.onStateChange(event => this.#onHostStateChange(event)));
        } catch {
            for (const listener of this.#listeners.splice(0)) {
                disposeSafely(listener);
            }
            throw new RideCodexConversationsError('operation-failed');
        }
    }

    snapshot(): RideCodexConversationsSnapshot {
        const threads = [...this.#threads.values()].sort(compareThreads);
        return Object.freeze({
            generation: this.#generation,
            threads: Object.freeze(threads),
            ...(this.#selectedThreadId === undefined ? {} : { selectedThreadId: this.#selectedThreadId }),
            persistedTranscriptCount: 0 as const
        });
    }

    status(): Promise<RideCodexConversationsSnapshot> {
        return Promise.resolve(this.snapshot());
    }

    setClient(client: RideCodexConversationsClient | undefined): void {
        if (!client || this.#disposed) {
            return;
        }
        this.#clients.add(client);
        this.#emitClient(client, this.snapshot());
    }

    disconnectClient(client: RideCodexConversationsClient): void {
        this.#clients.delete(client);
    }

    async listModels(options: RideCodexModelListRequest = {}): Promise<RideCodexModelPage> {
        this.#requireUsable();
        const record = requirePlainOptions(options, MODEL_OPTION_KEYS, 'Codex model-list options');
        const cursor = optionalString(record, 'cursor', MAX_CURSOR_LENGTH);
        const limit = optionalPageSize(record, 'limit');
        const includeHidden = optionalBoolean(record, 'includeHidden');
        const params = Object.freeze({
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
            ...(includeHidden === undefined ? {} : { includeHidden })
        });
        const raw = await this.#request('model/list', params, this.#lifecycle);
        return normalizeModelPage(raw);
    }

    async listThreads(options: RideCodexThreadListRequest = {}): Promise<RideCodexThreadPage> {
        this.#requireUsable();
        const record = requirePlainOptions(options, THREAD_LIST_KEYS, 'Codex thread-list options');
        const cursor = optionalString(record, 'cursor', MAX_CURSOR_LENGTH);
        const limit = optionalPageSize(record, 'limit');
        const archived = optionalBoolean(record, 'archived');
        const params = Object.freeze({
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
            ...(archived === undefined ? {} : { archived })
        });
        const operation = ++this.#threadListRevision;
        const context = this.#operationContext();
        const page = normalizeThreadPage(await this.#request('thread/list', params, context.lifecycle));
        if (archived !== true && operation === this.#threadListRevision
            && context.selectionRevision === this.#selectionRevision && !this.#disposed
            && context.stateRevision >= this.#metadataEvictionFloor) {
            let changed = false;
            if (cursor === undefined && context.stateRevision === this.#stateRevision) {
                changed = this.#threads.size > 0;
                this.#threads.clear();
                this.#threadRevisions.clear();
                this.#statusRevisions.clear();
            }
            for (const thread of page.data) {
                changed = this.#mergeThread(thread, context.stateRevision) || changed;
            }
            changed = this.#trimThreads() || changed;
            if (page.nextCursor === null && this.#selectedThreadId
                && !this.#threads.has(this.#selectedThreadId)) {
                this.#selectedThreadId = undefined;
                this.#selectionRevision += 1;
                changed = true;
            }
            if (changed) {
                this.#publish();
            }
        }
        return page;
    }

    async startThread(request: RideCodexThreadStartRequest): Promise<RideCodexThreadSummary> {
        this.#requireUsable();
        const record = requirePlainOptions(request, THREAD_START_KEYS, 'Codex thread-start request');
        const cwd = normalizeWorkspaceCwd(record, this.#pathStyle);
        const model = optionalIdentifier(record, 'model', MAX_MODEL_LENGTH);
        const serviceTier = optionalIdentifier(record, 'serviceTier', MAX_MODEL_LENGTH);
        const params = Object.freeze({
            cwd,
            ...(model === undefined ? {} : { model }),
            ...(serviceTier === undefined ? {} : { serviceTier }),
            sandbox: 'workspace-write' as const,
            approvalPolicy: 'on-request' as const,
            ephemeral: false
        });
        const context = this.#operationContext();
        const summary = normalizeThreadResponse(
            await this.#request('thread/start', params, context.lifecycle)
        );
        this.#commitThreadOperation(summary, context, true);
        return summary;
    }

    async resumeThread(request: RideCodexThreadResumeRequest): Promise<RideCodexThreadSummary> {
        this.#requireUsable();
        const record = requirePlainOptions(request, THREAD_RESUME_KEYS, 'Codex thread-resume request');
        const threadId = requiredIdentifier(record, 'threadId', MAX_ID_LENGTH);
        const cwd = normalizeWorkspaceCwd(record, this.#pathStyle);
        const model = optionalIdentifier(record, 'model', MAX_MODEL_LENGTH);
        const serviceTier = optionalIdentifier(record, 'serviceTier', MAX_MODEL_LENGTH);
        const params = Object.freeze({
            threadId,
            cwd,
            ...(model === undefined ? {} : { model }),
            ...(serviceTier === undefined ? {} : { serviceTier }),
            sandbox: 'workspace-write' as const,
            approvalPolicy: 'on-request' as const
        });
        const context = this.#operationContext();
        const summary = normalizeThreadResponse(
            await this.#request('thread/resume', params, context.lifecycle)
        );
        if (summary.id !== threadId) {
            throw new RideCodexConversationsError('invalid-data');
        }
        this.#commitThreadOperation(summary, context, true);
        return summary;
    }

    async readThread(threadId: string): Promise<RideCodexThreadSummary> {
        return this.#readThread(requiredStandaloneIdentifier(threadId, 'Codex thread id', MAX_ID_LENGTH));
    }

    async archiveThread(threadId: string): Promise<void> {
        this.#requireUsable();
        const id = requiredStandaloneIdentifier(threadId, 'Codex thread id', MAX_ID_LENGTH);
        const lifecycle = this.#lifecycle;
        normalizeEmptyResponse(await this.#request(
            'thread/archive', Object.freeze({ threadId: id }), lifecycle
        ));
        if (!this.#disposed && lifecycle === this.#lifecycle && this.#archiveThread(id)) {
            this.#publish();
        }
    }

    async selectThread(threadId: string | null): Promise<void> {
        this.#requireUsable();
        if (threadId === null) {
            const changed = this.#selectedThreadId !== undefined;
            this.#selectedThreadId = undefined;
            this.#selectionRevision += 1;
            if (changed) {
                this.#publish();
            }
            return;
        }
        const id = requiredStandaloneIdentifier(threadId, 'Codex thread id', MAX_ID_LENGTH);
        if (!this.#threads.has(id)) {
            const changed = this.#selectedThreadId !== undefined;
            this.#selectedThreadId = undefined;
            this.#selectionRevision += 1;
            if (changed) {
                this.#publish();
            }
            throw new RideCodexConversationsError('thread-unavailable');
        }
        const changed = this.#selectedThreadId !== id;
        this.#selectedThreadId = id;
        this.#selectionRevision += 1;
        if (changed) {
            this.#publish();
        }
    }

    async dispose(): Promise<void> {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        this.#lifecycle += 1;
        this.#threadListRevision += 1;
        for (const active of [...this.#activeRequests]) {
            active.invalidate(new RideCodexConversationsError('disposed'));
            active.release();
            this.#activeRequests.delete(active);
        }
        for (const listener of this.#listeners.splice(0)) {
            disposeSafely(listener);
        }
        this.#clients.clear();
    }

    onStop(): Promise<void> {
        return this.dispose();
    }

    async #readThread(threadId: string): Promise<RideCodexThreadSummary> {
        this.#requireUsable();
        const context = this.#operationContext();
        const summary = normalizeThreadResponse(await this.#request(
            'thread/read', Object.freeze({ threadId, includeTurns: false }), context.lifecycle
        ));
        if (summary.id !== threadId) {
            throw new RideCodexConversationsError('invalid-data');
        }
        this.#commitThreadOperation(summary, context, false);
        return summary;
    }

    #commitThreadOperation(summary: RideCodexThreadSummary, context: ThreadOperationContext, select: boolean): void {
        if (this.#disposed || context.lifecycle !== this.#lifecycle
            || context.stateRevision < this.#metadataEvictionFloor) {
            throw new RideCodexConversationsError('operation-superseded');
        }
        let changed = this.#mergeThread(summary, context.stateRevision);
        if (select && context.selectionRevision === this.#selectionRevision
            && this.#threads.has(summary.id) && this.#selectedThreadId !== summary.id) {
            this.#selectedThreadId = summary.id;
            this.#selectionRevision += 1;
            changed = true;
        }
        changed = this.#trimThreads() || changed;
        if (changed) {
            this.#publish();
        }
    }

    async #request(
        method: StableClientMethod,
        params: unknown,
        lifecycle: number
    ): Promise<unknown> {
        const active = this.#trackRequest();
        try {
            let acquiring: Promise<RideCodexThreadHostLease>;
            try {
                acquiring = Promise.resolve(this.#host.acquire('foreground-panel'));
            } catch {
                throw new RideCodexConversationsError('operation-failed');
            }
            const binding = acquiring.then(lease => {
                let generation: number;
                try {
                    generation = requireGeneration(lease.generation);
                } catch (error) {
                    releaseLeaseSafely(lease);
                    throw error;
                }
                if (!active.bind(lease, generation)) {
                    throw new RideCodexConversationsError(
                        this.#disposed ? 'disposed' : 'operation-superseded'
                    );
                }
                return Object.freeze({ lease, generation });
            });
            void binding.catch(() => undefined);
            const { lease, generation } = await Promise.race([binding, active.invalidated]);
            this.#requireOperation(lifecycle, generation);
            const pending = lease.request(method, params);
            if (typeof pending === 'object' && pending !== null && utilTypes.isProxy(pending)) {
                throw new RideCodexConversationsError('invalid-data');
            }
            const result = await Promise.race([Promise.resolve(pending), active.invalidated]);
            this.#requireOperation(lifecycle, generation);
            return result;
        } catch (error) {
            if (error instanceof RideCodexConversationsError) {
                throw error;
            }
            throw new RideCodexConversationsError('operation-failed');
        } finally {
            active.release();
            this.#activeRequests.delete(active);
        }
    }

    #trackRequest(): ActiveThreadRequest {
        if (this.#activeRequests.size >= MAX_ACTIVE_REQUESTS) {
            throw new RideCodexConversationsError('operation-failed');
        }
        let invalidated = false;
        let released = false;
        let lease: RideCodexThreadHostLease | undefined;
        let rejectInvalidated!: (error: RideCodexConversationsError) => void;
        const invalidation = new Promise<never>((_resolve, reject) => {
            rejectInvalidated = reject;
        });
        void invalidation.catch(() => undefined);
        const active: ActiveThreadRequest = {
            generation: undefined,
            invalidated: invalidation,
            bind: (nextLease, generation) => {
                if (invalidated || released || lease !== undefined) {
                    releaseLeaseSafely(nextLease);
                    return false;
                }
                lease = nextLease;
                active.generation = generation;
                return true;
            },
            invalidate: error => {
                if (!invalidated) {
                    invalidated = true;
                    rejectInvalidated(error);
                }
            },
            release: () => {
                if (released) {
                    return;
                }
                released = true;
                if (lease) {
                    releaseLeaseSafely(lease);
                }
            }
        };
        this.#activeRequests.add(active);
        return active;
    }

    #operationContext(): ThreadOperationContext {
        return Object.freeze({
            lifecycle: this.#lifecycle,
            stateRevision: this.#stateRevision,
            selectionRevision: this.#selectionRevision
        });
    }

    #mergeThread(summary: RideCodexThreadSummary, operationStateRevision: number): boolean {
        const archivedAt = this.#archiveRevisions.get(summary.id);
        if (archivedAt !== undefined && archivedAt > operationStateRevision) {
            return false;
        }
        const threadChangedAt = this.#threadRevisions.get(summary.id);
        if (threadChangedAt !== undefined && threadChangedAt > operationStateRevision) {
            return false;
        }
        const existing = this.#threads.get(summary.id);
        if (existing && existing.updatedAt > summary.updatedAt) {
            return false;
        }
        const pendingStatus = this.#pendingStatuses.get(summary.id);
        const candidate = pendingStatus !== undefined && pendingStatus.revision > operationStateRevision
            ? freezeThreadSummary({ ...summary, status: pendingStatus.status })
            : summary;
        const changed = !existing || !threadEquals(existing, candidate);
        if (changed) {
            this.#threads.set(candidate.id, candidate);
        }
        const revision = this.#nextStateRevision();
        this.#threadRevisions.set(candidate.id, revision);
        if (pendingStatus !== undefined && pendingStatus.revision > operationStateRevision) {
            this.#pendingStatuses.delete(candidate.id);
            this.#statusRevisions.set(candidate.id, revision);
        }
        return this.#trimThreads() || changed;
    }

    #mergeStartedNotification(summary: RideCodexThreadSummary): boolean {
        if (this.#archiveRevisions.has(summary.id)) {
            return false;
        }
        const existing = this.#threads.get(summary.id);
        const pendingStatus = this.#pendingStatuses.get(summary.id);
        if (existing && existing.updatedAt > summary.updatedAt && pendingStatus === undefined) {
            return false;
        }
        const base = existing && existing.updatedAt > summary.updatedAt ? existing : summary;
        const statusChangedAt = this.#statusRevisions.get(summary.id);
        const status = pendingStatus?.status
            ?? (existing && statusChangedAt !== undefined ? existing.status : base.status);
        const candidate = status === base.status ? base : freezeThreadSummary({ ...base, status });
        const changed = !existing || !threadEquals(existing, candidate);
        if (changed) {
            this.#threads.set(candidate.id, candidate);
        }
        const revision = this.#nextStateRevision();
        this.#threadRevisions.set(candidate.id, revision);
        if (pendingStatus !== undefined) {
            this.#pendingStatuses.delete(candidate.id);
            this.#statusRevisions.set(candidate.id, revision);
        }
        return this.#trimThreads() || changed;
    }

    #mergeStatusNotification(threadId: string, status: RideCodexThreadStatus): boolean {
        if (this.#archiveRevisions.has(threadId)) {
            return false;
        }
        const revision = this.#nextStateRevision();
        const existing = this.#threads.get(threadId);
        if (existing) {
            this.#threadRevisions.set(threadId, revision);
            this.#statusRevisions.set(threadId, revision);
            if (statusEquals(existing.status, status)) {
                return false;
            }
            this.#threads.set(threadId, freezeThreadSummary({ ...existing, status }));
            return true;
        }
        this.#pendingStatuses.delete(threadId);
        this.#pendingStatuses.set(threadId, Object.freeze({ status, revision }));
        while (this.#pendingStatuses.size > MAX_PENDING_STATUSES) {
            const oldest = this.#pendingStatuses.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            const evicted = this.#pendingStatuses.get(oldest);
            this.#recordMetadataEviction(evicted?.revision);
            this.#pendingStatuses.delete(oldest);
        }
        return false;
    }

    #nextStateRevision(): number {
        this.#stateRevision += 1;
        return this.#stateRevision;
    }

    #archiveThread(threadId: string): boolean {
        const removed = this.#threads.has(threadId);
        const selected = this.#selectedThreadId === threadId;
        const revision = this.#nextStateRevision();
        this.#archiveRevisions.delete(threadId);
        this.#archiveRevisions.set(threadId, revision);
        while (this.#archiveRevisions.size > MAX_ARCHIVE_TOMBSTONES) {
            const oldest = this.#archiveRevisions.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.#recordMetadataEviction(this.#archiveRevisions.get(oldest));
            this.#archiveRevisions.delete(oldest);
        }
        this.#pendingStatuses.delete(threadId);
        this.#threadRevisions.delete(threadId);
        this.#statusRevisions.delete(threadId);
        this.#threads.delete(threadId);
        if (selected) {
            this.#selectedThreadId = undefined;
            this.#selectionRevision += 1;
        }
        return removed || selected;
    }

    #trimThreads(): boolean {
        let changed = false;
        while (this.#threads.size > MAX_CACHED_THREADS) {
            const removable = [...this.#threads.keys()].find(id => id !== this.#selectedThreadId);
            if (!removable) {
                break;
            }
            this.#recordMetadataEviction(
                this.#threadRevisions.get(removable) ?? this.#stateRevision,
                this.#statusRevisions.get(removable),
                this.#pendingStatuses.get(removable)?.revision,
                this.#archiveRevisions.get(removable)
            );
            this.#threads.delete(removable);
            this.#threadRevisions.delete(removable);
            this.#statusRevisions.delete(removable);
            this.#pendingStatuses.delete(removable);
            this.#archiveRevisions.delete(removable);
            changed = true;
        }
        return changed;
    }

    #recordMetadataEviction(...revisions: readonly (number | undefined)[]): void {
        for (const revision of revisions) {
            if (revision !== undefined && revision > this.#metadataEvictionFloor) {
                this.#metadataEvictionFloor = revision;
            }
        }
    }

    #onNotification(notification: RideCodexNotification, generation: number): void {
        if (this.#disposed || !Number.isSafeInteger(generation) || generation !== this.#generation) {
            return;
        }
        try {
            switch (notification.method) {
                case 'thread/started': {
                    const params = requireValidatedRecord(notification.params);
                    const summary = normalizeThread(ownValue(params, 'thread'));
                    if (this.#mergeStartedNotification(summary)) {
                        this.#publish();
                    }
                    break;
                }
                case 'thread/status/changed': {
                    const params = requireValidatedRecord(notification.params);
                    const threadId = requiredIdentifier(params, 'threadId', MAX_ID_LENGTH);
                    const status = normalizeThreadStatus(ownValue(params, 'status'));
                    if (this.#mergeStatusNotification(threadId, status)) {
                        this.#publish();
                    }
                    break;
                }
                case 'thread/archived': {
                    const params = requireValidatedRecord(notification.params);
                    const threadId = requiredIdentifier(params, 'threadId', MAX_ID_LENGTH);
                    if (this.#archiveThread(threadId)) {
                        this.#publish();
                    }
                    break;
                }
                default:
                    break;
            }
        } catch {
            // Untrusted notifications fail closed and never replace trusted state.
        }
    }

    #onHostStateChange(event: RideCodexThreadHostStateEvent): void {
        if (this.#disposed || !Number.isSafeInteger(event.generation) || event.generation < this.#generation) {
            return;
        }
        if (event.generation > this.#generation) {
            this.#generation = event.generation;
            this.#nextStateRevision();
            this.#metadataEvictionFloor = 0;
            this.#threadRevisions.clear();
            this.#statusRevisions.clear();
            this.#pendingStatuses.clear();
            this.#archiveRevisions.clear();
            this.#restartRefreshGeneration = 0;
            this.#publish();
        }
        const hostInvalid = event.state === 'circuit-open' || event.state === 'disposed';
        for (const active of [...this.#activeRequests]) {
            if (active.generation !== undefined
                && (hostInvalid || active.generation !== this.#generation)) {
                active.invalidate(new RideCodexConversationsError('operation-superseded'));
                active.release();
                this.#activeRequests.delete(active);
            }
        }
        const selected = this.#selectedThreadId;
        if (event.state === 'ready' && selected && this.#restartRefreshGeneration !== event.generation) {
            this.#restartRefreshGeneration = event.generation;
            const generation = event.generation;
            const selectionRevision = this.#selectionRevision;
            void this.#refreshSelectedThread(selected, generation, selectionRevision);
        }
    }

    async #refreshSelectedThread(threadId: string, generation: number, selectionRevision: number): Promise<void> {
        try {
            await this.#readThread(threadId);
        } catch {
            if (!this.#disposed && this.#generation === generation
                && this.#selectionRevision === selectionRevision && this.#selectedThreadId === threadId) {
                this.#selectedThreadId = undefined;
                this.#selectionRevision += 1;
                this.#publish();
            }
        }
    }

    #publish(): void {
        const snapshot = this.snapshot();
        for (const client of [...this.#clients]) {
            this.#emitClient(client, snapshot);
        }
    }

    #emitClient(client: RideCodexConversationsClient, snapshot: RideCodexConversationsSnapshot): void {
        try {
            client.conversationsChanged(snapshot);
        } catch {
            // RPC clients cannot destabilize shared coordinator state.
        }
    }

    #requireUsable(): void {
        if (this.#disposed) {
            throw new RideCodexConversationsError('disposed');
        }
    }

    #requireOperation(lifecycle: number, generation: number): void {
        if (this.#disposed) {
            throw new RideCodexConversationsError('disposed');
        }
        if (lifecycle !== this.#lifecycle) {
            throw new RideCodexConversationsError('operation-superseded');
        }
        if (generation !== this.#generation) {
            throw new RideCodexConversationsError('operation-superseded');
        }
    }
}

function normalizeModelPage(value: unknown): RideCodexModelPage {
    const record = requireValidatedRecord(value);
    const data = requireArray(ownValue(record, 'data'), MAX_PAGE_SIZE);
    const models = Object.freeze(data.map(normalizeModel));
    const nextCursor = nullableString(ownValue(record, 'nextCursor'), MAX_CURSOR_LENGTH);
    return Object.freeze({ data: models, nextCursor });
}

function normalizeModel(value: unknown): RideCodexModel {
    const record = requirePlainRecord(value);
    const supportedReasoningEfforts = Object.freeze(requireArray(
        ownValue(record, 'supportedReasoningEfforts'), 32
    ).map(normalizeReasoningEffort));
    const defaultReasoningEffort = requiredString(record, 'defaultReasoningEffort', MAX_MODEL_LENGTH);
    if (!supportedReasoningEfforts.some(option => option.effort === defaultReasoningEffort)) {
        throw new RideCodexConversationsError('invalid-data');
    }
    const inputModalities = Object.freeze(requireArray(ownValue(record, 'inputModalities'), 4).map(value => {
        if (value !== 'text' && value !== 'image') {
            throw new RideCodexConversationsError('invalid-data');
        }
        return value;
    }));
    const serviceTiers = Object.freeze(requireArray(ownValue(record, 'serviceTiers'), 32).map(normalizeServiceTier));
    const defaultServiceTier = nullableString(ownValue(record, 'defaultServiceTier'), MAX_MODEL_LENGTH);
    if (defaultServiceTier !== null && !serviceTiers.some(tier => tier.id === defaultServiceTier)) {
        throw new RideCodexConversationsError('invalid-data');
    }
    return Object.freeze({
        id: requiredIdentifier(record, 'id', MAX_ID_LENGTH),
        model: requiredIdentifier(record, 'model', MAX_MODEL_LENGTH),
        displayName: requiredString(record, 'displayName', MAX_NAME_LENGTH),
        description: requiredString(record, 'description', MAX_DESCRIPTION_LENGTH, true),
        isDefault: requiredBoolean(record, 'isDefault'),
        hidden: requiredBoolean(record, 'hidden'),
        inputModalities,
        supportedReasoningEfforts,
        defaultReasoningEffort,
        supportsPersonality: requiredBoolean(record, 'supportsPersonality'),
        serviceTiers,
        defaultServiceTier
    });
}

function normalizeReasoningEffort(value: unknown): RideCodexReasoningEffort {
    const record = requirePlainRecord(value);
    return Object.freeze({
        effort: requiredString(record, 'reasoningEffort', MAX_MODEL_LENGTH),
        description: requiredString(record, 'description', MAX_DESCRIPTION_LENGTH, true)
    });
}

function normalizeServiceTier(value: unknown): RideCodexServiceTier {
    const record = requirePlainRecord(value);
    return Object.freeze({
        id: requiredIdentifier(record, 'id', MAX_MODEL_LENGTH),
        name: requiredString(record, 'name', MAX_NAME_LENGTH),
        description: requiredString(record, 'description', MAX_DESCRIPTION_LENGTH, true)
    });
}

function normalizeThreadPage(value: unknown): RideCodexThreadPage {
    const record = requireValidatedRecord(value);
    const data = Object.freeze(requireArray(ownValue(record, 'data'), MAX_PAGE_SIZE).map(normalizeThread));
    return Object.freeze({
        data,
        nextCursor: nullableString(ownValue(record, 'nextCursor'), MAX_CURSOR_LENGTH),
        backwardsCursor: nullableString(ownValue(record, 'backwardsCursor'), MAX_CURSOR_LENGTH)
    });
}

function normalizeThreadResponse(value: unknown): RideCodexThreadSummary {
    const record = requireValidatedRecord(value);
    return normalizeThread(ownValue(record, 'thread'));
}

function normalizeThread(value: unknown): RideCodexThreadSummary {
    const record = requirePlainRecord(value);
    if (requiredBoolean(record, 'ephemeral')) {
        throw new RideCodexConversationsError('invalid-data');
    }
    requireArray(ownValue(record, 'turns'), MAX_RAW_ARRAY_LENGTH);
    const nameValue = ownValue(record, 'name');
    const name = nameValue === null ? null : requireBoundedString(nameValue, MAX_NAME_LENGTH, true);
    const recencyValue = ownValue(record, 'recencyAt');
    const recencyAt = recencyValue === null ? null : requireTimestamp(recencyValue);
    return freezeThreadSummary({
        id: requiredIdentifier(record, 'id', MAX_ID_LENGTH),
        preview: requiredString(record, 'preview', MAX_PREVIEW_LENGTH, true),
        name,
        modelProvider: requiredIdentifier(record, 'modelProvider', MAX_MODEL_LENGTH),
        createdAt: requireTimestamp(ownValue(record, 'createdAt')),
        updatedAt: requireTimestamp(ownValue(record, 'updatedAt')),
        recencyAt,
        cwd: requiredString(record, 'cwd', MAX_PATH_LENGTH),
        status: normalizeThreadStatus(ownValue(record, 'status'))
    });
}

function normalizeThreadStatus(value: unknown): RideCodexThreadStatus {
    const record = requirePlainRecord(value);
    const type = requiredString(record, 'type', 32);
    if (type === 'notLoaded' || type === 'idle' || type === 'systemError') {
        return Object.freeze({
            kind: type === 'notLoaded' ? 'not-loaded' : type === 'systemError' ? 'system-error' : 'idle',
            activeFlags: Object.freeze([])
        });
    }
    if (type !== 'active') {
        throw new RideCodexConversationsError('invalid-data');
    }
    const rawFlags = requireArray(ownValue(record, 'activeFlags'), 2);
    const flags: RideCodexThreadActiveFlag[] = [];
    for (const flag of rawFlags) {
        const normalized = flag === 'waitingOnApproval'
            ? 'waiting-on-approval'
            : flag === 'waitingOnUserInput' ? 'waiting-on-user-input' : undefined;
        if (!normalized || flags.includes(normalized)) {
            throw new RideCodexConversationsError('invalid-data');
        }
        flags.push(normalized);
    }
    return Object.freeze({ kind: 'active', activeFlags: Object.freeze(flags) });
}

function normalizeEmptyResponse(value: unknown): void {
    const record = requireValidatedRecord(value);
    if (Object.getOwnPropertyNames(record).length !== 0) {
        throw new RideCodexConversationsError('invalid-data');
    }
}

function requireValidatedRecord(value: unknown): Record<string, unknown> {
    assertPlainData(value, 0, { remaining: MAX_RAW_NODES });
    return requirePlainRecord(value);
}

function assertPlainData(value: unknown, depth: number, budget: RawBudget): void {
    budget.remaining -= 1;
    if (budget.remaining < 0 || depth > MAX_RAW_DEPTH || utilTypes.isProxy(value)) {
        throw new RideCodexConversationsError('invalid-data');
    }
    if (value === null || typeof value === 'boolean') {
        return;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new RideCodexConversationsError('invalid-data');
        }
        return;
    }
    if (typeof value === 'string') {
        if (value.length > MAX_PATH_LENGTH || value.includes('\0')) {
            throw new RideCodexConversationsError('invalid-data');
        }
        return;
    }
    if (typeof value !== 'object') {
        throw new RideCodexConversationsError('invalid-data');
    }
    if (Array.isArray(value)) {
        if (value.length > MAX_RAW_ARRAY_LENGTH || Object.getOwnPropertySymbols(value).length !== 0) {
            throw new RideCodexConversationsError('invalid-data');
        }
        const names = Object.getOwnPropertyNames(value);
        if (names.length !== value.length + 1) {
            throw new RideCodexConversationsError('invalid-data');
        }
        for (let index = 0; index < value.length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                throw new RideCodexConversationsError('invalid-data');
            }
            assertPlainData(descriptor.value, depth + 1, budget);
        }
        return;
    }
    const record = requirePlainRecord(value);
    const keys = Object.getOwnPropertyNames(record);
    if (keys.length > MAX_RAW_OBJECT_KEYS || Object.getOwnPropertySymbols(record).length !== 0) {
        throw new RideCodexConversationsError('invalid-data');
    }
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            throw new RideCodexConversationsError('invalid-data');
        }
        assertPlainData(descriptor.value, depth + 1, budget);
    }
}

function requirePlainOptions<T extends readonly string[]>(
    value: unknown,
    allowed: T,
    label: string
): Record<string, unknown> {
    const record = requirePlainRecord(value, label);
    const keys = Object.getOwnPropertyNames(record);
    if (Object.getOwnPropertySymbols(record).length !== 0
        || keys.some(key => !(allowed as readonly string[]).includes(key))) {
        throw new TypeError(`${label} is invalid.`);
    }
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            throw new TypeError(`${label} is invalid.`);
        }
    }
    return record;
}

function requirePlainRecord(value: unknown, label = 'Codex response'): Record<string, unknown> {
    if (utilTypes.isProxy(value) || typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new RideCodexConversationsError('invalid-data');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new RideCodexConversationsError('invalid-data');
    }
    return value as Record<string, unknown>;
}

function requireArray(value: unknown, maximum: number): readonly unknown[] {
    if (utilTypes.isProxy(value) || !Array.isArray(value) || value.length > maximum) {
        throw new RideCodexConversationsError('invalid-data');
    }
    return value;
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new RideCodexConversationsError('invalid-data');
    }
    return descriptor.value;
}

function optionalString(record: Record<string, unknown>, key: string, maximum: number): string | undefined {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor) {
        return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TypeError(`Codex ${key} is invalid.`);
    }
    return requireBoundedString(descriptor.value, maximum);
}

function optionalIdentifier(record: Record<string, unknown>, key: string, maximum: number): string | undefined {
    const value = optionalString(record, key, maximum);
    if (value !== undefined) {
        validateIdentifier(value);
    }
    return value;
}

function optionalPageSize(record: Record<string, unknown>, key: string): number | undefined {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor) {
        return undefined;
    }
    const value = descriptor.value;
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || !Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_PAGE_SIZE) {
        throw new RangeError('Codex page size is invalid.');
    }
    return value as number;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor) {
        return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'boolean') {
        throw new TypeError(`Codex ${key} is invalid.`);
    }
    return descriptor.value;
}

function requiredString(
    record: Record<string, unknown>, key: string, maximum: number, allowEmpty = false
): string {
    return requireBoundedString(ownValue(record, key), maximum, allowEmpty);
}

function requiredIdentifier(record: Record<string, unknown>, key: string, maximum: number): string {
    const value = requiredString(record, key, maximum);
    validateIdentifier(value);
    return value;
}

function requiredStandaloneIdentifier(value: unknown, label: string, maximum: number): string {
    const normalized = requireBoundedString(value, maximum);
    try {
        validateIdentifier(normalized);
    } catch {
        throw new TypeError(`${label} is invalid.`);
    }
    return normalized;
}

function validateIdentifier(value: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
        throw new RideCodexConversationsError('invalid-data');
    }
}

function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
    const value = ownValue(record, key);
    if (typeof value !== 'boolean') {
        throw new RideCodexConversationsError('invalid-data');
    }
    return value;
}

function requireBoundedString(value: unknown, maximum: number, allowEmpty = false): string {
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0)
        || value.length > maximum || value.includes('\0')) {
        throw new RideCodexConversationsError('invalid-data');
    }
    return value;
}

function nullableString(value: unknown, maximum: number): string | null {
    return value === null ? null : requireBoundedString(value, maximum);
}

function requireTimestamp(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new RideCodexConversationsError('invalid-data');
    }
    return value as number;
}

function requireGeneration(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new RideCodexConversationsError('operation-failed');
    }
    return value as number;
}

function normalizeWorkspaceCwd(record: Record<string, unknown>, style: 'win32' | 'posix'): string {
    const root = requiredString(record, 'workspaceRoot', MAX_PATH_LENGTH);
    const cwd = optionalString(record, 'cwd', MAX_PATH_LENGTH) ?? root;
    const paths = style === 'win32' ? win32 : posix;
    if (isNetworkPath(root, style) || isNetworkPath(cwd, style)
        || !isFullyQualifiedLocalPath(root, style) || !isFullyQualifiedLocalPath(cwd, style)) {
        throw new TypeError('Codex workspace path is invalid.');
    }
    const normalizedRoot = paths.normalize(root);
    const normalizedCwd = paths.normalize(cwd);
    if (normalizedRoot === paths.parse(normalizedRoot).root) {
        throw new TypeError('Codex workspace path is invalid.');
    }
    const relative = paths.relative(normalizedRoot, normalizedCwd);
    if (relative !== '' && (relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative))) {
        throw new TypeError('Codex cwd must remain inside the workspace.');
    }
    return normalizedCwd;
}

function isFullyQualifiedLocalPath(value: string, style: 'win32' | 'posix'): boolean {
    if (style === 'posix') {
        return posix.isAbsolute(value);
    }
    const normalized = value.replace(/\//g, '\\');
    return /^[A-Za-z]:\\$/.test(win32.parse(normalized).root);
}

function isNetworkPath(value: string, style: 'win32' | 'posix'): boolean {
    if (style === 'win32') {
        const normalized = value.replace(/\//g, '\\');
        return normalized.startsWith('\\\\');
    }
    return value.startsWith('//');
}

function freezeThreadSummary(summary: RideCodexThreadSummary): RideCodexThreadSummary {
    return Object.freeze({ ...summary });
}

function compareThreads(left: RideCodexThreadSummary, right: RideCodexThreadSummary): number {
    return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
}

function statusEquals(left: RideCodexThreadStatus, right: RideCodexThreadStatus): boolean {
    return left.kind === right.kind
        && left.activeFlags.length === right.activeFlags.length
        && left.activeFlags.every((flag, index) => flag === right.activeFlags[index]);
}

function threadEquals(left: RideCodexThreadSummary, right: RideCodexThreadSummary): boolean {
    return left.id === right.id && left.preview === right.preview && left.name === right.name
        && left.modelProvider === right.modelProvider && left.createdAt === right.createdAt
        && left.updatedAt === right.updatedAt && left.recencyAt === right.recencyAt
        && left.cwd === right.cwd && statusEquals(left.status, right.status);
}

function releaseLeaseSafely(lease: RideCodexThreadHostLease): void {
    try {
        lease.release();
    } catch {
        // The host owns idempotent lease cleanup.
    }
}

function disposeSafely(disposable: RideCodexDisposable): void {
    try {
        disposable.dispose();
    } catch {
        // Observer disposal is idempotent and best effort.
    }
}
