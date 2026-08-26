/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { Container } from '@theia/core/shared/inversify';
import { RideCodexActivation } from '../src/browser/ride-codex-activation';
import * as RideCodexProxyModule from '../src/browser/ride-codex-chat-agent-proxy';
import { RideCodexChatAgentProxy } from '../src/browser/ride-codex-chat-agent-proxy';
import rideCodexFrontendModule from '../src/browser/ride-codex-frontend-module';
import { RideCodexAuthController } from '../src/browser/ride-codex-auth-controller';
import { RideCodexAuthClient, RideCodexAuthService } from '../src/common/ride-codex-protocol';

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

test('failed feature activation disposes and clears the first feature before explicit retry', async () => {
    let loads = 0;
    let firstDisposals = 0;
    let secondActivations = 0;
    const activation = new RideCodexActivation(async () => {
        loads++;
        if (loads === 1) {
            return {
                activate: async () => { throw new Error('feature activation failed'); },
                dispose: () => { firstDisposals++; },
            };
        }
        assert.equal(firstDisposals, 1, 'the failed feature must be cleaned before retry loads another feature');
        return {
            activate: async () => { secondActivations++; },
        };
    });

    await assert.rejects(activation.activate(), /feature activation failed/);
    assert.equal(firstDisposals, 1);
    assert.equal(activation.state, 'error');
    await activation.retry();

    assert.equal(loads, 2);
    assert.equal(secondActivations, 1);
    assert.equal(firstDisposals, 1);
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

test('throwing feature disposal is reported once and never escapes shutdown', async () => {
    const disposalError = new Error('dispose failed');
    let disposals = 0;
    const reports: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { reports.push(args); };
    try {
        const activation = new RideCodexActivation(async () => ({
            activate: async () => undefined,
            dispose: () => {
                disposals++;
                throw disposalError;
            },
        }));
        await activation.activate();

        assert.doesNotThrow(() => activation.dispose());
        assert.doesNotThrow(() => activation.dispose());
        assert.equal(disposals, 1);
        assert.deepEqual(reports, [[
            '[R-IDE] Failed to dispose Codex feature.',
            disposalError,
        ]]);
        await assert.rejects(activation.activate(), /disposed/i);
    } finally {
        console.error = originalConsoleError;
    }
});

test('throwing in-flight disposal preserves the canonical disposed rejection', async () => {
    const started = deferred<void>();
    const completed = deferred<void>();
    const disposalError = new Error('dispose failed');
    let disposals = 0;
    const reports: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { reports.push(args); };
    try {
        const activation = new RideCodexActivation(async () => ({
            activate: async () => {
                started.resolve();
                await completed.promise;
            },
            dispose: () => {
                disposals++;
                throw disposalError;
            },
        }));
        const pending = activation.activate();
        await started.promise;

        let shutdownError: unknown;
        try {
            activation.dispose();
        } catch (error) {
            shutdownError = error;
        }
        completed.resolve();
        const pendingError = await pending.then(() => undefined, error => error);
        const activateError = await activation.activate().then(() => undefined, error => error);
        const retryError = await activation.retry().then(() => undefined, error => error);

        assert.equal(shutdownError, undefined);
        assert.match(String(pendingError), /disposed/i);
        assert.equal(activateError, pendingError);
        assert.equal(retryError, pendingError);
        assert.equal(disposals, 1);
        assert.deepEqual(reports, [[
            '[R-IDE] Failed to dispose Codex feature.',
            disposalError,
        ]]);
        assert.notEqual(activation.state, 'ready');
    } finally {
        console.error = originalConsoleError;
    }
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

test('frontend bindings expose one inert activation graph to command and shutdown contributions', async () => {
    const container = new Container();
    container.load(rideCodexFrontendModule);
    const activation = container.get(RideCodexActivation);
    const proxy = container.get(RideCodexChatAgentProxy);

    assert.equal(activation.state, 'inactive');
    assert.equal(container.isBound(RideCodexAuthController), true);
    assert.equal(container.isBound(RideCodexAuthClient), true);
    assert.equal(container.isBound(RideCodexAuthService), true);
    assert.ok(container.getAll(CommandContribution).includes(proxy));
    assert.equal(container.isBound(FrontendApplicationContribution), true);
    const lifecycle = container.getAll(FrontendApplicationContribution);
    assert.equal(lifecycle.length, 1);
    const lifecycleContribution = lifecycle[0] as FrontendApplicationContribution;
    lifecycleContribution.onStop?.(undefined as never);
    assert.equal(lifecycle[0], activation);

    await assert.rejects(proxy.open(), /disposed/i);
});
