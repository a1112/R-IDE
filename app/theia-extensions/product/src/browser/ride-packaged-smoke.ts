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

type ParsedPlanResponse =
    | { readonly kind: 'inactive' }
    | { readonly kind: 'active'; readonly session: ActiveSmokeSession }
    | { readonly kind: 'malformed'; readonly sessionProof?: string };

const ACTIONS: readonly RideSmokeAction[] = [
    'editor-save',
    'terminal-sentinel',
    'workspace-search',
    'scm-status',
    'packaged-plugin-command',
    'secondary-window',
    'second-file-forwarding'
];
const PLAN_RESPONSE_KEYS = ['mode', 'plan', 'sessionProof', 'diagnostic'] as const;
const PLAN_KEYS = [
    'specSha256',
    'scenario',
    'profile',
    'workspace',
    'files',
    'actions',
    'actionTimeoutMs'
] as const;
const UPDATE_RESPONSE_KEYS = ['status', 'diagnostic'] as const;
const DIAGNOSTIC_KEYS = ['code', 'message'] as const;

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
const REPORT_DURABILITY_WARNING: RideSmokeDiagnostic = {
    code: 'report-durability-warning',
    message: 'Smoke report was committed but durability sync failed.'
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
        const parsed = parsePlanResponse(response);
        if (parsed.kind === 'inactive') {
            return;
        }
        if (parsed.kind === 'malformed') {
            if (parsed.sessionProof === undefined) {
                return;
            }
            await this.completeProtocolFailure(parsed.sessionProof, () => 0);
            return;
        }
        const { plan, sessionProof } = parsed.session;

        let smokeActions: RidePackagedSmokeActions;
        try {
            smokeActions = this.resolveActions();
        } catch {
            await this.completeProtocolFailure(sessionProof, () => 0);
            return;
        }
        await this.sequence({ plan, sessionProof }, smokeActions);
    }

    protected async sequence(session: ActiveSmokeSession, smokeActions: RidePackagedSmokeActions): Promise<void> {
        const elapsed = this.createElapsedClock();
        for (const action of session.plan.actions) {
            try {
                await this.record(session.sessionProof, {
                    action,
                    state: 'started',
                    durationMs: elapsed(),
                    diagnostic: JSON_NULL
                });
            } catch {
                return;
            }

            let diagnostic: RideSmokeDiagnostic | undefined;
            try {
                await this.withTimeout(this.executeAction(smokeActions, action, session.plan), session.plan.actionTimeoutMs);
            } catch (error) {
                diagnostic = error instanceof SmokeActionTimeout ? ACTION_TIMEOUT : ACTION_FAILED;
            }
            if (diagnostic !== undefined) {
                await this.reportActionFailure(session.sessionProof, action, diagnostic, elapsed);
                return;
            }

            try {
                await this.record(session.sessionProof, {
                    action,
                    state: 'passed',
                    durationMs: elapsed(),
                    diagnostic: JSON_NULL
                });
            } catch {
                return;
            }
        }

        await this.complete(session.sessionProof, {
            status: 'passed',
            failurePhase: JSON_NULL,
            durationMs: elapsed(),
            diagnostic: JSON_NULL
        });
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
        } catch {
            return;
        }
        try {
            await this.complete(sessionProof, {
                status: 'failed',
                failurePhase: 'action',
                durationMs: elapsed(),
                diagnostic
            });
        } catch {
            // The external runner owns the terminal timeout after bounded retries fail.
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
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const response = await this.protocol.recordStep(sessionProof, request);
                if (isUpdateResponse(response, 'recorded')) {
                    return;
                }
            } catch {
                // Rust replays the exact last committed mutation without applying it twice.
            }
        }
        throw new SmokeProtocolFailure();
    }

    protected async complete(sessionProof: string, request: RideSmokeCompleteRequest): Promise<void> {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const response = await this.protocol.complete(sessionProof, request);
                if (isUpdateResponse(response, 'completed')) {
                    return;
                }
            } catch {
                // Rust caches the exact committed completion response for one bounded replay.
            }
        }
        throw new SmokeProtocolFailure();
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
            let timerCreated = false;
            let handle: unknown;
            const settleFromOperation = (failed: boolean, error?: unknown): void => {
                if (!settled) {
                    settled = true;
                    let cleanupFailed = false;
                    if (timerCreated) {
                        try {
                            this.cancelTimeout(handle);
                        } catch {
                            cleanupFailed = true;
                        }
                    }
                    if (failed) {
                        reject(error);
                    } else if (cleanupFailed) {
                        reject(new SmokeProtocolFailure());
                    } else {
                        resolve();
                    }
                }
            };
            operation.then(
                () => settleFromOperation(false),
                error => settleFromOperation(true, error)
            );
            try {
                handle = this.scheduleTimeout(() => {
                    if (!settled) {
                        settled = true;
                        reject(new SmokeActionTimeout());
                    }
                }, timeoutMs);
                timerCreated = true;
            } catch {
                if (!settled) {
                    settled = true;
                    reject(new SmokeProtocolFailure());
                }
            }
        });
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && !!value && !Array.isArray(value);
}

function parsePlanResponse(value: unknown): ParsedPlanResponse {
    const trustedProof = isRecord(value) && value.mode === 'active' && isCanonicalProof(value.sessionProof)
        ? value.sessionProof
        : undefined;
    if (!isRecord(value) || !hasExactKeys(value, PLAN_RESPONSE_KEYS)) {
        return { kind: 'malformed', sessionProof: trustedProof };
    }
    if (value.mode === 'disabled') {
        return value.plan === JSON_NULL && value.sessionProof === JSON_NULL && value.diagnostic === JSON_NULL
            ? { kind: 'inactive' }
            : { kind: 'malformed' };
    }
    if (value.mode === 'rejected') {
        return value.plan === JSON_NULL && value.sessionProof === JSON_NULL
            && isExactDiagnostic(value.diagnostic, PROTOCOL_FAILED)
            ? { kind: 'inactive' }
            : { kind: 'malformed' };
    }
    if (value.mode !== 'active' || trustedProof === undefined || value.diagnostic !== JSON_NULL) {
        return { kind: 'malformed', sessionProof: trustedProof };
    }
    const plan = parseActivePlan(value.plan);
    return plan === undefined
        ? { kind: 'malformed', sessionProof: trustedProof }
        : { kind: 'active', session: { plan, sessionProof: trustedProof } };
}

function parseActivePlan(value: unknown): RideSmokePlan | undefined {
    if (!isRecord(value) || !hasExactKeys(value, PLAN_KEYS)) {
        return undefined;
    }
    if (!isCanonicalSha256(value.specSha256)
        || !isScenario(value.scenario) || !isProfile(value.profile)
        || !isCanonicalPortablePath(value.workspace, true)
        || !isCanonicalFiles(value.files) || !isCanonicalActions(value.actions)
        || !Number.isSafeInteger(value.actionTimeoutMs)
        || (value.actionTimeoutMs as number) < 1_000 || (value.actionTimeoutMs as number) > 300_000) {
        return undefined;
    }
    const files = Object.freeze([...value.files]);
    const actions = Object.freeze([...value.actions]);
    return Object.freeze({
        specSha256: value.specSha256,
        scenario: value.scenario,
        profile: value.profile,
        workspace: value.workspace,
        files,
        actions,
        actionTimeoutMs: value.actionTimeoutMs as number
    });
}

function isScenario(value: unknown): value is RideSmokePlan['scenario'] {
    return value === 'critical-file' || value === 'critical-empty' || value === 'full-file';
}

function isProfile(value: unknown): value is RideSmokePlan['profile'] {
    return value === 'tauri-critical' || value === 'full';
}

function isCanonicalProof(value: unknown): value is string {
    return isCanonicalSha256(value);
}

function isCanonicalSha256(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isCanonicalFiles(value: unknown): value is string[] {
    if (!Array.isArray(value)) {
        return false;
    }
    for (let index = 0; index < value.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)
            || !isCanonicalPortablePath(value[index], false)) {
            return false;
        }
    }
    const keys = value.map(windowsOrdinalCaseKey);
    return new Set(keys).size === keys.length;
}

function isCanonicalPortablePath(value: unknown, allowDot: boolean): value is string {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\\')) {
        return false;
    }
    if (value === '.') {
        return allowDot;
    }
    if (value.startsWith('/') || /^[A-Za-z]:/u.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) {
        return false;
    }
    const segments = value.split('/');
    if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
        return false;
    }
    return segments.every(isWindowsPortableSegment);
}

function isWindowsPortableSegment(segment: string): boolean {
    if (/[<>:"|?*\u0000-\u001f]/u.test(segment)
        || segment.endsWith('.') || segment.endsWith(' ')) {
        return false;
    }
    const deviceName = segment.split('.', 1)[0].toUpperCase();
    return !/^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/u.test(deviceName);
}

function windowsOrdinalCaseKey(path: string): string {
    return path.split('/').map(segment => {
        let key = '';
        for (const codePoint of segment) {
            const uppercase = codePoint.toUpperCase();
            key += [...uppercase].length === 1 ? uppercase : codePoint;
        }
        return key;
    }).join('/');
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
    if (!isRecord(value) || !hasExactKeys(value, UPDATE_RESPONSE_KEYS) || value.status !== expectedStatus) {
        return false;
    }
    if (expectedStatus === 'recorded') {
        return value.diagnostic === JSON_NULL;
    }
    return value.diagnostic === JSON_NULL || isExactDiagnostic(value.diagnostic, REPORT_DURABILITY_WARNING);
}

function isExactDiagnostic(value: unknown, expected: RideSmokeDiagnostic): boolean {
    return isRecord(value) && hasExactKeys(value, DIAGNOSTIC_KEYS)
        && value.code === expected.code && value.message === expected.message;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value);
    return actual.length === expected.length
        && expected.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
