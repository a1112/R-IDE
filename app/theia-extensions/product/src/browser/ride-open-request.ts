/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { open } from '@theia/core/lib/browser/opener-service';
import type { OpenerService } from '@theia/core/lib/browser/opener-service';
import type { Disposable } from '@theia/core/lib/common/disposable';
import { FileUri } from '@theia/core/lib/common/file-uri';
import type { MessageService } from '@theia/core/lib/common/message-service';
import type { WorkspaceService } from '@theia/workspace/lib/browser';
import type { RideNativeChrome } from './ride-native-chrome';

const MAX_U64_ID = '18446744073709551615';

export const RIDE_OPEN_REQUEST_PENDING_KEY = 'r-ide.open-request.pending.v1';
export const RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY = 'r-ide.open-request.last-consumed.v1';

export type RideOpenRequestSource = 'initial' | 'singleInstance' | 'openedUrl';

export interface RideOpenRequest {
    id: string;
    source: RideOpenRequestSource;
    workspace: string;
    files: string[];
}

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

    constructor(
        protected readonly workspaceService: WorkspaceService,
        protected readonly openerService: OpenerService,
        protected readonly messageService: MessageService,
        protected readonly shell: ApplicationShell,
        protected readonly nativeChrome: RideNativeChrome,
        storage?: Storage
    ) {
        this.storage = storage ?? window.sessionStorage;
    }

    async onStart(): Promise<void> {
        if (this.started || this.disposed) {
            return;
        }
        this.started = true;
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

        const previousId = this.readLastConsumedId();
        if (previousId && compareDecimalIds(request.id, previousId) <= 0) {
            return;
        }
        this.storage.setItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY, request.id);

        if (!this.isCurrentWorkspace(request.workspace)) {
            this.storage.setItem(RIDE_OPEN_REQUEST_PENDING_KEY, JSON.stringify(request));
            try {
                this.workspaceService.open(FileUri.create(request.workspace), { preserveWindow: true });
            } catch (error) {
                this.storage.removeItem(RIDE_OPEN_REQUEST_PENDING_KEY);
                if (previousId) {
                    this.storage.setItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY, previousId);
                } else {
                    this.storage.removeItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY);
                }
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

        const serialized = this.storage.getItem(RIDE_OPEN_REQUEST_PENDING_KEY) ?? undefined;
        if (serialized === undefined) {
            return;
        }
        this.storage.removeItem(RIDE_OPEN_REQUEST_PENDING_KEY);

        let payload: unknown;
        try {
            payload = JSON.parse(serialized);
        } catch {
            await this.messageService.error('R-IDE discarded a corrupt pending file-open request.');
            return;
        }
        const request = this.validateRequest(payload);
        if (!request) {
            await this.messageService.error('R-IDE discarded an invalid pending file-open request.');
            return;
        }

        const previousId = this.storage.getItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY) ?? undefined;
        if (!isCanonicalU64(previousId) || previousId !== request.id) {
            await this.messageService.error('R-IDE discarded an unauthorized pending file-open request.');
            return;
        }
        if (!this.isCurrentWorkspace(request.workspace)) {
            await this.messageService.error('R-IDE discarded a pending file-open request for a different workspace.');
            return;
        }

        await this.openFiles(request);
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
        for (const [index, file] of request.files.entries()) {
            try {
                const opened = await open(this.openerService, FileUri.create(file), {
                    activate: index === request.files.length - 1,
                    preview: false,
                    reveal: true
                } as never);
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
    }

    protected validateRequest(payload: unknown): RideOpenRequest | undefined {
        if (!isRecord(payload)
            || !isCanonicalU64(payload.id)
            || !isRideOpenRequestSource(payload.source)
            || typeof payload.workspace !== 'string'
            || !isNonEmptyStringArray(payload.files)
            || payload.files.some(file => /[\\/]$/.test(file))) {
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

    protected readLastConsumedId(): string | undefined {
        const id = this.storage.getItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY) ?? undefined;
        if (isCanonicalU64(id)) {
            return id;
        }
        if (id !== undefined) {
            this.storage.removeItem(RIDE_OPEN_REQUEST_LAST_CONSUMED_KEY);
        }
        return undefined;
    }

    protected isCurrentWorkspace(workspacePath: string): boolean {
        const current = this.workspaceService.workspace?.resource;
        if (!current || current.scheme !== 'file') {
            return false;
        }
        const requestedWorkspace = normalizeNativePath(workspacePath);
        const currentWorkspace = normalizeNativePath(FileUri.fsPath(current));
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

function normalizeNativePath(value: string): NormalizedNativePath | undefined {
    if (!value || value !== value.trim() || /[\0-\x1f]/.test(value)) {
        return undefined;
    }

    let normalized = value.replace(/\\/g, '/');
    if (/^\/\/\?\/UNC\//i.test(normalized)) {
        normalized = `//${normalized.slice(8)}`;
    } else if (/^\/\/\?\/[A-Za-z]:\//.test(normalized)) {
        normalized = normalized.slice(4);
    }

    let windows = false;
    if (/^[A-Za-z]:\//.test(normalized)) {
        windows = true;
    } else if (/^\/\/[^/]+\/[^/]+(?:\/|$)/.test(normalized)) {
        windows = true;
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
