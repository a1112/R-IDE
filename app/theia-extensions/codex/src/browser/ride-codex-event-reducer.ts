/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    deepFreezeRideCodex,
    RideCodexEventBatch,
    RideCodexEventBatchWire,
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
    readonly maxWireBytes?: number;
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
    reasoning: string[];
    changes: RideCodexFileChange[];
}

const DEFAULT_MAX_QUEUED_BYTES = 256 * 1024;
const DEFAULT_MAX_WIRE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BATCH_EVENTS = 4_096;
const DEFAULT_MAX_ITEM_BYTES = 64 * 1024;
const DEFAULT_MAX_RETAINED_ITEMS = 256;
const DEFAULT_MAX_RETAINED_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DIAGNOSTIC_HISTORY = 64;
const MAX_FILE_PATCH_PATH_BYTES = 32 * 1024;
const MAX_FILE_PATCH_DIFF_BYTES = 64 * 1024;
const MAX_IDENTIFIER_BYTES = 512;
const MAX_REASONING_INDEX = 1_024;
const RETAINED_ARRAY_SLOT_BYTES = 8;
const MAX_WIRE_DEPTH = 16;
const MAX_WIRE_NODES = 8_192;
const MAX_WIRE_ARRAY_ITEMS = 8_192;
const MAX_WIRE_OBJECT_KEYS = 128;
const MIN_COHERENT_BOUNDARY_BYTES = pendingBatchBytes({
    generation: 0,
    threadId: 'x',
    turnId: 'x',
    events: [
        { type: 'turn-started' },
        { type: 'turn-terminal', status: 'completed' }
    ]
});

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
    readonly #maxWireBytes: number;
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
        this.#maxWireBytes = positiveLimit(options.maxWireBytes, DEFAULT_MAX_WIRE_BYTES);
        this.#maxQueuedBytes = Math.max(
            MIN_COHERENT_BOUNDARY_BYTES,
            positiveLimit(options.maxQueuedBytes, DEFAULT_MAX_QUEUED_BYTES)
        );
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

    notifyMany(wire: RideCodexEventBatchWire): void {
        if (this.#disposed) {
            return;
        }
        const safeBatch = parseSafeBatch(wire, this.#maxWireBytes);
        if (!safeBatch) {
            return;
        }
        const sourceEvents = safeBatch.events;
        const selected = selectPriorityEvents(sourceEvents, this.#maxBatchEvents);
        const fitted = fitBatchEvents(safeBatch, selected, this.#maxBatchEvents, this.#maxQueuedBytes);
        if (fitted.events.length === 0) {
            return;
        }
        const pending = deepFreezeRideCodex({
            generation: safeBatch.generation,
            threadId: safeBatch.threadId,
            turnId: safeBatch.turnId,
            events: fitted.events
        }) as RideCodexEventBatch;
        this.#enqueuePending(pending, sourceEvents.length - selected.length + fitted.dropped);
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
        const terminatesTurn = batch.events.some(event => event.type === 'turn-terminal');
        if (batch.generation > this.#generation) {
            if (!startsTurn && !terminatesTurn) {
                return false;
            }
            this.#resetFor(batch);
        } else if (this.#turnId !== undefined
            && (batch.threadId !== this.#threadId || batch.turnId !== this.#turnId)) {
            if ((startsTurn && this.#isTerminal()) || terminatesTurn) {
                this.#resetFor(batch);
            } else {
                return false;
            }
        }
        if (this.#turnId === undefined) {
            if (!startsTurn && !terminatesTurn) {
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

    #enqueuePending(incoming: RideCodexEventBatch, initialDropped: number): void {
        let dropped = initialDropped;
        const events: RideCodexUiEvent[] = [];
        const matching: number[] = [];
        for (let index = 0; index < this.#pending.length; index += 1) {
            const pending = this.#pending[index];
            if (!sameBatchIdentity(pending, incoming)) {
                continue;
            }
            matching.push(index);
            for (const event of pending.events) {
                if (event.type === 'warning' && event.code === 'events-dropped') {
                    dropped = saturatingAdd(dropped, event.droppedEvents ?? 1);
                } else {
                    events.push(event);
                }
            }
        }
        for (const event of incoming.events) {
            if (event.type === 'warning' && event.code === 'events-dropped') {
                dropped = saturatingAdd(dropped, event.droppedEvents ?? 1);
            } else {
                events.push(event);
            }
        }
        const fitted = fitBatchEvents(incoming, events, this.#maxBatchEvents, this.#maxQueuedBytes);
        if (fitted.events.length === 0) {
            return;
        }
        dropped = saturatingAdd(dropped, fitted.dropped);

        for (let position = matching.length - 1; position >= 0; position -= 1) {
            const index = matching[position];
            const [removed] = this.#pending.splice(index, 1);
            this.#queuedBytes -= pendingBatchBytes(removed);
        }

        let accepted = [...fitted.events];
        let candidate = freezePendingBatch(incoming, accepted);
        dropped = saturatingAdd(dropped, this.#makePendingRoom(pendingBatchBytes(candidate), incoming));
        if (dropped > 0) {
            const warned = addDropWarning(
                incoming, accepted, dropped, this.#maxBatchEvents, this.#maxQueuedBytes
            );
            accepted = [...warned.events];
            dropped = warned.dropped;
            candidate = freezePendingBatch(incoming, accepted);
            const reserved = reserveDropWarningCount(candidate);
            const pressureDropped = this.#makePendingRoom(pendingBatchBytes(reserved), incoming);
            if (pressureDropped > 0) {
                dropped = saturatingAdd(dropped, pressureDropped);
                candidate = freezePendingBatch(incoming, replaceDropWarningCount(accepted, dropped));
            }
        }
        const candidateBytes = pendingBatchBytes(candidate);
        if (candidate.events.length === 0 || candidateBytes > this.#maxQueuedBytes
            || this.#queuedBytes + candidateBytes > this.#maxQueuedBytes) {
            return;
        }
        this.#pending.push(candidate);
        this.#queuedBytes += candidateBytes;
    }

    #makePendingRoom(requiredBytes: number, incoming: RideCodexEventBatch): number {
        let dropped = 0;
        while (this.#queuedBytes + requiredBytes > this.#maxQueuedBytes) {
            let removed = false;
            for (let batchIndex = 0; batchIndex < this.#pending.length; batchIndex += 1) {
                const pendingBatch = this.#pending[batchIndex];
                const eventIndex = pendingBatch.events.findIndex(event => !isTurnBoundary(event));
                if (eventIndex < 0) {
                    continue;
                }
                const events = pendingBatch.events.filter((_event, index) => index !== eventIndex);
                const previousBytes = pendingBatchBytes(pendingBatch);
                if (events.length === 0) {
                    this.#pending.splice(batchIndex, 1);
                    this.#queuedBytes -= previousBytes;
                } else {
                    const replacement = deepFreezeRideCodex({ ...pendingBatch, events }) as RideCodexEventBatch;
                    this.#pending[batchIndex] = replacement;
                    this.#queuedBytes -= previousBytes - pendingBatchBytes(replacement);
                }
                dropped += 1;
                removed = true;
                break;
            }
            if (removed) {
                continue;
            }
            const identityIndex = this.#pending.findIndex(pendingBatch =>
                pendingBatch.generation !== incoming.generation
                || pendingBatch.threadId !== incoming.threadId || pendingBatch.turnId !== incoming.turnId
            );
            if (identityIndex < 0) {
                break;
            }
            const [removedBatch] = this.#pending.splice(identityIndex, 1);
            this.#queuedBytes -= pendingBatchBytes(removedBatch);
            dropped += removedBatch.events.length;
        }
        return dropped;
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
            case 'reasoning-delta':
                return this.#appendReasoning(event.itemId, event.contentIndex, event.delta);
            case 'file-patch':
                return this.#replaceChanges(event.itemId, event.changes);
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
        this.#items.set(id, { id, kind, state: 'started', text: '', summaries: [], reasoning: [], changes: [] });
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
            item = { id, kind, state: 'started', text: '', summaries: [], reasoning: [], changes: [] };
            this.#items.set(id, item);
            this.#trimItemsByCount();
        }
        return item;
    }

    #append(id: string, kind: RideCodexItemKind, delta: string): boolean {
        const item = this.#item(id, kind);
        const combined = item.text + delta;
        const available = this.#availableItemBytes(item, utf8ByteLength(item.text));
        const next = truncateUtf8(combined, available);
        const warned = next !== combined && this.#warnItemTruncated(id);
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
        const combined = current + delta;
        const available = this.#availableItemBytes(item, utf8ByteLength(current));
        const next = truncateUtf8(combined, available);
        const warned = next !== combined && this.#warnItemTruncated(id);
        if (next === current) {
            return warned;
        }
        item.summaries[index] = next;
        return true;
    }

    #appendReasoning(id: string, index: number, delta: string): boolean {
        const item = this.#item(id, 'reasoning');
        while (item.reasoning.length <= index) {
            item.reasoning.push('');
        }
        const current = item.reasoning[index] ?? '';
        const combined = current + delta;
        const available = this.#availableItemBytes(item, utf8ByteLength(current));
        const next = truncateUtf8(combined, available);
        const warned = next !== combined && this.#warnItemTruncated(id);
        if (next === current) {
            return warned;
        }
        item.reasoning[index] = next;
        return true;
    }

    #replaceChanges(id: string, changes: readonly RideCodexFileChange[]): boolean {
        const item = this.#item(id, 'file-change');
        const available = this.#availableItemBytes(item, fileChangeStringBytes(item.changes));
        const bounded = boundFileChanges(changes, available);
        const changed = !sameFileChanges(item.changes, bounded.changes);
        item.changes = bounded.changes;
        const warned = bounded.truncated && this.#warnItemTruncated(id);
        return warned || changed;
    }

    #availableItemBytes(item: MutableItem, replacedBytes: number): number {
        return Math.max(0, this.#maxItemBytes - (itemPayloadBytes(item) - replacedBytes));
    }

    #warnItemTruncated(id: string): boolean {
        if (this.#truncatedItems.has(id)) {
            return false;
        }
        this.#truncatedItems.add(id);
        this.#pushWarning({
            type: 'warning', code: 'data-truncated',
            message: 'A Codex UI item was truncated to preserve responsiveness.'
        });
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
            bytes += item.reasoning.reduce((sum, reasoning) => sum + utf8ByteLength(reasoning), 0);
            bytes += (item.summaries.length + item.reasoning.length) * RETAINED_ARRAY_SLOT_BYTES;
            bytes += item.changes.reduce((sum, change) =>
                sum + utf8ByteLength(change.path) + utf8ByteLength(change.kind)
                + utf8ByteLength(change.diff)
                + (change.kind === 'update' && typeof change.movePath === 'string'
                    ? utf8ByteLength(change.movePath) : 0), 0);
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
            reasoning: [...item.reasoning],
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

function parseSafeBatch(wire: RideCodexEventBatchWire, maxWireBytes: number): RideCodexEventBatch | undefined {
    if (typeof wire !== 'string' || utf8ByteLength(wire) > maxWireBytes) {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(wire) as unknown;
    } catch {
        return undefined;
    }
    if (!validateJsonGraph(parsed, 0, { nodes: 0, bytes: 0, maxBytes: maxWireBytes })
        || JSON.stringify(parsed) !== wire
        || !isPlainRecord(parsed)
        || !hasExactKeys(parsed, ['generation', 'threadId', 'turnId', 'events'])) {
        return undefined;
    }
    const generation = parsed.generation;
    const threadId = parsed.threadId;
    const turnId = parsed.turnId;
    const events = parsed.events;
    if (!Number.isSafeInteger(generation) || (generation as number) < 0
        || !isIdentifier(threadId) || !isIdentifier(turnId)
        || !Array.isArray(events) || events.length === 0 || events.length > 8_192) {
        return undefined;
    }
    if (events.some(event => !isUiEvent(event))) {
        return undefined;
    }
    return deepFreezeRideCodex({
        generation: generation as number,
        threadId,
        turnId,
        events: events as RideCodexUiEvent[]
    }) as RideCodexEventBatch;
}

function isUiEvent(value: unknown): value is RideCodexUiEvent {
    if (!isPlainRecord(value) || typeof value.type !== 'string') {
        return false;
    }
    const identifier = isIdentifier;
    const text = (candidate: unknown): candidate is string => typeof candidate === 'string';
    const nonnegativeInteger = (candidate: unknown): candidate is number =>
        Number.isSafeInteger(candidate) && (candidate as number) >= 0;
    const reasoningIndex = (candidate: unknown): candidate is number =>
        nonnegativeInteger(candidate) && candidate <= MAX_REASONING_INDEX;
    switch (value.type) {
        case 'turn-started':
            return hasExactKeys(value, ['type']);
        case 'turn-terminal':
            return hasExactKeys(value, ['type', 'status'], ['error'])
                && ['completed', 'failed', 'interrupted', 'interrupt-uncertain'].includes(value.status as string)
                && (value.error === undefined || (isPlainRecord(value.error)
                    && hasExactKeys(value.error, ['code', 'message'])
                    && ['turn-error', 'operation-failed', 'interrupt-timeout', 'recovery-failed'].includes(value.error.code as string)
                    && text(value.error.message)));
        case 'item-started':
        case 'item-completed':
            return hasExactKeys(value, ['type', 'itemId', 'itemKind'])
                && identifier(value.itemId)
                && ['user-message', 'agent-message', 'plan', 'reasoning', 'command', 'file-change', 'other'].includes(value.itemKind as string);
        case 'agent-delta':
        case 'plan-delta':
        case 'command-output':
        case 'file-output':
            return hasExactKeys(value, ['type', 'itemId', 'delta'])
                && identifier(value.itemId) && text(value.delta);
        case 'reasoning-summary-delta':
            return hasExactKeys(value, ['type', 'itemId', 'summaryIndex', 'delta'])
                && identifier(value.itemId) && reasoningIndex(value.summaryIndex) && text(value.delta);
        case 'reasoning-delta':
            return hasExactKeys(value, ['type', 'itemId', 'contentIndex', 'delta'])
                && identifier(value.itemId) && reasoningIndex(value.contentIndex) && text(value.delta);
        case 'reasoning-summary-part':
            return hasExactKeys(value, ['type', 'itemId', 'summaryIndex'])
                && identifier(value.itemId) && reasoningIndex(value.summaryIndex);
        case 'file-patch':
            return hasOnlyKeys(value, ['type', 'itemId', 'changes'])
                && identifier(value.itemId) && Array.isArray(value.changes)
                && value.changes.every(isFileChange);
        case 'turn-plan':
            return hasExactKeys(value, ['type', 'steps'], ['explanation'])
                && (value.explanation === undefined || text(value.explanation))
                && Array.isArray(value.steps) && value.steps.every(step =>
                    isPlainRecord(step) && hasExactKeys(step, ['step', 'status']) && text(step.step)
                    && ['pending', 'in-progress', 'completed'].includes(step.status as string)
                );
        case 'turn-diff':
            return hasExactKeys(value, ['type', 'diff']) && text(value.diff);
        case 'token-usage':
            return hasExactKeys(value, ['type', 'totalTokens', 'inputTokens', 'outputTokens'])
                && nonnegativeInteger(value.totalTokens) && nonnegativeInteger(value.inputTokens)
                && nonnegativeInteger(value.outputTokens);
        case 'warning':
            return hasExactKeys(value, ['type', 'code', 'message'], ['droppedEvents', 'droppedBytes'])
                && ['server-warning', 'events-dropped', 'data-truncated'].includes(value.code as string)
                && text(value.message)
                && (value.droppedEvents === undefined || nonnegativeInteger(value.droppedEvents))
                && (value.droppedBytes === undefined || nonnegativeInteger(value.droppedBytes));
        case 'error':
            return hasExactKeys(value, ['type', 'code', 'message', 'retryable'])
                && ['turn-error', 'operation-failed', 'interrupt-timeout', 'recovery-failed'].includes(value.code as string)
                && text(value.message) && typeof value.retryable === 'boolean';
        default:
            return false;
    }
}

function isFileChange(value: unknown): value is RideCodexFileChange {
    if (!isPlainRecord(value) || !isDisplayPath(value.path)
        || typeof value.diff !== 'string'
        || utf8ByteLength(value.diff) > MAX_FILE_PATCH_DIFF_BYTES) {
        return false;
    }
    if (value.kind === 'add' || value.kind === 'delete') {
        return hasOnlyKeys(value, ['path', 'kind', 'diff']);
    }
    if (value.kind !== 'update' || !hasOnlyKeys(value, ['path', 'kind', 'diff', 'movePath'])) {
        return false;
    }
    return isOptionalDisplayPath(value.movePath);
}

function isDisplayPath(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0
        && utf8ByteLength(value) <= MAX_FILE_PATCH_PATH_BYTES
        && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isOptionalDisplayPath(value: unknown): value is string | null | undefined {
    return value === undefined || (!value && typeof value === 'object') || isDisplayPath(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    return Object.keys(value).every(key => allowed.includes(key));
}

function hasExactKeys(
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = []
): boolean {
    const keys = Object.keys(value);
    return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
        && keys.every(key => required.includes(key) || optional.includes(key));
}

function isIdentifier(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0
        && utf8ByteLength(value) <= MAX_IDENTIFIER_BYTES;
}

interface WireBudget {
    nodes: number;
    bytes: number;
    readonly maxBytes: number;
}

function validateJsonGraph(value: unknown, depth: number, budget: WireBudget): boolean {
    budget.nodes += 1;
    if (depth > MAX_WIRE_DEPTH || budget.nodes > MAX_WIRE_NODES) {
        return false;
    }
    if (typeof value === 'string') {
        budget.bytes += utf8ByteLength(value);
        return budget.bytes <= budget.maxBytes;
    }
    if (!value || typeof value === 'boolean') {
        return true;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value);
    }
    if (typeof value !== 'object') {
        return false;
    }
    if (Array.isArray(value)) {
        if (value.length > MAX_WIRE_ARRAY_ITEMS) {
            return false;
        }
        return value.every(child => validateJsonGraph(child, depth + 1, budget));
    }
    if (!isPlainRecord(value)) {
        return false;
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_WIRE_OBJECT_KEYS) {
        return false;
    }
    for (const key of keys) {
        budget.bytes += utf8ByteLength(key);
        if (budget.bytes > budget.maxBytes || !validateJsonGraph(value[key], depth + 1, budget)) {
            return false;
        }
    }
    return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || !prototype;
}

function itemPayloadBytes(item: MutableItem): number {
    return utf8ByteLength(item.text)
        + item.summaries.reduce((sum, value) => sum + utf8ByteLength(value), 0)
        + item.reasoning.reduce((sum, value) => sum + utf8ByteLength(value), 0)
        + fileChangeStringBytes(item.changes);
}

function fileChangeStringBytes(changes: readonly RideCodexFileChange[]): number {
    return changes.reduce((sum, change) => sum
        + utf8ByteLength(change.path)
        + utf8ByteLength(change.diff)
        + (change.kind === 'update' && typeof change.movePath === 'string'
            ? utf8ByteLength(change.movePath) : 0), 0);
}

function boundFileChanges(
    changes: readonly RideCodexFileChange[],
    maxBytes: number
): { readonly changes: RideCodexFileChange[]; readonly truncated: boolean } {
    const bounded: RideCodexFileChange[] = [];
    let remaining = maxBytes;
    let truncated = false;
    for (const change of changes) {
        const path = truncateUtf8(change.path, remaining);
        if (path.length === 0) {
            truncated = true;
            break;
        }
        if (path !== change.path) {
            truncated = true;
        }
        remaining -= utf8ByteLength(path);

        const diff = truncateUtf8(change.diff, remaining);
        if (diff !== change.diff) {
            truncated = true;
        }
        remaining -= utf8ByteLength(diff);

        if (change.kind !== 'update') {
            bounded.push({ path, kind: change.kind, diff });
            continue;
        }
        if (typeof change.movePath !== 'string') {
            bounded.push({
                path,
                kind: 'update',
                diff,
                ...(change.movePath === undefined ? {} : { movePath: change.movePath })
            });
            continue;
        }
        const movePath = truncateUtf8(change.movePath, remaining);
        if (movePath !== change.movePath) {
            truncated = true;
        }
        remaining -= utf8ByteLength(movePath);
        bounded.push({
            path,
            kind: 'update',
            diff,
            ...(movePath.length > 0 ? { movePath } : {})
        });
    }
    if (bounded.length < changes.length) {
        truncated = true;
    }
    return { changes: bounded, truncated };
}

function sameFileChanges(
    left: readonly RideCodexFileChange[],
    right: readonly RideCodexFileChange[]
): boolean {
    return left.length === right.length && left.every((change, index) => {
        const other = right[index];
        return change.path === other.path && change.kind === other.kind && change.diff === other.diff
            && (change.kind !== 'update' || other.kind !== 'update' || change.movePath === other.movePath);
    });
}

function fitBatchEvents(
    batch: Pick<RideCodexEventBatch, 'generation' | 'threadId' | 'turnId'>,
    sourceEvents: readonly RideCodexUiEvent[],
    maxEvents: number,
    maxBytes: number
): { readonly events: readonly RideCodexUiEvent[]; readonly dropped: number } {
    const events = [...selectPriorityEvents(sourceEvents, maxEvents)];
    let dropped = sourceEvents.length - events.length;
    while (events.length > 0 && pendingBatchBytes({ ...batch, events }) > maxBytes) {
        const removable = findLastOrdinaryEvent(events);
        if (removable < 0) {
            return { events: [], dropped: saturatingAdd(dropped, events.length) };
        }
        events.splice(removable, 1);
        dropped = saturatingAdd(dropped, 1);
    }
    return { events, dropped };
}

function addDropWarning(
    batch: Pick<RideCodexEventBatch, 'generation' | 'threadId' | 'turnId'>,
    sourceEvents: readonly RideCodexUiEvent[],
    initialDropped: number,
    maxEvents: number,
    maxBytes: number
): { readonly events: readonly RideCodexUiEvent[]; readonly dropped: number } {
    const events = [...sourceEvents];
    let dropped = initialDropped;
    while (events.length > 0) {
        const warning = dropWarning(dropped);
        const terminalIndex = events.findIndex(event => event.type === 'turn-terminal');
        const insertionIndex = terminalIndex < 0 ? events.length : terminalIndex;
        const candidate = [...events];
        candidate.splice(insertionIndex, 0, warning);
        const reserved = replaceDropWarningCount(candidate, Number.MAX_SAFE_INTEGER);
        if (candidate.length <= maxEvents && pendingBatchBytes({ ...batch, events: reserved }) <= maxBytes) {
            return { events: candidate, dropped };
        }
        const removable = findLastOrdinaryEvent(events);
        if (removable < 0) {
            break;
        }
        events.splice(removable, 1);
        dropped = saturatingAdd(dropped, 1);
    }
    return { events, dropped };
}

function dropWarning(droppedEvents: number): Extract<RideCodexUiEvent, { type: 'warning' }> {
    return {
        type: 'warning',
        code: 'events-dropped',
        message: 'Codex UI events were dropped.',
        droppedEvents
    };
}

function replaceDropWarningCount(
    events: readonly RideCodexUiEvent[],
    droppedEvents: number
): readonly RideCodexUiEvent[] {
    return events.map(event => event.type === 'warning' && event.code === 'events-dropped'
        ? dropWarning(droppedEvents) : event);
}

function reserveDropWarningCount(batch: RideCodexEventBatch): RideCodexEventBatch {
    return freezePendingBatch(batch, replaceDropWarningCount(batch.events, Number.MAX_SAFE_INTEGER));
}

function freezePendingBatch(
    identity: Pick<RideCodexEventBatch, 'generation' | 'threadId' | 'turnId'>,
    events: readonly RideCodexUiEvent[]
): RideCodexEventBatch {
    return deepFreezeRideCodex({
        generation: identity.generation,
        threadId: identity.threadId,
        turnId: identity.turnId,
        events
    }) as RideCodexEventBatch;
}

function sameBatchIdentity(left: RideCodexEventBatch, right: RideCodexEventBatch): boolean {
    return left.generation === right.generation
        && left.threadId === right.threadId && left.turnId === right.turnId;
}

function saturatingAdd(left: number, right: number): number {
    return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function pendingBatchBytes(batch: RideCodexEventBatch): number {
    return utf8ByteLength(JSON.stringify(batch));
}

function isTurnBoundary(event: RideCodexUiEvent): boolean {
    return event.type === 'turn-started' || event.type === 'turn-terminal';
}

function findLastOrdinaryEvent(events: readonly RideCodexUiEvent[]): number {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (!isTurnBoundary(events[index])) {
            return index;
        }
    }
    return -1;
}

function selectPriorityEvents(
    events: readonly RideCodexUiEvent[],
    limit: number
): readonly RideCodexUiEvent[] {
    const selected: Array<{ readonly event: RideCodexUiEvent; readonly index: number }> = [];
    for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (selected.length < limit) {
            selected.push({ event, index });
            continue;
        }
        if (!isTurnBoundary(event)) {
            continue;
        }
        const removable = findLastOrdinaryEvent(selected.map(entry => entry.event));
        if (removable >= 0) {
            selected.splice(removable, 1, { event, index });
        }
    }
    selected.sort((left, right) => left.index - right.index);
    return selected.map(entry => entry.event);
}
