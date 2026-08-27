/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Emitter, Event } from '@theia/core';
import {
    RideCodexAuthClient,
    RideCodexAuthSnapshot,
    RideCodexLoginRequest,
    RideCodexLoginResult,
    trustedRideCodexAuthNormalizers
} from '../common/ride-codex-auth';
import {
    RideCodexConversationsClient,
    RideCodexConversationsSnapshot,
    RideCodexModel,
    RideCodexModelListRequest,
    RideCodexModelPage,
    RideCodexReasoningEffort,
    RideCodexServiceTier,
    RideCodexThreadListRequest,
    RideCodexThreadPage,
    RideCodexThreadResumeRequest,
    RideCodexThreadStartRequest,
    RideCodexThreadSummary
} from '../common/ride-codex-conversations';
import {
    RideCodexApprovalCard,
    RideCodexApprovalDecision,
    RideCodexApprovalDecisionRequest,
    RideCodexApprovalDecisionResult,
    RideCodexApprovalContext,
    RideCodexFileApprovalChange
} from '../common/ride-codex-approvals';
import {
    RideCodexEventBatchWire,
    RideCodexTurnInterruptRequest,
    RideCodexTurnResult,
    RideCodexTurnSnapshot,
    RideCodexTurnStartRequest,
    RideCodexTurnSteerRequest
} from '../common/ride-codex-events';
import { mapRideCodexError, RideCodexMappedError } from './ride-codex-error-mapper';
import { RideCodexEventReducer, RideCodexFrameDisposable } from './ride-codex-event-reducer';

export interface RideCodexControlDisposable {
    dispose(): void;
}

export interface RideCodexControlAuthService {
    activate(): Promise<RideCodexAuthSnapshot>;
    status(): Promise<RideCodexAuthSnapshot>;
    login(request: RideCodexLoginRequest): Promise<RideCodexLoginResult>;
    cancelLogin(loginId: string): Promise<void>;
    logout(): Promise<RideCodexAuthSnapshot>;
    disconnectClient?(client: RideCodexAuthClient): void;
}

export interface RideCodexControlConversationsService {
    status(): Promise<RideCodexConversationsSnapshot>;
    listModels(options?: RideCodexModelListRequest): Promise<RideCodexModelPage>;
    listThreads(options?: RideCodexThreadListRequest): Promise<RideCodexThreadPage>;
    startThread(request: RideCodexThreadStartRequest): Promise<RideCodexThreadSummary>;
    resumeThread(request: RideCodexThreadResumeRequest): Promise<RideCodexThreadSummary>;
    readThread(threadId: string): Promise<RideCodexThreadSummary>;
    archiveThread(threadId: string): Promise<void>;
    selectThread(threadId: string | null): Promise<void>;
    disconnectClient?(client: RideCodexConversationsClient): void;
}

export interface RideCodexControlTurnService {
    startTurn(request: RideCodexTurnStartRequest): Promise<RideCodexTurnResult>;
    steerTurn(request: RideCodexTurnSteerRequest): Promise<RideCodexTurnResult>;
    interruptTurn(request: RideCodexTurnInterruptRequest): Promise<RideCodexTurnResult>;
    disconnectClient?(): void;
}

export interface RideCodexControlApprovalsService {
    setContext(context: RideCodexApprovalContext): Promise<void>;
    disposeContext(): Promise<void>;
    approvals(): Promise<readonly RideCodexApprovalCard[]>;
    decide(request: RideCodexApprovalDecisionRequest): Promise<RideCodexApprovalDecisionResult>;
}

export interface RideCodexControlServices {
    readonly auth: RideCodexControlAuthService;
    readonly conversations: RideCodexControlConversationsService;
    readonly turns: RideCodexControlTurnService;
    readonly approvals: RideCodexControlApprovalsService;
}

export type RideCodexControlPhase = 'loading' | 'ready' | 'auth-required' | 'error' | 'disposed';

export interface RideCodexControlSnapshot {
    readonly phase: RideCodexControlPhase;
    readonly auth: RideCodexAuthSnapshot;
    readonly conversations: RideCodexConversationsSnapshot;
    readonly models: readonly RideCodexModel[];
    readonly selectedModelId?: string;
    readonly selectedThreadId?: string;
    readonly approvals: readonly RideCodexApprovalCard[];
    readonly turn: RideCodexTurnSnapshot;
    readonly busy: boolean;
    readonly progress?: string;
    readonly error?: RideCodexMappedError;
}

export interface RideCodexControlModelOptions {
    readonly services: RideCodexControlServices;
    readonly workspaceRoot: string | (() => string | Promise<string>);
    readonly cwd?: string;
    readonly scheduleFrame?: (callback: () => void) => RideCodexControlDisposable;
    readonly onTurnEvents?: (listener: (wire: RideCodexEventBatchWire) => void) => RideCodexControlDisposable;
}

const EMPTY_AUTH: RideCodexAuthSnapshot = Object.freeze({ state: 'inactive' });
const EMPTY_CONVERSATIONS: RideCodexConversationsSnapshot = Object.freeze({
    generation: 0,
    threads: Object.freeze([]),
    persistedTranscriptCount: 0 as const
});
const EMPTY_TURN: RideCodexTurnSnapshot = Object.freeze({
    generation: 0,
    status: 'idle' as const,
    items: Object.freeze([]),
    warnings: Object.freeze([]),
    errors: Object.freeze([]),
    retainedBytes: 0
});
const MAX_MODELS = 100;
const MAX_THREADS = 500;
const MAX_APPROVALS = 128;
const MAX_PROMPT_LENGTH = 64 * 1024;

export class RideCodexControlModel {
    readonly #services: RideCodexControlServices;
    readonly #workspaceRoot: string | (() => string | Promise<string>);
    readonly #cwd: string | undefined;
    readonly #scheduleFrame: ((callback: () => void) => RideCodexControlDisposable) | undefined;
    readonly #onDidChangeEmitter = new Emitter<RideCodexControlSnapshot>();
    readonly #waiters = new Set<{
        readonly threadId: string;
        readonly turnId: string;
        readonly resolve: (result: RideCodexTurnResult) => void;
        readonly dispose: () => void;
    }>();
    readonly #turnEventsAttachment: RideCodexControlDisposable | undefined;
    #reducer: RideCodexEventReducer;
    #reducerAttachment: RideCodexFrameDisposable;
    #phase: RideCodexControlPhase = 'loading';
    #auth: RideCodexAuthSnapshot = EMPTY_AUTH;
    #conversations: RideCodexConversationsSnapshot = EMPTY_CONVERSATIONS;
    #models: readonly RideCodexModel[] = Object.freeze([]);
    #selectedModelId: string | undefined;
    #selectedThreadId: string | undefined;
    #approvals: readonly RideCodexApprovalCard[] = Object.freeze([]);
    #turn: RideCodexTurnSnapshot = EMPTY_TURN;
    #busy = false;
    #progress: string | undefined;
    #error: RideCodexMappedError | undefined;
    #initialization: Promise<void> | undefined;
    #disposed = false;

    constructor(options: RideCodexControlModelOptions) {
        if (!options.services || !options.services.auth || !options.services.conversations
            || !options.services.turns || !options.services.approvals) {
            throw new TypeError('Codex control services are required.');
        }
        this.#services = options.services;
        this.#workspaceRoot = options.workspaceRoot;
        this.#cwd = options.cwd;
        this.#scheduleFrame = options.scheduleFrame;
        this.#reducer = this.createReducer(options.scheduleFrame);
        this.#reducerAttachment = this.#reducer.onDidChange(snapshot => {
            this.#turn = snapshot;
            this.#resolveTurnWaiters(snapshot);
            this.emit();
        });
        this.#turnEventsAttachment = options.onTurnEvents?.(wire => this.notifyTurnEvents(wire));
    }

    get onDidChange(): Event<RideCodexControlSnapshot> {
        return this.#onDidChangeEmitter.event;
    }

    snapshot(): RideCodexControlSnapshot {
        return Object.freeze({
            phase: this.#phase,
            auth: this.#auth,
            conversations: this.#conversations,
            models: this.#models,
            ...(this.#selectedModelId === undefined ? {} : { selectedModelId: this.#selectedModelId }),
            ...(this.#selectedThreadId === undefined ? {} : { selectedThreadId: this.#selectedThreadId }),
            approvals: this.#approvals,
            turn: this.#turn,
            busy: this.#busy,
            ...(this.#progress === undefined ? {} : { progress: this.#progress }),
            ...(this.#error === undefined ? {} : { error: this.#error })
        });
    }

    async initialize(): Promise<void> {
        this.requireUsable();
        if (this.#initialization) {
            return this.#initialization;
        }
        this.#phase = 'loading';
        this.#error = undefined;
        this.emit();
        const operation = this.initializeOnce();
        this.#initialization = operation;
        operation.catch(() => undefined);
        return operation;
    }

    async retry(): Promise<void> {
        this.requireUsable();
        if (this.#phase === 'loading' && this.#initialization) {
            return this.#initialization;
        }
        this.#initialization = undefined;
        return this.initialize();
    }

    async login(request: RideCodexLoginRequest): Promise<RideCodexLoginResult> {
        this.requireUsable();
        this.setBusy(true, 'Signing in to Codex…');
        try {
            const result = await this.#services.auth.login(request);
            await this.refreshAuth(result.type === 'apiKey' ? 'ready' : 'auth-required');
            return result;
        } catch {
            this.setError('auth');
            throw new Error('Codex authentication could not be completed.');
        } finally {
            this.setBusy(false);
        }
    }

    async cancelLogin(): Promise<void> {
        this.requireUsable();
        const loginId = this.#auth.pendingLogin?.loginId;
        if (!loginId) {
            return;
        }
        try {
            await this.#services.auth.cancelLogin(loginId);
            await this.refreshAuth('auth-required');
        } catch {
            this.setError('auth');
        }
    }

    async logout(): Promise<void> {
        this.requireUsable();
        this.setBusy(true, 'Signing out…');
        try {
            this.#auth = normalizeAuthSnapshot(await this.#services.auth.logout());
            this.#selectedThreadId = undefined;
            this.#approvals = Object.freeze([]);
            await this.#services.approvals.disposeContext();
            this.resetTurnReducer();
            this.#phase = 'auth-required';
            this.#error = undefined;
            this.emit();
        } catch {
            this.setError('auth');
        } finally {
            this.setBusy(false);
        }
    }

    async selectModel(modelId: string): Promise<void> {
        this.requireUsable();
        if (typeof modelId !== 'string' || !this.#models.some(model => model.id === modelId)) {
            throw new Error('The selected Codex model is unavailable.');
        }
        if (this.#selectedModelId !== modelId) {
            this.#selectedModelId = modelId;
            this.emit();
        }
    }

    async selectThread(threadId: string | null): Promise<void> {
        this.requireUsable();
        // null is the protocol-level value for clearing the selected thread.
        // eslint-disable-next-line no-null/no-null
        if (threadId !== null && !this.#conversations.threads.some(thread => thread.id === threadId)) {
            throw new Error('The selected Codex thread is unavailable.');
        }
        await this.#services.conversations.selectThread(threadId);
        if (this.#selectedThreadId !== (threadId ?? undefined)) {
            this.#selectedThreadId = threadId ?? undefined;
            this.#approvals = Object.freeze([]);
            await this.#services.approvals.disposeContext();
            this.resetTurnReducer();
            this.emit();
        }
    }

    async startThread(): Promise<RideCodexThreadSummary> {
        this.requireAuthenticated();
        this.setBusy(true, 'Starting a Codex thread…');
        try {
            const workspaceRoot = await this.resolveWorkspaceRoot();
            const request: RideCodexThreadStartRequest = Object.freeze({
                workspaceRoot,
                ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
                ...(this.#selectedModelId === undefined ? {} : { model: this.#selectedModelId })
            });
            const summary = await this.#services.conversations.startThread(request);
            this.commitThread(summary);
            await this.#services.conversations.selectThread(summary.id);
            this.#selectedThreadId = summary.id;
            this.#approvals = Object.freeze([]);
            await this.#services.approvals.disposeContext();
            this.resetTurnReducer();
            this.emit();
            return summary;
        } catch {
            this.setError('protocol');
            throw new Error('Codex thread could not be started.');
        } finally {
            this.setBusy(false);
        }
    }

    async resumeThread(threadId: string): Promise<RideCodexThreadSummary> {
        this.requireAuthenticated();
        if (!this.#conversations.threads.some(thread => thread.id === threadId)) {
            throw new Error('The selected Codex thread is unavailable.');
        }
        this.setBusy(true, 'Resuming the Codex thread…');
        try {
            const workspaceRoot = await this.resolveWorkspaceRoot();
            const request: RideCodexThreadResumeRequest = Object.freeze({
                threadId,
                workspaceRoot,
                ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
                ...(this.#selectedModelId === undefined ? {} : { model: this.#selectedModelId })
            });
            const summary = await this.#services.conversations.resumeThread(request);
            this.commitThread(summary);
            this.#selectedThreadId = summary.id;
            this.resetTurnReducer();
            this.emit();
            return summary;
        } catch {
            this.setError('protocol');
            throw new Error('Codex thread could not be resumed.');
        } finally {
            this.setBusy(false);
        }
    }

    async archiveThread(threadId: string): Promise<void> {
        this.requireAuthenticated();
        try {
            await this.#services.conversations.archiveThread(threadId);
            const threads = this.#conversations.threads.filter(thread => thread.id !== threadId);
            this.#conversations = Object.freeze({ ...this.#conversations, threads: Object.freeze(threads) });
            if (this.#selectedThreadId === threadId) {
                this.#selectedThreadId = undefined;
                this.resetTurnReducer();
            }
            this.emit();
        } catch {
            this.setError('protocol');
        }
    }

    async submitTurn(prompt: string, clientMessageId?: string): Promise<RideCodexTurnResult> {
        this.requireAuthenticated();
        const text = boundedPrompt(prompt);
        if (!text) {
            throw new Error('Codex input cannot be empty.');
        }
        if (!this.#selectedThreadId) {
            await this.startThread();
        }
        const threadId = this.#selectedThreadId;
        if (!threadId) {
            throw new Error('A Codex thread is required.');
        }
        this.setBusy(true, 'Codex is working…');
        try {
            const result = await this.#services.turns.startTurn(Object.freeze({
                threadId,
                ...(clientMessageId === undefined ? {} : { clientMessageId }),
                input: Object.freeze([{ type: 'text' as const, text }])
            }));
            await this.bindApprovalContext(result, threadId);
            return result.status === 'in-progress'
                ? await this.waitForTerminal(threadId, result.turnId)
                : result;
        } catch {
            this.setError('turn');
            throw new Error('Codex turn could not be completed.');
        } finally {
            this.setBusy(false);
        }
    }

    async steerTurn(prompt: string, expectedTurnId?: string): Promise<RideCodexTurnResult> {
        this.requireAuthenticated();
        const threadId = this.#selectedThreadId;
        const turnId = expectedTurnId ?? this.#turn.turnId;
        const text = boundedPrompt(prompt);
        if (!threadId || !turnId || !text) {
            throw new Error('An active Codex turn is required.');
        }
        try {
            const result = await this.#services.turns.steerTurn(Object.freeze({
                threadId,
                expectedTurnId: turnId,
                input: Object.freeze([{ type: 'text' as const, text }])
            }));
            await this.bindApprovalContext(result, threadId);
            return result.status === 'in-progress'
                ? await this.waitForTerminal(threadId, result.turnId)
                : result;
        } catch {
            this.setError('turn');
            throw new Error('Codex turn could not be steered.');
        }
    }

    async interruptTurn(): Promise<RideCodexTurnResult> {
        this.requireAuthenticated();
        const threadId = this.#selectedThreadId;
        const turnId = this.#turn.turnId;
        if (!threadId || !turnId) {
            throw new Error('An active Codex turn is required.');
        }
        try {
            const result = await this.#services.turns.interruptTurn(Object.freeze({ threadId, turnId }));
            return result.status === 'in-progress'
                ? await this.waitForTerminal(threadId, result.turnId)
                : result;
        } catch {
            this.setError('turn');
            throw new Error('Codex turn could not be interrupted.');
        }
    }

    async decideApproval(card: RideCodexApprovalCard, decision: RideCodexApprovalDecision): Promise<RideCodexApprovalDecisionResult> {
        this.requireAuthenticated();
        const request: RideCodexApprovalDecisionRequest = Object.freeze({
            token: card.token,
            fingerprint: card.fingerprint,
            decision
        });
        try {
            const result = await this.#services.approvals.decide(request);
            if (result.status === 'rejected' && result.code === 'response-failed') {
                this.setError('protocol');
            }
            return result;
        } catch {
            this.setError('protocol');
            throw new Error('Codex approval could not be submitted.');
        }
    }

    authStateChanged(snapshot: RideCodexAuthSnapshot): void {
        if (this.#disposed) {
            return;
        }
        try {
            this.#auth = normalizeAuthSnapshot(snapshot);
            this.updatePhaseForAuth();
            this.emit();
        } catch {
            this.setError('auth');
        }
    }

    conversationsChanged(snapshot: RideCodexConversationsSnapshot): void {
        if (this.#disposed) {
            return;
        }
        try {
            this.#conversations = normalizeConversationSnapshot(snapshot);
            if (this.#selectedThreadId === undefined && this.#conversations.selectedThreadId !== undefined) {
                this.#selectedThreadId = this.#conversations.selectedThreadId;
            }
            this.emit();
        } catch {
            this.setError('protocol');
        }
    }

    approvalsChanged(approvals: readonly RideCodexApprovalCard[]): void {
        if (this.#disposed) {
            return;
        }
        try {
            if (!Array.isArray(approvals)) {
                throw new TypeError('Invalid approval data.');
            }
            this.#approvals = Object.freeze(approvals.slice(0, MAX_APPROVALS).map(card => {
                if (card.kind === 'file-change') {
                    return Object.freeze({
                        ...card,
                        allowedDecisions: Object.freeze([...card.allowedDecisions]),
                         changes: Object.freeze(card.changes.map((change: RideCodexFileApprovalChange) => Object.freeze({ ...change })))
                    });
                }
                return Object.freeze({
                    ...card,
                    allowedDecisions: Object.freeze([...card.allowedDecisions]),
                    ...(card.network === undefined ? {} : { network: Object.freeze({ ...card.network }) })
                });
            }));
            this.emit();
        } catch {
            this.setError('protocol');
        }
    }

    notifyTurnEvents(wire: RideCodexEventBatchWire): void {
        if (!this.#disposed) {
            this.#reducer.notifyMany(wire);
        }
    }

    async dispose(): Promise<void> {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        this.#phase = 'disposed';
        this.#turnEventsAttachment?.dispose();
        this.#reducerAttachment.dispose();
        this.#reducer.dispose();
        for (const waiter of [...this.#waiters]) {
            waiter.dispose();
            waiter.resolve(Object.freeze({
                threadId: waiter.threadId,
                turnId: waiter.turnId,
                status: 'failed' as const
            }));
        }
        this.#waiters.clear();
        try {
            await this.#services.approvals.disposeContext();
        } catch {
            // Disposal cannot make a settled UI request unsafe.
        }
        try {
            this.#services.turns.disconnectClient?.();
        } catch {
            // RPC client disposal is best effort.
        }
        this.#onDidChangeEmitter.dispose();
    }

    private async initializeOnce(): Promise<void> {
        try {
            this.#auth = normalizeAuthSnapshot(await this.#services.auth.activate());
            if (this.#auth.state !== 'authenticated') {
                this.#phase = 'auth-required';
                this.emit();
                return;
            }
            const [conversationStatus, modelPage, threadPage, approvals] = await Promise.all([
                this.#services.conversations.status(),
                this.#services.conversations.listModels({ limit: MAX_MODELS }),
                this.#services.conversations.listThreads({ limit: MAX_THREADS }),
                this.#services.approvals.approvals()
            ]);
            this.conversationsChanged(Object.freeze({
                ...conversationStatus,
                threads: Object.freeze(threadPage.data.slice(0, MAX_THREADS))
            }));
            this.#models = normalizeModels(modelPage);
            this.#selectedModelId = this.#models.find(model => model.isDefault)?.id ?? this.#models[0]?.id;
            this.approvalsChanged(approvals);
            this.#phase = 'ready';
            this.#error = undefined;
            this.emit();
        } catch {
            this.setError('protocol');
        }
    }

    private async refreshAuth(fallback: RideCodexControlPhase): Promise<void> {
        this.#auth = normalizeAuthSnapshot(await this.#services.auth.status());
        if (this.#auth.state === 'authenticated') {
            this.#phase = 'loading';
            await this.initializeAuthenticatedData();
        } else {
            this.#phase = fallback;
            this.emit();
        }
    }

    private async initializeAuthenticatedData(): Promise<void> {
        const [conversationStatus, modelPage, threadPage, approvals] = await Promise.all([
            this.#services.conversations.status(),
            this.#services.conversations.listModels({ limit: MAX_MODELS }),
            this.#services.conversations.listThreads({ limit: MAX_THREADS }),
            this.#services.approvals.approvals()
        ]);
        this.conversationsChanged(Object.freeze({
            ...conversationStatus,
            threads: Object.freeze(threadPage.data.slice(0, MAX_THREADS))
        }));
        this.#models = normalizeModels(modelPage);
        this.#selectedModelId = this.#models.find(model => model.isDefault)?.id ?? this.#models[0]?.id;
        this.approvalsChanged(approvals);
        this.#phase = 'ready';
        this.#error = undefined;
        this.emit();
    }

    private async bindApprovalContext(result: RideCodexTurnResult, threadId: string): Promise<void> {
        await this.#services.approvals.setContext(Object.freeze({
            generation: this.#conversations.generation,
            threadId,
            turnId: result.turnId
        }));
    }

    private waitForTerminal(threadId: string, turnId: string): Promise<RideCodexTurnResult> {
        const current = this.#terminalResult(threadId, turnId);
        if (current) {
            return Promise.resolve(current);
        }
        return new Promise(resolve => {
            const waiter = {
                threadId,
                turnId,
                resolve,
                dispose: () => this.#waiters.delete(waiter)
            };
            this.#waiters.add(waiter);
            const afterSubscribe = this.#terminalResult(threadId, turnId);
            if (afterSubscribe) {
                waiter.dispose();
                resolve(afterSubscribe);
            }
        });
    }

    #terminalResult(threadId: string, turnId: string): RideCodexTurnResult | undefined {
        if (this.#turn.threadId !== threadId || this.#turn.turnId !== turnId) {
            return undefined;
        }
        const status = this.#turn.status;
        return status === 'completed' || status === 'failed' || status === 'interrupted' || status === 'interrupt-uncertain'
            ? Object.freeze({ threadId, turnId, status })
            : undefined;
    }

    #resolveTurnWaiters(snapshot: RideCodexTurnSnapshot): void {
        for (const waiter of [...this.#waiters]) {
            const result = this.#terminalResult(waiter.threadId, waiter.turnId);
            if (result) {
                waiter.dispose();
                waiter.resolve(result);
            }
        }
        if (snapshot.status === 'failed' && snapshot.errors.length > 0) {
            this.#error = mapRideCodexError(snapshot.errors[snapshot.errors.length - 1].code, 'turn');
        }
    }

    private createReducer(scheduleFrame?: (callback: () => void) => RideCodexControlDisposable): RideCodexEventReducer {
        return new RideCodexEventReducer({
            ...(scheduleFrame === undefined ? {} : { scheduleFrame })
        });
    }

    private resetTurnReducer(): void {
        this.#reducerAttachment.dispose();
        this.#reducer.dispose();
        this.#reducer = this.createReducer(this.#scheduleFrame);
        this.#turn = EMPTY_TURN;
        this.#reducerAttachment = this.#reducer.onDidChange(snapshot => {
            this.#turn = snapshot;
            this.#resolveTurnWaiters(snapshot);
            this.emit();
        });
    }

    private commitThread(summary: RideCodexThreadSummary): void {
        const threads = [summary, ...this.#conversations.threads.filter(thread => thread.id !== summary.id)]
            .slice(0, MAX_THREADS);
        this.#conversations = Object.freeze({
            ...this.#conversations,
            threads: Object.freeze(threads),
            selectedThreadId: summary.id
        });
    }

    private async resolveWorkspaceRoot(): Promise<string> {
        const root = typeof this.#workspaceRoot === 'function'
            ? await this.#workspaceRoot() : this.#workspaceRoot;
        if (typeof root !== 'string' || root.length === 0 || root.length > 32_768 || root.includes('\0')) {
            throw new Error('A valid workspace is required.');
        }
        return root;
    }

    private requireUsable(): void {
        if (this.#disposed) {
            throw new Error('Codex control is disposed.');
        }
    }

    private requireAuthenticated(): void {
        this.requireUsable();
        if (this.#phase !== 'ready' || this.#auth.state !== 'authenticated') {
            throw new Error('Codex authentication is required.');
        }
    }

    private setBusy(busy: boolean, progress?: string): void {
        this.#busy = busy;
        this.#progress = busy ? progress : undefined;
        this.emit();
    }

    private setError(fallbackLayer: 'auth' | 'protocol' | 'turn'): void {
        this.#error = mapRideCodexError(undefined, fallbackLayer);
        this.#phase = fallbackLayer === 'auth' ? 'auth-required' : 'error';
        this.emit();
    }

    private updatePhaseForAuth(): void {
        if (this.#auth.state === 'authenticated') {
            if (this.#phase === 'auth-required') {
                this.#phase = 'ready';
            }
        } else if (this.#auth.state === 'authenticating' || this.#auth.state === 'unauthenticated') {
            this.#phase = 'auth-required';
        } else if (this.#auth.state === 'error') {
            this.#phase = 'error';
            this.#error = mapRideCodexError('auth-error', 'auth');
        }
    }

    private emit(): void {
        if (!this.#disposed) {
            this.#onDidChangeEmitter.fire(this.snapshot());
        }
    }
}

function normalizeAuthSnapshot(snapshot: RideCodexAuthSnapshot): RideCodexAuthSnapshot {
    return trustedRideCodexAuthNormalizers.createRideCodexAuthSnapshot(snapshot);
}

function normalizeModels(page: RideCodexModelPage): readonly RideCodexModel[] {
    if (!page || !Array.isArray(page.data)) {
        throw new TypeError('Codex model data is invalid.');
    }
    return Object.freeze(page.data.slice(0, MAX_MODELS).map(model => Object.freeze({
        ...model,
        inputModalities: Object.freeze([...model.inputModalities]),
        supportedReasoningEfforts: Object.freeze(model.supportedReasoningEfforts.map((effort: RideCodexReasoningEffort) => Object.freeze({ ...effort }))),
        serviceTiers: Object.freeze(model.serviceTiers.map((tier: RideCodexServiceTier) => Object.freeze({ ...tier })))
    })));
}

function normalizeConversationSnapshot(snapshot: RideCodexConversationsSnapshot): RideCodexConversationsSnapshot {
    if (!snapshot || !Number.isSafeInteger(snapshot.generation) || !Array.isArray(snapshot.threads)) {
        throw new TypeError('Codex conversation data is invalid.');
    }
    const threads = Object.freeze(snapshot.threads.slice(0, MAX_THREADS).map(thread => Object.freeze({
        ...thread,
        status: Object.freeze({ ...thread.status, activeFlags: Object.freeze([...thread.status.activeFlags]) })
    })));
    return Object.freeze({
        generation: snapshot.generation,
        threads,
        ...(typeof snapshot.selectedThreadId === 'string' ? { selectedThreadId: snapshot.selectedThreadId } : {}),
        persistedTranscriptCount: 0 as const
    });
}

function boundedPrompt(prompt: string): string {
    return typeof prompt === 'string' && prompt.length <= MAX_PROMPT_LENGTH ? prompt.trim() : '';
}
