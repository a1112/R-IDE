/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export type RideCodexTurnTerminalStatus = 'completed' | 'failed' | 'interrupted' | 'interrupt-uncertain';
export type RideCodexTurnStatus = 'idle' | 'in-progress' | RideCodexTurnTerminalStatus;
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
    readonly code: 'turn-error' | 'operation-failed' | 'interrupt-timeout' | 'recovery-failed';
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
        code: 'turn-error' | 'operation-failed' | 'interrupt-timeout' | 'recovery-failed';
        message: string;
        retryable: boolean;
    }>;

export interface RideCodexEventBatch {
    readonly generation: number;
    readonly threadId: string;
    readonly turnId: string;
    readonly events: readonly RideCodexUiEvent[];
}

export interface RideCodexTurnClient {
    turnEvents(batch: RideCodexEventBatch): void | Promise<void>;
}

export interface RideCodexRenderedItem {
    readonly id: string;
    readonly kind: RideCodexItemKind;
    readonly state: 'started' | 'completed';
    readonly text: string;
    readonly summaries: readonly string[];
    readonly reasoning: readonly string[];
    readonly changes: readonly RideCodexFileChange[];
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
        threadId: batch.threadId,
        turnId: batch.turnId,
        events: batch.events.map(event => deepFreezeRideCodex({ ...event }))
    }) as RideCodexEventBatch;
}
