/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    deepFreezeRideCodex,
    RideCodexEventBatch,
    RideCodexFileChange,
    RideCodexItemKind,
    RideCodexRenderedItem,
    RideCodexTurnSnapshot,
    RideCodexUiEvent,
    truncateUtf8,
    utf8ByteLength
} from '../common/ride-codex-events';

export interface RideCodexFrameDisposable {
    dispose(): void;
}

export interface RideCodexEventReducerOptions {
    readonly scheduleFrame?: (callback: () => void) => RideCodexFrameDisposable;
    readonly maxQueuedBytes?: number;
    readonly maxBatchEvents?: number;
    readonly maxItemBytes?: number;
    readonly maxRetainedItems?: number;
    readonly maxRetainedBytes?: number;
    readonly maxDiagnosticHistory?: number;
}

interface MutableItem {
    readonly id: string;
    kind: RideCodexItemKind;
    state: 'started' | 'completed';
    text: string;
    summaries: string[];
    changes: RideCodexFileChange[];
}

const DEFAULT_MAX_QUEUED_BYTES = 256 * 1024;
const DEFAULT_MAX_BATCH_EVENTS = 4_096;
const DEFAULT_MAX_ITEM_BYTES = 64 * 1024;
const DEFAULT_MAX_RETAINED_ITEMS = 256;
const DEFAULT_MAX_RETAINED_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DIAGNOSTIC_HISTORY = 64;

const EMPTY_SNAPSHOT: RideCodexTurnSnapshot = deepFreezeRideCodex({
    generation: 0,
    status: 'idle' as const,
    items: [],
    warnings: [],
    errors: [],
    retainedBytes: 0
}) as RideCodexTurnSnapshot;

export class RideCodexEventReducer {
    readonly #scheduleFrame: (callback: () => void) => RideCodexFrameDisposable;
    readonly #maxQueuedBytes: number;
    readonly #maxBatchEvents: number;
    readonly #maxItemBytes: number;
    readonly #maxRetainedItems: number;
    readonly #maxRetainedBytes: number;
    readonly #maxDiagnosticHistory: number;
    readonly #listeners = new Set<(snapshot: RideCodexTurnSnapshot) => void>();
    readonly #pending: RideCodexEventBatch[] = [];
    readonly #items = new Map<string, MutableItem>();
    readonly #truncatedItems = new Set<string>();
    #snapshot: RideCodexTurnSnapshot = EMPTY_SNAPSHOT;
    #frame: RideCodexFrameDisposable | undefined;
    #queuedBytes = 0;
    #generation = 0;
    #threadId: string | undefined;
    #turnId: string | undefined;
    #status: RideCodexTurnSnapshot['status'] = 'idle';
    #plan: RideCodexTurnSnapshot['plan'];
    #diff: string | undefined;
    #usage: RideCodexTurnSnapshot['usage'];
    #warnings: Extract<RideCodexUiEvent, { type: 'warning' }>[] = [];
    #errors: Extract<RideCodexUiEvent, { type: 'error' }>[] = [];
    #disposed = false;

    constructor(options: RideCodexEventReducerOptions = {}) {
        this.#scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame;
        this.#maxQueuedBytes = positiveLimit(options.maxQueuedBytes, DEFAULT_MAX_QUEUED_BYTES);
        this.#maxBatchEvents = Math.max(2, positiveLimit(options.maxBatchEvents, DEFAULT_MAX_BATCH_EVENTS));
        this.#maxItemBytes = positiveLimit(options.maxItemBytes, DEFAULT_MAX_ITEM_BYTES);
        this.#maxRetainedItems = positiveLimit(options.maxRetainedItems, DEFAULT_MAX_RETAINED_ITEMS);
        this.#maxRetainedBytes = positiveLimit(options.maxRetainedBytes, DEFAULT_MAX_RETAINED_BYTES);
        this.#maxDiagnosticHistory = positiveLimit(options.maxDiagnosticHistory, DEFAULT_MAX_DIAGNOSTIC_HISTORY);
    }

    snapshot(): RideCodexTurnSnapshot {
        return this.#snapshot;
    }

    onDidChange(listener: (snapshot: RideCodexTurnSnapshot) => void): RideCodexFrameDisposable {
        if (this.#disposed) {
            return { dispose: () => undefined };
        }
        this.#listeners.add(listener);
        let disposed = false;
        return {
            dispose: () => {
                if (!disposed) {
                    disposed = true;
                    this.#listeners.delete(listener);
                }
            }
        };
    }

    notifyMany(batch: RideCodexEventBatch): void {
        if (this.#disposed) {
            return;
        }
        const safeBatch = copySafeBatch(batch, Math.min(
            4 * 1024 * 1024,
            Math.max(64 * 1024, this.#maxQueuedBytes * 4, this.#maxItemBytes * 2)
        ));
        if (!safeBatch) {
            return;
        }
        const sourceEvents = safeBatch.events;
        const reserveDrop = sourceEvents.length > this.#maxBatchEvents;
        const events = sourceEvents.slice(0, reserveDrop ? this.#maxBatchEvents - 1 : this.#maxBatchEvents);
        let bytes = utf8ByteLength(safeBatch.threadId) + utf8ByteLength(safeBatch.turnId);
        const accepted: RideCodexUiEvent[] = [];
        for (const event of events) {
            const eventBytes = estimateEventBytes(event);
            if (bytes + eventBytes > this.#maxQueuedBytes || this.#queuedBytes + bytes + eventBytes > this.#maxQueuedBytes) {
                break;
            }
            accepted.push(event);
            bytes += eventBytes;
        }
        const dropped = sourceEvents.length - accepted.length;
        if (dropped > 0) {
            const warning: RideCodexUiEvent = {
                type: 'warning',
                code: 'events-dropped',
                message: 'Some Codex UI events were dropped to preserve responsiveness.',
                droppedEvents: dropped
            };
            const warningBytes = estimateEventBytes(warning);
            while (accepted.length >= this.#maxBatchEvents || bytes + warningBytes > this.#maxQueuedBytes) {
                const removed = accepted.pop();
                if (!removed || removed.type === 'turn-started') {
                    if (removed) {
                        accepted.push(removed);
                    }
                    break;
                }
                bytes -= estimateEventBytes(removed);
            }
            if (accepted.length < this.#maxBatchEvents && bytes + warningBytes <= this.#maxQueuedBytes) {
                accepted.push(warning);
                bytes += warningBytes;
            }
        }
        if (accepted.length === 0) {
            return;
        }
        this.#pending.push({
            generation: safeBatch.generation,
            threadId: safeBatch.threadId,
            turnId: safeBatch.turnId,
            events: accepted
        });
        this.#queuedBytes += bytes;
        if (!this.#frame) {
            this.#frame = this.#scheduleFrame(() => this.#flushFrame());
        }
    }

    dispose(): void {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        this.#frame?.dispose();
        this.#frame = undefined;
        this.#pending.length = 0;
        this.#queuedBytes = 0;
        this.#items.clear();
        this.#truncatedItems.clear();
        this.#listeners.clear();
        this.#snapshot = EMPTY_SNAPSHOT;
    }

    #flushFrame(): void {
        this.#frame = undefined;
        if (this.#disposed || this.#pending.length === 0) {
            return;
        }
        const pending = this.#pending.splice(0);
        this.#queuedBytes = 0;
        let changed = false;
        for (const batch of pending) {
            changed = this.#applyBatch(batch) || changed;
        }
        if (!changed) {
            return;
        }
        this.#trimRetained();
        this.#snapshot = this.#buildSnapshot();
        for (const listener of [...this.#listeners]) {
            try {
                listener(this.#snapshot);
            } catch {
                // UI observers cannot own reducer scheduling.
            }
        }
    }

    #applyBatch(batch: RideCodexEventBatch): boolean {
        if (batch.generation < this.#generation) {
            return false;
        }
        const startsTurn = batch.events.some(event => event.type === 'turn-started');
        if (batch.generation > this.#generation) {
            if (!startsTurn) {
                return false;
            }
            this.#resetFor(batch);
        } else if (this.#turnId !== undefined
            && (batch.threadId !== this.#threadId || batch.turnId !== this.#turnId)) {
            if (startsTurn && this.#isTerminal()) {
                this.#resetFor(batch);
            } else {
                return false;
            }
        }
        if (this.#turnId === undefined) {
            if (!startsTurn) {
                return false;
            }
            this.#resetFor(batch);
        }
        let changed = false;
        for (const event of batch.events) {
            changed = this.#applyEvent(event) || changed;
        }
        return changed;
    }

    #resetFor(batch: RideCodexEventBatch): void {
        this.#generation = batch.generation;
        this.#threadId = batch.threadId;
        this.#turnId = batch.turnId;
        this.#status = 'idle';
        this.#items.clear();
        this.#truncatedItems.clear();
        this.#plan = undefined;
        this.#diff = undefined;
        this.#usage = undefined;
        this.#warnings = [];
        this.#errors = [];
    }

    #applyEvent(event: RideCodexUiEvent): boolean {
        if (this.#isTerminal()) {
            return false;
        }
        switch (event.type) {
            case 'turn-started':
                if (this.#status !== 'idle') {
                    return false;
                }
                this.#status = 'in-progress';
                return true;
            case 'turn-terminal':
                this.#status = event.status;
                if (event.error) {
                    this.#pushError({
                        type: 'error', code: event.error.code, message: event.error.message, retryable: false
                    });
                }
                return true;
            case 'item-started':
                return this.#startItem(event.itemId, event.itemKind);
            case 'item-completed':
                return this.#completeItem(event.itemId, event.itemKind);
            case 'agent-delta':
                return this.#append(event.itemId, 'agent-message', event.delta);
            case 'plan-delta':
                return this.#append(event.itemId, 'plan', event.delta);
            case 'command-output':
                return this.#append(event.itemId, 'command', event.delta);
            case 'file-output':
                return this.#append(event.itemId, 'file-change', event.delta);
            case 'reasoning-summary-part':
                return this.#ensureSummary(event.itemId, event.summaryIndex);
            case 'reasoning-summary-delta':
                return this.#appendSummary(event.itemId, event.summaryIndex, event.delta);
            case 'file-patch': {
                const item = this.#item(event.itemId, 'file-change');
                item.changes = event.changes.map(change => ({ ...change }));
                return true;
            }
            case 'turn-plan':
                this.#plan = deepFreezeRideCodex({
                    ...(event.explanation === undefined ? {} : { explanation: event.explanation }),
                    steps: event.steps.map(step => ({ ...step }))
                }) as RideCodexTurnSnapshot['plan'];
                return true;
            case 'turn-diff':
                this.#diff = truncateUtf8(event.diff, this.#maxItemBytes);
                return true;
            case 'token-usage':
                this.#usage = Object.freeze({
                    totalTokens: event.totalTokens,
                    inputTokens: event.inputTokens,
                    outputTokens: event.outputTokens
                });
                return true;
            case 'warning':
                this.#pushWarning(event);
                return true;
            case 'error':
                this.#pushError(event);
                return true;
        }
    }

    #startItem(id: string, kind: RideCodexItemKind): boolean {
        if (this.#items.has(id)) {
            return false;
        }
        this.#items.set(id, { id, kind, state: 'started', text: '', summaries: [], changes: [] });
        this.#trimItemsByCount();
        return true;
    }

    #completeItem(id: string, kind: RideCodexItemKind): boolean {
        const item = this.#item(id, kind);
        if (item.state === 'completed') {
            return false;
        }
        item.state = 'completed';
        return true;
    }

    #item(id: string, kind: RideCodexItemKind): MutableItem {
        let item = this.#items.get(id);
        if (!item) {
            item = { id, kind, state: 'started', text: '', summaries: [], changes: [] };
            this.#items.set(id, item);
            this.#trimItemsByCount();
        }
        return item;
    }

    #append(id: string, kind: RideCodexItemKind, delta: string): boolean {
        const item = this.#item(id, kind);
        const combined = item.text + delta;
        const next = truncateUtf8(combined, this.#maxItemBytes);
        let warned = false;
        if (next !== combined && !this.#truncatedItems.has(id)) {
            this.#truncatedItems.add(id);
            this.#pushWarning({
                type: 'warning', code: 'data-truncated',
                message: 'A Codex UI item was truncated to preserve responsiveness.'
            });
            warned = true;
        }
        if (next === item.text) {
            return warned;
        }
        item.text = next;
        return true;
    }

    #ensureSummary(id: string, index: number): boolean {
        const item = this.#item(id, 'reasoning');
        if (item.summaries[index] !== undefined) {
            return false;
        }
        while (item.summaries.length <= index) {
            item.summaries.push('');
        }
        return true;
    }

    #appendSummary(id: string, index: number, delta: string): boolean {
        const item = this.#item(id, 'reasoning');
        this.#ensureSummary(id, index);
        const current = item.summaries[index] ?? '';
        const otherBytes = utf8ByteLength(item.text)
            + item.summaries.reduce((sum, value, position) => position === index ? sum : sum + utf8ByteLength(value), 0);
        const next = truncateUtf8(current + delta, Math.max(0, this.#maxItemBytes - otherBytes));
        if (next === current) {
            return false;
        }
        item.summaries[index] = next;
        return true;
    }

    #pushWarning(event: Extract<RideCodexUiEvent, { type: 'warning' }>): void {
        this.#warnings.push(deepFreezeRideCodex({ ...event }) as typeof event);
        this.#warnings.splice(0, Math.max(0, this.#warnings.length - this.#maxDiagnosticHistory));
    }

    #pushError(event: Extract<RideCodexUiEvent, { type: 'error' }>): void {
        const previous = this.#errors[this.#errors.length - 1];
        if (previous && previous.code === event.code && previous.message === event.message
            && previous.retryable === event.retryable) {
            return;
        }
        this.#errors.push(deepFreezeRideCodex({ ...event }) as typeof event);
        this.#errors.splice(0, Math.max(0, this.#errors.length - this.#maxDiagnosticHistory));
    }

    #trimItemsByCount(): void {
        while (this.#items.size > this.#maxRetainedItems) {
            const oldest = this.#items.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.#items.delete(oldest);
            this.#truncatedItems.delete(oldest);
        }
    }

    #trimRetained(): void {
        this.#trimItemsByCount();
        while (this.#retainedBytes() > this.#maxRetainedBytes && this.#items.size > 0) {
            const oldest = this.#items.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.#items.delete(oldest);
            this.#truncatedItems.delete(oldest);
        }
    }

    #retainedBytes(): number {
        let bytes = 0;
        for (const item of this.#items.values()) {
            bytes += utf8ByteLength(item.id) + utf8ByteLength(item.text);
            bytes += item.summaries.reduce((sum, summary) => sum + utf8ByteLength(summary), 0);
            bytes += item.changes.reduce((sum, change) =>
                sum + utf8ByteLength(change.path) + utf8ByteLength(change.kind)
                + (change.diff === undefined ? 0 : utf8ByteLength(change.diff)), 0);
        }
        return bytes;
    }

    #buildSnapshot(): RideCodexTurnSnapshot {
        const items: RideCodexRenderedItem[] = [...this.#items.values()].map(item => ({
            id: item.id,
            kind: item.kind,
            state: item.state,
            text: item.text,
            summaries: [...item.summaries],
            changes: item.changes.map(change => ({ ...change }))
        }));
        return deepFreezeRideCodex({
            generation: this.#generation,
            ...(this.#threadId === undefined ? {} : { threadId: this.#threadId }),
            ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
            status: this.#status,
            items,
            ...(this.#plan === undefined ? {} : { plan: this.#plan }),
            ...(this.#diff === undefined ? {} : { diff: this.#diff }),
            ...(this.#usage === undefined ? {} : { usage: this.#usage }),
            warnings: [...this.#warnings],
            errors: [...this.#errors],
            retainedBytes: this.#retainedBytes()
        }) as RideCodexTurnSnapshot;
    }

    #isTerminal(): boolean {
        return this.#status === 'completed' || this.#status === 'failed'
            || this.#status === 'interrupted' || this.#status === 'interrupt-uncertain';
    }
}

function defaultScheduleFrame(callback: () => void): RideCodexFrameDisposable {
    if (typeof requestAnimationFrame === 'function') {
        const animationFrameHandle = requestAnimationFrame(callback);
        return { dispose: () => cancelAnimationFrame(animationFrameHandle) };
    }
    const timerHandle = setTimeout(callback, 16);
    return { dispose: () => clearTimeout(timerHandle) };
}

function positiveLimit(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback;
}

function copySafeBatch(value: RideCodexEventBatch, maxRawBytes: number): RideCodexEventBatch | undefined {
    const copied = copyData(value, 0, { nodes: 0, bytes: 0, maxBytes: maxRawBytes });
    if (!isPlainRecord(copied)) {
        return undefined;
    }
    const generation = copied.generation;
    const threadId = copied.threadId;
    const turnId = copied.turnId;
    const events = copied.events;
    if (!Number.isSafeInteger(generation) || (generation as number) < 0
        || typeof threadId !== 'string' || threadId.length === 0
        || typeof turnId !== 'string' || turnId.length === 0
        || !Array.isArray(events) || events.length === 0 || events.length > 8_192) {
        return undefined;
    }
    if (events.some(event => !isUiEvent(event))) {
        return undefined;
    }
    return {
        generation: generation as number,
        threadId,
        turnId,
        events: events as RideCodexUiEvent[]
    };
}

function isUiEvent(value: unknown): value is RideCodexUiEvent {
    if (!isPlainRecord(value) || typeof value.type !== 'string') {
        return false;
    }
    const identifier = (candidate: unknown): candidate is string =>
        typeof candidate === 'string' && candidate.length > 0;
    const text = (candidate: unknown): candidate is string => typeof candidate === 'string';
    const index = (candidate: unknown): candidate is number =>
        Number.isSafeInteger(candidate) && (candidate as number) >= 0;
    switch (value.type) {
        case 'turn-started':
            return true;
        case 'turn-terminal':
            return ['completed', 'failed', 'interrupted', 'interrupt-uncertain'].includes(value.status as string)
                && (value.error === undefined || (isPlainRecord(value.error)
                    && text(value.error.code) && text(value.error.message)));
        case 'item-started':
        case 'item-completed':
            return identifier(value.itemId) && text(value.itemKind);
        case 'agent-delta':
        case 'plan-delta':
        case 'command-output':
        case 'file-output':
            return identifier(value.itemId) && text(value.delta);
        case 'reasoning-summary-delta':
            return identifier(value.itemId) && index(value.summaryIndex) && text(value.delta);
        case 'reasoning-summary-part':
            return identifier(value.itemId) && index(value.summaryIndex);
        case 'file-patch':
            return identifier(value.itemId) && Array.isArray(value.changes)
                && value.changes.every(change => isPlainRecord(change)
                    && text(change.path) && text(change.kind)
                    && (change.diff === undefined || text(change.diff)));
        case 'turn-plan':
            return (value.explanation === undefined || text(value.explanation))
                && Array.isArray(value.steps) && value.steps.every(step =>
                    isPlainRecord(step) && text(step.step)
                    && ['pending', 'in-progress', 'completed'].includes(step.status as string)
                );
        case 'turn-diff':
            return text(value.diff);
        case 'token-usage':
            return index(value.totalTokens) && index(value.inputTokens) && index(value.outputTokens);
        case 'warning':
            return ['server-warning', 'events-dropped', 'data-truncated'].includes(value.code as string)
                && text(value.message)
                && (value.droppedEvents === undefined || index(value.droppedEvents))
                && (value.droppedBytes === undefined || index(value.droppedBytes));
        case 'error':
            return ['turn-error', 'operation-failed', 'interrupt-timeout', 'recovery-failed'].includes(value.code as string)
                && text(value.message) && typeof value.retryable === 'boolean';
        default:
            return false;
    }
}

interface CopyBudget {
    nodes: number;
    bytes: number;
    readonly maxBytes: number;
}

function copyData(value: unknown, depth: number, budget: CopyBudget): unknown {
    budget.nodes += 1;
    if (depth > 16 || budget.nodes > 8_192) {
        return undefined;
    }
    if (typeof value === 'string') {
        budget.bytes += utf8ByteLength(value);
        return budget.bytes <= budget.maxBytes ? value : undefined;
    }
    if (!value || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value !== 'object') {
        return undefined;
    }
    let descriptors: PropertyDescriptorMap;
    let prototype: object | undefined;
    try {
        descriptors = Object.getOwnPropertyDescriptors(value);
        prototype = Object.getPrototypeOf(value) || undefined;
    } catch {
        return undefined;
    }
    if (Object.values(descriptors).some(descriptor => descriptor.get || descriptor.set)) {
        return undefined;
    }
    if (Array.isArray(value)) {
        const length = descriptors.length?.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > 8_192) {
            return undefined;
        }
        const arrayResult: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
            const descriptor = descriptors[String(index)];
            if (!descriptor) {
                return undefined;
            }
            const child = copyData(descriptor.value, depth + 1, budget);
            if (child === undefined && descriptor.value !== undefined) {
                return undefined;
            }
            arrayResult.push(child);
        }
        return arrayResult;
    }
    if (prototype !== Object.prototype && prototype) {
        return undefined;
    }
    const keys = Object.keys(descriptors);
    if (keys.length > 128 || Object.getOwnPropertySymbols(value).length > 0) {
        return undefined;
    }
    const objectResult: Record<string, unknown> = {};
    for (const key of keys) {
        const descriptor = descriptors[key];
        const child = copyData(descriptor.value, depth + 1, budget);
        if (child === undefined && descriptor.value !== undefined) {
            return undefined;
        }
        objectResult[key] = child;
    }
    return objectResult;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function estimateEventBytes(event: RideCodexUiEvent): number {
    try {
        return utf8ByteLength(JSON.stringify(event));
    } catch {
        return Number.MAX_SAFE_INTEGER;
    }
}
