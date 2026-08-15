/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { invoke, isTauri as isTauriRuntime } from '@tauri-apps/api/core';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import type { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { open } from '@theia/core/lib/browser/opener-service';
import type { OpenerService } from '@theia/core/lib/browser/opener-service';
import type { WidgetOpenerOptions } from '@theia/core/lib/browser/widget-open-handler';
import type { Disposable } from '@theia/core/lib/common/disposable';
import { FileUri } from '@theia/core/lib/common/file-uri';
import type { MessageService } from '@theia/core/lib/common/message-service';
import type { WorkspaceService } from '@theia/workspace/lib/browser';
import type { HostedPluginSupport } from '@theia/plugin-ext/lib/hosted/browser/hosted-plugin';
import type { RideNativeChrome } from './ride-native-chrome';

const MAX_U64_ID = '18446744073709551615';
const MAX_PENDING_REQUESTS = 64;
const MAX_STATE_CHARS = 262_144;

export const RIDE_OPEN_REQUEST_STATE_KEY = 'r-ide.open-request.state.v2';
const LEGACY_PENDING_KEY = 'r-ide.open-request.pending.v1';
const LEGACY_LAST_CONSUMED_KEY = 'r-ide.open-request.last-consumed.v1';

export type RideOpenRequestSource = 'initial' | 'singleInstance' | 'openedUrl';
export type RideStartupMilestone =
    | 'frontend_shell_attached'
    | 'target_file_opened'
    | 'plugins_started'
    | 'plugins_ready';

type StartupMilestoneReporter = (milestone: RideStartupMilestone) => Promise<void>;

type ObservedPluginPromise =
    | { readonly succeeded: true }
    | { readonly succeeded: false; readonly error: unknown };

export interface RideOpenRequest {
    id: string;
    source: RideOpenRequestSource;
    workspace: string;
    files: string[];
}

interface RideOpenRequestState {
    readonly version: 2;
    readonly lastConsumed: string;
    readonly requests: RideOpenRequest[];
}

type RideOpenRequestStateRead =
    | { readonly kind: 'missing' }
    | { readonly kind: 'invalid' }
    | { readonly kind: 'valid'; readonly state: RideOpenRequestState };

interface NormalizedNativePath {
    readonly comparisonPath: string;
    readonly fileSystemPath: string;
    readonly windows: boolean;
}

export class RideOpenRequestContribution implements FrontendApplicationContribution, Disposable {
    protected readonly storage: Storage;
    protected restoreAttempted = false;
    protected started = false;
    protected disposed = false;
    protected unlisten: (() => void) | undefined;
    protected requestChain = Promise.resolve();
    protected pluginObservationStarted = false;
    protected readonly pluginWillStart: Promise<ObservedPluginPromise>;
    protected readonly pluginDidStart: Promise<ObservedPluginPromise>;

    constructor(
        protected readonly workspaceService: WorkspaceService,
        protected readonly openerService: OpenerService,
        protected readonly messageService: MessageService,
        protected readonly shell: ApplicationShell,
        protected readonly nativeChrome: RideNativeChrome,
        protected readonly applicationState: FrontendApplicationStateService,
        hostedPlugins: HostedPluginSupport,
        storage?: Storage,
        protected readonly startupMilestoneReporter: StartupMilestoneReporter = reportRideStartupMilestone
    ) {
        this.storage = storage ?? window.sessionStorage;
        this.pluginWillStart = observePluginPromise(hostedPlugins.willStart);
        this.pluginDidStart = observePluginPromise(hostedPlugins.didStart);
    }

    onStart(): void {
        if (this.started || this.disposed) {
            return;
        }
        this.started = true;
        this.initializeAfterShellAttached().catch(error => this.reportInitializationFailure(error));
    }

    protected async initializeAfterShellAttached(): Promise<void> {
        await this.applicationState.reachedState('attached_shell');
        if (this.disposed) {
            return;
        }
        await this.reportStartupMilestone('frontend_shell_attached');
        if (this.disposed) {
            return;
        }
        await this.workspaceService.ready;
        if (this.disposed) {
            return;
        }
        await this.restorePendingRequest();
        if (this.disposed) {
            return;
        }

        try {
            const unlisten = await this.nativeChrome.listenForOpenRequests(request => this.enqueueOpenRequest(request));
            if (this.disposed) {
                unlisten();
            } else {
                this.unlisten = unlisten;
            }
        } catch (error) {
            await this.messageService.error(`R-IDE could not listen for file-open requests: ${errorMessage(error)}`);
        }
    }

    protected reportInitializationFailure(error: unknown): void {
        try {
            this.messageService
                .error(`R-IDE could not initialize file-open activation: ${errorMessage(error)}`)
                .catch(notificationError => {
                    console.warn('[R-IDE] Failed to report file-open initialization failure.', notificationError);
                });
        } catch (notificationError) {
            console.warn('[R-IDE] Failed to report file-open initialization failure.', notificationError);
        }
    }

    onStop(): void {
        this.dispose();
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.unlisten?.();
        this.unlisten = undefined;
    }

    async handleOpenRequest(payload: unknown): Promise<void> {
        const request = this.validateRequest(payload);
        if (!request) {
            await this.messageService.error('R-IDE rejected an invalid file-open request.');
            return;
        }

        const stateRead = await this.readState();
        if (stateRead.kind === 'invalid') {
            return;
        }
        const state = stateRead.kind === 'valid' ? stateRead.state : undefined;
        if (state && compareDecimalIds(request.id, state.lastConsumed) <= 0) {
            return;
        }

        if (state && state.requests.length > 0) {
            await this.commitState({
                version: 2,
                lastConsumed: request.id,
                requests: [...state.requests, request]
            });
            return;
        }

        const currentWorkspace = this.isCurrentWorkspace(request.workspace);
        const nextState: RideOpenRequestState = {
            version: 2,
            lastConsumed: request.id,
            requests: currentWorkspace ? [] : [request]
        };
        if (!await this.commitState(nextState)) {
            return;
        }

        if (!currentWorkspace) {
            try {
                this.workspaceService.open(FileUri.create(request.workspace), { preserveWindow: true });
            } catch (error) {
                await this.messageService.error(`R-IDE could not switch workspace: ${errorMessage(error)}`);
            }
            return;
        }

        await this.openFiles(request);
    }

    async restorePendingRequest(): Promise<void> {
        if (this.restoreAttempted) {
            return;
        }
        this.restoreAttempted = true;

        const stateRead = await this.readState();
        if (stateRead.kind !== 'valid' || stateRead.state.requests.length === 0) {
            return;
        }
        await this.dispatchPendingRequests(stateRead.state);
    }

    protected enqueueOpenRequest(request: RideOpenRequest): void {
        this.requestChain = this.requestChain
            .then(() => this.handleOpenRequest(request))
            .catch(error => {
                this.messageService.error(`R-IDE could not process a file-open request: ${errorMessage(error)}`).catch(console.warn);
            });
    }

    protected async openFiles(request: RideOpenRequest): Promise<void> {
        let targetWidgetId: string | undefined;
        let openedTarget = false;
        const options: WidgetOpenerOptions = { mode: 'open' };
        for (const file of request.files) {
            try {
                const opened = await open(this.openerService, FileUri.create(file), options);
                openedTarget = true;
                if (hasWidgetId(opened)) {
                    targetWidgetId = opened.id;
                }
            } catch (error) {
                await this.messageService.error(`R-IDE could not open ${file}: ${errorMessage(error)}`);
            }
        }
        if (targetWidgetId) {
            await this.shell.activateWidget(targetWidgetId);
        }
        if (openedTarget) {
            await this.reportStartupMilestone('target_file_opened');
            this.startPluginObservation();
        }
    }

    protected startPluginObservation(): void {
        if (this.pluginObservationStarted || this.disposed) {
            return;
        }
        this.pluginObservationStarted = true;
        this.observePluginLifecycle().catch(error => {
            console.warn('[R-IDE] Failed to observe the plugin lifecycle.', error);
        });
    }

    protected async observePluginLifecycle(): Promise<void> {
        const willStart = await this.pluginWillStart;
        if (this.disposed) {
            return;
        }
        if (!willStart.succeeded) {
            console.warn('[R-IDE] Failed to observe plugins starting.', willStart.error);
            return;
        }
        await this.reportStartupMilestone('plugins_started');

        const didStart = await this.pluginDidStart;
        if (this.disposed) {
            return;
        }
        if (!didStart.succeeded) {
            console.warn('[R-IDE] Failed to observe plugins becoming ready.', didStart.error);
            return;
        }
        await this.reportStartupMilestone('plugins_ready');
    }

    protected async reportStartupMilestone(milestone: RideStartupMilestone): Promise<void> {
        try {
            await this.startupMilestoneReporter(milestone);
        } catch (error) {
            console.warn(`[R-IDE] Failed to report startup milestone ${milestone}.`, error);
        }
    }

    protected async readState(): Promise<RideOpenRequestStateRead> {
        const serialized = this.storage.getItem(RIDE_OPEN_REQUEST_STATE_KEY) ?? undefined;
        if (serialized === undefined) {
            return this.clearLegacyState();
        }
        if (serialized.length > MAX_STATE_CHARS) {
            return this.rejectInvalidState('R-IDE discarded an oversized file-open state.');
        }

        let payload: unknown;
        try {
            payload = JSON.parse(serialized);
        } catch {
            return this.rejectInvalidState('R-IDE discarded a corrupt file-open state.');
        }
        if (!isRecord(payload)
            || payload.version !== 2
            || !isCanonicalU64(payload.lastConsumed)
            || !Array.isArray(payload.requests)
            || payload.requests.length > MAX_PENDING_REQUESTS) {
            return this.rejectInvalidState('R-IDE discarded an invalid file-open state.');
        }

        const requests: RideOpenRequest[] = [];
        for (const candidate of payload.requests) {
            const request = this.validateRequest(candidate);
            const previous = requests[requests.length - 1];
            if (!request || previous && compareDecimalIds(request.id, previous.id) <= 0) {
                return this.rejectInvalidState('R-IDE discarded an invalid file-open state.');
            }
            requests.push(request);
        }
        if (requests.length > 0 && requests[requests.length - 1].id !== payload.lastConsumed) {
            return this.rejectInvalidState('R-IDE discarded an unauthorized file-open state.');
        }
        return {
            kind: 'valid',
            state: { version: 2, lastConsumed: payload.lastConsumed, requests }
        };
    }

    protected async clearLegacyState(): Promise<RideOpenRequestStateRead> {
        const legacyPending = this.storage.getItem(LEGACY_PENDING_KEY) ?? undefined;
        const legacyLastConsumed = this.storage.getItem(LEGACY_LAST_CONSUMED_KEY) ?? undefined;
        if (legacyPending === undefined && legacyLastConsumed === undefined) {
            return { kind: 'missing' };
        }
        try {
            this.storage.removeItem(LEGACY_PENDING_KEY);
            this.storage.removeItem(LEGACY_LAST_CONSUMED_KEY);
        } catch (error) {
            await this.messageService.error(`R-IDE could not clear legacy file-open state: ${errorMessage(error)}`);
            return { kind: 'invalid' };
        }
        await this.messageService.error('R-IDE discarded unpublished legacy file-open state.');
        return { kind: 'invalid' };
    }

    protected async rejectInvalidState(message: string): Promise<RideOpenRequestStateRead> {
        try {
            this.storage.removeItem(RIDE_OPEN_REQUEST_STATE_KEY);
        } catch (error) {
            await this.messageService.error(`R-IDE could not clear invalid file-open state: ${errorMessage(error)}`);
            return { kind: 'invalid' };
        }
        await this.messageService.error(message);
        return { kind: 'invalid' };
    }

    protected async commitState(state: RideOpenRequestState): Promise<boolean> {
        if (state.requests.length > MAX_PENDING_REQUESTS) {
            await this.messageService.error(`R-IDE cannot queue more than ${MAX_PENDING_REQUESTS} file-open requests.`);
            return false;
        }
        let serialized: string;
        try {
            serialized = JSON.stringify(state);
        } catch (error) {
            await this.messageService.error(`R-IDE could not serialize file-open state: ${errorMessage(error)}`);
            return false;
        }
        if (serialized.length > MAX_STATE_CHARS) {
            await this.messageService.error('R-IDE could not save an oversized file-open state.');
            return false;
        }
        try {
            this.storage.setItem(RIDE_OPEN_REQUEST_STATE_KEY, serialized);
        } catch (error) {
            await this.messageService.error(`R-IDE could not save file-open state: ${errorMessage(error)}`);
            return false;
        }
        return true;
    }

    protected async dispatchPendingRequests(initialState: RideOpenRequestState): Promise<void> {
        let state = initialState;
        while (state.requests.length > 0) {
            const request = state.requests[0];
            if (!this.isCurrentWorkspace(request.workspace)) {
                try {
                    this.workspaceService.open(FileUri.create(request.workspace), { preserveWindow: true });
                } catch (error) {
                    await this.messageService.error(`R-IDE could not switch workspace: ${errorMessage(error)}`);
                }
                return;
            }

            const nextState: RideOpenRequestState = {
                ...state,
                requests: state.requests.slice(1)
            };
            if (!await this.commitState(nextState)) {
                return;
            }
            await this.openFiles(request);
            state = nextState;
        }
    }

    protected validateRequest(payload: unknown): RideOpenRequest | undefined {
        if (!isRecord(payload)
            || !isCanonicalU64(payload.id)
            || !isRideOpenRequestSource(payload.source)
            || typeof payload.workspace !== 'string'
            || !isNonEmptyStringArray(payload.files)
            || payload.files.some(hasTrailingDirectorySeparator)) {
            return undefined;
        }

        const workspace = normalizeNativePath(payload.workspace);
        const files = payload.files.map(normalizeNativePath);
        const firstFile = files[0];
        if (!workspace || !firstFile || files.some(file => !file) || !isImmediateParentPath(workspace, firstFile)) {
            return undefined;
        }

        return {
            id: payload.id,
            source: payload.source,
            workspace: workspace.fileSystemPath,
            files: files.map(file => file!.fileSystemPath)
        };
    }

    protected isCurrentWorkspace(workspacePath: string): boolean {
        const current = this.workspaceService.workspace?.resource;
        if (!current || current.scheme !== 'file') {
            return false;
        }
        const requestedWorkspace = normalizeNativePath(workspacePath);
        const currentWorkspace = requestedWorkspace
            ? normalizeNativePath(requestedWorkspace.windows ? FileUri.fsPath(current) : current.path.toString())
            : undefined;
        return !!requestedWorkspace
            && !!currentWorkspace
            && requestedWorkspace.windows === currentWorkspace.windows
            && requestedWorkspace.comparisonPath === currentWorkspace.comparisonPath;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && !!value && !Array.isArray(value);
}

function isRideOpenRequestSource(value: unknown): value is RideOpenRequestSource {
    return value === 'initial' || value === 'singleInstance' || value === 'openedUrl';
}

function isNonEmptyStringArray(value: unknown): value is string[] {
    if (!Array.isArray(value) || value.length === 0) {
        return false;
    }
    for (let index = 0; index < value.length; index++) {
        if (typeof value[index] !== 'string') {
            return false;
        }
    }
    return true;
}

function isCanonicalU64(value: unknown): value is string {
    return typeof value === 'string'
        && /^[1-9][0-9]*$/.test(value)
        && (value.length < MAX_U64_ID.length
            || value.length === MAX_U64_ID.length && value <= MAX_U64_ID);
}

function compareDecimalIds(left: string, right: string): number {
    return left.length === right.length ? left.localeCompare(right) : left.length - right.length;
}

function hasTrailingDirectorySeparator(value: string): boolean {
    return value.endsWith('/') || value.endsWith('\\') && isFullyQualifiedWindowsPath(value);
}

function isFullyQualifiedWindowsPath(value: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(value)
        || /^\\\\/.test(value)
        || /^\/\/(?:\?\/|[^/]+\/[^/]+(?:\/|$))/.test(value);
}

function normalizeNativePath(value: string): NormalizedNativePath | undefined {
    if (!value || /[\0-\x1f]/.test(value)) {
        return undefined;
    }
    if (/^\\(?!\\)/.test(value)) {
        return undefined;
    }

    const windows = isFullyQualifiedWindowsPath(value);
    let normalized = windows ? value.replace(/\\/g, '/') : value;
    if (/^\/\/\?\/UNC\//i.test(normalized)) {
        normalized = `//${normalized.slice(8)}`;
    } else if (/^\/\/\?\/[A-Za-z]:\//.test(normalized)) {
        normalized = normalized.slice(4);
    }
    if (/^[A-Za-z]:\/+$/i.test(normalized)) {
        normalized = `${normalized.slice(0, 2)}/`;
    }

    if (windows) {
        if (!/^[A-Za-z]:\//.test(normalized) && !/^\/\/[^/]+\/[^/]+(?:\/|$)/.test(normalized)) {
            return undefined;
        }
    } else if (!normalized.startsWith('/') || normalized.startsWith('//')) {
        return undefined;
    }

    const isDriveRoot = windows && /^[a-zA-Z]:\/$/.test(normalized);
    const rootLength = isDriveRoot ? 3 : normalized === '/' ? 1 : 0;
    while (normalized.length > rootLength && normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }
    const pathSegments = normalized === '/' || isDriveRoot ? [] : normalized.replace(/^\/\/?/, '').split('/');
    if (pathSegments.some(segment => !segment || segment === '.' || segment === '..')) {
        return undefined;
    }

    return {
        comparisonPath: windows ? normalized.toLowerCase() : normalized,
        fileSystemPath: normalized,
        windows
    };
}

function isImmediateParentPath(parent: NormalizedNativePath, child: NormalizedNativePath): boolean {
    if (parent.windows !== child.windows) {
        return false;
    }
    const prefix = parent.comparisonPath.endsWith('/') ? parent.comparisonPath : `${parent.comparisonPath}/`;
    const relativePath = child.comparisonPath.slice(prefix.length);
    return child.comparisonPath.startsWith(prefix) && !!relativePath && !relativePath.includes('/');
}

function hasWidgetId(value: object | undefined): value is { id: string } {
    return !!value && 'id' in value && typeof value.id === 'string';
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function reportRideStartupMilestone(milestone: RideStartupMilestone): Promise<void> {
    if (typeof window !== 'object' || !isTauriRuntime()) {
        return;
    }
    await invoke('ride_record_startup_milestone', { milestone });
}

function observePluginPromise(promise: Promise<void>): Promise<ObservedPluginPromise> {
    return promise.then<ObservedPluginPromise, ObservedPluginPromise>(
        () => ({ succeeded: true }),
        error => ({ succeeded: false, error })
    );
}
