/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export type RideCodexTurnTerminalStatus = 'completed' | 'failed' | 'interrupted' | 'interrupt-uncertain';
export type RideCodexTurnStatus = 'idle' | 'in-progress' | RideCodexTurnTerminalStatus;
export const RIDE_CODEX_MAX_IDENTIFIER_BYTES = 512;
export const RIDE_CODEX_SAFE_ERROR_MESSAGES = Object.freeze({
    'turn-error': 'Codex turn failed.',
    'operation-failed': 'Codex turn operation failed.',
    'interrupt-timeout': 'Codex turn interrupt could not be confirmed.',
    'recovery-failed': 'Codex thread recovery failed.',
    unauthorized: 'Codex authorization is required.',
    'rate-limit': 'Codex usage limit was reached.',
    'context-limit': 'Codex context limit was reached.',
    'sandbox-denied': 'Codex action was denied by the sandbox.',
    'transport-error': 'Codex connection failed.'
});
export type RideCodexSafeErrorCode = keyof typeof RIDE_CODEX_SAFE_ERROR_MESSAGES;
export const RIDE_CODEX_SAFE_ERROR_CODES = Object.freeze(
    Object.keys(RIDE_CODEX_SAFE_ERROR_MESSAGES) as RideCodexSafeErrorCode[]
);
const RIDE_CODEX_BOUNDARY_IDENTITY = Object.freeze({
    generation: Number.MAX_SAFE_INTEGER,
    turnSequence: Number.MAX_SAFE_INTEGER,
    threadId: '\u0000'.repeat(RIDE_CODEX_MAX_IDENTIFIER_BYTES),
    turnId: '\u0000'.repeat(RIDE_CODEX_MAX_IDENTIFIER_BYTES)
});
const RIDE_CODEX_TERMINAL_BOUNDARIES = Object.freeze([
    Object.freeze({ type: 'turn-terminal', status: 'completed' }),
    Object.freeze({ type: 'turn-terminal', status: 'interrupted' }),
    ...RIDE_CODEX_SAFE_ERROR_CODES.map(code => Object.freeze({
        type: 'turn-terminal',
        status: 'failed',
        error: Object.freeze({ code, message: RIDE_CODEX_SAFE_ERROR_MESSAGES[code] })
    })),
    Object.freeze({
        type: 'turn-terminal',
        status: 'interrupt-uncertain',
        error: Object.freeze({
            code: 'interrupt-timeout',
            message: 'Codex turn interrupt could not be confirmed.'
        })
    })
]);
const RIDE_CODEX_RECOVERY_FAILED_DIAGNOSTIC = Object.freeze({
    type: 'error',
    code: 'recovery-failed',
    message: 'Codex thread recovery failed.',
    retryable: false
});
const RIDE_CODEX_MAX_BOUNDARY_BATCH_BYTES = Math.max(...RIDE_CODEX_TERMINAL_BOUNDARIES.map(terminal =>
    utf8ByteLength(JSON.stringify({
        ...RIDE_CODEX_BOUNDARY_IDENTITY,
        events: [Object.freeze({ type: 'turn-started' }), terminal]
    }))
));
const RIDE_CODEX_RECOVERY_BATCH_BYTES = utf8ByteLength(JSON.stringify({
    ...RIDE_CODEX_BOUNDARY_IDENTITY,
    events: [RIDE_CODEX_RECOVERY_FAILED_DIAGNOSTIC]
}));
export const RIDE_CODEX_MIN_QUEUED_BYTES =
    RIDE_CODEX_MAX_BOUNDARY_BATCH_BYTES + RIDE_CODEX_RECOVERY_BATCH_BYTES;
export type RideCodexItemKind =
    | 'user-message' | 'agent-message' | 'plan' | 'reasoning'
    | 'command' | 'file-change' | 'other';

export interface RideCodexTextInput {
    readonly type: 'text';
    readonly text: string;
}

export interface RideCodexLocalImageInput {
    readonly type: 'local-image';
    readonly path: string;
}

export type RideCodexUserInput = RideCodexTextInput | RideCodexLocalImageInput;

export interface RideCodexTurnStartRequest {
    readonly threadId: string;
    readonly clientMessageId?: string;
    readonly input: readonly RideCodexUserInput[];
}

export interface RideCodexTurnSteerRequest {
    readonly threadId: string;
    readonly expectedTurnId: string;
    readonly clientMessageId?: string;
    readonly input: readonly RideCodexUserInput[];
}

export interface RideCodexTurnInterruptRequest {
    readonly threadId: string;
    readonly turnId: string;
}

export interface RideCodexTurnResult {
    readonly threadId: string;
    readonly turnId: string;
    readonly status: RideCodexTurnStatus;
}

export interface RideCodexSafeError {
    readonly code: RideCodexSafeErrorCode;
    readonly message: string;
}

interface RideCodexFileChangeBase {
    readonly path: string;
    readonly diff: string;
}

export type RideCodexFileChange =
    | Readonly<RideCodexFileChangeBase & { kind: 'add' | 'delete' }>
    | Readonly<RideCodexFileChangeBase & { kind: 'update'; movePath?: string | null }>;

export interface RideCodexPlanStep {
    readonly step: string;
    readonly status: 'pending' | 'in-progress' | 'completed';
}

export type RideCodexUiEvent =
    | Readonly<{ type: 'turn-started' }>
    | Readonly<{ type: 'turn-terminal'; status: RideCodexTurnTerminalStatus; error?: RideCodexSafeError }>
    | Readonly<{ type: 'item-started' | 'item-completed'; itemId: string; itemKind: RideCodexItemKind }>
    | Readonly<{ type: 'agent-delta' | 'plan-delta' | 'command-output' | 'file-output'; itemId: string; delta: string }>
    | Readonly<{ type: 'reasoning-summary-delta'; itemId: string; summaryIndex: number; delta: string }>
    | Readonly<{ type: 'reasoning-summary-part'; itemId: string; summaryIndex: number }>
    | Readonly<{ type: 'reasoning-delta'; itemId: string; contentIndex: number; delta: string }>
    | Readonly<{ type: 'file-patch'; itemId: string; changes: readonly RideCodexFileChange[] }>
    | Readonly<{ type: 'turn-plan'; explanation?: string; steps: readonly RideCodexPlanStep[] }>
    | Readonly<{ type: 'turn-diff'; diff: string }>
    | Readonly<{ type: 'token-usage'; totalTokens: number; inputTokens: number; outputTokens: number }>
    | Readonly<{
        type: 'warning';
        code: 'server-warning' | 'events-dropped' | 'data-truncated';
        message: string;
        droppedEvents?: number;
        droppedBytes?: number;
    }>
    | Readonly<{
        type: 'error';
        code: RideCodexSafeErrorCode;
        message: string;
        retryable: boolean;
    }>;

export interface RideCodexEventBatch {
    readonly generation: number;
    readonly turnSequence: number;
    readonly threadId: string;
    readonly turnId: string;
    readonly events: readonly RideCodexUiEvent[];
}

export type RideCodexEventBatchWire = string;

export interface RideCodexTurnClient {
    turnEvents(wire: RideCodexEventBatchWire): void | Promise<void>;
}

export interface RideCodexRenderedItem {
    readonly id: string;
    readonly kind: RideCodexItemKind;
    readonly state: 'started' | 'completed';
    readonly text: string;
    readonly summaries: readonly string[];
    readonly reasoning: readonly string[];
    readonly changes: readonly RideCodexFileChange[];
    readonly truncation?: RideCodexRenderTruncation;
}

export interface RideCodexRenderTruncation {
    readonly omittedUtf8Bytes: number;
    readonly omittedChanges: number;
    readonly omittedPaths: number;
}

export interface RideCodexRenderedPlan {
    readonly explanation?: string;
    readonly steps: readonly RideCodexPlanStep[];
}

export interface RideCodexRenderedUsage {
    readonly totalTokens: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
}

export interface RideCodexTurnSnapshot {
    readonly generation: number;
    readonly threadId?: string;
    readonly turnId?: string;
    readonly status: RideCodexTurnStatus;
    readonly items: readonly RideCodexRenderedItem[];
    readonly plan?: RideCodexRenderedPlan;
    readonly diff?: string;
    readonly usage?: RideCodexRenderedUsage;
    readonly warnings: readonly Extract<RideCodexUiEvent, { type: 'warning' }>[];
    readonly errors: readonly Extract<RideCodexUiEvent, { type: 'error' }>[];
    readonly retainedBytes: number;
}

export function utf8ByteLength(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

export function truncateUtf8(value: string, maxBytes: number): string {
    if (utf8ByteLength(value) <= maxBytes) {
        return value;
    }
    let result = '';
    let used = 0;
    for (const codePoint of value) {
        const bytes = utf8ByteLength(codePoint);
        if (used + bytes > maxBytes) {
            break;
        }
        result += codePoint;
        used += bytes;
    }
    return result;
}

export function deepFreezeRideCodex<T>(value: T): Readonly<T> {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
        return value;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
        deepFreezeRideCodex(child);
    }
    return Object.freeze(value);
}

export function freezeRideCodexEventBatch(batch: RideCodexEventBatch): RideCodexEventBatch {
    return deepFreezeRideCodex({
        generation: batch.generation,
        turnSequence: batch.turnSequence,
        threadId: batch.threadId,
        turnId: batch.turnId,
        events: batch.events.map(event => deepFreezeRideCodex({ ...event }))
    }) as RideCodexEventBatch;
}

/**
 * Serializes a coordinator-owned batch after the Node boundary has rejected
 * proxies/accessors and verified that the normalized graph is deeply frozen.
 */
export function serializeRideCodexEventBatch(
    batch: RideCodexEventBatch,
    maxBytes: number
): RideCodexEventBatchWire | undefined {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        return undefined;
    }
    try {
        const wire = JSON.stringify(batch);
        return utf8ByteLength(wire) <= maxBytes ? wire : undefined;
    } catch {
        return undefined;
    }
}
