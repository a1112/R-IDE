/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { types as utilTypes } from 'node:util';
import {
    RideCodexAuthClient,
    RideCodexAuthSnapshot,
    RideCodexLoginRequest,
    RideCodexLoginResult,
    RideCodexRateLimits,
    RideCodexUnsafeAuthPayloadError
} from '../common/ride-codex-auth';
import type { StableClientMethod, RideCodexDisposable, RideCodexNotification } from './ride-codex-jsonl-client';
import { rideCodexNodeAuthNormalizers } from './ride-codex-auth-normalizers';
import { RideCodexAppServerDiagnostics } from './ride-codex-diagnostics';

export type RideCodexAuthHostState =
    | 'stopped' | 'starting' | 'ready' | 'restarting' | 'stopping' | 'circuit-open' | 'disposed';

export interface RideCodexAuthHostStateEvent {
    readonly state: RideCodexAuthHostState;
    readonly generation: number;
}

export interface RideCodexAuthHostLease {
    request(method: StableClientMethod, params: unknown, timeoutMs?: number): unknown | Promise<unknown>;
    release(): void;
}

export interface RideCodexAuthHost {
    acquire(kind: 'foreground-panel'): Promise<RideCodexAuthHostLease>;
    onNotification(
        listener: (notification: RideCodexNotification, generation: number) => void
    ): RideCodexDisposable;
    onStateChange(listener: (event: RideCodexAuthHostStateEvent) => void): RideCodexDisposable;
    snapshot(): { readonly state: RideCodexAuthHostState; readonly generation: number };
}

export interface RideCodexAuthBrokerOptions {
    readonly host: RideCodexAuthHost;
    readonly diagnostics: RideCodexAppServerDiagnostics;
}

interface NotificationAccountRefreshContext {
    readonly refresh: number;
    readonly callerOperation: number;
    readonly accountRevision: number;
    readonly generation: number;
}

export class RideCodexAuthError extends Error {
    constructor(readonly code: 'invalid-data' | 'operation-failed' | 'operation-superseded' | 'unknown-login' | 'disposed') {
        super(AUTH_ERROR_MESSAGES[code]);
        this.name = 'RideCodexAuthError';
    }
}

const AUTH_ERROR_MESSAGES: Readonly<Record<RideCodexAuthError['code'], string>> = Object.freeze({
    'invalid-data': 'Codex authentication returned invalid data.',
    'operation-failed': 'Codex authentication could not be completed.',
    'operation-superseded': 'Codex authentication operation was superseded.',
    'unknown-login': 'Codex login is not known or is no longer active.',
    'disposed': 'Codex authentication broker is disposed.'
});
const MAX_KNOWN_LOGINS = 32;
const {
    createRideCodexAuthSnapshot,
    normalizeRideCodexAccountReadResult,
    normalizeRideCodexAccountUpdate,
    normalizeRideCodexCancelResult,
    normalizeRideCodexLoginCompletion,
    normalizeRideCodexLoginRequest,
    normalizeRideCodexLoginResult,
    normalizeRideCodexRateLimits,
    normalizeRideCodexRateLimitUpdate
} = rideCodexNodeAuthNormalizers;

export class RideCodexAuthBroker {
    readonly #host: RideCodexAuthHost;
    readonly #diagnostics: RideCodexAppServerDiagnostics;
    readonly #clients = new Set<RideCodexAuthClient>();
    readonly #knownLogins = new Map<string, Readonly<{
        status: 'active' | 'canceled' | 'completed';
        operation: number;
    }>>();
    readonly #listeners: RideCodexDisposable[] = [];
    readonly #notificationSignatures = new Map<string, string>();
    #snapshot: RideCodexAuthSnapshot = createRideCodexAuthSnapshot({ state: 'inactive' });
    #lease: RideCodexAuthHostLease | undefined;
    #leasePromise: Promise<RideCodexAuthHostLease> | undefined;
    #activationPromise: Promise<RideCodexAuthSnapshot> | undefined;
    #activeGeneration = 0;
    #callerAuthOperation = 0;
    #notificationAccountRefresh = 0;
    #notificationAccountRefreshFlight: NotificationAccountRefreshContext | undefined;
    #notificationAccountRefreshPending: NotificationAccountRefreshContext | undefined;
    #accountRevision = 0;
    #rateOperation = 0;
    #rateVersion = 0;
    #disposed = false;

    constructor(options: RideCodexAuthBrokerOptions) {
        this.#host = options.host;
        this.#diagnostics = options.diagnostics;
        try {
            this.#listeners.push(
                this.#host.onNotification((notification, generation) => this.#onNotification(notification, generation))
            );
            this.#listeners.push(this.#host.onStateChange(event => this.#onHostStateChange(event)));
        } catch {
            for (const listener of this.#listeners.splice(0)) {
                disposeSafely(listener);
            }
            throw new RideCodexAuthError('operation-failed');
        }
    }

    snapshot(): RideCodexAuthSnapshot {
        return this.#snapshot;
    }

    status(): Promise<RideCodexAuthSnapshot> {
        return Promise.resolve(this.#snapshot);
    }

    setClient(client: RideCodexAuthClient | undefined): void {
        if (client && !this.#disposed) {
            this.#clients.add(client);
            this.#emitClient(client, this.#snapshot);
        }
    }

    disconnectClient(client: RideCodexAuthClient): void {
        this.#clients.delete(client);
    }

    activate(): Promise<RideCodexAuthSnapshot> {
        this.#requireUsable();
        if (this.#activationPromise) {
            return this.#activationPromise;
        }
        const operation = (async () => {
            await this.#ensureLease();
            const token = this.#beginCallerAuthOperation();
            return this.#readAccountForToken(token, false);
        })();
        let tracked!: Promise<RideCodexAuthSnapshot>;
        tracked = operation.finally(() => {
            if (this.#activationPromise === tracked) {
                this.#activationPromise = undefined;
            }
        });
        this.#activationPromise = tracked;
        void tracked.catch(() => undefined);
        return tracked;
    }

    async readAccount(options: Readonly<{ refreshToken?: boolean }> = {}): Promise<RideCodexAuthSnapshot> {
        this.#requireUsable();
        const record = requirePlainOptions(options, ['refreshToken']);
        const refreshToken = record.refreshToken === true;
        if (record.refreshToken !== undefined && typeof record.refreshToken !== 'boolean') {
            throw new TypeError('Codex refresh-token option must be boolean');
        }
        await this.#ensureLease();
        const token = this.#beginCallerAuthOperation();
        return this.#readAccountForToken(token, refreshToken);
    }

    async login(request: RideCodexLoginRequest): Promise<RideCodexLoginResult> {
        this.#requireUsable();
        let normalized: RideCodexLoginRequest | undefined = normalizeRideCodexLoginRequest(request);
        await this.#ensureLease();
        const token = this.#beginCallerAuthOperation();
        const previousSnapshot = this.#snapshot;
        const authenticatingSnapshot = this.#setAuthSnapshot({
            state: 'authenticating',
            account: this.#snapshot.account,
            rateLimits: this.#snapshot.rateLimits,
            pendingLogin: { type: normalized.type }
        });
        if (normalized.type === 'apiKey') {
            let apiKey = normalized.apiKey;
            normalized = undefined;
            try {
                return await this.#loginWithApiKey(apiKey, token, {
                    current: authenticatingSnapshot,
                    previous: previousSnapshot
                });
            } finally {
                apiKey = '';
            }
        }
        const interactiveLogin = normalized;
        try {
            const pending = rejectProxyBeforeAwait(
                this.#lease!.request('account/login/start', { type: interactiveLogin.type })
            );
            const raw = await pending;
            this.#requireCurrentOperation(token);
            const result = normalizeRideCodexLoginResult(raw);
            if (result.type !== interactiveLogin.type) {
                throw new TypeError('Mismatched Codex login response');
            }
            this.#rememberLogin(result.loginId, 'active', token);
            this.#setAuthSnapshot({
                state: 'authenticating',
                account: this.#snapshot.account,
                rateLimits: this.#snapshot.rateLimits,
                pendingLogin: { type: result.type, loginId: result.loginId }
            });
            return result;
        } catch (error) {
            throw this.#failOperation(error, token, {
                current: authenticatingSnapshot,
                previous: previousSnapshot
            });
        }
    }

    async cancelLogin(loginId: string): Promise<void> {
        this.#requireUsable();
        if (typeof loginId !== 'string' || loginId.length === 0 || loginId.length > 256
            || !this.#knownLogins.has(loginId)) {
            throw new RideCodexAuthError('unknown-login');
        }
        if (this.#knownLogins.get(loginId)?.status !== 'active') {
            return;
        }
        await this.#ensureLease();
        const token = this.#beginCallerAuthOperation();
        try {
            const pending = rejectProxyBeforeAwait(this.#lease!.request('account/login/cancel', { loginId }));
            const raw = await pending;
            this.#requireCurrentOperation(token);
            normalizeRideCodexCancelResult(raw);
            this.#rememberLogin(loginId, 'canceled', token);
            if (this.#snapshot.pendingLogin?.loginId === loginId) {
                this.#setAuthSnapshot({
                    state: this.#snapshot.account ? 'authenticated' : 'unauthenticated',
                    account: this.#snapshot.account,
                    rateLimits: this.#snapshot.rateLimits
                });
            }
        } catch (error) {
            throw this.#failOperation(error, token);
        }
    }

    async logout(): Promise<RideCodexAuthSnapshot> {
        this.#requireUsable();
        await this.#ensureLease();
        const token = this.#beginCallerAuthOperation();
        this.#invalidateRateReads();
        try {
            await this.#lease!.request('account/logout', {});
            this.#requireCurrentOperation(token);
            this.#knownLogins.clear();
            return this.#setAuthSnapshot({ state: 'unauthenticated' });
        } catch (error) {
            throw this.#failOperation(error, token);
        }
    }

    async readRateLimits(): Promise<RideCodexAuthSnapshot> {
        this.#requireUsable();
        await this.#ensureLease();
        const token = ++this.#rateOperation;
        const version = this.#rateVersion;
        try {
            const pending = rejectProxyBeforeAwait(this.#lease!.request('account/rateLimits/read', {}));
            const raw = await pending;
            if (token !== this.#rateOperation) {
                throw new RideCodexAuthError('operation-superseded');
            }
            const rateLimits = normalizeRideCodexRateLimits(raw);
            if (version !== this.#rateVersion) {
                return this.#snapshot;
            }
            return this.#setSnapshot({ ...this.#snapshot, rateLimits });
        } catch (error) {
            if (token === this.#rateOperation && version !== this.#rateVersion) {
                return this.#snapshot;
            }
            throw this.#failRateOperation(error, token);
        }
    }

    dispose(): void {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        this.#beginCallerAuthOperation();
        this.#invalidateRateReads();
        for (const listener of this.#listeners.splice(0)) {
            disposeSafely(listener);
        }
        this.#clients.clear();
        this.#knownLogins.clear();
        this.#notificationSignatures.clear();
        this.#lease?.release();
        this.#lease = undefined;
    }

    onStop(): void {
        this.dispose();
    }

    async #loginWithApiKey(
        input: string,
        token: number,
        rollback: Readonly<{ current: RideCodexAuthSnapshot; previous: RideCodexAuthSnapshot }>
    ): Promise<RideCodexLoginResult> {
        let secret = input;
        let params: { type: 'apiKey'; apiKey: string } | undefined = { type: 'apiKey', apiKey: secret };
        const scope = this.#diagnostics.registerTransientSecret(secret);
        let raw: unknown;
        try {
            const pending = rejectProxyBeforeAwait(this.#lease!.request('account/login/start', params));
            raw = await pending;
        } catch (error) {
            throw this.#failOperation(error, token, rollback);
        } finally {
            params = undefined;
            secret = '';
            input = '';
            scope.dispose();
        }
        try {
            this.#requireCurrentOperation(token);
            const result = normalizeRideCodexLoginResult(raw);
            if (result.type !== 'apiKey') {
                throw new TypeError('Mismatched Codex API key login response');
            }
            const confirmation = await this.#readAccountForToken(token, false, rollback, true);
            this.#requireCurrentOperation(token);
            if (confirmation.state !== 'authenticated' || confirmation.account?.type !== 'apiKey') {
                throw new TypeError('Codex API key login was not confirmed');
            }
            if (confirmation !== this.#snapshot) {
                this.#setAuthSnapshot(confirmation);
            }
            return result;
        } catch (error) {
            throw this.#failOperation(error, token, rollback);
        }
    }

    async #ensureLease(): Promise<RideCodexAuthHostLease> {
        this.#requireUsable();
        if (this.#lease) {
            return this.#lease;
        }
        if (this.#leasePromise) {
            return this.#leasePromise;
        }
        const operation = this.#host.acquire('foreground-panel').then(
            lease => {
                if (this.#disposed) {
                    lease.release();
                    throw new RideCodexAuthError('disposed');
                }
                this.#lease = lease;
                const hostSnapshot = this.#host.snapshot();
                this.#activeGeneration = hostSnapshot.generation;
                return lease;
            },
            () => {
                if (this.#disposed) {
                    throw new RideCodexAuthError('disposed');
                }
                if (this.#snapshot.state !== 'disconnected') {
                    this.#setGenericError('operation-failed');
                }
                throw new RideCodexAuthError('operation-failed');
            }
        );
        this.#leasePromise = operation.finally(() => {
            this.#leasePromise = undefined;
        });
        void this.#leasePromise.catch(() => undefined);
        return this.#leasePromise;
    }

    async #readAccountForToken(
        token: number,
        refreshToken: boolean,
        rollback?: Readonly<{ current: RideCodexAuthSnapshot; previous: RideCodexAuthSnapshot }>,
        requireFreshResponse = false
    ): Promise<RideCodexAuthSnapshot> {
        const accountRevision = this.#accountRevision;
        try {
            const pending = rejectProxyBeforeAwait(this.#lease!.request('account/read', { refreshToken }));
            const raw = await pending;
            if (token !== this.#callerAuthOperation) {
                return this.#snapshot;
            }
            if (!requireFreshResponse && accountRevision !== this.#accountRevision) {
                return this.#snapshot;
            }
            const response = normalizeRideCodexAccountReadResult(raw);
            const snapshot = createRideCodexAuthSnapshot({
                state: response.account ? 'authenticated' : 'unauthenticated',
                account: response.account,
                rateLimits: response.account ? this.#snapshot.rateLimits : undefined
            });
            if (accountRevision !== this.#accountRevision) {
                return snapshot;
            }
            return this.#setAuthSnapshot(snapshot);
        } catch (error) {
            if (token !== this.#callerAuthOperation
                || (!requireFreshResponse && accountRevision !== this.#accountRevision)) {
                return this.#snapshot;
            }
            throw this.#failOperation(error, token, rollback);
        }
    }

    #scheduleNotificationAccountRefresh(generation: number): void {
        const context: NotificationAccountRefreshContext = {
            refresh: ++this.#notificationAccountRefresh,
            callerOperation: this.#callerAuthOperation,
            accountRevision: this.#accountRevision,
            generation
        };
        if (this.#notificationAccountRefreshFlight) {
            this.#notificationAccountRefreshPending = context;
            return;
        }
        this.#startNotificationAccountRefresh(context);
    }

    #startNotificationAccountRefresh(context: NotificationAccountRefreshContext): void {
        this.#notificationAccountRefreshFlight = context;
        const operation = this.#readAccountForNotification(context);
        void operation.finally(() => {
            if (this.#notificationAccountRefreshFlight !== context) {
                return;
            }
            this.#notificationAccountRefreshFlight = undefined;
            const pending = this.#notificationAccountRefreshPending;
            this.#notificationAccountRefreshPending = undefined;
            if (pending && this.#isCurrentNotificationAccountRefresh(pending)) {
                this.#startNotificationAccountRefresh(pending);
            }
        }).catch(() => undefined);
    }

    async #readAccountForNotification(context: NotificationAccountRefreshContext): Promise<void> {
        try {
            const pending = rejectProxyBeforeAwait(this.#lease!.request('account/read', { refreshToken: false }));
            const raw = await pending;
            if (!this.#isCurrentNotificationAccountRefresh(context)) {
                return;
            }
            const response = normalizeRideCodexAccountReadResult(raw);
            if (!this.#isCurrentNotificationAccountRefresh(context)) {
                return;
            }
            this.#setAuthSnapshot({
                state: response.account ? 'authenticated' : 'unauthenticated',
                account: response.account,
                rateLimits: response.account ? this.#snapshot.rateLimits : undefined
            });
        } catch (error) {
            if (this.#isCurrentNotificationAccountRefresh(context)) {
                this.#failOperation(error, context.callerOperation);
            }
        }
    }

    #isCurrentNotificationAccountRefresh(context: NotificationAccountRefreshContext): boolean {
        return !this.#disposed
            && context.generation === this.#activeGeneration
            && context.callerOperation === this.#callerAuthOperation
            && context.refresh === this.#notificationAccountRefresh
            && context.accountRevision === this.#accountRevision;
    }

    #onNotification(notification: RideCodexNotification, generation: number): void {
        if (this.#disposed || generation !== this.#activeGeneration) {
            return;
        }
        try {
            switch (notification.method) {
                case 'account/updated': {
                    const account = normalizeRideCodexAccountUpdate(notification.params);
                    if (this.#isDuplicateNotification(notification.method, account ?? null)) {
                        return;
                    }
                    this.#setAuthSnapshot({
                        state: account ? 'authenticated' : 'unauthenticated',
                        account,
                        rateLimits: account ? this.#snapshot.rateLimits : undefined
                    });
                    this.#scheduleNotificationAccountRefresh(generation);
                    return;
                }
                case 'account/login/completed': {
                    const completion = normalizeRideCodexLoginCompletion(notification.params);
                    if (this.#isDuplicateNotification(notification.method, completion)) {
                        return;
                    }
                    this.#onLoginCompleted(completion);
                    return;
                }
                case 'account/rateLimits/updated': {
                    let update: RideCodexRateLimits;
                    try {
                        update = normalizeRideCodexRateLimitUpdate(notification.params);
                    } catch {
                        this.#diagnostics.record('protocol-error');
                        return;
                    }
                    ++this.#rateVersion;
                    if (this.#isDuplicateNotification(notification.method, update)) {
                        return;
                    }
                    const merged = Object.freeze({ ...(this.#snapshot.rateLimits ?? {}), ...update }) as RideCodexRateLimits;
                    this.#setSnapshot({ ...this.#snapshot, rateLimits: merged });
                    return;
                }
            }
        } catch (error) {
            if (error instanceof RideCodexUnsafeAuthPayloadError) {
                this.#diagnostics.record('protocol-error');
                return;
            }
            this.#setGenericError('invalid-data');
        }
    }

    #onLoginCompleted(completion: ReturnType<typeof normalizeRideCodexLoginCompletion>): void {
        if (!completion.loginId) {
            return;
        }
        const login = this.#knownLogins.get(completion.loginId);
        if (!login || login.status !== 'active') {
            return;
        }
        this.#rememberLogin(completion.loginId, 'completed', login.operation);
        if (login.operation !== this.#callerAuthOperation) {
            return;
        }
        if (!completion.success) {
            this.#invalidateNotificationAccountRefresh();
            this.#setGenericError('operation-failed');
            return;
        }
        this.#scheduleNotificationAccountRefresh(this.#activeGeneration);
    }

    #isDuplicateNotification(method: string, safeValue: unknown): boolean {
        const signature = JSON.stringify(safeValue);
        if (this.#notificationSignatures.get(method) === signature) {
            return true;
        }
        this.#notificationSignatures.set(method, signature);
        return false;
    }

    #onHostStateChange(event: RideCodexAuthHostStateEvent): void {
        if (this.#disposed || !this.#lease || event.generation < this.#activeGeneration) {
            return;
        }
        let invalidated = false;
        if (event.generation !== this.#activeGeneration) {
            this.#activeGeneration = event.generation;
            this.#beginCallerAuthOperation();
            this.#knownLogins.clear();
            this.#notificationSignatures.clear();
            this.#invalidateRateReads();
            invalidated = true;
        }
        if (event.state === 'ready') {
            const token = invalidated ? this.#callerAuthOperation : this.#beginCallerAuthOperation();
            void this.#readAccountForToken(token, false).catch(() => undefined);
            return;
        }
        if (event.state === 'restarting' || event.state === 'stopped'
            || event.state === 'circuit-open' || event.state === 'disposed') {
            if (!invalidated) {
                this.#beginCallerAuthOperation();
                this.#invalidateRateReads();
            }
            this.#setAuthSnapshot({ state: 'disconnected' });
        }
    }

    #failOperation(
        error: unknown,
        token: number,
        rollback?: Readonly<{ current: RideCodexAuthSnapshot; previous: RideCodexAuthSnapshot }>
    ): RideCodexAuthError {
        if (error instanceof RideCodexAuthError) {
            return error;
        }
        if (token !== this.#callerAuthOperation) {
            return new RideCodexAuthError('operation-superseded');
        }
        if (error instanceof RideCodexUnsafeAuthPayloadError) {
            this.#diagnostics.record('protocol-error');
            if (rollback && this.#snapshot === rollback.current) {
                this.#restoreSnapshot(rollback.previous);
            }
            return new RideCodexAuthError('invalid-data');
        }
        this.#setGenericError(error instanceof TypeError ? 'invalid-data' : 'operation-failed');
        return new RideCodexAuthError(error instanceof TypeError ? 'invalid-data' : 'operation-failed');
    }

    #failRateOperation(error: unknown, token: number): RideCodexAuthError {
        if (error instanceof RideCodexAuthError) {
            return error;
        }
        if (token !== this.#rateOperation) {
            return new RideCodexAuthError('operation-superseded');
        }
        if (error instanceof TypeError || error instanceof RangeError) {
            this.#diagnostics.record('protocol-error');
            return new RideCodexAuthError('invalid-data');
        }
        this.#setGenericError('operation-failed');
        return new RideCodexAuthError('operation-failed');
    }

    #setGenericError(code: 'invalid-data' | 'operation-failed'): void {
        this.#setAuthSnapshot({
            state: 'error',
            account: this.#snapshot.account,
            rateLimits: this.#snapshot.rateLimits,
            error: { code, message: AUTH_ERROR_MESSAGES[code] }
        });
    }

    #requireCurrentOperation(token: number): void {
        if (token !== this.#callerAuthOperation) {
            throw new RideCodexAuthError('operation-superseded');
        }
    }

    #beginCallerAuthOperation(): number {
        const token = ++this.#callerAuthOperation;
        this.#invalidateNotificationAccountRefresh();
        return token;
    }

    #invalidateNotificationAccountRefresh(): void {
        ++this.#notificationAccountRefresh;
        this.#notificationAccountRefreshPending = undefined;
    }

    #invalidateRateReads(): void {
        ++this.#rateOperation;
        ++this.#rateVersion;
    }

    #rememberLogin(
        loginId: string,
        status: 'active' | 'canceled' | 'completed',
        operation: number
    ): void {
        this.#knownLogins.delete(loginId);
        this.#knownLogins.set(loginId, Object.freeze({ status, operation }));
        while (this.#knownLogins.size > MAX_KNOWN_LOGINS) {
            this.#knownLogins.delete(this.#knownLogins.keys().next().value as string);
        }
    }

    #setSnapshot(value: RideCodexAuthSnapshot): RideCodexAuthSnapshot {
        this.#snapshot = createRideCodexAuthSnapshot(value);
        for (const client of [...this.#clients]) {
            this.#emitClient(client, this.#snapshot);
        }
        return this.#snapshot;
    }

    #setAuthSnapshot(value: RideCodexAuthSnapshot): RideCodexAuthSnapshot {
        ++this.#accountRevision;
        return this.#setSnapshot(value);
    }

    #restoreSnapshot(snapshot: RideCodexAuthSnapshot): void {
        ++this.#accountRevision;
        this.#snapshot = snapshot;
        for (const client of [...this.#clients]) {
            this.#emitClient(client, snapshot);
        }
    }

    #emitClient(client: RideCodexAuthClient, snapshot: RideCodexAuthSnapshot): void {
        try {
            client.authStateChanged(snapshot);
        } catch {
            // A frontend callback must not destabilize the broker or retain untrusted data.
        }
    }

    #requireUsable(): void {
        if (this.#disposed) {
            throw new RideCodexAuthError('disposed');
        }
    }
}

function requirePlainOptions(value: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || utilTypes.isProxy(value) || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
        throw new TypeError('Codex auth options are invalid');
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(record)) {
        if (!allowed.includes(key)) {
            throw new TypeError('Codex auth options contain an unsupported property');
        }
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.get || descriptor.set) {
            throw new TypeError('Codex auth options contain an unsafe property');
        }
    }
    return record;
}

function rejectProxyBeforeAwait<T>(value: T): T {
    if (typeof value === 'object' && value !== null && utilTypes.isProxy(value)) {
        throw new RideCodexUnsafeAuthPayloadError();
    }
    return value;
}

function disposeSafely(disposable: RideCodexDisposable): void {
    try {
        disposable.dispose();
    } catch {
        // Listener disposal is idempotent and best effort.
    }
}
