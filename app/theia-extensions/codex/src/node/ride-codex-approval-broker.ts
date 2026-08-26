/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { types as utilTypes } from 'node:util';
import {
    RideCodexApprovalCard,
    RideCodexApprovalClient,
    RideCodexApprovalContext,
    RideCodexApprovalDecision,
    RideCodexApprovalDecisionRequest,
    RideCodexApprovalDecisionResult,
    RideCodexApprovalSession
} from '../common/ride-codex-approvals';
import { deepFreezeRideCodex, utf8ByteLength } from '../common/ride-codex-events';

type RequestId = string | number;

export interface RideCodexApprovalHostLease {
    readonly kind: string;
    readonly generation: number;
    release(): void;
}

export interface RideCodexApprovalHost {
    acquire(kind: 'approval'): Promise<RideCodexApprovalHostLease>;
    respondServerRequest(generation: number, id: RequestId, result: unknown): Promise<void>;
    onServerRequest?(listener: (request: Readonly<{
        id: RequestId;
        method: string;
        params: unknown;
    }>, generation: number) => void): { dispose(): void };
    onStateChange?(listener: (event: Readonly<{
        state: string;
        generation: number;
    }>) => void): { dispose(): void };
    snapshot?(): Readonly<{ state: string; generation: number }>;
    onNotification?(listener: (notification: Readonly<{
        method: string;
        params: unknown;
    }>, generation: number) => void): { dispose(): void };
}

export interface RideCodexApprovalScopeChange {
    readonly path: string;
    readonly kind: 'add' | 'delete' | 'update';
    readonly movePath?: string | null;
    readonly diff?: string;
}

export interface RideCodexApprovalScopeResolution {
    readonly workspaceRoot: string;
    readonly changes: readonly RideCodexApprovalScopeChange[];
}

export interface RideCodexApprovalScopeIdentity extends RideCodexApprovalContext {
    readonly itemId: string;
}

export interface RideCodexApprovalBrokerOptions {
    readonly host: RideCodexApprovalHost;
    readonly now?: () => number;
    readonly schedule?: (callback: () => void, delayMs: number) => { dispose(): void };
    readonly ttlMs?: number;
    readonly maxPending?: number;
    readonly maxClients?: number;
    readonly pathStyle?: 'posix' | 'win32';
    readonly allowAcceptForSession?: (kind: 'command' | 'file-change') => boolean;
    readonly resolveFileScope?: (
        identity: RideCodexApprovalScopeIdentity
    ) => Promise<RideCodexApprovalScopeResolution | undefined>;
    readonly resolveRealPath?: (path: string) => Promise<string>;
}

interface SessionRecord {
    readonly id: number;
    readonly client: RideCodexApprovalClient;
    context?: RideCodexApprovalContext;
    disposed: boolean;
}

interface PendingApproval {
    readonly token: string;
    readonly fingerprint: string;
    readonly generation: number;
    readonly requestId: RequestId;
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly ownerId: number;
    readonly allowedDecisions: readonly RideCodexApprovalDecision[];
    readonly card: RideCodexApprovalCard;
    readonly lease: RideCodexApprovalHostLease;
    readonly timer: { dispose(): void };
}

interface ValidatedCommandRequest {
    readonly id: RequestId;
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly command: string;
    readonly cwd?: string;
    readonly reason?: string;
    readonly network?: Readonly<{
        host: string;
        protocol: 'http' | 'https' | 'socks5Tcp' | 'socks5Udp';
    }>;
}

interface ValidatedFileRequest {
    readonly id: RequestId;
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly reason?: string;
}

interface SupportedEnvelope {
    readonly id: RequestId;
    readonly method: 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval';
    readonly params: unknown;
}

interface TrackedThreadRoot {
    readonly generation: number;
    readonly threadId: string;
    readonly root: string;
}

interface TrackedFileScope extends RideCodexApprovalScopeIdentity {
    readonly changes: readonly RideCodexApprovalScopeChange[];
}

const DEFAULT_TTL_MS = 2 * 60 * 1_000;
const DEFAULT_MAX_PENDING = 32;
const MAX_TIMER_MS = 0x7fffffff;
const MAX_IDENTIFIER_BYTES = 512;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 32 * 1024;
const MAX_REASON_BYTES = 8 * 1024;
const MAX_ENVIRONMENT_BYTES = 512;
const MAX_COMMAND_ACTIONS = 128;
const ALLOWED_COMMAND_KEYS = Object.freeze([
    'threadId', 'turnId', 'itemId', 'startedAtMs', 'approvalId', 'environmentId',
    'reason', 'networkApprovalContext', 'command', 'cwd', 'commandActions',
    'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments'
]);
const REQUIRED_COMMAND_KEYS = Object.freeze([
    'threadId', 'turnId', 'itemId', 'startedAtMs', 'environmentId'
]);
const ALLOWED_FILE_KEYS = Object.freeze([
    'threadId', 'turnId', 'itemId', 'startedAtMs', 'reason', 'grantRoot'
]);
const REQUIRED_FILE_KEYS = Object.freeze(['threadId', 'turnId', 'itemId', 'startedAtMs']);
const MAX_FILE_CHANGES = 256;
const MAX_DIFF_BYTES = 64 * 1024;
const MAX_TRACKED_THREADS = 256;
const MAX_TRACKED_FILE_SCOPES = 256;
const NULL_PROTOTYPE = Reflect.getPrototypeOf(Object.prototype);
const STALE_RESULT = Object.freeze({ status: 'rejected', code: 'stale-approval' } as const);
const OWNERSHIP_RESULT = Object.freeze({ status: 'rejected', code: 'ownership-mismatch' } as const);
const INVALID_RESULT = Object.freeze({ status: 'rejected', code: 'invalid-decision' } as const);
const RESPONSE_FAILED_RESULT = Object.freeze({ status: 'rejected', code: 'response-failed' } as const);
const RESPONDED_RESULT = Object.freeze({ status: 'responded' } as const);

export class RideCodexApprovalBroker {
    readonly #host: RideCodexApprovalHost;
    readonly #now: () => number;
    readonly #schedule: (callback: () => void, delayMs: number) => { dispose(): void };
    readonly #ttlMs: number;
    readonly #maxPending: number;
    readonly #maxClients: number;
    readonly #pathStyle: 'posix' | 'win32';
    readonly #allowAcceptForSession: (kind: 'command' | 'file-change') => boolean;
    readonly #resolveFileScope: (
        identity: RideCodexApprovalScopeIdentity
    ) => Promise<RideCodexApprovalScopeResolution | undefined>;
    readonly #resolveRealPath: (path: string) => Promise<string>;
    readonly #instanceKey = randomBytes(32);
    readonly #sessions = new Map<number, SessionRecord>();
    readonly #pending = new Map<string, PendingApproval>();
    readonly #threadRoots = new Map<string, TrackedThreadRoot>();
    readonly #fileScopes = new Map<string, TrackedFileScope>();
    readonly #hostListener?: { dispose(): void };
    readonly #hostStateListener?: { dispose(): void };
    readonly #hostNotificationListener?: { dispose(): void };
    #nextSessionId = 1;
    #disposed = false;

    constructor(options: RideCodexApprovalBrokerOptions) {
        this.#host = options.host;
        this.#now = options.now ?? Date.now;
        this.#schedule = options.schedule ?? ((callback, delayMs) => {
            const handle = setTimeout(callback, delayMs);
            return { dispose: () => clearTimeout(handle) };
        });
        this.#ttlMs = boundedInteger(options.ttlMs ?? DEFAULT_TTL_MS, 1, MAX_TIMER_MS, 'approval TTL');
        this.#maxPending = boundedInteger(options.maxPending ?? DEFAULT_MAX_PENDING, 1, 256, 'pending approval count');
        this.#maxClients = boundedInteger(options.maxClients ?? 8, 1, 64, 'approval client count');
        this.#pathStyle = options.pathStyle ?? (process.platform === 'win32' ? 'win32' : 'posix');
        this.#allowAcceptForSession = options.allowAcceptForSession ?? (() => false);
        this.#resolveFileScope = options.resolveFileScope ?? (async identity => this.#trackedFileScope(identity));
        this.#resolveRealPath = options.resolveRealPath ?? (path => resolveNearestRealPath(path, this.#pathStyle));
        this.#hostListener = this.#host.onServerRequest?.((request, generation) => {
            this.handleServerRequest(request, generation).catch(() => undefined);
        });
        this.#hostStateListener = this.#host.onStateChange?.(event => this.#onHostStateChange(event));
        this.#hostNotificationListener = this.#host.onNotification?.((notification, generation) => {
            this.#onHostNotification(notification, generation);
        });
    }

    connectClient(client: RideCodexApprovalClient): RideCodexApprovalSession {
        while (this.#sessions.size >= this.#maxClients) {
            const oldest = this.#sessions.values().next().value as SessionRecord | undefined;
            if (!oldest) {
                break;
            }
            this.#disconnect(oldest).catch(() => undefined);
        }
        const record: SessionRecord = {
            id: this.#nextSessionId++,
            client,
            disposed: false
        };
        this.#sessions.set(record.id, record);
        return Object.freeze({
            setContext: (context: RideCodexApprovalContext) => this.#setContext(record, context),
            disposeContext: () => this.#disposeContext(record),
            approvals: async () => this.#cardsFor(record),
            decide: (request: RideCodexApprovalDecisionRequest) => this.#decide(record, request),
            dispose: () => { this.#disconnect(record).catch(() => undefined); }
        });
    }

    async handleServerRequest(request: unknown, generation: number): Promise<void> {
        if (this.#disposed || !Number.isSafeInteger(generation) || generation < 1) {
            return;
        }
        const envelope = validateSupportedEnvelope(request);
        if (!envelope) {
            return;
        }
        const lease = await this.#host.acquire('approval');
        if (this.#disposed || lease.generation !== generation) {
            releaseOnce(lease);
            return;
        }
        const validated = envelope.method === 'item/commandExecution/requestApproval'
            ? validateCommandRequest(envelope, this.#pathStyle)
            : validateFileRequest(envelope);
        if (!validated) {
            await this.#respondAndRelease(lease, generation, envelope.id, 'decline');
            return;
        }
        const owner = [...this.#sessions.values()].find(candidate =>
            !candidate.disposed
            && candidate.context?.generation === generation
            && candidate.context.threadId === validated.threadId
            && candidate.context.turnId === validated.turnId
        );
        if (!owner) {
            await this.#respondAndRelease(lease, generation, validated.id, 'cancel');
            return;
        }

        const kind = envelope.method === 'item/commandExecution/requestApproval'
            ? 'command' as const : 'file-change' as const;
        let scope: Record<string, unknown>;
        let ownershipScope: Record<string, unknown>;
        if (kind === 'command') {
            const command = validated as ValidatedCommandRequest;
            scope = {
                command: command.command,
                ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
                ...(command.reason === undefined ? {} : { reason: command.reason }),
                ...(command.network === undefined ? {} : { network: command.network })
            };
            ownershipScope = scope;
        } else {
            let resolved: RideCodexApprovalScopeResolution | undefined;
            try {
                resolved = await this.#resolveFileScope(Object.freeze({
                    generation,
                    threadId: validated.threadId,
                    turnId: validated.turnId,
                    itemId: validated.itemId
                }));
            } catch {
                resolved = undefined;
            }
            const fileScope = resolved && await normalizeFileScope(
                resolved, this.#pathStyle, this.#resolveRealPath
            );
            if (!fileScope) {
                await this.#respondAndRelease(lease, generation, validated.id, 'decline');
                return;
            }
            scope = {
                ...(validated.reason === undefined ? {} : { reason: validated.reason }),
                changes: fileScope.changes
            };
            ownershipScope = {
                workspace: fileScope.workspace,
                ...scope
            };
        }

        while (this.#pending.size >= this.#maxPending) {
            const oldest = this.#pending.values().next().value as PendingApproval | undefined;
            if (!oldest) {
                break;
            }
            await this.#settle(oldest, 'cancel');
        }
        let sessionDecisionAllowed = false;
        let expiresAt: number;
        try {
            sessionDecisionAllowed = this.#allowAcceptForSession(kind) === true;
            const issuedAt = this.#now();
            if (!Number.isSafeInteger(issuedAt) || issuedAt < 0
                || issuedAt > Number.MAX_SAFE_INTEGER - this.#ttlMs) {
                throw new RangeError('Invalid approval clock');
            }
            expiresAt = issuedAt + this.#ttlMs;
        } catch {
            await this.#respondAndRelease(lease, generation, validated.id, 'decline');
            return;
        }
        const allowedDecisions = Object.freeze([
            'accept',
            ...(sessionDecisionAllowed ? ['acceptForSession' as const] : []),
            'decline',
            'cancel'
        ] as const);
        const token = randomBytes(32).toString('base64url');
        const fingerprint = this.#fingerprint({
            generation,
            requestId: validated.id,
            threadId: validated.threadId,
            turnId: validated.turnId,
            itemId: validated.itemId,
            kind,
            scope: ownershipScope,
            allowedDecisions
        });
        const card = deepFreezeRideCodex({
            kind, token, fingerprint, expiresAt, ...scope, allowedDecisions
        }) as unknown as RideCodexApprovalCard;
        const pendingHolder: { value?: PendingApproval } = {};
        let expiredBeforeInsertion = false;
        let timer: { dispose(): void };
        try {
            timer = this.#schedule(() => {
                if (pendingHolder.value) {
                    this.#settle(pendingHolder.value, 'cancel').catch(() => undefined);
                } else {
                    expiredBeforeInsertion = true;
                }
            }, this.#ttlMs);
        } catch {
            await this.#respondAndRelease(lease, generation, validated.id, 'decline');
            return;
        }
        const pending: PendingApproval = {
            token,
            fingerprint,
            generation,
            requestId: validated.id,
            threadId: validated.threadId,
            turnId: validated.turnId,
            itemId: validated.itemId,
            ownerId: owner.id,
            allowedDecisions,
            card,
            lease,
            timer
        };
        pendingHolder.value = pending;
        this.#pending.set(token, pending);
        this.#publish(owner);
        if (expiredBeforeInsertion) {
            await this.#settle(pending, 'cancel');
        }
    }

    async closeContext(context: RideCodexApprovalContext): Promise<void> {
        const safe = validateContext(context);
        if (!safe) {
            return;
        }
        const matches = [...this.#pending.values()].filter(pending =>
            pending.generation === safe.generation
            && pending.threadId === safe.threadId
            && pending.turnId === safe.turnId
        );
        await Promise.all(matches.map(pending => this.#settle(pending, 'cancel')));
    }

    async dispose(): Promise<void> {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        this.#hostListener?.dispose();
        this.#hostStateListener?.dispose();
        this.#hostNotificationListener?.dispose();
        const pending = [...this.#pending.values()];
        await Promise.all(pending.map(entry => this.#settle(entry, 'cancel')));
        this.#sessions.clear();
        this.#threadRoots.clear();
        this.#fileScopes.clear();
        this.#instanceKey.fill(0);
    }

    onStop(): Promise<void> {
        return this.dispose();
    }

    async #setContext(record: SessionRecord, context: RideCodexApprovalContext): Promise<void> {
        if (record.disposed || this.#disposed) {
            return;
        }
        const safe = validateContext(context);
        if (!safe) {
            await this.#disposeContext(record);
            return;
        }
        if (record.context && !sameContext(record.context, safe)) {
            await this.#cancelOwned(record);
        }
        record.context = safe;
        this.#publish(record);
    }

    async #disposeContext(record: SessionRecord): Promise<void> {
        if (record.disposed) {
            return;
        }
        await this.#cancelOwned(record);
        record.context = undefined;
        this.#publish(record);
    }

    async #disconnect(record: SessionRecord): Promise<void> {
        if (record.disposed) {
            return;
        }
        record.disposed = true;
        this.#sessions.delete(record.id);
        await this.#cancelOwned(record);
    }

    async #cancelOwned(record: SessionRecord): Promise<void> {
        const owned = [...this.#pending.values()].filter(pending => pending.ownerId === record.id);
        await Promise.all(owned.map(pending => this.#settle(pending, 'cancel')));
    }

    async #decide(
        record: SessionRecord,
        request: RideCodexApprovalDecisionRequest
    ): Promise<RideCodexApprovalDecisionResult> {
        const safe = validateDecisionRequest(request);
        if (!safe) {
            return INVALID_RESULT;
        }
        const pending = this.#pending.get(safe.token);
        if (!pending) {
            return STALE_RESULT;
        }
        if (record.disposed || pending.ownerId !== record.id
            || !constantTimeEqual(pending.fingerprint, safe.fingerprint)) {
            return OWNERSHIP_RESULT;
        }
        if (!record.context
            || record.context.generation !== pending.generation
            || record.context.threadId !== pending.threadId
            || record.context.turnId !== pending.turnId) {
            return OWNERSHIP_RESULT;
        }
        if (!pending.allowedDecisions.includes(safe.decision)) {
            return INVALID_RESULT;
        }
        return this.#settle(pending, safe.decision);
    }

    async #respondAndRelease(
        lease: RideCodexApprovalHostLease,
        generation: number,
        rpcRequestId: RequestId,
        decision: 'decline' | 'cancel'
    ): Promise<void> {
        try {
            await this.#host.respondServerRequest(
                generation,
                rpcRequestId,
                deepFreezeRideCodex({ decision })
            );
        } catch {
            // A failed generation-bound responder is terminal and must never be retried.
        } finally {
            releaseOnce(lease);
        }
    }

    #onHostStateChange(event: Readonly<{ state: string; generation: number }>): void {
        if (this.#disposed || !Number.isSafeInteger(event.generation)) {
            return;
        }
        if (event.state === 'ready') {
            for (const [key, tracked] of [...this.#threadRoots]) {
                if (tracked.generation !== event.generation) {
                    this.#threadRoots.delete(key);
                }
            }
            for (const [key, tracked] of [...this.#fileScopes]) {
                if (tracked.generation !== event.generation) {
                    this.#fileScopes.delete(key);
                }
            }
            for (const pending of [...this.#pending.values()]) {
                if (pending.generation !== event.generation) {
                    this.#abandon(pending);
                }
            }
            return;
        }
        for (const pending of [...this.#pending.values()]) {
            this.#abandon(pending);
        }
        this.#threadRoots.clear();
        this.#fileScopes.clear();
    }

    #onHostNotification(
        notification: Readonly<{ method: string; params: unknown }>,
        generation: number
    ): void {
        if (this.#disposed || !Number.isSafeInteger(generation) || generation < 1) {
            return;
        }
        const event = exactDataRecord(notification, ['method', 'params']);
        if (!event || typeof event.method !== 'string') {
            return;
        }
        const params = dataRecord(event.params);
        if (!params) {
            return;
        }
        switch (event.method) {
            case 'thread/started': {
                const thread = dataRecord(params.thread);
                const threadId = thread && boundedString(thread.id, MAX_IDENTIFIER_BYTES);
                const root = thread && boundedString(thread.cwd, MAX_PATH_BYTES);
                if (!thread || threadId === undefined || root === undefined) {
                    return;
                }
                setBounded(this.#threadRoots, threadKey(generation, threadId), Object.freeze({
                    generation, threadId, root
                }), MAX_TRACKED_THREADS);
                return;
            }
            case 'item/started':
            case 'item/fileChange/patchUpdated': {
                const threadId = boundedString(params.threadId, MAX_IDENTIFIER_BYTES);
                const turnId = boundedString(params.turnId, MAX_IDENTIFIER_BYTES);
                const item = event.method === 'item/started' ? dataRecord(params.item) : undefined;
                const itemId = event.method === 'item/started'
                    ? item && boundedString(item.id, MAX_IDENTIFIER_BYTES)
                    : boundedString(params.itemId, MAX_IDENTIFIER_BYTES);
                const rawChanges = event.method === 'item/started' ? item?.changes : params.changes;
                if (threadId === undefined || turnId === undefined || itemId === undefined
                    || (event.method === 'item/started' && item?.type !== 'fileChange')) {
                    return;
                }
                const changes = normalizeTrackedFileChanges(rawChanges);
                if (!changes) {
                    return;
                }
                const tracked = deepFreezeRideCodex({ generation, threadId, turnId, itemId, changes });
                setBounded(
                    this.#fileScopes,
                    fileScopeKey(tracked),
                    tracked,
                    MAX_TRACKED_FILE_SCOPES
                );
                return;
            }
            case 'item/completed': {
                const threadId = boundedString(params.threadId, MAX_IDENTIFIER_BYTES);
                const turnId = boundedString(params.turnId, MAX_IDENTIFIER_BYTES);
                const item = dataRecord(params.item);
                const itemId = item && boundedString(item.id, MAX_IDENTIFIER_BYTES);
                if (threadId !== undefined && turnId !== undefined && itemId !== undefined) {
                    this.#fileScopes.delete(fileScopeKey({ generation, threadId, turnId, itemId }));
                }
                return;
            }
            case 'turn/completed': {
                const turn = dataRecord(params.turn);
                const threadId = boundedString(params.threadId, MAX_IDENTIFIER_BYTES);
                const turnId = turn && boundedString(turn.id, MAX_IDENTIFIER_BYTES);
                if (!turn || threadId === undefined || turnId === undefined
                    || !['completed', 'failed', 'interrupted'].includes(turn.status as string)) {
                    return;
                }
                for (const [key, tracked] of [...this.#fileScopes]) {
                    if (tracked.generation === generation
                        && tracked.threadId === threadId && tracked.turnId === turnId) {
                        this.#fileScopes.delete(key);
                    }
                }
                this.closeContext(Object.freeze({ generation, threadId, turnId })).catch(() => undefined);
                return;
            }
            default:
                return;
        }
    }

    #trackedFileScope(identity: RideCodexApprovalScopeIdentity): RideCodexApprovalScopeResolution | undefined {
        const root = this.#threadRoots.get(threadKey(identity.generation, identity.threadId));
        const scope = this.#fileScopes.get(fileScopeKey(identity));
        if (!root || !scope) {
            return undefined;
        }
        return deepFreezeRideCodex({ workspaceRoot: root.root, changes: scope.changes });
    }

    #abandon(pending: PendingApproval): void {
        if (this.#pending.get(pending.token) !== pending) {
            return;
        }
        this.#pending.delete(pending.token);
        pending.timer.dispose();
        const owner = this.#sessions.get(pending.ownerId);
        if (owner) {
            this.#publish(owner);
        }
        releaseOnce(pending.lease);
    }

    async #settle(
        pending: PendingApproval,
        decision: RideCodexApprovalDecision
    ): Promise<RideCodexApprovalDecisionResult> {
        if (this.#pending.get(pending.token) !== pending) {
            return STALE_RESULT;
        }
        this.#pending.delete(pending.token);
        pending.timer.dispose();
        const owner = this.#sessions.get(pending.ownerId);
        if (owner) {
            this.#publish(owner);
        }
        try {
            await this.#host.respondServerRequest(
                pending.generation,
                pending.requestId,
                deepFreezeRideCodex({ decision: decision as 'accept' | 'acceptForSession' | 'decline' | 'cancel' })
            );
            return RESPONDED_RESULT;
        } catch {
            return RESPONSE_FAILED_RESULT;
        } finally {
            releaseOnce(pending.lease);
        }
    }

    #cardsFor(record: SessionRecord): readonly RideCodexApprovalCard[] {
        return deepFreezeRideCodex([...this.#pending.values()]
            .filter(pending => pending.ownerId === record.id)
            .map(pending => pending.card)) as readonly RideCodexApprovalCard[];
    }

    #publish(record: SessionRecord): void {
        if (record.disposed) {
            return;
        }
        try {
            const result = record.client.approvalsChanged(this.#cardsFor(record));
            Promise.resolve(result).catch(() => this.#disconnect(record).catch(() => undefined));
        } catch {
            this.#disconnect(record).catch(() => undefined);
        }
    }

    #fingerprint(value: unknown): string {
        return createHmac('sha256', this.#instanceKey).update(JSON.stringify(value)).digest('base64url');
    }
}

function validateSupportedEnvelope(value: unknown): SupportedEnvelope | undefined {
    const envelope = exactDataRecord(value, ['id', 'method', 'params']);
    if (!envelope || !requestId(envelope.id)
        || !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']
            .includes(envelope.method as string)) {
        return undefined;
    }
    return Object.freeze({
        id: envelope.id,
        method: envelope.method as SupportedEnvelope['method'],
        params: envelope.params
    });
}

function validateCommandRequest(
    envelope: SupportedEnvelope,
    pathStyle: 'posix' | 'win32'
): ValidatedCommandRequest | undefined {
    const params = exactDataRecord(envelope.params, REQUIRED_COMMAND_KEYS, ALLOWED_COMMAND_KEYS);
    if (!params) {
        return undefined;
    }
    const threadId = boundedString(params.threadId, MAX_IDENTIFIER_BYTES);
    const turnId = boundedString(params.turnId, MAX_IDENTIFIER_BYTES);
    const itemId = boundedString(params.itemId, MAX_IDENTIFIER_BYTES);
    const command = boundedString(params.command, MAX_COMMAND_BYTES);
    if (threadId === undefined || turnId === undefined || itemId === undefined || command === undefined
        || !Number.isSafeInteger(params.startedAtMs) || (params.startedAtMs as number) < 0
        || !nullableBoundedString(params.environmentId, MAX_ENVIRONMENT_BYTES)
        || !optionalNullableBoundedString(params.approvalId, MAX_IDENTIFIER_BYTES)
        || !optionalNullableBoundedString(params.reason, MAX_REASON_BYTES)
        || !optionalNullableBoundedString(params.cwd, MAX_PATH_BYTES)
        || !validateCommandActions(params.commandActions)
        || !absentOrNull(params.proposedExecpolicyAmendment)
        || !absentOrNull(params.proposedNetworkPolicyAmendments)) {
        return undefined;
    }
    const network = validateNetwork(params.networkApprovalContext);
    if (network === false) {
        return undefined;
    }
    const rawCwd = typeof params.cwd === 'string' ? params.cwd : undefined;
    const cwd = rawCwd === undefined ? undefined : normalizeDisplayPath(rawCwd, pathStyle);
    if (rawCwd !== undefined && cwd === undefined) {
        return undefined;
    }
    return deepFreezeRideCodex({
        id: envelope.id as RequestId,
        threadId,
        turnId,
        itemId,
        command,
        ...(cwd === undefined ? {} : { cwd }),
        ...(typeof params.reason === 'string' ? { reason: params.reason } : {}),
        ...(network ? { network } : {})
    }) as ValidatedCommandRequest;
}

function validateFileRequest(envelope: SupportedEnvelope): ValidatedFileRequest | undefined {
    const params = exactDataRecord(envelope.params, REQUIRED_FILE_KEYS, ALLOWED_FILE_KEYS);
    if (!params) {
        return undefined;
    }
    const threadId = boundedString(params.threadId, MAX_IDENTIFIER_BYTES);
    const turnId = boundedString(params.turnId, MAX_IDENTIFIER_BYTES);
    const itemId = boundedString(params.itemId, MAX_IDENTIFIER_BYTES);
    if (threadId === undefined || turnId === undefined || itemId === undefined
        || !Number.isSafeInteger(params.startedAtMs) || (params.startedAtMs as number) < 0
        || !optionalNullableBoundedString(params.reason, MAX_REASON_BYTES)
        || !absentOrNull(params.grantRoot)) {
        return undefined;
    }
    return Object.freeze({
        id: envelope.id,
        threadId,
        turnId,
        itemId,
        ...(typeof params.reason === 'string' ? { reason: params.reason } : {})
    });
}

function validateContext(value: unknown): RideCodexApprovalContext | undefined {
    const record = exactDataRecord(value, ['generation', 'threadId', 'turnId']);
    if (!record || !Number.isSafeInteger(record.generation) || (record.generation as number) < 1) {
        return undefined;
    }
    const threadId = boundedString(record.threadId, MAX_IDENTIFIER_BYTES);
    const turnId = boundedString(record.turnId, MAX_IDENTIFIER_BYTES);
    return threadId === undefined || turnId === undefined ? undefined : Object.freeze({
        generation: record.generation as number,
        threadId,
        turnId
    });
}

function validateDecisionRequest(value: unknown): RideCodexApprovalDecisionRequest | undefined {
    const record = exactDataRecord(value, ['token', 'fingerprint', 'decision']);
    if (!record || typeof record.token !== 'string' || typeof record.fingerprint !== 'string'
        || !['accept', 'acceptForSession', 'decline', 'cancel'].includes(record.decision as string)) {
        return undefined;
    }
    return Object.freeze({
        token: record.token,
        fingerprint: record.fingerprint,
        decision: record.decision as RideCodexApprovalDecision
    });
}

function validateNetwork(value: unknown): ValidatedCommandRequest['network'] | false | undefined {
    if (value === undefined || isNull(value)) {
        return undefined;
    }
    const record = exactDataRecord(value, ['host', 'protocol']);
    const host = record && boundedString(record.host, 253);
    if (!record || host === undefined || host.length === 0
        || !isNetworkHost(host)
        || !['http', 'https', 'socks5Tcp', 'socks5Udp'].includes(record.protocol as string)) {
        return false;
    }
    return Object.freeze({
        host,
        protocol: record.protocol as NonNullable<ValidatedCommandRequest['network']>['protocol']
    });
}

function validateCommandActions(value: unknown): boolean {
    if (value === undefined || isNull(value)) {
        return true;
    }
    const items = safeArray(value, MAX_COMMAND_ACTIONS);
    if (!items) {
        return false;
    }
    return items.every(item => {
        const base = dataRecord(item);
        if (!base || typeof base.type !== 'string') {
            return false;
        }
        switch (base.type) {
            case 'unknown':
                return !!exactDataRecord(item, ['type', 'command'])
                    && boundedString(base.command, MAX_COMMAND_BYTES) !== undefined;
            case 'read': {
                const record = exactDataRecord(item, ['type', 'command', 'name', 'path']);
                return !!record && boundedString(record.command, MAX_COMMAND_BYTES) !== undefined
                    && boundedString(record.name, MAX_REASON_BYTES) !== undefined
                    && boundedString(record.path, MAX_PATH_BYTES) !== undefined;
            }
            case 'listFiles': {
                const record = exactDataRecord(item, ['type', 'command', 'path']);
                return !!record && boundedString(record.command, MAX_COMMAND_BYTES) !== undefined
                    && nullableBoundedString(record.path, MAX_PATH_BYTES);
            }
            case 'search': {
                const record = exactDataRecord(item, ['type', 'command', 'query', 'path']);
                return !!record && boundedString(record.command, MAX_COMMAND_BYTES) !== undefined
                    && nullableBoundedString(record.query, MAX_REASON_BYTES)
                    && nullableBoundedString(record.path, MAX_PATH_BYTES);
            }
            default:
                return false;
        }
    });
}

function normalizeTrackedFileChanges(value: unknown): readonly RideCodexApprovalScopeChange[] | undefined {
    const items = safeArray(value, MAX_FILE_CHANGES);
    if (!items || items.length === 0) {
        return undefined;
    }
    const changes: RideCodexApprovalScopeChange[] = [];
    for (const raw of items) {
        const record = exactDataRecord(raw, ['path', 'kind', 'diff']);
        const path = record && boundedString(record.path, MAX_PATH_BYTES);
        const diff = record && boundedString(record.diff, MAX_DIFF_BYTES);
        const kind = record && exactDataRecord(record.kind, ['type'], ['type', 'move_path']);
        if (!record || path === undefined || diff === undefined || !kind
            || /[\u0000-\u001f\u007f-\u009f]/u.test(path)) {
            return undefined;
        }
        if (kind.type === 'add' || kind.type === 'delete') {
            if (Object.keys(kind).length !== 1) {
                return undefined;
            }
            changes.push(Object.freeze({ path, kind: kind.type }));
            continue;
        }
        if (kind.type !== 'update' || !Object.prototype.hasOwnProperty.call(kind, 'move_path')) {
            return undefined;
        }
        const movePath = kind.move_path;
        if (!isNull(movePath) && (boundedString(movePath, MAX_PATH_BYTES) === undefined
            || /[\u0000-\u001f\u007f-\u009f]/u.test(movePath as string))) {
            return undefined;
        }
        changes.push(Object.freeze({
            path,
            kind: 'update',
            ...(typeof movePath === 'string' ? { movePath } : {})
        }));
    }
    return Object.freeze(changes);
}

function exactDataRecord(
    value: unknown,
    required: readonly string[],
    allowed: readonly string[] = required
): Record<string, unknown> | undefined {
    const record = dataRecord(value);
    if (!record) {
        return undefined;
    }
    const keys = Object.keys(record);
    if (!required.every(key => Object.prototype.hasOwnProperty.call(record, key))
        || keys.some(key => !allowed.includes(key))) {
        return undefined;
    }
    return record;
}

function dataRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
        return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== NULL_PROTOTYPE) {
        return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) {
        return undefined;
    }
    const record: Record<string, unknown> = Object.create(NULL_PROTOTYPE) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable) {
            return undefined;
        }
        record[key] = descriptor.value;
    }
    return record;
}

function safeArray(value: unknown, maxItems: number): readonly unknown[] | undefined {
    if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > maxItems) {
        return undefined;
    }
    const values: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            return undefined;
        }
        values.push(descriptor.value);
    }
    return values;
}

function boundedString(value: unknown, maxBytes: number): string | undefined {
    return typeof value === 'string' && utf8ByteLength(value) <= maxBytes ? value : undefined;
}

function nullableBoundedString(value: unknown, maxBytes: number): boolean {
    return isNull(value) || boundedString(value, maxBytes) !== undefined;
}

function optionalNullableBoundedString(value: unknown, maxBytes: number): boolean {
    return value === undefined || nullableBoundedString(value, maxBytes);
}

function absentOrNull(value: unknown): boolean {
    return value === undefined || isNull(value);
}

function isNull(value: unknown): boolean {
    return typeof value === 'object' && !value;
}

function requestId(value: unknown): value is RequestId {
    return typeof value === 'number'
        ? Number.isSafeInteger(value)
        : typeof value === 'string' && value.length > 0 && utf8ByteLength(value) <= 1_024;
}

function threadKey(generation: number, threadId: string): string {
    return JSON.stringify([generation, threadId]);
}

function fileScopeKey(identity: RideCodexApprovalScopeIdentity): string {
    return JSON.stringify([
        identity.generation, identity.threadId, identity.turnId, identity.itemId
    ]);
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
    map.delete(key);
    while (map.size >= limit) {
        const oldest = map.keys().next().value as K | undefined;
        if (oldest === undefined) {
            break;
        }
        map.delete(oldest);
    }
    map.set(key, value);
}

function normalizeDisplayPath(value: string, style: 'posix' | 'win32'): string | undefined {
    if (!isSafeLocalPath(value, style)) {
        return undefined;
    }
    const paths = style === 'win32' ? win32 : posix;
    const normalized = paths.normalize(value);
    return utf8ByteLength(normalized) <= MAX_PATH_BYTES ? normalized : undefined;
}

function isNetworkHost(value: string): boolean {
    return /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]{2,253}\])$/u.test(value)
        && !value.includes('..');
}

async function normalizeFileScope(
    value: unknown,
    style: 'posix' | 'win32',
    resolveRealPath: (path: string) => Promise<string>
): Promise<Readonly<{
    workspace: string;
    changes: readonly Readonly<{
        path: string;
        kind: 'add' | 'delete' | 'update';
        movePath?: string;
    }>[];
}> | undefined> {
    const scope = exactDataRecord(value, ['workspaceRoot', 'changes']);
    const workspaceRoot = scope && boundedString(scope.workspaceRoot, MAX_PATH_BYTES);
    const rawChanges = scope && safeArray(scope.changes, MAX_FILE_CHANGES);
    if (!scope || workspaceRoot === undefined || !rawChanges) {
        return undefined;
    }
    const paths = style === 'win32' ? win32 : posix;
    if (!isSafeLocalPath(workspaceRoot, style) || !paths.isAbsolute(workspaceRoot)) {
        return undefined;
    }
    const workspace = paths.normalize(workspaceRoot);
    let realWorkspace: string;
    try {
        realWorkspace = paths.normalize(await resolveRealPath(workspace));
    } catch {
        return undefined;
    }
    if (!isSafeLocalPath(realWorkspace, style) || !paths.isAbsolute(realWorkspace)) {
        return undefined;
    }
    const changes: Array<Readonly<{
        path: string;
        kind: 'add' | 'delete' | 'update';
        movePath?: string;
    }>> = [];
    for (const raw of rawChanges) {
        const change = exactDataRecord(raw, ['path', 'kind'], ['path', 'kind', 'movePath', 'diff']);
        const rawPath = change && boundedString(change.path, MAX_PATH_BYTES);
        if (!change || rawPath === undefined
            || !['add', 'delete', 'update'].includes(change.kind as string)
            || (change.diff !== undefined && boundedString(change.diff, MAX_DIFF_BYTES) === undefined)
            || (change.movePath !== undefined && !isNull(change.movePath)
                && boundedString(change.movePath, MAX_PATH_BYTES) === undefined)) {
            return undefined;
        }
        const normalizedPath = await normalizeScopedPath(
            rawPath, workspace, realWorkspace, style, resolveRealPath
        );
        if (!normalizedPath) {
            return undefined;
        }
        let movePath: string | undefined;
        if (typeof change.movePath === 'string') {
            movePath = await normalizeScopedPath(
                change.movePath, workspace, realWorkspace, style, resolveRealPath
            );
            if (!movePath) {
                return undefined;
            }
        }
        changes.push(Object.freeze({
            path: normalizedPath,
            kind: change.kind as 'add' | 'delete' | 'update',
            ...(movePath === undefined ? {} : { movePath })
        }));
    }
    if (changes.length === 0) {
        return undefined;
    }
    return deepFreezeRideCodex({ workspace, changes });
}

async function normalizeScopedPath(
    rawPath: string,
    workspace: string,
    realWorkspace: string,
    style: 'posix' | 'win32',
    resolveRealPath: (path: string) => Promise<string>
): Promise<string | undefined> {
    const paths = style === 'win32' ? win32 : posix;
    if (!isSafeLocalPath(rawPath, style)) {
        return undefined;
    }
    const target = paths.normalize(paths.isAbsolute(rawPath) ? rawPath : paths.resolve(workspace, rawPath));
    if (!isWithin(workspace, target, paths)) {
        return undefined;
    }
    let realTarget: string;
    try {
        realTarget = paths.normalize(await resolveRealPath(target));
    } catch {
        return undefined;
    }
    if (!isSafeLocalPath(realTarget, style) || !paths.isAbsolute(realTarget)
        || !isWithin(realWorkspace, realTarget, paths)) {
        return undefined;
    }
    const relative = paths.relative(workspace, target);
    return relative.length > 0 && utf8ByteLength(relative) <= MAX_PATH_BYTES ? relative : undefined;
}

function isSafeLocalPath(value: string, style: 'posix' | 'win32'): boolean {
    if (!value || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
        return false;
    }
    if (style === 'win32') {
        if (/^(?:\\\\|\/\/)/u.test(value)) {
            return false;
        }
        const withoutDrive = /^[A-Za-z]:/u.test(value) ? value.slice(2) : value;
        return !withoutDrive.includes(':');
    }
    return !value.startsWith('//');
}

function isWithin(
    root: string,
    target: string,
    paths: typeof posix | typeof win32
): boolean {
    const relative = paths.relative(root, target);
    return relative === '' || (!relative.startsWith(`..${paths.sep}`)
        && relative !== '..' && !paths.isAbsolute(relative));
}

async function resolveNearestRealPath(path: string, style: 'posix' | 'win32'): Promise<string> {
    const paths = style === 'win32' ? win32 : posix;
    const tail: string[] = [];
    let candidate = path;
    while (true) {
        try {
            const resolved = await realpath(candidate);
            return paths.resolve(resolved, ...tail.reverse());
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            const parent = paths.dirname(candidate);
            if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === candidate) {
                throw error;
            }
            tail.push(paths.basename(candidate));
            candidate = parent;
        }
    }
}

function sameContext(left: RideCodexApprovalContext, right: RideCodexApprovalContext): boolean {
    return left.generation === right.generation
        && left.threadId === right.threadId
        && left.turnId === right.turnId;
}

function constantTimeEqual(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new RangeError(`Invalid ${label}`);
    }
    return value;
}

function releaseOnce(lease: RideCodexApprovalHostLease): void {
    try {
        lease.release();
    } catch {
        // Lease cleanup is idempotent and must not destabilize approval settlement.
    }
}
