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

interface RideSmokeActionRun {
    readonly aborted: boolean;
    assertActive(): void;
    wait<T>(value: PromiseLike<T> | T): Promise<T>;
    delay(timeoutMs: number): Promise<void>;
    onAbort(callback: () => void): () => void;
}

export class RidePackagedSmokeActionService implements RidePackagedSmokeActions, Disposable {
    protected readonly backendIsWindows: boolean;
    protected readonly pollIntervalMs: number;
    protected readonly pollTimeoutMs: number;
    protected readonly scheduleTimeout: (callback: () => void, timeoutMs: number) => unknown;
    protected readonly cancelTimeout: (handle: unknown) => void;
    protected readonly activeCancellations = new Set<() => void>();
    protected disposed = false;

    constructor(protected readonly services: RidePackagedSmokeActionServices) {
        this.backendIsWindows = services.backendIsWindows ?? OS.backend.isWindows;
        this.pollIntervalMs = services.pollIntervalMs ?? 100;
        this.pollTimeoutMs = services.pollTimeoutMs ?? 5_000;
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
        return this.runAction(plan, async run => {
            const root = await this.resolveWorkspaceRoot(plan, run);
            const expectedFile = this.resolveExpectedFile(plan, root);
            const editorManager = this.requireService(this.services.editorManager);
            const fileService = this.requireService(this.services.fileService);
            run.assertActive();
            const editor = editorManager.activeEditor?.editor;
            if (!editor || !this.uriEquals(editor.uri, expectedFile)) {
                throw this.error('Smoke action unavailable.');
            }
            run.assertActive();
            const content = editor.document.getText();
            const end = editor.document.positionAt(content.length);
            const eol = content.includes('\r\n') ? '\r\n' : '\n';
            const markerAppend = `${content && !content.endsWith('\n') ? eol : ''}# ${RIDE_SMOKE_EDITOR_MARKER}${eol}`;
            const expectedContent = content + markerAppend;
            run.assertActive();
            const changed = await run.wait(editor.replaceText({
                source: 'ride-packaged-smoke',
                replaceOperations: [{
                    range: { start: end, end },
                    text: markerAppend
                }]
            }));
            if (!changed) {
                throw this.error('Smoke action failed.');
            }
            run.assertActive();
            const editedContent = editor.document.getText();
            if (editedContent !== expectedContent
                || !editedContent.startsWith(content)
                || !editedContent.endsWith(markerAppend)
                || this.markerCount(editedContent) !== this.markerCount(content) + 1) {
                throw this.error('Smoke action failed.');
            }
            run.assertActive();
            await run.wait(editor.document.save());
            run.assertActive();
            const persisted = await run.wait(fileService.read(expectedFile));
            if (persisted.value !== editedContent) {
                throw this.error('Smoke action failed.');
            }
        });
    }

    terminalSentinel(plan: RideSmokePlan): Promise<void> {
        return this.runAction(plan, async run => {
            const root = await this.resolveWorkspaceRoot(plan, run);
            const terminalService = this.requireService(this.services.terminalService);
            const fileService = this.requireService(this.services.fileService);
            const sentinel = this.resolveRelative(root, RIDE_SMOKE_TERMINAL_SENTINEL);
            const windows = this.backendIsWindows;
            let terminal: TerminalWidgetLike | undefined;
            let terminalDisposed = false;
            let lateStartCleanupDone = false;
            const tryDisposeTerminal = (candidate: TerminalWidgetLike): void => {
                try {
                    candidate.dispose();
                } catch {
                    // Cleanup failures must not expose implementation details or replace the terminal outcome.
                }
            };
            const disposeTerminal = (candidate: TerminalWidgetLike | undefined): void => {
                if (!candidate || terminalDisposed) {
                    return;
                }
                terminalDisposed = true;
                tryDisposeTerminal(candidate);
            };
            const disposeAfterLateStart = (candidate: TerminalWidgetLike): void => {
                if (lateStartCleanupDone) {
                    return;
                }
                lateStartCleanupDone = true;
                tryDisposeTerminal(candidate);
            };
            const stopOnAbort = run.onAbort(() => disposeTerminal(terminal));
            try {
                run.assertActive();
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
                        if (run.aborted) {
                            disposeTerminal(candidate);
                        }
                    },
                    () => undefined
                );
                terminal = await run.wait(creation);
                run.assertActive();
                const startedTerminal = terminal;
                const start = Promise.resolve(startedTerminal.start());
                start.then(
                    () => {
                        if (run.aborted) {
                            disposeAfterLateStart(startedTerminal);
                        }
                    },
                    () => undefined
                );
                await run.wait(start);
                run.assertActive();
                terminal.sendText(windows ? RIDE_SMOKE_WINDOWS_COMMAND : RIDE_SMOKE_UNIX_COMMAND);
                while (true) {
                    run.assertActive();
                    if (await run.wait(fileService.exists(sentinel))) {
                        return;
                    }
                    await run.delay(this.pollIntervalMs);
                }
            } finally {
                stopOnAbort();
                disposeTerminal(terminal);
            }
        });
    }

    workspaceSearch(plan: RideSmokePlan): Promise<void> {
        return this.runAction(plan, async run => {
            const root = await this.resolveWorkspaceRoot(plan, run);
            const expectedFile = this.resolveExpectedFile(plan, root);
            const searchService = this.requireService(this.services.searchService);
            await this.waitForSearch(searchService, root, expectedFile, run);
        });
    }

    scmStatus(plan: RideSmokePlan): Promise<void> {
        return this.runAction(plan, async run => {
            const root = await this.resolveWorkspaceRoot(plan, run);
            const expectedFile = this.resolveExpectedFile(plan, root);
            const scmService = this.requireService(this.services.scmService);
            while (true) {
                run.assertActive();
                const repository = scmService.repositories.find(candidate => {
                    try {
                        return this.uriEquals(new URI(candidate.provider.rootUri), root);
                    } catch {
                        return false;
                    }
                });
                if (repository?.provider.groups.some(group =>
                    group.resources.some(resource => {
                        try {
                            return this.uriEquals(new URI(resource.sourceUri.toString()), expectedFile);
                        } catch {
                            return false;
                        }
                    })
                )) {
                    return;
                }
                await run.delay(this.pollIntervalMs);
            }
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

    protected async resolveWorkspaceRoot(plan: RideSmokePlan, run: RideSmokeActionRun): Promise<URI> {
        run.assertActive();
        if (plan.workspace !== '.') {
            throw this.error('Smoke action unavailable.');
        }
        const workspaceService = this.requireService(this.services.workspaceService);
        const roots = await run.wait(workspaceService.roots);
        if (roots.length !== 1 || roots[0].resource.scheme !== 'file'
            || !!roots[0].resource.query || !!roots[0].resource.fragment) {
            throw this.error('Smoke action unavailable.');
        }
        return roots[0].resource.normalizePath().withoutQuery().withoutFragment();
    }

    protected resolveExpectedFile(plan: RideSmokePlan, root: URI): URI {
        const firstFile = plan.files[0];
        if (!firstFile) {
            throw this.error('Smoke action unavailable.');
        }
        return this.resolveRelative(root, firstFile);
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
        run: RideSmokeActionRun
    ): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            let found = false;
            let searchId: number | undefined;
            let cancelRequested = false;
            let searchCancelled = false;
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
                stopOnAbort();
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
            let stopOnAbort = (): void => undefined;
            stopOnAbort = run.onAbort(() => settle(this.error('Smoke action disposed.')));
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
            run.assertActive();
            let search: Promise<number>;
            try {
                search = Promise.resolve(searchService.searchWithCallback(
                    RIDE_SMOKE_EDITOR_MARKER,
                    [root.toString()],
                    callbacks,
                    { matchCase: true, maxResults: 20 }
                ));
            } catch {
                settle(this.error('Smoke action failed.'));
                return;
            }
            search.then(
                id => {
                    searchId = id;
                    if (run.aborted) {
                        cancelRequested = true;
                    }
                    cancelSearch();
                },
                () => settle(this.error('Smoke action failed.'))
            );
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

    protected async runAction(
        plan: RideSmokePlan,
        operation: (run: RideSmokeActionRun) => Promise<void>
    ): Promise<void> {
        this.ensureActive();
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            let timerAssigned = false;
            let timer: unknown;
            let abortError: RideSmokeActionError | undefined;
            const abortCallbacks = new Set<() => void>();
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
            const finish = (error?: unknown): void => {
                if (settled) {
                    return;
                }
                settled = true;
                this.activeCancellations.delete(cancel);
                clearTimer();
                abortCallbacks.clear();
                if (error) {
                    reject(error instanceof RideSmokeActionError ? error : this.error('Smoke action failed.'));
                } else {
                    resolve();
                }
            };
            const abort = (error: RideSmokeActionError): void => {
                if (settled) {
                    return;
                }
                abortError = error;
                for (const callback of [...abortCallbacks]) {
                    try {
                        callback();
                    } catch {
                        // Cancellation is best-effort; the bounded result remains authoritative.
                    }
                }
                finish(error);
            };
            const cancel = (): void => abort(this.error('Smoke action disposed.'));
            const assertActive = (): void => {
                if (abortError) {
                    throw abortError;
                }
                this.ensureActive();
            };
            const onAbort = (callback: () => void): (() => void) => {
                if (abortError) {
                    try {
                        callback();
                    } catch {
                        // Cancellation is best-effort.
                    }
                    return () => undefined;
                }
                abortCallbacks.add(callback);
                return () => abortCallbacks.delete(callback);
            };
            const wait = <T>(value: PromiseLike<T> | T): Promise<T> => {
                const source = Promise.resolve(value);
                return new Promise<T>((resolveWait, rejectWait) => {
                    let waitSettled = false;
                    let stopWaiting = (): void => undefined;
                    const finishWait = (result?: T, error?: unknown): void => {
                        if (waitSettled) {
                            return;
                        }
                        waitSettled = true;
                        stopWaiting();
                        if (error) {
                            rejectWait(error);
                        } else {
                            try {
                                assertActive();
                                resolveWait(result as T);
                            } catch (activeError) {
                                rejectWait(activeError);
                            }
                        }
                    };
                    stopWaiting = onAbort(() => finishWait(undefined, abortError));
                    source.then(
                        result => finishWait(result),
                        error => finishWait(undefined, error)
                    );
                });
            };
            const delay = (timeoutMs: number): Promise<void> => {
                let handleAssigned = false;
                let handle: unknown;
                let delaySettled = false;
                return wait(new Promise<void>((resolveDelay, rejectDelay) => {
                    let stopDelay = (): void => undefined;
                    const finishDelay = (error?: unknown): void => {
                        if (delaySettled) {
                            return;
                        }
                        delaySettled = true;
                        stopDelay();
                        if (handleAssigned) {
                            try {
                                this.cancelTimeout(handle);
                            } catch {
                                // Timer cleanup must not prevent settlement.
                            }
                        }
                        if (error) {
                            rejectDelay(error);
                        } else {
                            resolveDelay();
                        }
                    };
                    stopDelay = onAbort(() => finishDelay(abortError));
                    try {
                        handle = this.scheduleTimeout(() => finishDelay(), Math.max(1, timeoutMs));
                        handleAssigned = true;
                        if (delaySettled) {
                            try {
                                this.cancelTimeout(handle);
                            } catch {
                                // Synchronous schedulers may settle before returning a handle.
                            }
                        }
                    } catch (error) {
                        finishDelay(error);
                    }
                }));
            };
            const run: RideSmokeActionRun = {
                get aborted(): boolean { return abortError !== undefined; },
                assertActive,
                wait,
                delay,
                onAbort
            };
            this.activeCancellations.add(cancel);
            try {
                timer = this.scheduleTimeout(
                    () => abort(this.error('Smoke action timed out.')),
                    this.effectiveTimeout(plan.actionTimeoutMs)
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
            Promise.resolve().then(() => operation(run)).then(
                () => finish(),
                error => finish(error)
            );
        });
    }
}
