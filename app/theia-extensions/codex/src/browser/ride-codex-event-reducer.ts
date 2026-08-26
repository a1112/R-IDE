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
    RIDE_CODEX_MAX_IDENTIFIER_BYTES,
    RIDE_CODEX_MIN_QUEUED_BYTES,
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
    omittedUtf8Bytes: number;
    omittedChanges: number;
    omittedPaths: number;
}

interface TurnAuthority {
    readonly generation: number;
    readonly turnSequence: number;
    readonly threadId: string;
    readonly turnId: string;
    readonly terminal: boolean;
}

interface PendingEntry {
    readonly batch: RideCodexEventBatch;
    readonly originalIndex: number;
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
const MAX_REASONING_INDEX = 1_024;
const RETAINED_ARRAY_SLOT_BYTES = 8;
const MAX_RETAINED_PLAN_STEPS = 256;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_HISTORY_LIMIT = 256;
const MAX_FINALIZED_IDENTITIES = 256;
const MAX_WIRE_DEPTH = 16;
const MAX_WIRE_NODES = 8_192;
const MAX_WIRE_ARRAY_ITEMS = 8_192;
const MAX_WIRE_OBJECT_KEYS = 128;
const REDUCER_ITEMS = new WeakSet<object>();
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
    readonly #finalizedIdentities = new Set<string>();
    #snapshot: RideCodexTurnSnapshot = EMPTY_SNAPSHOT;
    #frame: RideCodexFrameDisposable | undefined;
    #recoveryFailureRetained = false;
    #generation = 0;
    #highestTurnSequence: number | undefined;
    #threadId: string | undefined;
    #turnId: string | undefined;
    #status: RideCodexTurnSnapshot['status'] = 'idle';
    #plan: RideCodexTurnSnapshot['plan'];
    #diff: string | undefined;
    #usage: RideCodexTurnSnapshot['usage'];
    #warnings: Extract<RideCodexUiEvent, { type: 'warning' }>[] = [];
    #errors: Extract<RideCodexUiEvent, { type: 'error' }>[] = [];
    #diagnosticRetainedBytes = 0;
    #retentionTruncated = false;
    #disposed = false;

    constructor(options: RideCodexEventReducerOptions = {}) {
        this.#scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame;
        this.#maxWireBytes = positiveLimit(options.maxWireBytes, DEFAULT_MAX_WIRE_BYTES);
        this.#maxQueuedBytes = requireQueueLimit(options.maxQueuedBytes, DEFAULT_MAX_QUEUED_BYTES);
        this.#maxBatchEvents = requireBatchLimit(options.maxBatchEvents, DEFAULT_MAX_BATCH_EVENTS);
        this.#maxItemBytes = positiveLimit(options.maxItemBytes, DEFAULT_MAX_ITEM_BYTES);
        this.#maxRetainedItems = positiveLimit(options.maxRetainedItems, DEFAULT_MAX_RETAINED_ITEMS);
        this.#maxRetainedBytes = positiveLimit(options.maxRetainedBytes, DEFAULT_MAX_RETAINED_BYTES);
        this.#maxDiagnosticHistory = Math.min(
            positiveLimit(options.maxDiagnosticHistory, DEFAULT_MAX_DIAGNOSTIC_HISTORY),
            MAX_DIAGNOSTIC_HISTORY_LIMIT
        );
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
        if (!safeBatch || !this.#isAuthorizedForPending(safeBatch)) {
            return;
        }
        this.#rebuildPendingIdentity(safeBatch);
        if (this.#pending.length > 0 && !this.#frame) {
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
        this.#recoveryFailureRetained = false;
        this.#items.clear();
        this.#truncatedItems.clear();
        this.#finalizedIdentities.clear();
        this.#highestTurnSequence = undefined;
        this.#listeners.clear();
        this.#snapshot = EMPTY_SNAPSHOT;
    }

    #flushFrame(): void {
        this.#frame = undefined;
        if (this.#disposed || this.#pending.length === 0) {
            return;
        }
        const pending = this.#pending.splice(0);
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
        const identityKey = finalizedIdentityKey(batch);
        const currentFinalizedDiagnostic = this.#isTerminal()
            && isDiagnosticOnly(batch.events)
            && batch.generation === this.#generation
            && batch.turnSequence === this.#highestTurnSequence
            && batch.threadId === this.#threadId
            && batch.turnId === this.#turnId;
        if (batch.generation === this.#generation && this.#finalizedIdentities.has(identityKey)
            && !currentFinalizedDiagnostic) {
            return false;
        }
        const startsTurn = batch.events.some(event => event.type === 'turn-started');
        const terminatesTurn = batch.events.some(event => event.type === 'turn-terminal');
        if (batch.generation > this.#generation) {
            if (!startsTurn && !terminatesTurn) {
                return false;
            }
            this.#finalizedIdentities.clear();
            this.#resetFor(batch);
        } else if (this.#highestTurnSequence !== undefined
            && batch.turnSequence < this.#highestTurnSequence) {
            return false;
        } else if (this.#highestTurnSequence !== undefined
            && batch.turnSequence === this.#highestTurnSequence
            && (batch.threadId !== this.#threadId || batch.turnId !== this.#turnId)) {
            return false;
        } else if (this.#highestTurnSequence !== undefined
            && batch.turnSequence > this.#highestTurnSequence) {
            if (!startsTurn && !terminatesTurn) {
                return false;
            }
            this.#resetFor(batch);
        } else if (this.#turnId !== undefined
            && (batch.threadId !== this.#threadId || batch.turnId !== this.#turnId)) {
            if (this.#status === 'in-progress') {
                return false;
            }
            if (startsTurn && this.#isTerminal()) {
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
        if (this.#isTerminal()) {
            this.#rememberFinalized(identityKey);
        }
        return changed;
    }

    #isAuthorizedForPending(incoming: RideCodexEventBatch): boolean {
        const boundary = hasTurnBoundary(incoming.events);
        const authority = this.#highestPendingAuthority();
        if (!authority) {
            return boundary;
        }
        if (incoming.generation !== authority.generation) {
            return incoming.generation > authority.generation && boundary;
        }
        if (incoming.turnSequence !== authority.turnSequence) {
            return incoming.turnSequence > authority.turnSequence && boundary;
        }
        if (incoming.threadId !== authority.threadId || incoming.turnId !== authority.turnId) {
            return false;
        }
        return !authority.terminal || isDiagnosticOnly(incoming.events);
    }

    #highestPendingAuthority(): TurnAuthority | undefined {
        let authority: TurnAuthority | undefined;
        if (this.#highestTurnSequence !== undefined
            && this.#threadId !== undefined && this.#turnId !== undefined) {
            authority = {
                generation: this.#generation,
                turnSequence: this.#highestTurnSequence,
                threadId: this.#threadId,
                turnId: this.#turnId,
                terminal: this.#isTerminal()
            };
        }
        for (const batch of this.#pending) {
            if (!hasTurnBoundary(batch.events)) {
                continue;
            }
            const terminal = batch.events.some(event => event.type === 'turn-terminal');
            if (!authority || batch.generation > authority.generation
                || (batch.generation === authority.generation
                    && batch.turnSequence > authority.turnSequence)) {
                authority = {
                    generation: batch.generation,
                    turnSequence: batch.turnSequence,
                    threadId: batch.threadId,
                    turnId: batch.turnId,
                    terminal
                };
            } else if (batch.generation === authority.generation
                && batch.turnSequence === authority.turnSequence
                && batch.threadId === authority.threadId && batch.turnId === authority.turnId
                && terminal && !authority.terminal) {
                authority = { ...authority, terminal: true };
            }
        }
        return authority;
    }

    #rememberFinalized(identityKey: string): void {
        if (this.#finalizedIdentities.has(identityKey)) {
            return;
        }
        if (this.#finalizedIdentities.size >= MAX_FINALIZED_IDENTITIES) {
            const oldest = this.#finalizedIdentities.values().next().value as string | undefined;
            if (oldest !== undefined) {
                this.#finalizedIdentities.delete(oldest);
            }
        }
        this.#finalizedIdentities.add(identityKey);
    }

    #rebuildPendingIdentity(incoming: RideCodexEventBatch): void {
        let insertionIndex = this.#pending.length;
        let dropped = 0;
        const combinedEvents: RideCodexUiEvent[] = [];
        let remaining: readonly PendingEntry[] = this.#pending.map((batch, originalIndex) => ({
            batch, originalIndex
        }));
        remaining = remaining.filter(entry => {
            if (!sameBatchIdentity(entry.batch, incoming)) {
                return true;
            }
            insertionIndex = Math.min(insertionIndex, entry.originalIndex);
            for (const event of entry.batch.events) {
                if (isDropWarning(event)) {
                    dropped = saturatingAdd(dropped, event.droppedEvents ?? 1);
                } else {
                    combinedEvents.push(event);
                }
            }
            return false;
        });
        for (const event of incoming.events) {
            if (isDropWarning(event)) {
                dropped = saturatingAdd(dropped, event.droppedEvents ?? 1);
            } else {
                combinedEvents.push(event);
            }
        }

        let candidateEvents = dedupeProtectedPendingEvents(combinedEvents);
        let candidate = packPendingBatches(incoming, candidateEvents, this.#maxBatchEvents);
        let remainingBytes = pendingEntriesBytes(remaining);
        if (remainingBytes + pendingBatchesBytes(candidate) > this.#maxQueuedBytes) {
            const protectedEvents = candidateEvents.filter(isProtectedPendingEvent);
            dropped = saturatingAdd(dropped, candidateEvents.length - protectedEvents.length);
            candidateEvents = protectedEvents;
            candidate = packPendingBatches(incoming, candidateEvents, this.#maxBatchEvents);
        }

        if (remainingBytes + pendingBatchesBytes(candidate) > this.#maxQueuedBytes) {
            const compacted = compactOrdinaryPendingEntries(remaining);
            remaining = compacted.entries;
            dropped = saturatingAdd(dropped, compacted.dropped);
            remainingBytes = pendingEntriesBytes(remaining);
        }

        while (remainingBytes + pendingBatchesBytes(candidate) > this.#maxQueuedBytes) {
            const removableKey = remaining
                .map(entry => entry.batch)
                .find(batch => isOlderBatchIdentity(batch, incoming));
            if (!removableKey) {
                return;
            }
            const retained = remaining.filter(entry => !sameBatchIdentity(entry.batch, removableKey));
            dropped = saturatingAdd(dropped, remaining.reduce((count, entry) =>
                sameBatchIdentity(entry.batch, removableKey) ? count + entry.batch.events.length : count, 0));
            remaining = retained;
            remainingBytes = pendingEntriesBytes(remaining);
        }

        if (candidate.length === 0 && dropped === 0) {
            return;
        }
        if (dropped > 0) {
            const reservedEvents = [...candidateEvents, dropWarning(Number.MAX_SAFE_INTEGER)];
            const reserved = packPendingBatches(incoming, reservedEvents, this.#maxBatchEvents);
            if (remainingBytes + pendingBatchesBytes(reserved) <= this.#maxQueuedBytes) {
                candidateEvents = [...candidateEvents, dropWarning(dropped)];
                candidate = packPendingBatches(incoming, candidateEvents, this.#maxBatchEvents);
            }
        }
        if (candidate.length === 0
            || remainingBytes + pendingBatchesBytes(candidate) > this.#maxQueuedBytes) {
            return;
        }

        const rebuilt = remaining.map(entry => entry.batch);
        const targetIndex = remaining.findIndex(entry => entry.originalIndex >= insertionIndex);
        rebuilt.splice(targetIndex < 0 ? rebuilt.length : targetIndex, 0, ...candidate);
        this.#pending.splice(0, this.#pending.length, ...rebuilt);
    }

    #resetFor(batch: RideCodexEventBatch): void {
        this.#generation = batch.generation;
        this.#highestTurnSequence = batch.turnSequence;
        this.#recoveryFailureRetained = false;
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
        this.#diagnosticRetainedBytes = 0;
        this.#retentionTruncated = false;
    }

    #applyEvent(event: RideCodexUiEvent): boolean {
        if (this.#isTerminal()) {
            if (event.type === 'warning') {
                this.#pushWarning(event);
                return true;
            }
            if (event.type === 'error') {
                return this.#pushErrorOnce(event);
            }
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
                    this.#pushErrorOnce({
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
            case 'turn-plan': {
                if (event.steps.length > MAX_RETAINED_PLAN_STEPS) {
                    this.#retentionTruncated = true;
                }
                const plan = deepFreezeRideCodex({
                    ...(event.explanation === undefined ? {} : {
                        explanation: truncateUtf8(event.explanation, this.#maxItemBytes)
                    }),
                    steps: event.steps.slice(0, MAX_RETAINED_PLAN_STEPS).map(step => ({
                        ...step,
                        step: truncateUtf8(step.step, this.#maxItemBytes)
                    }))
                }) as NonNullable<RideCodexTurnSnapshot['plan']>;
                this.#plan = plan;
                if ((event.explanation !== undefined && plan.explanation !== event.explanation)
                    || plan.steps.some((step, index) => step.step !== event.steps[index].step)) {
                    this.#retentionTruncated = true;
                }
                return true;
            }
            case 'turn-diff':
                this.#diff = truncateUtf8(event.diff, this.#maxItemBytes);
                if (this.#diff !== event.diff) {
                    this.#retentionTruncated = true;
                }
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
                return this.#pushErrorOnce(event);
        }
    }

    #startItem(id: string, kind: RideCodexItemKind): boolean {
        if (this.#items.has(id)) {
            return false;
        }
        this.#items.set(id, newMutableItem(id, kind));
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
            item = newMutableItem(id, kind);
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
        if (next !== combined) {
            item.omittedUtf8Bytes = saturatingAdd(
                item.omittedUtf8Bytes,
                utf8ByteLength(combined) - utf8ByteLength(next)
            );
        }
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
        const slotBytes = (index + 1 - item.summaries.length) * RETAINED_ARRAY_SLOT_BYTES;
        if (itemPayloadBytes(item) + slotBytes > this.#maxItemBytes) {
            return this.#warnItemTruncated(id);
        }
        while (item.summaries.length <= index) {
            item.summaries.push('');
        }
        return true;
    }

    #appendSummary(id: string, index: number, delta: string): boolean {
        const item = this.#item(id, 'reasoning');
        const allocated = this.#ensureSummary(id, index);
        if (item.summaries.length <= index) {
            return allocated;
        }
        const current = item.summaries[index] ?? '';
        const combined = current + delta;
        const available = this.#availableItemBytes(item, utf8ByteLength(current));
        const next = truncateUtf8(combined, available);
        const warned = next !== combined && this.#warnItemTruncated(id);
        if (next === current) {
            return allocated || warned;
        }
        item.summaries[index] = next;
        return true;
    }

    #appendReasoning(id: string, index: number, delta: string): boolean {
        const item = this.#item(id, 'reasoning');
        let allocated = false;
        const slotBytes = (index + 1 - item.reasoning.length) * RETAINED_ARRAY_SLOT_BYTES;
        if (slotBytes > 0 && itemPayloadBytes(item) + slotBytes > this.#maxItemBytes) {
            return this.#warnItemTruncated(id);
        }
        while (item.reasoning.length <= index) {
            item.reasoning.push('');
            allocated = true;
        }
        const current = item.reasoning[index] ?? '';
        const combined = current + delta;
        const available = this.#availableItemBytes(item, utf8ByteLength(current));
        const next = truncateUtf8(combined, available);
        const warned = next !== combined && this.#warnItemTruncated(id);
        if (next === current) {
            return allocated || warned;
        }
        item.reasoning[index] = next;
        return true;
    }

    #replaceChanges(id: string, changes: readonly RideCodexFileChange[]): boolean {
        const item = this.#item(id, 'file-change');
        const available = this.#availableItemBytes(item, fileChangePayloadBytes(item.changes));
        const bounded = boundFileChanges(changes, available);
        const changed = !sameFileChanges(item.changes, bounded.changes);
        item.changes = bounded.changes;
        item.omittedUtf8Bytes = bounded.omittedUtf8Bytes;
        item.omittedChanges = bounded.omittedChanges;
        item.omittedPaths = bounded.omittedPaths;
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
        if (event.code === 'data-truncated'
            && this.#warnings.some(warning => warning.code === 'data-truncated')) {
            return;
        }
        const message = truncateUtf8(event.message, Math.min(this.#maxItemBytes, MAX_DIAGNOSTIC_BYTES));
        if (message !== event.message) {
            this.#retentionTruncated = true;
        }
        const bounded = deepFreezeRideCodex({ ...event, message }) as typeof event;
        this.#warnings.push(bounded);
        this.#diagnosticRetainedBytes += diagnosticEventBytes(bounded);
        this.#trimDiagnostics();
    }

    #pushError(event: Extract<RideCodexUiEvent, { type: 'error' }>): void {
        const previous = this.#errors[this.#errors.length - 1];
        if (previous && previous.code === event.code && previous.message === event.message
            && previous.retryable === event.retryable) {
            return;
        }
        const message = truncateUtf8(event.message, Math.min(this.#maxItemBytes, MAX_DIAGNOSTIC_BYTES));
        if (message !== event.message) {
            this.#retentionTruncated = true;
        }
        const bounded = deepFreezeRideCodex({ ...event, message }) as typeof event;
        this.#errors.push(bounded);
        this.#diagnosticRetainedBytes += diagnosticEventBytes(bounded);
        this.#trimDiagnostics();
    }

    #pushErrorOnce(event: Extract<RideCodexUiEvent, { type: 'error' }>): boolean {
        if (isReservedRecoveryDiagnostic(event)) {
            if (this.#recoveryFailureRetained) {
                return false;
            }
            this.#recoveryFailureRetained = true;
        }
        this.#pushError(event);
        return true;
    }

    #trimDiagnostics(): void {
        const byteLimit = Math.min(this.#maxRetainedBytes, MAX_DIAGNOSTIC_BYTES);
        while (this.#warnings.length + this.#errors.length > this.#maxDiagnosticHistory
            || this.#diagnosticBytes() > byteLimit) {
            if (this.#warnings.length > 0) {
                this.#shiftWarning();
            } else if (this.#errors.length > 0) {
                this.#shiftError();
            } else {
                break;
            }
            this.#retentionTruncated = true;
        }
    }

    #diagnosticBytes(): number {
        return this.#diagnosticRetainedBytes;
    }

    #shiftWarning(): Extract<RideCodexUiEvent, { type: 'warning' }> | undefined {
        const warning = this.#warnings.shift();
        if (warning) {
            this.#diagnosticRetainedBytes -= diagnosticEventBytes(warning);
        }
        return warning;
    }

    #shiftError(): Extract<RideCodexUiEvent, { type: 'error' }> | undefined {
        const error = this.#errors.shift();
        if (error) {
            this.#diagnosticRetainedBytes -= diagnosticEventBytes(error);
        }
        return error;
    }

    #trimItemsByCount(): void {
        while (this.#items.size > this.#maxRetainedItems) {
            const oldest = this.#items.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.#items.delete(oldest);
            this.#truncatedItems.delete(oldest);
            this.#retentionTruncated = true;
        }
    }

    #trimRetained(): void {
        this.#trimItemsByCount();
        let truncated = this.#retentionTruncated;
        while (this.#retainedBytes() > this.#maxRetainedBytes && this.#warnings.length > 0) {
            this.#shiftWarning();
            truncated = true;
        }
        while (this.#retainedBytes() > this.#maxRetainedBytes && this.#errors.length > 0) {
            this.#shiftError();
            truncated = true;
        }
        while (this.#retainedBytes() > this.#maxRetainedBytes && this.#items.size > 0) {
            const oldest = this.#items.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.#items.delete(oldest);
            this.#truncatedItems.delete(oldest);
            truncated = true;
        }
        while (this.#retainedBytes() > this.#maxRetainedBytes && this.#plan && this.#plan.steps.length > 0) {
            this.#plan = deepFreezeRideCodex({
                ...(this.#plan.explanation === undefined ? {} : { explanation: this.#plan.explanation }),
                steps: this.#plan.steps.slice(1).map(step => ({ ...step }))
            }) as RideCodexTurnSnapshot['plan'];
            truncated = true;
        }
        if (this.#retainedBytes() > this.#maxRetainedBytes && this.#plan?.explanation !== undefined) {
            const explanationBytes = utf8ByteLength(this.#plan.explanation);
            const available = Math.max(0,
                this.#maxRetainedBytes - (this.#retainedBytes() - explanationBytes));
            const explanation = truncateUtf8(this.#plan.explanation, available);
            this.#plan = deepFreezeRideCodex({
                explanation,
                steps: this.#plan.steps.map(step => ({ ...step }))
            }) as RideCodexTurnSnapshot['plan'];
            truncated = true;
        }
        if (this.#retainedBytes() > this.#maxRetainedBytes && this.#diff !== undefined) {
            const diffBytes = utf8ByteLength(this.#diff);
            const available = Math.max(0, this.#maxRetainedBytes - (this.#retainedBytes() - diffBytes));
            this.#diff = truncateUtf8(this.#diff, available);
            truncated = true;
        }
        if (this.#retainedBytes() > this.#maxRetainedBytes) {
            this.#plan = undefined;
            this.#diff = undefined;
            truncated = true;
        }
        this.#retentionTruncated = false;
        if (truncated) {
            this.#appendRetentionDiagnostic();
        }
    }

    #appendRetentionDiagnostic(): void {
        if (this.#warnings.some(warning => warning.code === 'data-truncated')) {
            return;
        }
        while (this.#warnings.length + this.#errors.length >= this.#maxDiagnosticHistory) {
            if (this.#warnings.length > 0) {
                this.#shiftWarning();
            } else {
                return;
            }
        }
        const fixedBytes = RETAINED_ARRAY_SLOT_BYTES
            + utf8ByteLength('warning') + utf8ByteLength('data-truncated');
        const available = Math.min(
            this.#maxRetainedBytes - this.#retainedBytes() - fixedBytes,
            MAX_DIAGNOSTIC_BYTES - this.#diagnosticBytes() - fixedBytes
        );
        if (available < 0) {
            return;
        }
        const message = truncateUtf8('Codex UI data was truncated.', available);
        const diagnostic = deepFreezeRideCodex({
            type: 'warning', code: 'data-truncated', message
        }) as Extract<RideCodexUiEvent, { type: 'warning' }>;
        this.#warnings.push(diagnostic);
        this.#diagnosticRetainedBytes += diagnosticEventBytes(diagnostic);
    }

    #retainedBytes(): number {
        let bytes = this.#items.size * RETAINED_ARRAY_SLOT_BYTES;
        for (const item of this.#items.values()) {
            bytes += utf8ByteLength(item.id) + utf8ByteLength(item.kind)
                + utf8ByteLength(item.state) + utf8ByteLength(item.text);
            bytes += item.summaries.reduce((sum, summary) => sum + utf8ByteLength(summary), 0);
            bytes += item.reasoning.reduce((sum, reasoning) => sum + utf8ByteLength(reasoning), 0);
            bytes += (item.summaries.length + item.reasoning.length + item.changes.length)
                * RETAINED_ARRAY_SLOT_BYTES;
            bytes += item.changes.reduce((sum, change) =>
                sum + utf8ByteLength(change.path) + utf8ByteLength(change.kind)
                + utf8ByteLength(change.diff)
                + (change.kind === 'update' && typeof change.movePath === 'string'
                    ? utf8ByteLength(change.movePath) : 0), 0);
        }
        if (this.#plan) {
            bytes += this.#plan.steps.length * RETAINED_ARRAY_SLOT_BYTES;
            bytes += this.#plan.explanation === undefined ? 0 : utf8ByteLength(this.#plan.explanation);
            bytes += this.#plan.steps.reduce((sum, step) =>
                sum + utf8ByteLength(step.step) + utf8ByteLength(step.status), 0);
        }
        bytes += this.#diff === undefined ? 0 : utf8ByteLength(this.#diff);
        bytes += this.#diagnosticBytes();
        return bytes;
    }

    #buildSnapshot(): RideCodexTurnSnapshot {
        const items: RideCodexRenderedItem[] = [...this.#items.values()].map(item => {
            const rendered: RideCodexRenderedItem = {
                id: item.id,
                kind: item.kind,
                state: item.state,
                text: item.text,
                summaries: [...item.summaries],
                reasoning: [...item.reasoning],
                changes: item.changes.map(change => ({ ...change })),
                ...(item.omittedUtf8Bytes === 0 && item.omittedChanges === 0 && item.omittedPaths === 0
                    ? {} : {
                        truncation: {
                            omittedUtf8Bytes: item.omittedUtf8Bytes,
                            omittedChanges: item.omittedChanges,
                            omittedPaths: item.omittedPaths
                        }
                    })
            };
            REDUCER_ITEMS.add(rendered);
            return rendered;
        });
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

export function isRideCodexReducerItem(value: unknown): value is RideCodexRenderedItem {
    return !!value && typeof value === 'object' && REDUCER_ITEMS.has(value as object);
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

function requireBatchLimit(value: number | undefined, fallback: number): number {
    if (value === undefined) {
        return fallback;
    }
    if (!Number.isSafeInteger(value) || value < 2) {
        throw new RangeError('Codex event batches require room for a coherent turn boundary.');
    }
    return value;
}

function requireQueueLimit(value: number | undefined, fallback: number): number {
    if (value === undefined) {
        return fallback;
    }
    if (!Number.isSafeInteger(value) || value < RIDE_CODEX_MIN_QUEUED_BYTES) {
        throw new RangeError('Codex event queue budget is below the coherent boundary.');
    }
    return value;
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
        || !hasExactKeys(parsed, ['generation', 'turnSequence', 'threadId', 'turnId', 'events'])) {
        return undefined;
    }
    const generation = parsed.generation;
    const turnSequence = parsed.turnSequence;
    const threadId = parsed.threadId;
    const turnId = parsed.turnId;
    const events = parsed.events;
    if (!Number.isSafeInteger(generation) || (generation as number) < 0
        || !Number.isSafeInteger(turnSequence) || (turnSequence as number) <= 0
        || !isIdentifier(threadId) || !isIdentifier(turnId)
        || !Array.isArray(events) || events.length === 0 || events.length > 8_192) {
        return undefined;
    }
    if (events.some(event => !isUiEvent(event))) {
        return undefined;
    }
    return deepFreezeRideCodex({
        generation: generation as number,
        turnSequence: turnSequence as number,
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
    return typeof value === 'string'
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
    return typeof value === 'string'
        && utf8ByteLength(value) <= RIDE_CODEX_MAX_IDENTIFIER_BYTES;
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

function newMutableItem(id: string, kind: RideCodexItemKind): MutableItem {
    return {
        id,
        kind,
        state: 'started',
        text: '',
        summaries: [],
        reasoning: [],
        changes: [],
        omittedUtf8Bytes: 0,
        omittedChanges: 0,
        omittedPaths: 0
    };
}

function itemPayloadBytes(item: MutableItem): number {
    return utf8ByteLength(item.text)
        + (item.summaries.length + item.reasoning.length + item.changes.length) * RETAINED_ARRAY_SLOT_BYTES
        + item.summaries.reduce((sum, value) => sum + utf8ByteLength(value), 0)
        + item.reasoning.reduce((sum, value) => sum + utf8ByteLength(value), 0)
        + fileChangeStringBytes(item.changes);
}

function fileChangePayloadBytes(changes: readonly RideCodexFileChange[]): number {
    return changes.length * RETAINED_ARRAY_SLOT_BYTES + fileChangeStringBytes(changes);
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
): Readonly<{
    changes: RideCodexFileChange[];
    truncated: boolean;
    omittedUtf8Bytes: number;
    omittedChanges: number;
    omittedPaths: number;
}> {
    const bounded: RideCodexFileChange[] = [];
    let remaining = maxBytes;
    let truncated = false;
    for (const change of changes) {
        if (remaining < RETAINED_ARRAY_SLOT_BYTES) {
            truncated = true;
            break;
        }
        remaining -= RETAINED_ARRAY_SLOT_BYTES;
        const path = truncateUtf8(change.path, remaining);
        if (path.length === 0 && change.path.length > 0) {
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
            ...(movePath.length > 0 || change.movePath.length === 0 ? { movePath } : {})
        });
    }
    if (bounded.length < changes.length) {
        truncated = true;
    }
    let omittedPaths = 0;
    for (let index = 0; index < bounded.length; index += 1) {
        const boundedChange = bounded[index];
        const sourceChange = changes[index];
        if (boundedChange.path !== sourceChange.path) {
            omittedPaths += 1;
        }
        const boundedMove = boundedChange.kind === 'update' ? boundedChange.movePath : undefined;
        const sourceMove = sourceChange.kind === 'update' ? sourceChange.movePath : undefined;
        if (boundedMove !== sourceMove && typeof sourceMove === 'string') {
            omittedPaths += 1;
        }
    }
    return {
        changes: bounded,
        truncated,
        omittedUtf8Bytes: Math.max(0, fileChangeStringBytes(changes) - fileChangeStringBytes(bounded)),
        omittedChanges: changes.length - bounded.length,
        omittedPaths
    };
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

function diagnosticEventBytes(
    event: Extract<RideCodexUiEvent, { type: 'warning' | 'error' }>
): number {
    return RETAINED_ARRAY_SLOT_BYTES + utf8ByteLength(event.type)
        + utf8ByteLength(event.code) + utf8ByteLength(event.message);
}

function dropWarning(droppedEvents: number): Extract<RideCodexUiEvent, { type: 'warning' }> {
    return {
        type: 'warning',
        code: 'events-dropped',
        message: 'Codex UI events were dropped.',
        droppedEvents
    };
}

function dedupeProtectedPendingEvents(events: readonly RideCodexUiEvent[]): RideCodexUiEvent[] {
    let started = false;
    let terminal = false;
    let recoveryFailed = false;
    return events.filter(event => {
        if (event.type === 'turn-started') {
            if (started) {
                return false;
            }
            started = true;
        } else if (event.type === 'turn-terminal') {
            if (terminal) {
                return false;
            }
            terminal = true;
        } else if (isReservedRecoveryDiagnostic(event)) {
            if (recoveryFailed) {
                return false;
            }
            recoveryFailed = true;
        }
        return true;
    });
}

function compactOrdinaryPendingEntries(
    entries: readonly PendingEntry[]
): { readonly entries: readonly PendingEntry[]; readonly dropped: number } {
    let dropped = 0;
    const compacted: PendingEntry[] = [];
    for (const entry of entries) {
        const events = entry.batch.events.filter(isProtectedPendingEvent);
        dropped = saturatingAdd(dropped, entry.batch.events.length - events.length);
        if (events.length > 0) {
            compacted.push({
                batch: freezePendingBatch(entry.batch, events),
                originalIndex: entry.originalIndex
            });
        }
    }
    return { entries: compacted, dropped };
}

function packPendingBatches(
    identity: Pick<RideCodexEventBatch, 'generation' | 'turnSequence' | 'threadId' | 'turnId'>,
    events: readonly RideCodexUiEvent[],
    maxEvents: number
): RideCodexEventBatch[] {
    const batches: RideCodexEventBatch[] = [];
    for (let offset = 0; offset < events.length; offset += maxEvents) {
        batches.push(freezePendingBatch(identity, events.slice(offset, offset + maxEvents)));
    }
    return batches;
}

function freezePendingBatch(
    identity: Pick<RideCodexEventBatch, 'generation' | 'turnSequence' | 'threadId' | 'turnId'>,
    events: readonly RideCodexUiEvent[]
): RideCodexEventBatch {
    return deepFreezeRideCodex({
        generation: identity.generation,
        turnSequence: identity.turnSequence,
        threadId: identity.threadId,
        turnId: identity.turnId,
        events
    }) as RideCodexEventBatch;
}

function sameBatchIdentity(left: RideCodexEventBatch, right: RideCodexEventBatch): boolean {
    return left.generation === right.generation
        && left.turnSequence === right.turnSequence
        && left.threadId === right.threadId && left.turnId === right.turnId;
}

function finalizedIdentityKey(
    identity: Pick<RideCodexEventBatch, 'generation' | 'turnSequence' | 'threadId' | 'turnId'>
): string {
    return JSON.stringify([
        identity.generation, identity.turnSequence, identity.threadId, identity.turnId
    ]);
}

function saturatingAdd(left: number, right: number): number {
    return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function pendingBatchBytes(batch: RideCodexEventBatch): number {
    return utf8ByteLength(JSON.stringify(batch));
}

function pendingBatchesBytes(batches: readonly RideCodexEventBatch[]): number {
    return batches.reduce((total, batch) => total + pendingBatchBytes(batch), 0);
}

function pendingEntriesBytes(entries: readonly PendingEntry[]): number {
    return entries.reduce((total, entry) => total + pendingBatchBytes(entry.batch), 0);
}

function isOlderBatchIdentity(
    batch: RideCodexEventBatch,
    incoming: Pick<RideCodexEventBatch, 'generation' | 'turnSequence'>
): boolean {
    return batch.generation < incoming.generation
        || (batch.generation === incoming.generation && batch.turnSequence < incoming.turnSequence);
}

function isTurnBoundary(event: RideCodexUiEvent): boolean {
    return event.type === 'turn-started' || event.type === 'turn-terminal';
}

function hasTurnBoundary(events: readonly RideCodexUiEvent[]): boolean {
    return events.some(isTurnBoundary);
}

function isDiagnosticOnly(events: readonly RideCodexUiEvent[]): boolean {
    return events.length > 0 && events.every(event => event.type === 'warning' || event.type === 'error');
}

function isDropWarning(event: RideCodexUiEvent): event is Extract<RideCodexUiEvent, { type: 'warning' }> {
    return event.type === 'warning' && event.code === 'events-dropped';
}

function isReservedRecoveryDiagnostic(event: RideCodexUiEvent): boolean {
    return event.type === 'error' && event.code === 'recovery-failed';
}

function isProtectedPendingEvent(event: RideCodexUiEvent): boolean {
    return isTurnBoundary(event) || isReservedRecoveryDiagnostic(event);
}
