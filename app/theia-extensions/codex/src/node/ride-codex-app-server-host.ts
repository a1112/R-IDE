/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    ChildProcessWithoutNullStreams,
    spawn as nodeSpawn
} from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { INITIALIZE_CAPABILITIES } from '../common/ride-codex-methods';
import {
    RideCodexClientNotificationMethod,
    RideCodexDisposable,
    RideCodexIncomingRequest,
    RideCodexJsonlClient,
    RideCodexJsonlTransport,
    RideCodexNotification,
    StableClientMethod
} from './ride-codex-jsonl-client';
import { RideCodexLaunchSpec } from './ride-codex-launch-spec';
import { RideCodexRuntimeResolver } from './ride-codex-runtime-resolver';
import {
    RideCodexAppServerDiagnosticCode,
    RideCodexAppServerDiagnostics,
    RideCodexAppServerDiagnosticSnapshot
} from './ride-codex-diagnostics';

export type RideCodexAppServerLeaseKind = 'foreground-panel' | 'active-turn' | 'approval';
export type RideCodexAppServerState =
    | 'stopped'
    | 'starting'
    | 'ready'
    | 'restarting'
    | 'stopping'
    | 'circuit-open'
    | 'disposed';

export interface RideCodexAppServerSpawnOptions {
    readonly shell: false;
    readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
    readonly env: NodeJS.ProcessEnv;
    readonly windowsHide: true;
}

export type RideCodexAppServerSpawn = (
    executable: string,
    args: readonly string[],
    options: RideCodexAppServerSpawnOptions
) => ChildProcessWithoutNullStreams;

export interface RideCodexAppServerResolver {
    resolve(): Promise<RideCodexLaunchSpec>;
}

export interface RideCodexAppServerHostOptions {
    readonly resolver?: RideCodexAppServerResolver;
    readonly diagnostics?: RideCodexAppServerDiagnostics;
    readonly spawn?: RideCodexAppServerSpawn;
    readonly handshakeTimeoutMs?: number;
    readonly idleTimeoutMs?: number;
    readonly shutdownGraceMs?: number;
}

export interface RideCodexAppServerLease {
    readonly kind: RideCodexAppServerLeaseKind;
    readonly generation: number;
    request(method: StableClientMethod, params: unknown, timeoutMs?: number): Promise<unknown>;
    notify(method: RideCodexClientNotificationMethod, params: unknown): Promise<void>;
    release(): void;
}

export interface RideCodexAppServerHostSnapshot {
    readonly state: RideCodexAppServerState;
    readonly generation: number;
    readonly pid?: number;
    readonly leaseCount: number;
    readonly unsafeApprovalCount: number;
    readonly restartAttempts: number;
    readonly initialization?: typeof INITIALIZE_PARAMS;
    readonly diagnostics: RideCodexAppServerDiagnosticSnapshot;
}

export interface RideCodexAppServerHostStateEvent {
    readonly state: RideCodexAppServerState;
    readonly generation: number;
}

export type RideCodexAppServerHostErrorCode =
    | RideCodexAppServerDiagnosticCode
    | 'disposed'
    | 'lease-released'
    | 'recovery-superseded';

const ERROR_MESSAGE_BY_CODE: Readonly<Record<RideCodexAppServerHostErrorCode, string>> = Object.freeze({
    'early-exit': 'Codex App Server exited before initialize completed.',
    'handshake-timeout': 'Codex App Server initialize handshake timed out.',
    'protocol-error': 'Codex App Server initialize protocol failed.',
    'spawn-failed': 'Codex App Server start failed.',
    'unexpected-exit': 'Codex App Server exited unexpectedly.',
    'unsafe-approval-exit': 'Codex App Server exited during an unsafe approval.',
    'circuit-open': 'Codex App Server restart circuit is open.',
    'shutdown-forced': 'Codex App Server required bounded exact-child termination.',
    'shutdown-timeout': 'Codex App Server did not confirm shutdown within the configured bound.',
    'disposed': 'Codex App Server host is disposed.',
    'lease-released': 'Codex App Server lease is released.',
    'recovery-superseded': 'Codex App Server recovery generation was superseded.'
});

export class RideCodexAppServerHostError extends Error {
    constructor(readonly code: RideCodexAppServerHostErrorCode) {
        super(ERROR_MESSAGE_BY_CODE[code]);
        this.name = 'RideCodexAppServerHostError';
    }
}

interface LeaseRecord {
    readonly id: number;
    readonly kind: RideCodexAppServerLeaseKind;
    released: boolean;
}

interface Connection {
    readonly generation: number;
    readonly child: ChildProcessWithoutNullStreams;
    readonly pid?: number;
    readonly transport: ChildJsonlTransport;
    readonly client: RideCodexJsonlClient;
    readonly exitPromise: Promise<void>;
    readonly resolveExit: () => void;
    readonly stderrDataListener: (chunk: Buffer) => void;
    readonly stderrErrorListener: () => void;
    readonly processExitListener: () => void;
    readonly clientListeners: RideCodexDisposable[];
    intentionalStop: boolean;
    ready: boolean;
    finalized: boolean;
    killRequested: boolean;
    exitHandling: boolean;
}

const INITIALIZE_PARAMS = Object.freeze({
    clientInfo: Object.freeze({ name: 'r-ide', title: 'R-IDE', version: '1.72.100' }),
    capabilities: INITIALIZE_CAPABILITIES
});

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
const MAX_TIMER_MS = 0x7fffffff;
const MAX_APP_SERVER_ENVIRONMENT_ENTRIES = 32;
const MAX_APP_SERVER_ENVIRONMENT_SOURCE_ENTRIES = 1_024;
const MAX_APP_SERVER_ENVIRONMENT_KEY_BYTES = 64;
const MAX_APP_SERVER_ENVIRONMENT_VALUE_BYTES = 8 * 1024;
const MAX_APP_SERVER_ENVIRONMENT_BYTES = 16 * 1024;
const XDG_APP_SERVER_ENVIRONMENT_KEYS = [
    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR'
] as const;
const LOCALE_APP_SERVER_ENVIRONMENT_KEYS = [
    'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_NUMERIC', 'LC_TIME', 'LC_COLLATE',
    'LC_MONETARY', 'LC_MESSAGES', 'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE',
    'LC_MEASUREMENT', 'LC_IDENTIFICATION'
] as const;
const WINDOWS_APP_SERVER_ENVIRONMENT_KEYS = new Map([
    'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'USERPROFILE',
    'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TZ',
    ...XDG_APP_SERVER_ENVIRONMENT_KEYS,
    ...LOCALE_APP_SERVER_ENVIRONMENT_KEYS
].map(key => [key, key]));
const POSIX_APP_SERVER_ENVIRONMENT_KEYS = new Set([
    'HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'TZ',
    ...XDG_APP_SERVER_ENVIRONMENT_KEYS,
    ...LOCALE_APP_SERVER_ENVIRONMENT_KEYS
]);

export class RideCodexAppServerHost {
    readonly diagnostics: RideCodexAppServerDiagnostics;
    readonly #resolver: RideCodexAppServerResolver;
    readonly #spawn: RideCodexAppServerSpawn;
    readonly #handshakeTimeoutMs: number;
    readonly #idleTimeoutMs: number;
    readonly #shutdownGraceMs: number;
    readonly #leases = new Map<number, LeaseRecord>();
    readonly #notificationListeners = new Set<(notification: RideCodexNotification, generation: number) => void>();
    readonly #stateListeners = new Set<(event: RideCodexAppServerHostStateEvent) => void>();
    readonly #serverRequestListeners = new Set<(request: RideCodexIncomingRequest, generation: number) => void>();
    #state: RideCodexAppServerState = 'stopped';
    #generation = 0;
    #nextLeaseId = 1;
    #unsafeApprovalCount = 0;
    #restartAttempts = 0;
    #connection: Connection | undefined;
    #startPromise: Promise<Connection> | undefined;
    #stopPromise: Promise<void> | undefined;
    #stoppingConnection: Connection | undefined;
    #idleTimer: ReturnType<typeof setTimeout> | undefined;
    #disposePromise: Promise<void> | undefined;
    #recoveryPromise: Promise<number> | undefined;
    #recoveryGeneration: number | undefined;
    #disposed = false;

    constructor(options: RideCodexAppServerHostOptions = {}) {
        this.#resolver = options.resolver ?? new RideCodexRuntimeResolver();
        this.diagnostics = options.diagnostics ?? new RideCodexAppServerDiagnostics();
        this.#spawn = options.spawn ?? defaultSpawn;
        this.#handshakeTimeoutMs = timerLimit(
            options.handshakeTimeoutMs,
            DEFAULT_HANDSHAKE_TIMEOUT_MS,
            'initialize handshake timeout',
            1
        );
        this.#idleTimeoutMs = timerLimit(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 'idle timeout', 0);
        this.#shutdownGraceMs = timerLimit(
            options.shutdownGraceMs,
            DEFAULT_SHUTDOWN_GRACE_MS,
            'shutdown grace period',
            0
        );
    }

    async acquire(kind: RideCodexAppServerLeaseKind): Promise<RideCodexAppServerLease> {
        this.#requireUsable();
        if (!isLeaseKind(kind)) {
            throw new TypeError('Unsupported Codex App Server lease kind');
        }
        this.#cancelIdleTimer();
        const record: LeaseRecord = { id: this.#nextLeaseId, kind, released: false };
        this.#nextLeaseId += 1;
        this.#leases.set(record.id, record);
        if (kind === 'approval') {
            this.#unsafeApprovalCount += 1;
        }
        try {
            const connection = await this.#ensureStarted(false);
            this.#requireUsable();
            return this.#createLease(record, connection.generation);
        } catch (error) {
            this.#releaseRecord(record);
            throw error;
        }
    }

    async retry(): Promise<void> {
        if (this.#disposed) {
            throw new RideCodexAppServerHostError('disposed');
        }
        const stopping = this.#stopPromise;
        if (stopping) {
            await stopping.catch(() => undefined);
        }
        const owned = this.#connection;
        if (owned && !owned.finalized && (!owned.ready || this.#state === 'circuit-open')) {
            try {
                await this.#stopConnection(owned, 'retry');
            } catch {
                if (!this.#disposed) {
                    this.#setState('circuit-open');
                }
                throw new RideCodexAppServerHostError('shutdown-timeout');
            }
        }
        this.#restartAttempts = 0;
        if (this.#state === 'circuit-open') {
            this.#setState('stopped');
        }
        if (this.#leases.size > 0) {
            await this.#ensureStarted(false);
        }
    }

    restartForRecovery(expectedGeneration: number): Promise<number> {
        if (this.#disposed) {
            return Promise.reject(new RideCodexAppServerHostError('disposed'));
        }
        if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
            return Promise.reject(new RideCodexAppServerHostError('recovery-superseded'));
        }
        if (this.#recoveryPromise) {
            return this.#recoveryGeneration === expectedGeneration
                ? this.#recoveryPromise
                : Promise.reject(new RideCodexAppServerHostError('recovery-superseded'));
        }
        const connection = this.#connection;
        if (expectedGeneration !== this.#generation || this.#state !== 'ready'
            || !connection || connection.generation !== expectedGeneration
            || !connection.ready || connection.finalized || this.#unsafeApprovalCount > 0) {
            return Promise.reject(new RideCodexAppServerHostError('recovery-superseded'));
        }
        this.#cancelIdleTimer();
        this.#recoveryGeneration = expectedGeneration;
        const operation: Promise<number> = (async (): Promise<number> => {
            try {
                await this.#stopConnection(connection, 'recovery');
                this.#requireUsable();
                if (this.#connection && this.#connection !== connection) {
                    throw new RideCodexAppServerHostError('recovery-superseded');
                }
                this.#restartAttempts = 0;
                const replacement = await this.#ensureStarted(true);
                this.#requireUsable();
                if (this.#leases.size === 0) {
                    this.#scheduleIdleShutdown();
                }
                return replacement.generation;
            } finally {
                if (this.#recoveryGeneration === expectedGeneration) {
                    this.#recoveryPromise = undefined;
                    this.#recoveryGeneration = undefined;
                }
            }
        })();
        this.#recoveryPromise = operation;
        operation.catch(() => undefined);
        return operation;
    }

    onNotification(listener: (notification: RideCodexNotification, generation: number) => void): RideCodexDisposable {
        this.#notificationListeners.add(listener);
        let disposed = false;
        return {
            dispose: () => {
                if (!disposed) {
                    disposed = true;
                    this.#notificationListeners.delete(listener);
                }
            }
        };
    }

    onStateChange(listener: (event: RideCodexAppServerHostStateEvent) => void): RideCodexDisposable {
        return addListener(this.#stateListeners, listener);
    }

    onServerRequest(listener: (request: RideCodexIncomingRequest, generation: number) => void): RideCodexDisposable {
        this.#serverRequestListeners.add(listener);
        let disposed = false;
        return {
            dispose: () => {
                if (!disposed) {
                    disposed = true;
                    this.#serverRequestListeners.delete(listener);
                }
            }
        };
    }

    respondServerRequest(generation: number, id: string | number, result: unknown): Promise<void> {
        const connection = this.#connection;
        if (!Number.isSafeInteger(generation) || generation < 1
            || this.#state !== 'ready' || generation !== this.#generation
            || !connection || connection.generation !== generation
            || !connection.ready || connection.finalized) {
            return Promise.reject(new RideCodexAppServerHostError('recovery-superseded'));
        }
        return connection.client.respondConfirmed(id, result);
    }

    snapshot(): RideCodexAppServerHostSnapshot {
        return Object.freeze({
            state: this.#state,
            generation: this.#generation,
            ...(this.#connection?.pid === undefined ? {} : { pid: this.#connection.pid }),
            leaseCount: this.#leases.size,
            unsafeApprovalCount: this.#unsafeApprovalCount,
            restartAttempts: this.#restartAttempts,
            ...(this.#connection?.ready ? { initialization: INITIALIZE_PARAMS } : {}),
            diagnostics: this.diagnostics.snapshot()
        });
    }

    dispose(): Promise<void> {
        if (this.#disposePromise) {
            return this.#disposePromise;
        }
        this.#disposed = true;
        this.#setState('disposed');
        this.#cancelIdleTimer();
        for (const record of this.#leases.values()) {
            record.released = true;
        }
        this.#leases.clear();
        this.#unsafeApprovalCount = 0;
        this.#notificationListeners.clear();
        this.#stateListeners.clear();
        this.#serverRequestListeners.clear();

        const operation = (async () => {
            const starting = this.#startPromise;
            const current = this.#connection;
            if (current) {
                await this.#stopConnectionForDisposal(current);
            }
            if (starting) {
                await starting.catch(() => undefined);
            }
            const connectionAfterStart = this.#connection;
            if (connectionAfterStart && connectionAfterStart !== current) {
                await this.#stopConnectionForDisposal(connectionAfterStart);
            }
            this.#setState('disposed');
        })();
        this.#disposePromise = operation;
        return operation;
    }

    onStop(): Promise<void> {
        return this.dispose();
    }

    #createLease(record: LeaseRecord, generation: number): RideCodexAppServerLease {
        return Object.freeze({
            kind: record.kind,
            generation,
            request: (method: StableClientMethod, params: unknown, timeoutMs?: number) =>
                this.#request(record, method, params, timeoutMs),
            notify: (method: RideCodexClientNotificationMethod, params: unknown) =>
                this.#notify(record, method, params),
            release: () => this.#releaseRecord(record)
        });
    }

    async #request(
        record: LeaseRecord,
        method: StableClientMethod,
        params: unknown,
        timeoutMs?: number
    ): Promise<unknown> {
        this.#requireLease(record);
        if (method === 'initialize') {
            throw new Error('Initialize is owned by the Codex App Server host');
        }
        const connection = await this.#ensureStarted(false);
        this.#requireLease(record);
        if (!connection.ready || this.#connection !== connection) {
            throw new RideCodexAppServerHostError('unexpected-exit');
        }
        return connection.client.request(method, params, timeoutMs);
    }

    async #notify(
        record: LeaseRecord,
        method: RideCodexClientNotificationMethod,
        params: unknown
    ): Promise<void> {
        this.#requireLease(record);
        if (method === 'initialized') {
            throw new Error('Initialized is owned by the Codex App Server host');
        }
        const connection = await this.#ensureStarted(false);
        this.#requireLease(record);
        connection.client.notify(method, params);
    }

    #releaseRecord(record: LeaseRecord): void {
        if (record.released) {
            return;
        }
        record.released = true;
        if (!this.#leases.delete(record.id)) {
            return;
        }
        if (record.kind === 'approval') {
            this.#unsafeApprovalCount = Math.max(0, this.#unsafeApprovalCount - 1);
        }
        if (!this.#disposed && this.#leases.size === 0 && (this.#connection || this.#startPromise)) {
            this.#scheduleIdleShutdown();
        }
    }

    #requireLease(record: LeaseRecord): void {
        this.#requireUsable();
        if (record.released || this.#leases.get(record.id) !== record) {
            throw new RideCodexAppServerHostError('lease-released');
        }
    }

    #requireUsable(): void {
        if (this.#disposed) {
            throw new RideCodexAppServerHostError('disposed');
        }
        if (this.#state === 'circuit-open') {
            throw new RideCodexAppServerHostError('circuit-open');
        }
    }

    async #ensureStarted(restarting: boolean): Promise<Connection> {
        try {
            this.#requireUsable();
        } catch (error) {
            throw error;
        }
        const stopping = this.#stopPromise;
        if (stopping) {
            await stopping;
            this.#requireUsable();
            return this.#ensureStarted(restarting);
        }
        if (this.#connection?.ready) {
            return this.#connection;
        }
        if (this.#startPromise) {
            return this.#startPromise;
        }
        if (this.#connection && !this.#connection.finalized) {
            if (!this.#disposed) {
                this.#setState('circuit-open');
            }
            throw new RideCodexAppServerHostError('circuit-open');
        }
        const generation = this.#generation + 1;
        this.#generation = generation;
        this.#setState(restarting ? 'restarting' : 'starting', true);
        const operation = this.#startGeneration(generation);
        let tracked!: Promise<Connection>;
        tracked = operation.then(
            connection => {
                if (this.#startPromise === tracked) {
                    this.#startPromise = undefined;
                }
                return connection;
            },
            error => {
                if (this.#startPromise === tracked) {
                    this.#startPromise = undefined;
                }
                throw error;
            }
        );
        void tracked.catch(() => undefined);
        this.#startPromise = tracked;
        return tracked;
    }

    async #startGeneration(generation: number): Promise<Connection> {
        let child: ChildProcessWithoutNullStreams | undefined;
        let connection: Connection | undefined;
        try {
            const launchSpec = await this.#resolver.resolve();
            if (this.#disposed || generation !== this.#generation) {
                throw new RideCodexAppServerHostError('disposed');
            }
            child = this.#spawn(launchSpec.executable, ['app-server', '--stdio'], Object.freeze({
                shell: false,
                stdio: Object.freeze(['pipe', 'pipe', 'pipe'] as const),
                env: createAppServerEnvironment(process.env, launchSpec.environment, process.platform),
                windowsHide: true
            }));
            requirePipedChild(child);
            connection = this.#createConnection(generation, child);
            this.#connection = connection;

            await connection.client.request('initialize', INITIALIZE_PARAMS, this.#handshakeTimeoutMs);
            if (this.#disposed || this.#connection !== connection || generation !== this.#generation) {
                throw new RideCodexAppServerHostError(this.#disposed ? 'disposed' : 'early-exit');
            }
            await connection.client.notifyConfirmed('initialized', {});
            if (this.#disposed || this.#connection !== connection || generation !== this.#generation) {
                throw new RideCodexAppServerHostError(this.#disposed ? 'disposed' : 'early-exit');
            }
            connection.ready = true;
            this.#setState('ready');
            return connection;
        } catch (error) {
            const safe = classifyStartupError(error, connection);
            if (connection) {
                await this.#stopConnection(connection, 'startup-failure');
            } else if (child) {
                await terminateUnpublishedChild(child, this.#shutdownGraceMs);
            }
            if (!this.#disposed && this.#state !== 'circuit-open') {
                this.#setState('stopped');
            }
            if (safe.code !== 'disposed' && safe.code !== 'lease-released'
                && safe.code !== 'recovery-superseded') {
                this.diagnostics.record(safe.code);
            }
            throw safe;
        }
    }

    #createConnection(generation: number, child: ChildProcessWithoutNullStreams): Connection {
        let resolveExit!: () => void;
        const exitPromise = new Promise<void>(resolve => { resolveExit = resolve; });
        const transport = new ChildJsonlTransport(child);
        const stderrDataListener = (chunk: Buffer): void => this.diagnostics.appendStderr(chunk);
        const stderrErrorListener = (): void => undefined;
        let client: RideCodexJsonlClient | undefined;
        const clientListeners: RideCodexDisposable[] = [];
        let stderrDataRegistered = false;
        let stderrErrorRegistered = false;
        try {
            client = new RideCodexJsonlClient(transport);
            child.stderr.on('data', stderrDataListener);
            stderrDataRegistered = true;
            child.stderr.on('error', stderrErrorListener);
            stderrErrorRegistered = true;
            child.stderr.resume();
            clientListeners.push(
                client.onNotification(notification => this.#emitNotification(notification, generation)),
                client.onServerRequest(request => this.#emitServerRequest(request, generation))
            );
        } catch (error) {
            for (const listener of clientListeners) {
                disposeSafely(listener);
            }
            client?.dispose();
            transport.dispose();
            if (stderrDataRegistered) {
                child.stderr.off('data', stderrDataListener);
            }
            if (stderrErrorRegistered) {
                child.stderr.off('error', stderrErrorListener);
            }
            throw error;
        }
        let connection!: Connection;
        connection = {
            generation,
            child,
            pid: child.pid,
            transport,
            client,
            exitPromise,
            resolveExit,
            stderrDataListener,
            stderrErrorListener,
            processExitListener: () => {
                resolveExit();
                void this.#handleConnectionExit(connection);
            },
            clientListeners,
            intentionalStop: false,
            ready: false,
            finalized: false,
            killRequested: false,
            exitHandling: false
        };
        child.on('exit', connection.processExitListener);
        child.on('close', connection.processExitListener);
        transport.onExit(reason => {
            if (hasProcessExited(child)) {
                connection.resolveExit();
            }
            void this.#handleConnectionExit(connection, reason);
        });
        return connection;
    }

    async #handleConnectionExit(connection: Connection, _reason?: Error): Promise<void> {
        if (connection.finalized || connection.exitHandling) {
            return;
        }
        connection.exitHandling = true;
        try {
            const wasCurrent = this.#connection === connection && this.#generation === connection.generation;
            if (!hasProcessExited(connection.child)) {
                connection.client.dispose();
                this.#killExactChild(connection);
                if (!await settlesWithin(connection.exitPromise, this.#shutdownGraceMs)) {
                    this.diagnostics.record('shutdown-timeout');
                    if (wasCurrent && !this.#disposed) {
                        this.#openCircuit('circuit-open');
                    }
                    return;
                }
            }
            this.#finalizeConnection(connection);
            if (!wasCurrent) {
                return;
            }
            this.#connection = undefined;
            if (this.#disposed) {
                this.#setState('disposed');
                return;
            }
            if (connection.intentionalStop) {
                if (!this.#connection && this.#state !== 'circuit-open') {
                    this.#setState('stopped');
                }
                return;
            }
            if (!connection.ready) {
                if (this.#state !== 'circuit-open') {
                    this.#setState('stopped');
                }
                return;
            }

            this.diagnostics.record('unexpected-exit');
            if (this.#unsafeApprovalCount > 0) {
                this.#openCircuit('unsafe-approval-exit');
                return;
            }
            if (this.#restartAttempts >= 1) {
                this.#openCircuit('circuit-open');
                return;
            }
            if (this.#leases.size === 0) {
                this.#setState('stopped');
                return;
            }
            this.#restartAttempts += 1;
            try {
                await this.#ensureStarted(true);
            } catch {
                if (!this.#disposed && this.#state !== 'circuit-open') {
                    this.#openCircuit('circuit-open');
                }
            }
        } finally {
            connection.exitHandling = false;
        }
    }

    #openCircuit(code: 'unsafe-approval-exit' | 'circuit-open'): void {
        this.#setState('circuit-open');
        this.diagnostics.record(code);
    }

    #scheduleIdleShutdown(): void {
        this.#cancelIdleTimer();
        this.#idleTimer = setTimeout(() => {
            this.#idleTimer = undefined;
            if (this.#disposed || this.#leases.size > 0) {
                return;
            }
            const connection = this.#connection;
            if (connection) {
                void this.#stopConnection(connection, 'idle');
            }
        }, this.#idleTimeoutMs);
        this.#idleTimer.unref?.();
    }

    #cancelIdleTimer(): void {
        if (this.#idleTimer) {
            clearTimeout(this.#idleTimer);
            this.#idleTimer = undefined;
        }
    }

    #stopConnection(
        connection: Connection,
        reason: 'idle' | 'dispose' | 'startup-failure' | 'retry' | 'recovery'
    ): Promise<void> {
        if (this.#stopPromise) {
            if (this.#stoppingConnection === connection) {
                return this.#stopPromise;
            }
            return this.#stopPromise.then(() => this.#stopConnection(connection, reason));
        }
        let resolveStop!: () => void;
        let rejectStop!: (error: unknown) => void;
        const stopPromise = new Promise<void>((resolve, reject) => {
            resolveStop = resolve;
            rejectStop = reject;
        });
        this.#stopPromise = stopPromise;
        this.#stoppingConnection = connection;
        void this.#performStopConnection(connection, reason === 'retry' || reason === 'recovery').then(
            () => {
                if (this.#stopPromise === stopPromise) {
                    this.#stopPromise = undefined;
                    this.#stoppingConnection = undefined;
                }
                resolveStop();
            },
            error => {
                if (this.#stopPromise === stopPromise) {
                    this.#stopPromise = undefined;
                    this.#stoppingConnection = undefined;
                }
                rejectStop(error);
            }
        );
        void stopPromise.catch(() => undefined);
        return stopPromise;
    }

    async #stopConnectionForDisposal(connection: Connection): Promise<void> {
        try {
            await this.#stopConnection(connection, 'dispose');
        } catch (error) {
            if (error instanceof RideCodexAppServerHostError && error.code === 'shutdown-timeout') {
                return;
            }
            throw error;
        }
    }

    async #performStopConnection(connection: Connection, retryTermination: boolean): Promise<void> {
        if (connection.finalized) {
            return;
        }
        connection.intentionalStop = true;
        connection.ready = false;
        if (!this.#disposed && this.#state !== 'circuit-open') {
            this.#setState('stopping');
        }
        connection.client.dispose();
        if (!connection.killRequested && await settlesWithin(connection.exitPromise, this.#shutdownGraceMs)) {
            this.#finalizeConnection(connection);
            if (this.#connection === connection) {
                this.#connection = undefined;
            }
            if (!this.#disposed) {
                this.#setState('stopped');
            }
            return;
        }
        if (!connection.killRequested) {
            this.diagnostics.record('shutdown-forced');
        }
        this.#killExactChild(connection, retryTermination);
        if (!await settlesWithin(connection.exitPromise, this.#shutdownGraceMs)) {
            this.diagnostics.record('shutdown-timeout');
            if (this.#disposed) {
                this.#setState('disposed');
                return;
            }
            this.#openCircuit('circuit-open');
            throw new RideCodexAppServerHostError('shutdown-timeout');
        }
        this.#finalizeConnection(connection);
        if (this.#connection === connection) {
            this.#connection = undefined;
        }
        if (!this.#disposed) {
            this.#setState('stopped');
        }
    }

    #killExactChild(connection: Connection, retry = false): void {
        if (connection.killRequested && !retry) {
            return;
        }
        connection.killRequested = true;
        try {
            connection.child.kill();
        } catch {
            // Only the exact owned child is eligible for termination. Tauri's existing
            // process-tree containment remains the final descendant cleanup boundary.
        }
    }

    #finalizeConnection(connection: Connection): void {
        if (connection.finalized) {
            return;
        }
        connection.finalized = true;
        for (const listener of connection.clientListeners) {
            disposeSafely(listener);
        }
        connection.client.dispose();
        connection.transport.dispose();
        connection.child.stderr.off('data', connection.stderrDataListener);
        connection.child.stderr.off('error', connection.stderrErrorListener);
        connection.child.off('exit', connection.processExitListener);
        connection.child.off('close', connection.processExitListener);
        this.diagnostics.flushStderr();
    }

    #emitSafely<T>(listeners: ReadonlySet<(event: T) => void>, event: T): void {
        for (const listener of [...listeners]) {
            try {
                listener(event);
            } catch {
                // Downstream listeners must not own or destabilize the shared process.
            }
        }
    }

    #emitNotification(notification: RideCodexNotification, generation: number): void {
        for (const listener of [...this.#notificationListeners]) {
            try {
                listener(notification, generation);
            } catch {
                // Downstream listeners must not own or destabilize the shared process.
            }
        }
    }

    #emitServerRequest(request: RideCodexIncomingRequest, generation: number): void {
        for (const listener of [...this.#serverRequestListeners]) {
            try {
                listener(request, generation);
            } catch {
                // Approval listeners cannot own or destabilize the shared process.
            }
        }
    }

    #setState(state: RideCodexAppServerState, force = false): void {
        if (!force && this.#state === state) {
            return;
        }
        this.#state = state;
        const event = Object.freeze({ state, generation: this.#generation });
        this.#emitSafely(this.#stateListeners, event);
    }
}

class ChildJsonlTransport implements RideCodexJsonlTransport {
    readonly #dataListeners = new Set<(chunk: Uint8Array) => void>();
    readonly #exitListeners = new Set<(reason?: Error) => void>();
    readonly #stdout: Readable;
    readonly #stdin: Writable;
    readonly #onData = (chunk: Buffer): void => {
        for (const listener of [...this.#dataListeners]) {
            listener(chunk);
        }
    };
    readonly #onExit = (): void => this.#emitExit(new Error('Codex App Server process exited'));
    readonly #onProcessError = (): void => this.#emitExit(new Error('Codex App Server process failed'));
    readonly #onStreamError = (): void => this.#emitExit(new Error('Codex App Server stdio failed'));
    readonly #onStdinClose = (): void => {
        if (!this.#closeRequested) {
            this.#emitExit(new Error('Codex App Server stdin closed'));
        }
    };
    #exited = false;
    #closeRequested = false;
    #disposed = false;

    constructor(readonly child: ChildProcessWithoutNullStreams) {
        this.#stdout = child.stdout;
        this.#stdin = child.stdin;
        try {
            this.#stdout.on('data', this.#onData);
            this.#stdout.on('error', this.#onStreamError);
            this.#stdin.on('error', this.#onStreamError);
            this.#stdin.on('close', this.#onStdinClose);
            child.on('error', this.#onProcessError);
            child.on('exit', this.#onExit);
        } catch (error) {
            this.dispose();
            throw error;
        }
    }

    write(data: string): void {
        const operation = this.writeConfirmed(data);
        void operation.catch(() => undefined);
    }

    writeConfirmed(data: string): Promise<void> {
        if (this.#exited || this.#disposed || this.#closeRequested || !this.#stdin.writable) {
            return containedWriteRejection(new Error('Codex App Server stdin is unavailable'));
        }
        let exitListener: RideCodexDisposable | undefined;
        const operation = new Promise<void>((resolve, reject) => {
            let settled = false;
            const settle = (error?: Error): void => {
                if (settled) {
                    return;
                }
                settled = true;
                exitListener?.dispose();
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };
            exitListener = this.onExit(reason => settle(reason ?? new Error('Codex App Server process exited')));
            try {
                this.#stdin.write(data, 'utf8', error => {
                    if (error) {
                        const failure = new Error('Codex App Server stdio failed');
                        this.#emitExit(failure);
                        settle(failure);
                    } else {
                        settle();
                    }
                });
            } catch {
                const failure = new Error('Codex App Server stdio failed');
                this.#emitExit(failure);
                settle(failure);
            }
        });
        void operation.catch(() => undefined);
        return operation;
    }

    onData(listener: (chunk: Uint8Array) => void): RideCodexDisposable {
        return addListener(this.#dataListeners, listener);
    }

    onExit(listener: (reason?: Error) => void): RideCodexDisposable {
        if (this.#exited) {
            listener(new Error('Codex App Server process exited'));
            return { dispose: () => undefined };
        }
        return addListener(this.#exitListeners, listener);
    }

    close(): void {
        if (this.#closeRequested) {
            return;
        }
        this.#closeRequested = true;
        try {
            this.#stdin.end();
        } catch {
            this.#emitExit(new Error('Codex App Server stdio failed'));
        }
    }

    dispose(): void {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        this.#stdout.off('data', this.#onData);
        this.#stdout.off('error', this.#onStreamError);
        this.#stdin.off('error', this.#onStreamError);
        this.#stdin.off('close', this.#onStdinClose);
        this.child.off('error', this.#onProcessError);
        this.child.off('exit', this.#onExit);
        this.#dataListeners.clear();
        this.#exitListeners.clear();
    }

    #emitExit(reason: Error): void {
        if (this.#exited) {
            return;
        }
        this.#exited = true;
        for (const listener of [...this.#exitListeners]) {
            listener(reason);
        }
    }
}

function defaultSpawn(
    executable: string,
    args: readonly string[],
    options: RideCodexAppServerSpawnOptions
): ChildProcessWithoutNullStreams {
    return nodeSpawn(executable, [...args], {
        shell: options.shell,
        stdio: [...options.stdio],
        env: options.env,
        windowsHide: options.windowsHide
    });
}

function createAppServerEnvironment(
    inherited: Readonly<Record<string, string | undefined>>,
    overlay: Readonly<Record<string, string>>,
    platform: NodeJS.Platform
): Readonly<NodeJS.ProcessEnv> {
    const values = new Map<string, string>();
    collectAllowedEnvironment(values, inherited, platform, false);
    collectAllowedEnvironment(values, overlay, platform, true);
    if (values.size > MAX_APP_SERVER_ENVIRONMENT_ENTRIES) {
        throw new Error('Codex App Server environment is invalid');
    }
    const safe: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
    let totalBytes = 0;
    for (const [key, value] of values) {
        const entryBytes = Buffer.byteLength(key) + Buffer.byteLength(value);
        if (totalBytes + entryBytes > MAX_APP_SERVER_ENVIRONMENT_BYTES) {
            throw new Error('Codex App Server environment is invalid');
        }
        safe[key] = value;
        totalBytes += entryBytes;
    }
    return Object.freeze(safe);
}

function collectAllowedEnvironment(
    destination: Map<string, string>,
    source: Readonly<Record<string, string | undefined>>,
    platform: NodeJS.Platform,
    rejectUndefined: boolean
): void {
    if (typeof source !== 'object' || source === null || Array.isArray(source)) {
        throw new Error('Codex App Server environment is invalid');
    }
    const keys = Object.getOwnPropertyNames(source);
    if (keys.length > MAX_APP_SERVER_ENVIRONMENT_SOURCE_ENTRIES) {
        throw new Error('Codex App Server environment is invalid');
    }
    const seen = new Set<string>();
    for (const key of keys) {
        if (Buffer.byteLength(key) > MAX_APP_SERVER_ENVIRONMENT_KEY_BYTES
            || key.includes('\0') || key.includes('=')) {
            throw new Error('Codex App Server environment is invalid');
        }
        if (isSecretEnvironmentKey(key)) {
            continue;
        }
        const canonicalKey = canonicalAppServerEnvironmentKey(key, platform);
        if (!canonicalKey) {
            continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
            || Object.prototype.hasOwnProperty.call(descriptor, 'get')
            || Object.prototype.hasOwnProperty.call(descriptor, 'set')) {
            throw new Error('Codex App Server environment is invalid');
        }
        const value = descriptor.value;
        if (value === undefined && !rejectUndefined) {
            continue;
        }
        if (typeof value !== 'string' || value.includes('\0')
            || Buffer.byteLength(value) > MAX_APP_SERVER_ENVIRONMENT_VALUE_BYTES) {
            throw new Error('Codex App Server environment is invalid');
        }
        if (seen.has(canonicalKey)) {
            throw new Error('Codex App Server environment is invalid');
        }
        seen.add(canonicalKey);
        destination.set(canonicalKey, value);
    }
}

function canonicalAppServerEnvironmentKey(key: string, platform: NodeJS.Platform): string | undefined {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return undefined;
    }
    const upper = key.toUpperCase();
    if (platform === 'win32') {
        return WINDOWS_APP_SERVER_ENVIRONMENT_KEYS.get(upper);
    }
    return POSIX_APP_SERVER_ENVIRONMENT_KEYS.has(key) ? key : undefined;
}

function isSecretEnvironmentKey(key: string): boolean {
    const segments = key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .filter(segment => segment.length > 0)
        .map(segment => segment.toLowerCase());
    const sensitiveSegments = new Set([
        'authorization', 'bearer', 'secret', 'password', 'passwd', 'token', 'credential'
    ]);
    if (segments.some(segment => sensitiveSegments.has(segment))) {
        return true;
    }
    if (segments.length === 1 && segments[0] === 'key') {
        return true;
    }
    const sensitiveKeyQualifiers = new Set(['private', 'api', 'signing', 'access']);
    for (let index = 1; index < segments.length; index += 1) {
        if (segments[index] === 'key' && sensitiveKeyQualifiers.has(segments[index - 1])) {
            return true;
        }
    }
    const collapsed = segments.join('');
    return [
        'authorization', 'bearer', 'secret', 'password', 'passwd', 'token', 'credential',
        'privatekey', 'apikey', 'signingkey', 'accesskey'
    ].some(suffix => collapsed === suffix || collapsed.endsWith(suffix));
}

function requirePipedChild(child: ChildProcessWithoutNullStreams): void {
    if (!child || !child.stdin || !child.stdout || !child.stderr) {
        throw new Error('Codex App Server spawn did not provide all required stdio pipes');
    }
}

function hasProcessExited(child: ChildProcessWithoutNullStreams): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

async function terminateUnpublishedChild(child: ChildProcessWithoutNullStreams, graceMs: number): Promise<void> {
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    try {
        child.stdin?.end();
    } catch {
        // Continue to bounded exact-child termination.
    }
    if (await settlesWithin(exited, graceMs)) {
        return;
    }
    try {
        child.kill();
    } catch {
        // No global process lookup or tree kill is allowed here.
    }
    await settlesWithin(exited, graceMs);
}

function classifyStartupError(error: unknown, connection: Connection | undefined): RideCodexAppServerHostError {
    if (error instanceof RideCodexAppServerHostError) {
        return error;
    }
    const message = error instanceof Error ? error.message : '';
    if (/timed out/i.test(message)) {
        return new RideCodexAppServerHostError('handshake-timeout');
    }
    if (/protocol|malformed|JSON|UTF-8|envelope/i.test(message)) {
        return new RideCodexAppServerHostError('protocol-error');
    }
    return new RideCodexAppServerHostError(connection ? 'early-exit' : 'spawn-failed');
}

function timerLimit(value: number | undefined, fallback: number, label: string, minimum: number): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > MAX_TIMER_MS) {
        throw new RangeError(`${label} must be a safe timer duration between ${minimum} and ${MAX_TIMER_MS}`);
    }
    return resolved;
}

function isLeaseKind(value: string): value is RideCodexAppServerLeaseKind {
    return value === 'foreground-panel' || value === 'active-turn' || value === 'approval';
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

function disposeSafely(disposable: RideCodexDisposable): void {
    try {
        disposable.dispose();
    } catch {
        // Listener disposal is idempotent and best effort.
    }
}

function containedWriteRejection(error: Error): Promise<never> {
    const rejection = Promise.reject(error);
    void rejection.catch(() => undefined);
    return rejection;
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
    if (timeoutMs === 0) {
        return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
    });
    const settled = await Promise.race([promise.then(() => true as const), timeout]);
    if (timer) {
        clearTimeout(timer);
    }
    return settled;
}
