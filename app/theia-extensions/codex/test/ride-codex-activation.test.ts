/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RideCodexActivation } from '../src/browser/ride-codex-activation';

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
