/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { RideCodexActivation } from '../src/browser/ride-codex-activation';
import * as RideCodexProxyModule from '../src/browser/ride-codex-chat-agent-proxy';
import { RideCodexChatAgentProxy } from '../src/browser/ride-codex-chat-agent-proxy';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    return {
        promise: new Promise<T>(resolver => { resolve = resolver; }),
        resolve,
    };
}

test('startup leaves the Codex feature inactive without loading it', () => {
    let loads = 0;
    const activation = new RideCodexActivation(async () => {
        loads++;
        return { activate: async () => undefined };
    });

    assert.equal(activation.state, 'inactive');
    assert.equal(loads, 0);
});

test('concurrent activation loads and activates the feature once', async () => {
    let loads = 0;
    let activations = 0;
    const activation = new RideCodexActivation(async () => {
        loads++;
        return { activate: async () => { activations++; } };
    });

    await Promise.all([activation.activate(), activation.activate(), activation.activate()]);

    assert.equal(loads, 1);
    assert.equal(activations, 1);
    assert.equal(activation.state, 'ready');
});

test('failure stays error until an explicit retry succeeds', async () => {
    let loads = 0;
    const activation = new RideCodexActivation(async () => {
        loads++;
        if (loads === 1) {
            throw new Error('load failed');
        }
        return { activate: async () => undefined };
    });

    await assert.rejects(activation.activate(), /load failed/);
    assert.equal(activation.state, 'error');
    await assert.rejects(activation.activate(), /load failed/);
    assert.equal(loads, 1);
    await activation.retry();
    assert.equal(loads, 2);
    assert.equal(activation.state, 'ready');
});

test('dispose is idempotent, disposes a loaded feature, and prevents activation', async () => {
    let disposals = 0;
    const activation = new RideCodexActivation(async () => ({
        activate: async () => undefined,
        dispose: () => { disposals++; },
    }));

    await activation.activate();
    activation.dispose();
    activation.dispose();

    assert.equal(disposals, 1);
    await assert.rejects(activation.activate(), /disposed/i);
    await assert.rejects(activation.retry(), /disposed/i);
});

test('dispose during loading rejects activation and disposes the late feature without activating it', async () => {
    const loaded = deferred<{
        activate(): Promise<void>;
        dispose(): void;
    }>();
    let activations = 0;
    let disposals = 0;
    const activation = new RideCodexActivation(() => loaded.promise);
    const pending = activation.activate();

    activation.dispose();
    loaded.resolve({
        activate: async () => { activations++; },
        dispose: () => { disposals++; },
    });

    await assert.rejects(pending, /disposed/i);
    assert.equal(activations, 0);
    assert.equal(disposals, 1);
    assert.notEqual(activation.state, 'ready');
    await assert.rejects(activation.activate(), /disposed/i);
    await assert.rejects(activation.retry(), /disposed/i);
});

test('dispose during feature activation prevents ready completion and disposes once', async () => {
    const started = deferred<void>();
    const completed = deferred<void>();
    let disposals = 0;
    const activation = new RideCodexActivation(async () => ({
        activate: async () => {
            started.resolve();
            await completed.promise;
        },
        dispose: () => { disposals++; },
    }));
    const pending = activation.activate();
    await started.promise;

    activation.dispose();
    completed.resolve();

    await assert.rejects(pending, /disposed/i);
    assert.equal(disposals, 1);
    assert.notEqual(activation.state, 'ready');
    await assert.rejects(activation.activate(), /disposed/i);
    await assert.rejects(activation.retry(), /disposed/i);
});

test('exports stable Codex command and agent identities', () => {
    const module = RideCodexProxyModule as unknown as Record<string, unknown>;
    assert.deepEqual(module.RIDE_CODEX_OPEN_COMMAND, { id: 'ride.codex.open', label: 'Open Codex' });
    assert.equal(module.RIDE_CODEX_AGENT_ID, 'Codex');
});

test('registering the Codex command is inert and execution delegates to the permanent proxy', async () => {
    let activations = 0;
    const activation = new RideCodexActivation(async () => ({
        activate: async () => { activations++; },
    }));
    const proxy = new RideCodexChatAgentProxy(activation);
    const contribution = proxy as unknown as CommandContribution;
    assert.equal(typeof contribution.registerCommands, 'function');
    const commands = new CommandRegistry({ getContributions: () => [] });

    contribution.registerCommands(commands);
    assert.equal(activations, 0);
    await Promise.all([
        commands.executeCommand('ride.codex.open'),
        commands.executeCommand('ride.codex.open'),
    ]);

    assert.equal(activations, 1);
});
