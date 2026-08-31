/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MarkdownChatResponseContentImpl } from '@theia/ai-chat';
import { RideCodexChatAgent, RideCodexChatAgentRuntime } from '../src/browser/ride-codex-chat-agent';

function event<T>(): {
    readonly event: (listener: (value: T) => void) => { dispose(): void };
    fire(value: T): void;
} {
    const listeners = new Set<(value: T) => void>();
    return {
        event: listener => {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        },
        fire: value => {
            for (const listener of [...listeners]) {
                listener(value);
            }
        }
    };
}

function requestFixture(): {
    request: any;
    contents: unknown[];
    completed: number;
    canceled: number;
    errors: Error[];
    fireCancellation(): void;
} {
    const contents: unknown[] = [];
    const errors: Error[] = [];
    let completed = 0;
    let canceled = 0;
    const cancellation = event<void>();
    const request = {
        id: 'request-1',
        request: { text: 'inspect the repository' },
        response: {
            response: { addContent: (content: unknown) => contents.push(content) },
            complete: () => { completed += 1; },
            cancel: () => { canceled += 1; },
            error: (error: Error) => { errors.push(error); },
            cancellationToken: {
                isCancellationRequested: false,
                onCancellationRequested: cancellation.event
            }
        }
    };
    return {
        request,
        contents,
        get completed() { return completed; },
        get canceled() { return canceled; },
        errors,
        fireCancellation: () => cancellation.fire(undefined)
    };
}

test('streams reducer-owned agent deltas into one Theia markdown response', async () => {
    const changes = event<any>();
    let prompt = '';
    const runtime = {
        onDidChange: changes.event,
        snapshot: () => ({ phase: 'ready', turn: { status: 'idle', items: [], warnings: [], errors: [] }, approvals: [] }),
        submitTurn: async (value: string) => {
            prompt = value;
            changes.fire({
                phase: 'ready',
                turn: {
                    status: 'completed',
                    items: [{ id: 'item-1', kind: 'agent-message', state: 'completed', text: 'hello Codex', summaries: [], reasoning: [], changes: [] }],
                    warnings: [],
                    errors: []
                },
                approvals: [],
                models: [],
                conversations: { generation: 0, threads: [] }
            });
            return { threadId: 'thread-1', turnId: 'turn-1', status: 'completed' as const };
        },
        interruptTurn: async () => ({ threadId: 'thread-1', turnId: 'turn-1', status: 'interrupted' as const })
    } as unknown as RideCodexChatAgentRuntime;
    const fixture = requestFixture();
    await new RideCodexChatAgent(runtime).invoke(fixture.request);

    assert.equal(prompt, 'inspect the repository');
    assert.equal(fixture.completed, 1);
    assert.equal(fixture.errors.length, 0);
    assert.ok(fixture.contents.some(content => content instanceof MarkdownChatResponseContentImpl));
    assert.match(fixture.contents.map(content => typeof (content as { asString?: () => string }).asString === 'function'
        ? (content as { asString(): string }).asString() : '').join(''), /hello Codex/);
});

test('maps runtime errors to safe Theia response text and never forwards raw failures', async () => {
    const runtime = {
        onDidChange: event<any>().event,
        snapshot: () => ({
            phase: 'error',
            turn: { status: 'failed', items: [], warnings: [], errors: [] },
            approvals: [],
            models: [],
            conversations: { generation: 0, threads: [] },
            error: {
                layer: 'protocol', title: 'Codex connection error', message: 'Codex connection could not be used safely.',
                code: 'protocol-error', retryable: true, action: 'restart'
            }
        }),
        submitTurn: async () => { throw new Error('secret=sk-live-not-for-ui'); },
        interruptTurn: async () => ({ threadId: 'thread-1', turnId: 'turn-1', status: 'interrupted' as const })
    } as unknown as RideCodexChatAgentRuntime;
    const fixture = requestFixture();
    await new RideCodexChatAgent(runtime).invoke(fixture.request);

    assert.equal(fixture.completed, 0);
    assert.equal(fixture.errors.length, 1);
    assert.doesNotMatch(fixture.errors[0].message, /sk-live/);
    assert.match(fixture.errors[0].message, /connection/i);
});

test('cancellation requests one interrupt and completes the Theia response as canceled', async () => {
    const changes = event<any>();
    let interrupts = 0;
    const runtime = {
        onDidChange: changes.event,
        snapshot: () => ({ phase: 'ready', turn: { status: 'in-progress', items: [], warnings: [], errors: [] }, approvals: [], models: [], conversations: { generation: 0, threads: [] } }),
        submitTurn: async () => {
            await new Promise<void>(resolve => setImmediate(resolve));
            interrupts += 1;
            return { threadId: 'thread-1', turnId: 'turn-1', status: 'interrupted' as const };
        },
        interruptTurn: async () => ({ threadId: 'thread-1', turnId: 'turn-1', status: 'interrupted' as const })
    } as unknown as RideCodexChatAgentRuntime;
    const fixture = requestFixture();
    const invocation = new RideCodexChatAgent(runtime).invoke(fixture.request);
    fixture.fireCancellation();
    await invocation;

    assert.equal(interrupts, 1);
    assert.equal(fixture.canceled, 1);
});
