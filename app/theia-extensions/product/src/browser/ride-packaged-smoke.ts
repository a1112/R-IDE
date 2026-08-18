/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { invoke as tauriInvoke, isTauri as isTauriRuntime } from '@tauri-apps/api/core';
import type { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import type { Disposable } from '@theia/core/lib/common/disposable';

export type RideSmokeAction =
    | 'editor-save'
    | 'terminal-sentinel'
    | 'workspace-search'
    | 'scm-status'
    | 'packaged-plugin-command'
    | 'secondary-window'
    | 'second-file-forwarding';

export interface RideSmokePlan {
    readonly specSha256: string;
    readonly scenario: 'critical-file' | 'critical-empty' | 'full-file';
    readonly profile: 'tauri-critical' | 'full';
    readonly workspace: string;
    readonly files: readonly string[];
    readonly actions: readonly RideSmokeAction[];
    readonly actionTimeoutMs: number;
}

export interface RideSmokeDiagnostic {
    readonly code: string;
    readonly message: string;
}

export interface RideSmokeStepRequest {
    readonly action: RideSmokeAction;
    readonly state: 'started' | 'passed' | 'failed';
    readonly durationMs: number;
    readonly diagnostic: RideSmokeDiagnostic | null;
}

export interface RideSmokeCompleteRequest {
    readonly status: 'passed' | 'failed';
    readonly failurePhase: 'startup' | 'sidecar' | 'protocol' | 'action' | 'cleanup' | null;
    readonly durationMs: number;
    readonly diagnostic: RideSmokeDiagnostic | null;
}

export const RidePackagedSmokeActions = Symbol('RidePackagedSmokeActions');
export interface RidePackagedSmokeActions {
    editorSave(plan: RideSmokePlan): Promise<void>;
    terminalSentinel(plan: RideSmokePlan): Promise<void>;
    workspaceSearch(plan: RideSmokePlan): Promise<void>;
    scmStatus(plan: RideSmokePlan): Promise<void>;
    packagedPluginCommand(plan: RideSmokePlan): Promise<void>;
    secondaryWindow(plan: RideSmokePlan): Promise<void>;
    waitForSecondFile(plan: RideSmokePlan): Promise<void>;
}

export const RidePackagedSmokeProtocol = Symbol('RidePackagedSmokeProtocol');
export interface RidePackagedSmokeProtocol {
    isTauri(): boolean;
    plan(): Promise<unknown>;
    recordStep(sessionProof: string, request: RideSmokeStepRequest): Promise<unknown>;
    complete(sessionProof: string, request: RideSmokeCompleteRequest): Promise<unknown>;
}

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface RideTauriPackagedSmokeProtocolOptions {
    readonly isTauri?: () => boolean;
    readonly invoke?: TauriInvoke;
}

export class RideTauriPackagedSmokeProtocol implements RidePackagedSmokeProtocol {
    protected readonly isTauriRuntime: () => boolean;
    protected readonly invoke: TauriInvoke;

    constructor(options: RideTauriPackagedSmokeProtocolOptions = {}) {
        this.isTauriRuntime = options.isTauri ?? (() => typeof window === 'object' && isTauriRuntime());
        this.invoke = options.invoke ?? tauriInvoke;
    }

    isTauri(): boolean {
        return this.isTauriRuntime();
    }

    plan(): Promise<unknown> {
        return this.invoke('ride_smoke_plan');
    }

    recordStep(sessionProof: string, request: RideSmokeStepRequest): Promise<unknown> {
        return this.invoke('ride_smoke_record_step', {
            request: { sessionProof, request }
        });
    }

    complete(sessionProof: string, request: RideSmokeCompleteRequest): Promise<unknown> {
        return this.invoke('ride_smoke_complete', {
            request: { sessionProof, request }
        });
    }
}

export interface RidePackagedSmokeSequencerOptions {
    readonly now?: () => number;
    readonly setTimeout?: (callback: () => void, timeoutMs: number) => unknown;
    readonly clearTimeout?: (handle: unknown) => void;
}

interface ActiveSmokeSession {
    readonly plan: RideSmokePlan;
    readonly sessionProof: string;
}

const ACTIONS: readonly RideSmokeAction[] = [
    'editor-save',
    'terminal-sentinel',
    'workspace-search',
    'scm-status',
    'packaged-plugin-command',
    'secondary-window',
    'second-file-forwarding'
];

const PROTOCOL_FAILED: RideSmokeDiagnostic = {
    code: 'protocol-failed',
    message: 'Smoke protocol failed.'
};
const ACTION_FAILED: RideSmokeDiagnostic = {
    code: 'action-failed',
    message: 'Smoke action failed.'
};
const ACTION_TIMEOUT: RideSmokeDiagnostic = {
    code: 'action-timeout',
    message: 'Smoke action timed out.'
};
// Rust serializes absent Option values as JSON null; keep outbound envelopes canonical.
// eslint-disable-next-line no-null/no-null
const JSON_NULL = null;

class SmokeProtocolFailure extends Error { }
class SmokeActionTimeout extends Error { }

export class RidePackagedSmokeContribution implements FrontendApplicationContribution, Disposable {
    protected readonly now: () => number;
    protected readonly scheduleTimeout: (callback: () => void, timeoutMs: number) => unknown;
    protected readonly cancelTimeout: (handle: unknown) => void;
    protected started = false;
    protected disposed = false;

    constructor(
        protected readonly applicationState: FrontendApplicationStateService,
        protected readonly protocol: RidePackagedSmokeProtocol,
        protected readonly resolveActions: () => RidePackagedSmokeActions,
        options: RidePackagedSmokeSequencerOptions = {}
    ) {
        this.now = options.now ?? (() => Date.now());
        this.scheduleTimeout = options.setTimeout ?? ((callback, timeoutMs) => globalThis.setTimeout(callback, timeoutMs));
        this.cancelTimeout = options.clearTimeout ?? (handle => globalThis.clearTimeout(
            handle as ReturnType<typeof globalThis.setTimeout>
        ));
    }

    onStart(): void {
        if (this.started || this.disposed) {
            return;
        }
        this.started = true;
        this.startAfterShellAttached().catch(() => undefined);
    }

    onStop(): void {
        this.dispose();
    }

    dispose(): void {
        this.disposed = true;
    }

    protected async startAfterShellAttached(): Promise<void> {
        await this.applicationState.reachedState('attached_shell');
        if (this.disposed || !this.protocol.isTauri()) {
            return;
        }

        const response = await this.protocol.plan();
        if (this.disposed || isInactivePlanResponse(response)) {
            return;
        }

        const sessionProof = activeSessionProof(response);
        if (sessionProof === undefined) {
            return;
        }
        const plan = activeSessionPlan(response);
        if (plan === undefined) {
            await this.completeProtocolFailure(sessionProof, () => 0);
            return;
        }

        let smokeActions: RidePackagedSmokeActions;
        try {
            smokeActions = this.resolveActions();
        } catch {
            await this.completeProtocolFailure(sessionProof, () => 0);
            return;
        }
        if (this.disposed) {
            return;
        }

        await this.sequence({ plan, sessionProof }, smokeActions);
    }

    protected async sequence(session: ActiveSmokeSession, smokeActions: RidePackagedSmokeActions): Promise<void> {
        const elapsed = this.createElapsedClock();
        for (const action of session.plan.actions) {
            if (this.disposed) {
                return;
            }
            await this.record(session.sessionProof, {
                action,
                state: 'started',
                durationMs: elapsed(),
                diagnostic: JSON_NULL
            });

            let diagnostic: RideSmokeDiagnostic | undefined;
            try {
                await this.withTimeout(this.executeAction(smokeActions, action, session.plan), session.plan.actionTimeoutMs);
            } catch (error) {
                diagnostic = error instanceof SmokeActionTimeout ? ACTION_TIMEOUT : ACTION_FAILED;
            }
            if (this.disposed) {
                return;
            }
            if (diagnostic !== undefined) {
                await this.reportActionFailure(session.sessionProof, action, diagnostic, elapsed);
                return;
            }

            await this.record(session.sessionProof, {
                action,
                state: 'passed',
                durationMs: elapsed(),
                diagnostic: JSON_NULL
            });
        }

        if (!this.disposed) {
            await this.complete(session.sessionProof, {
                status: 'passed',
                failurePhase: JSON_NULL,
                durationMs: elapsed(),
                diagnostic: JSON_NULL
            });
        }
    }

    protected executeAction(
        smokeActions: RidePackagedSmokeActions,
        action: RideSmokeAction,
        plan: RideSmokePlan
    ): Promise<void> {
        switch (action) {
            case 'editor-save': return smokeActions.editorSave(plan);
            case 'terminal-sentinel': return smokeActions.terminalSentinel(plan);
            case 'workspace-search': return smokeActions.workspaceSearch(plan);
            case 'scm-status': return smokeActions.scmStatus(plan);
            case 'packaged-plugin-command': return smokeActions.packagedPluginCommand(plan);
            case 'secondary-window': return smokeActions.secondaryWindow(plan);
            case 'second-file-forwarding': return smokeActions.waitForSecondFile(plan);
        }
    }

    protected async reportActionFailure(
        sessionProof: string,
        action: RideSmokeAction,
        diagnostic: RideSmokeDiagnostic,
        elapsed: () => number
    ): Promise<void> {
        try {
            await this.record(sessionProof, {
                action,
                state: 'failed',
                durationMs: elapsed(),
                diagnostic
            });
            await this.complete(sessionProof, {
                status: 'failed',
                failurePhase: 'action',
                durationMs: elapsed(),
                diagnostic
            });
        } catch {
            // The server may have rejected the transition. Do not retry an
            // ambiguous mutation and do not expose the original action error.
        }
    }

    protected async completeProtocolFailure(sessionProof: string, elapsed: () => number): Promise<void> {
        try {
            await this.complete(sessionProof, {
                status: 'failed',
                failurePhase: 'protocol',
                durationMs: elapsed(),
                diagnostic: PROTOCOL_FAILED
            });
        } catch {
            // A malformed/rejected IPC exchange is terminal for this sequencer.
        }
    }

    protected async record(sessionProof: string, request: RideSmokeStepRequest): Promise<void> {
        const response = await this.protocol.recordStep(sessionProof, request);
        if (!isUpdateResponse(response, 'recorded')) {
            throw new SmokeProtocolFailure();
        }
    }

    protected async complete(sessionProof: string, request: RideSmokeCompleteRequest): Promise<void> {
        const response = await this.protocol.complete(sessionProof, request);
        if (!isUpdateResponse(response, 'completed')) {
            throw new SmokeProtocolFailure();
        }
    }

    protected createElapsedClock(): () => number {
        let origin: number | undefined;
        let previous = 0;
        return () => {
            const current = this.now();
            if (!Number.isFinite(current)) {
                return previous;
            }
            if (origin === undefined) {
                origin = current;
            }
            const duration = Math.max(previous, Math.floor(current - origin));
            previous = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, duration));
            return previous;
        };
    }

    protected withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const handle = this.scheduleTimeout(() => {
                if (!settled) {
                    settled = true;
                    reject(new SmokeActionTimeout());
                }
            }, timeoutMs);
            operation.then(
                () => {
                    if (!settled) {
                        settled = true;
                        this.cancelTimeout(handle);
                        resolve();
                    }
                },
                error => {
                    if (!settled) {
                        settled = true;
                        this.cancelTimeout(handle);
                        reject(error);
                    }
                }
            );
        });
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && !!value && !Array.isArray(value);
}

function isInactivePlanResponse(value: unknown): boolean {
    return isRecord(value) && (value.mode === 'disabled' || value.mode === 'rejected');
}

function activeSessionProof(value: unknown): string | undefined {
    if (!isRecord(value) || value.mode !== 'active' || typeof value.sessionProof !== 'string'
        || value.sessionProof.length === 0) {
        return undefined;
    }
    return value.sessionProof;
}

function activeSessionPlan(value: unknown): RideSmokePlan | undefined {
    if (!isRecord(value) || value.mode !== 'active' || !isRecord(value.plan)) {
        return undefined;
    }
    const plan = value.plan;
    if (typeof plan.specSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(plan.specSha256)
        || !isScenario(plan.scenario) || !isProfile(plan.profile)
        || typeof plan.workspace !== 'string' || plan.workspace.length === 0
        || !isStringArray(plan.files) || !isCanonicalActions(plan.actions)
        || !Number.isSafeInteger(plan.actionTimeoutMs)
        || (plan.actionTimeoutMs as number) < 1_000 || (plan.actionTimeoutMs as number) > 300_000) {
        return undefined;
    }
    return {
        specSha256: plan.specSha256,
        scenario: plan.scenario,
        profile: plan.profile,
        workspace: plan.workspace,
        files: [...plan.files],
        actions: [...plan.actions],
        actionTimeoutMs: plan.actionTimeoutMs as number
    };
}

function isScenario(value: unknown): value is RideSmokePlan['scenario'] {
    return value === 'critical-file' || value === 'critical-empty' || value === 'full-file';
}

function isProfile(value: unknown): value is RideSmokePlan['profile'] {
    return value === 'tauri-critical' || value === 'full';
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isCanonicalActions(value: unknown): value is RideSmokeAction[] {
    if (!Array.isArray(value)) {
        return false;
    }
    let previous = -1;
    for (const action of value) {
        const index = ACTIONS.indexOf(action as RideSmokeAction);
        if (index <= previous) {
            return false;
        }
        previous = index;
    }
    return true;
}

function isUpdateResponse(value: unknown, expectedStatus: 'recorded' | 'completed'): boolean {
    return isRecord(value) && value.status === expectedStatus;
}
