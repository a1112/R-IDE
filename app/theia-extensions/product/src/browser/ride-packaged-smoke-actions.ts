/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { OS } from '@theia/core/lib/common/os';
import URI from '@theia/core/lib/common/uri';
import type { Disposable } from '@theia/core/lib/common/disposable';
import type { RidePackagedSmokeActions, RideSmokePlan } from './ride-packaged-smoke';

export const RIDE_SMOKE_EDITOR_MARKER = 'RIDE_PACKAGED_SMOKE_EDITOR_MARKER';
export const RIDE_SMOKE_TERMINAL_SENTINEL = '.ride-smoke-terminal-ok';
export const RIDE_SMOKE_WINDOWS_COMMAND = "New-Item -ItemType File -Force '.ride-smoke-terminal-ok' | Out-Null\r\n";
export const RIDE_SMOKE_UNIX_COMMAND = ": > '.ride-smoke-terminal-ok'\n";

interface WorkspaceRootLike {
    readonly resource: URI;
}

interface WorkspaceServiceLike {
    readonly roots: Promise<readonly WorkspaceRootLike[]>;
}

interface EditorDocumentLike {
    getText(): string;
    positionAt(offset: number): { line: number; character: number };
    save(): void | PromiseLike<void>;
}

interface EditorLike {
    readonly uri: URI;
    readonly document: EditorDocumentLike;
    replaceText(request: {
        source: string;
        replaceOperations: Array<{
            range: {
                start: { line: number; character: number };
                end: { line: number; character: number };
            };
            text: string;
        }>;
    }): Promise<boolean>;
}

interface EditorManagerLike {
    readonly activeEditor: { readonly editor: EditorLike } | undefined;
}

interface FileServiceLike {
    read(uri: URI): Promise<{ readonly value: string }>;
    exists(uri: URI): Promise<boolean>;
}

interface TerminalWidgetLike extends Disposable {
    start(): Promise<number>;
    sendText(text: string): void;
}

interface TerminalServiceLike {
    newTerminal(options: {
        readonly title: string;
        readonly cwd: URI;
        readonly shellPath: string;
        readonly shellArgs: string[];
        readonly destroyTermOnClose: boolean;
        readonly hideFromUser: boolean;
        readonly isTransient: boolean;
        readonly kind: string;
    }): Promise<TerminalWidgetLike>;
}

interface SearchResultLike {
    readonly root: string;
    readonly fileUri: string;
    readonly matches: readonly unknown[];
}

interface SearchCallbacksLike {
    onResult(searchId: number, result: SearchResultLike): void;
    onDone(searchId: number, error?: string): void;
}

interface SearchServiceLike {
    searchWithCallback(
        what: string,
        rootUris: string[],
        callbacks: SearchCallbacksLike,
        options: { readonly matchCase: boolean; readonly maxResults: number }
    ): Promise<number>;
    cancel(searchId: number): void;
}

interface ScmServiceLike {
    readonly repositories: ReadonlyArray<{
        readonly provider: {
            readonly rootUri: string;
            readonly groups: ReadonlyArray<{
                readonly resources: ReadonlyArray<{ readonly sourceUri: { toString(): string } }>;
            }>;
        };
    }>;
}

export interface RidePackagedSmokeActionServices {
    readonly workspaceService?: WorkspaceServiceLike;
    readonly editorManager?: EditorManagerLike;
    readonly fileService?: FileServiceLike;
    readonly terminalService?: TerminalServiceLike;
    readonly searchService?: SearchServiceLike;
    readonly scmService?: ScmServiceLike;
    readonly backendIsWindows?: boolean;
    readonly pollIntervalMs?: number;
    readonly pollTimeoutMs?: number;
    readonly now?: () => number;
    readonly setTimeout?: (callback: () => void, timeoutMs: number) => unknown;
    readonly clearTimeout?: (handle: unknown) => void;
}

type SafeErrorMessage =
    | 'Smoke action unavailable.'
    | 'Smoke action failed.'
    | 'Smoke action timed out.'
    | 'Smoke action disposed.'
    | 'Smoke action not ready.';

class RideSmokeActionError extends Error {
    constructor(message: SafeErrorMessage) {
        super(message);
    }
}

export class RidePackagedSmokeActionService implements RidePackagedSmokeActions, Disposable {
    protected readonly backendIsWindows: boolean;
    protected readonly pollIntervalMs: number;
    protected readonly pollTimeoutMs: number;
    protected readonly now: () => number;
    protected readonly scheduleTimeout: (callback: () => void, timeoutMs: number) => unknown;
    protected readonly cancelTimeout: (handle: unknown) => void;
    protected readonly activeCancellations = new Set<() => void>();
    protected disposed = false;

    constructor(protected readonly services: RidePackagedSmokeActionServices) {
        this.backendIsWindows = services.backendIsWindows ?? OS.backend.isWindows;
        this.pollIntervalMs = services.pollIntervalMs ?? 100;
        this.pollTimeoutMs = services.pollTimeoutMs ?? 5_000;
        this.now = services.now ?? (() => Date.now());
        this.scheduleTimeout = services.setTimeout ?? ((callback, timeoutMs) => globalThis.setTimeout(callback, timeoutMs));
        this.cancelTimeout = services.clearTimeout ?? (handle => globalThis.clearTimeout(
            handle as ReturnType<typeof globalThis.setTimeout>
        ));
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        for (const cancel of [...this.activeCancellations]) {
            cancel();
        }
        this.activeCancellations.clear();
    }

    editorSave(plan: RideSmokePlan): Promise<void> {
        return this.runSafely(async () => {
            const { expectedFile } = await this.resolveWorkspace(plan);
            const editorManager = this.requireService(this.services.editorManager);
            const fileService = this.requireService(this.services.fileService);
            const editor = editorManager.activeEditor?.editor;
            if (!editor || !this.uriEquals(editor.uri, expectedFile)) {
                throw this.error('Smoke action unavailable.');
            }
            this.ensureActive();
            const content = editor.document.getText();
            const end = editor.document.positionAt(content.length);
            const markerAppend = `\n# ${RIDE_SMOKE_EDITOR_MARKER}\n`;
            const changed = await editor.replaceText({
                source: 'ride-packaged-smoke',
                replaceOperations: [{
                    range: { start: end, end },
                    text: markerAppend
                }]
            });
            if (!changed) {
                throw this.error('Smoke action failed.');
            }
            this.ensureActive();
            const editedContent = editor.document.getText();
            if (editedContent.length <= content.length
                || this.markerCount(editedContent) <= this.markerCount(content)) {
                throw this.error('Smoke action failed.');
            }
            await editor.document.save();
            this.ensureActive();
            const persisted = await fileService.read(expectedFile);
            if (persisted.value !== editedContent) {
                throw this.error('Smoke action failed.');
            }
        });
    }

    terminalSentinel(plan: RideSmokePlan): Promise<void> {
        return this.runSafely(async () => {
            const { root } = await this.resolveWorkspace(plan);
            const terminalService = this.requireService(this.services.terminalService);
            const fileService = this.requireService(this.services.fileService);
            const sentinel = this.resolveRelative(root, RIDE_SMOKE_TERMINAL_SENTINEL);
            const windows = this.backendIsWindows;
            let terminal: TerminalWidgetLike | undefined;
            let terminalDisposed = false;
            let retired = false;
            const disposeTerminal = (candidate: TerminalWidgetLike | undefined): void => {
                if (!candidate || terminalDisposed) {
                    return;
                }
                terminalDisposed = true;
                try {
                    candidate.dispose();
                } catch {
                    // Cleanup failures must not expose implementation details or replace the terminal outcome.
                }
            };
            const retire = (): void => {
                retired = true;
                disposeTerminal(terminal);
            };
            try {
                await this.withDeadline(async () => {
                    const creation = Promise.resolve(terminalService.newTerminal({
                        title: 'R-IDE Smoke',
                        cwd: root,
                        shellPath: windows ? 'powershell.exe' : '/bin/sh',
                        shellArgs: windows ? ['-NoLogo', '-NoProfile', '-NonInteractive'] : [],
                        destroyTermOnClose: true,
                        hideFromUser: true,
                        isTransient: true,
                        kind: 'ride-smoke'
                    }));
                    creation.then(
                        candidate => {
                            if (retired) {
                                disposeTerminal(candidate);
                            }
                        },
                        () => undefined
                    );
                    const created = await creation;
                    terminal = created;
                    if (retired) {
                        disposeTerminal(created);
                        return;
                    }
                    await Promise.resolve(created.start());
                    if (retired) {
                        return;
                    }
                    this.ensureActive();
                    created.sendText(windows ? RIDE_SMOKE_WINDOWS_COMMAND : RIDE_SMOKE_UNIX_COMMAND);
                    while (!retired) {
                        if (await fileService.exists(sentinel)) {
                            return;
                        }
                        if (!retired) {
                            await this.delay(this.pollIntervalMs);
                        }
                    }
                }, plan.actionTimeoutMs, retire);
            } finally {
                retire();
            }
        });
    }

    workspaceSearch(plan: RideSmokePlan): Promise<void> {
        return this.runSafely(async () => {
            const { root, expectedFile } = await this.resolveWorkspace(plan);
            const searchService = this.requireService(this.services.searchService);
            await this.waitForSearch(searchService, root, expectedFile, plan.actionTimeoutMs);
        });
    }

    scmStatus(plan: RideSmokePlan): Promise<void> {
        return this.runSafely(async () => {
            const { root, expectedFile } = await this.resolveWorkspace(plan);
            const scmService = this.requireService(this.services.scmService);
            const repository = scmService.repositories.find(candidate => {
                try {
                    return this.uriEquals(new URI(candidate.provider.rootUri), root);
                } catch {
                    return false;
                }
            });
            if (!repository) {
                throw this.error('Smoke action unavailable.');
            }
            await this.pollUntil(async () => repository.provider.groups.some(group =>
                group.resources.some(resource => {
                    try {
                        return this.uriEquals(new URI(resource.sourceUri.toString()), expectedFile);
                    } catch {
                        return false;
                    }
                })
            ), plan.actionTimeoutMs);
        });
    }

    async packagedPluginCommand(_plan: RideSmokePlan): Promise<void> {
        this.ensureActive();
        throw this.error('Smoke action not ready.');
    }

    async secondaryWindow(_plan: RideSmokePlan): Promise<void> {
        this.ensureActive();
        throw this.error('Smoke action not ready.');
    }

    async waitForSecondFile(_plan: RideSmokePlan): Promise<void> {
        this.ensureActive();
        throw this.error('Smoke action not ready.');
    }

    protected async resolveWorkspace(plan: RideSmokePlan): Promise<{ root: URI; expectedFile: URI }> {
        this.ensureActive();
        if (plan.workspace !== '.') {
            throw this.error('Smoke action unavailable.');
        }
        const workspaceService = this.requireService(this.services.workspaceService);
        const roots = await workspaceService.roots;
        this.ensureActive();
        if (roots.length !== 1 || roots[0].resource.scheme !== 'file'
            || !!roots[0].resource.query || !!roots[0].resource.fragment) {
            throw this.error('Smoke action unavailable.');
        }
        const root = roots[0].resource.normalizePath().withoutQuery().withoutFragment();
        const firstFile = plan.files[0];
        if (!firstFile) {
            throw this.error('Smoke action unavailable.');
        }
        return { root, expectedFile: this.resolveRelative(root, firstFile) };
    }

    protected resolveRelative(root: URI, relative: string): URI {
        if (!relative || relative.includes('\\') || relative.startsWith('/') || /^[A-Za-z]:/u.test(relative)) {
            throw this.error('Smoke action unavailable.');
        }
        const segments = relative.split('/');
        if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
            throw this.error('Smoke action unavailable.');
        }
        const resolved = root.resolve(relative).normalizePath().withoutQuery().withoutFragment();
        if (!root.isEqualOrParent(resolved, !this.backendIsWindows)) {
            throw this.error('Smoke action unavailable.');
        }
        return resolved;
    }

    protected uriEquals(left: URI, right: URI): boolean {
        return left.normalizePath().isEqual(
            right.normalizePath(),
            !this.backendIsWindows
        );
    }

    protected markerCount(content: string): number {
        return content.split(RIDE_SMOKE_EDITOR_MARKER).length - 1;
    }

    protected async waitForSearch(
        searchService: SearchServiceLike,
        root: URI,
        expectedFile: URI,
        actionTimeoutMs: number
    ): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            let found = false;
            let searchId: number | undefined;
            let cancelRequested = false;
            let searchCancelled = false;
            let timer: unknown;
            const cancelSearch = (): void => {
                if (!cancelRequested || searchCancelled || searchId === undefined) {
                    return;
                }
                searchCancelled = true;
                try {
                    searchService.cancel(searchId);
                } catch {
                    // Cancellation is best-effort after the promise has settled.
                }
            };
            const settle = (error?: RideSmokeActionError): void => {
                if (settled) {
                    return;
                }
                settled = true;
                this.activeCancellations.delete(cancel);
                if (timer !== undefined) {
                    try {
                        this.cancelTimeout(timer);
                    } catch {
                        // Timer cleanup must not replace the bounded action result.
                    }
                }
                if (error) {
                    cancelRequested = true;
                    cancelSearch();
                }
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };
            const cancel = (): void => settle(this.error('Smoke action disposed.'));
            this.activeCancellations.add(cancel);
            try {
                timer = this.scheduleTimeout(
                    () => settle(this.error('Smoke action timed out.')),
                    this.effectiveTimeout(actionTimeoutMs)
                );
            } catch {
                settle(this.error('Smoke action failed.'));
                return;
            }
            const callbacks: SearchCallbacksLike = {
                onResult: (_id, result) => {
                    if (settled || !result.matches.length) {
                        return;
                    }
                    try {
                        const resultRoot = new URI(result.root);
                        const resultFile = new URI(result.fileUri);
                        found ||= this.uriEquals(resultRoot, root)
                            && root.isEqualOrParent(resultFile, !this.backendIsWindows)
                            && this.uriEquals(resultFile, expectedFile);
                    } catch {
                        // Malformed or external result URIs are not accepted.
                    }
                },
                onDone: (_id, error) => settle(error || !found ? this.error('Smoke action failed.') : undefined)
            };
            Promise.resolve(searchService.searchWithCallback(
                RIDE_SMOKE_EDITOR_MARKER,
                [root.toString()],
                callbacks,
                { matchCase: true, maxResults: 20 }
            )).then(
                id => {
                    searchId = id;
                    cancelSearch();
                },
                () => settle(this.error('Smoke action failed.'))
            );
        });
    }

    protected async pollUntil(predicate: () => Promise<boolean>, actionTimeoutMs: number): Promise<void> {
        const timeout = this.effectiveTimeout(actionTimeoutMs);
        const deadline = this.now() + timeout;
        while (true) {
            this.ensureActive();
            if (await predicate()) {
                return;
            }
            this.ensureActive();
            if (this.now() >= deadline) {
                throw this.error('Smoke action timed out.');
            }
            await this.delay(Math.min(this.pollIntervalMs, Math.max(1, deadline - this.now())));
        }
    }

    protected withDeadline<T>(
        operation: () => Promise<T>,
        actionTimeoutMs: number,
        onAbort: () => void
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            let settled = false;
            let timerAssigned = false;
            let timer: unknown;
            const clearTimer = (): void => {
                if (!timerAssigned) {
                    return;
                }
                try {
                    this.cancelTimeout(timer);
                } catch {
                    // Timer cleanup must not prevent settlement.
                }
            };
            const finish = (value?: T, error?: RideSmokeActionError): void => {
                if (settled) {
                    return;
                }
                settled = true;
                this.activeCancellations.delete(cancel);
                clearTimer();
                if (error) {
                    reject(error);
                } else {
                    resolve(value as T);
                }
            };
            const abort = (error: RideSmokeActionError): void => {
                if (settled) {
                    return;
                }
                try {
                    onAbort();
                } finally {
                    finish(undefined, error);
                }
            };
            const cancel = (): void => abort(this.error('Smoke action disposed.'));
            this.activeCancellations.add(cancel);
            try {
                timer = this.scheduleTimeout(
                    () => abort(this.error('Smoke action timed out.')),
                    this.effectiveTimeout(actionTimeoutMs)
                );
                timerAssigned = true;
                if (settled) {
                    clearTimer();
                }
            } catch {
                abort(this.error('Smoke action failed.'));
            }
            if (settled) {
                return;
            }
            Promise.resolve().then(operation).then(
                value => finish(value),
                () => finish(undefined, this.error('Smoke action failed.'))
            );
        });
    }

    protected delay(timeoutMs: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            let handle: unknown;
            const finish = (error?: RideSmokeActionError): void => {
                if (settled) {
                    return;
                }
                settled = true;
                this.activeCancellations.delete(cancel);
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };
            const cancel = (): void => {
                if (handle !== undefined) {
                    try {
                        this.cancelTimeout(handle);
                    } catch {
                        // The promise is still settled below.
                    }
                }
                finish(this.error('Smoke action disposed.'));
            };
            this.activeCancellations.add(cancel);
            try {
                handle = this.scheduleTimeout(() => finish(), timeoutMs);
            } catch {
                finish(this.error('Smoke action failed.'));
            }
        });
    }

    protected effectiveTimeout(actionTimeoutMs: number): number {
        return Math.max(1, Math.min(this.pollTimeoutMs, actionTimeoutMs));
    }

    protected requireService<T>(service: T | undefined): T {
        if (service === undefined) {
            throw this.error('Smoke action unavailable.');
        }
        return service;
    }

    protected ensureActive(): void {
        if (this.disposed) {
            throw this.error('Smoke action disposed.');
        }
    }

    protected error(message: SafeErrorMessage): RideSmokeActionError {
        return new RideSmokeActionError(message);
    }

    protected async runSafely(operation: () => Promise<void>): Promise<void> {
        this.ensureActive();
        try {
            await operation();
        } catch (error) {
            if (error instanceof RideSmokeActionError) {
                throw error;
            }
            throw this.error('Smoke action failed.');
        }
    }
}
