/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    RideCodexAppServerHost,
    type RideCodexAppServerResolver
} from '../src/node/ride-codex-app-server-host';
import type { RideCodexIncomingRequest, RideCodexNotification } from '../src/node/ride-codex-jsonl-client';
import { createRideCodexPackagedSmokeResolver, createRideCodexPackagedSmokeSpawn, RIDE_CODEX_PACKAGED_SMOKE_NONCE } from '../src/node/ride-codex-packaged-smoke';
import { createRideCodexLaunchSpec } from '../src/node/ride-codex-launch-spec';

const NONCE = 'a'.repeat(64);

async function eventually(predicate: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(message);
        }
        await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
}

function turnParams(text: string): Readonly<Record<string, unknown>> {
    return {
        threadId: 'codex-smoke-thread',
        input: [{ type: 'text', text }]
    };
}

test('the nonce-guarded packaged App Server completes streaming, approvals, and interruption', async () => {
    const environment = Object.freeze({
        [RIDE_CODEX_PACKAGED_SMOKE_NONCE]: NONCE
    });
    const neverResolver: RideCodexAppServerResolver = {
        resolve: async () => createRideCodexLaunchSpec({
            executable: process.execPath,
            version: '0.144.0',
            target: 'unreachable',
            source: 'system'
        })
    };
    const resolver = createRideCodexPackagedSmokeResolver(neverResolver, environment);
    const host = new RideCodexAppServerHost({
        resolver,
        spawn: createRideCodexPackagedSmokeSpawn(environment),
        handshakeTimeoutMs: 2_000,
        idleTimeoutMs: 0,
        shutdownGraceMs: 1_000
    });
    const notifications: RideCodexNotification[] = [];
    const requests: Array<{ readonly request: RideCodexIncomingRequest; readonly generation: number }> = [];
    const notificationListener = host.onNotification(notification => notifications.push(notification));
    const requestListener = host.onServerRequest((request, generation) => requests.push({ request, generation }));

    try {
        const lease = await host.acquire('foreground-panel');
        try {
            const models = await lease.request('model/list', {});
            assert.equal((models as { data: readonly unknown[] }).data.length, 1);
            const thread = await lease.request('thread/start', { cwd: process.cwd() });
            assert.equal((thread as { thread: { id: string } }).thread.id, 'codex-smoke-thread');

            await lease.request('turn/start', turnParams('codex smoke stream'));
            await eventually(
                () => notifications.some(notification => notification.method === 'turn/completed'),
                'stream fixture did not complete'
            );
            assert.equal(notifications.some(notification => notification.method === 'item/agentMessage/delta'), true);

            await lease.request('turn/start', turnParams('codex smoke command approval'));
            await eventually(
                () => requests.some(({ request }) => request.method === 'item/commandExecution/requestApproval'),
                'command approval fixture did not arrive'
            );
            const commandRequest = requests.find(({ request }) => request.method === 'item/commandExecution/requestApproval');
            assert.ok(commandRequest);
            await host.respondServerRequest(commandRequest.generation, commandRequest.request.id, { decision: 'accept' });
            await eventually(
                () => notifications.filter(notification => notification.method === 'turn/completed').length >= 2,
                'command approval fixture did not complete'
            );

            await lease.request('turn/start', turnParams('codex smoke file approval'));
            await eventually(
                () => requests.some(({ request }) => request.method === 'item/fileChange/requestApproval'),
                'file approval fixture did not arrive'
            );
            const fileRequest = requests.find(({ request }) => request.method === 'item/fileChange/requestApproval');
            assert.ok(fileRequest);
            await host.respondServerRequest(fileRequest.generation, fileRequest.request.id, { decision: 'accept' });
            await eventually(
                () => notifications.filter(notification => notification.method === 'turn/completed').length >= 3,
                'file approval fixture did not complete'
            );

            await lease.request('turn/start', turnParams('codex smoke interrupt'));
            await lease.request('turn/interrupt', {
                threadId: 'codex-smoke-thread',
                turnId: 'codex-smoke-turn-4'
            });
            await eventually(
                () => notifications.some(notification => (
                    notification.method === 'turn/completed'
                    && (notification.params as { turn: { status: string } }).turn.status === 'interrupted'
                )),
                'interrupt fixture did not complete as interrupted'
            );

            await assert.rejects(
                lease.request('turn/start', turnParams('codex smoke recover')),
                /exit|request|connection/i
            );
            await eventually(
                () => host.snapshot().state === 'ready' && host.snapshot().generation >= 2,
                'recover fixture did not restart the App Server'
            );
            assert.deepEqual(await lease.request('account/read', {}), {
                account: { type: 'apiKey' },
                requiresOpenaiAuth: false
            });

            lease.release();
            await eventually(
                () => host.snapshot().state === 'stopped',
                'idle release did not stop the packaged App Server'
            );
        } finally {
            await host.dispose();
        }
    } finally {
        notificationListener.dispose();
        requestListener.dispose();
    }
});

test('the packaged fake path is unreachable without a valid nonce', () => {
    const fallback: RideCodexAppServerResolver = {
        resolve: async () => createRideCodexLaunchSpec({
            executable: process.execPath,
            version: '0.144.0',
            target: 'fallback',
            source: 'system'
        })
    };
    assert.strictEqual(
        createRideCodexPackagedSmokeResolver(fallback, {}).resolve,
        fallback.resolve
    );
    assert.strictEqual(
        createRideCodexPackagedSmokeResolver(fallback, {
            [RIDE_CODEX_PACKAGED_SMOKE_NONCE]: 'not-a-nonce'
        }).resolve,
        fallback.resolve
    );
});
