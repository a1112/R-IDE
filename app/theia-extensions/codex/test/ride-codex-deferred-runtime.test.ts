/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RpcProxy } from '@theia/core/lib/common/messaging/proxy-factory';
import type {
    RideCodexApprovalClient,
    RideCodexAuthClient,
    RideCodexConversationsClient,
    RideCodexTurnClient
} from '../src/common/ride-codex-protocol';
import {
    RideCodexDeferredRuntime,
    RideCodexDeferredRuntimeServices
} from '../src/node/ride-codex-deferred-runtime';

function clientWithClose<T extends object>(): Readonly<{
    client: RpcProxy<T>;
    close(): void;
}> {
    let listener: (() => void) | undefined;
    return {
        client: {
            onDidCloseConnection(candidate: () => void) {
                listener = candidate;
                return { dispose() { listener = undefined; } };
            }
        } as RpcProxy<T>,
        close: () => listener?.()
    };
}

function runtimeFixture(events: string[] = []): Readonly<{
    runtime: RideCodexDeferredRuntime;
    services: RideCodexDeferredRuntimeServices;
    turnSession: unknown;
    approvalSession: unknown;
}> {
    const auth = {
        setClient: () => events.push('auth:set-client'),
        disconnectClient: () => events.push('auth:disconnect'),
        onStop: () => events.push('auth:stop')
    };
    const conversations = {
        setClient: () => events.push('conversations:set-client'),
        disconnectClient: () => events.push('conversations:disconnect'),
        onStop: async () => { events.push('conversations:stop'); }
    };
    const turnSession = {
        disconnectClient: () => events.push('turn-session:disconnect')
    };
    const turns = {
        connectClient: () => {
            events.push('turns:connect-client');
            return turnSession;
        },
        onStop: async () => { events.push('turns:stop'); }
    };
    const approvalSession = {
        dispose: () => events.push('approval-session:dispose')
    };
    const approvals = {
        connectClient: () => {
            events.push('approvals:connect-client');
            return approvalSession;
        },
        onStop: async () => { events.push('approvals:stop'); }
    };
    const services = {
        auth,
        conversations,
        turns,
        approvals,
        host: { onStop: async () => { events.push('host:stop'); } },
        dispose: async () => { events.push('child:dispose'); }
    } as unknown as RideCodexDeferredRuntimeServices;
    return { runtime: new RideCodexDeferredRuntime(services), services, turnSession, approvalSession };
}

test('deferred runtime wires every client to one retained service graph', () => {
    const events: string[] = [];
    const { runtime, services, turnSession, approvalSession } = runtimeFixture(events);
    const auth = clientWithClose<RideCodexAuthClient>();
    const conversations = clientWithClose<RideCodexConversationsClient>();
    const turns = clientWithClose<RideCodexTurnClient>();
    const approvals = clientWithClose<RideCodexApprovalClient>();

    assert.equal(runtime.connectAuth(auth.client), services.auth);
    assert.equal(runtime.connectConversations(conversations.client), services.conversations);
    assert.equal(runtime.connectTurns(turns.client), turnSession);
    assert.equal(runtime.connectApprovals(approvals.client), approvalSession);
    auth.close();
    conversations.close();
    turns.close();
    approvals.close();

    assert.deepEqual(events, [
        'auth:set-client',
        'conversations:set-client',
        'turns:connect-client',
        'approvals:connect-client',
        'auth:disconnect',
        'conversations:disconnect',
        'turn-session:disconnect',
        'approval-session:dispose'
    ]);
});

test('deferred runtime stops every service once and disposes its child after failures', async () => {
    const events: string[] = [];
    const { runtime, services } = runtimeFixture(events);
    (services.conversations as unknown as { onStop(): Promise<void> }).onStop = async () => {
        events.push('conversations:stop');
        throw new Error('conversation cleanup failed');
    };

    const first = runtime.onStop();
    const second = runtime.onStop();
    assert.equal(first, second);
    await assert.rejects(first, error => {
        assert.equal((error as Error).constructor.name, 'RideCodexDeferredRuntimeStopError');
        assert.match(String((error as Readonly<{ errors: readonly unknown[] }>).errors[0]), /conversation cleanup failed/);
        return true;
    });
    assert.deepEqual(events, [
        'auth:stop',
        'conversations:stop',
        'turns:stop',
        'approvals:stop',
        'host:stop',
        'child:dispose'
    ]);
    assert.throws(() => runtime.connectAuth(clientWithClose<RideCodexAuthClient>().client), /stopped/i);
});
