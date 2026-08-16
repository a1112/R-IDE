/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as nativeChrome from '../src/browser/ride-native-chrome';
import type { RidePerformanceSnapshot } from '../src/browser/ride-performance';

type WindowControlLayout = {
    placement: 'left' | 'right';
    actions: string[];
};

const nativeChromeWithLayout = nativeChrome as typeof nativeChrome & {
    getRideWindowControls?: (platform: 'macos' | 'windows' | 'linux' | 'unknown') => WindowControlLayout;
};

test('uses platform-native window control placement and order', () => {
    const getRideWindowControls = nativeChromeWithLayout.getRideWindowControls;
    assert.equal(typeof getRideWindowControls, 'function');

    assert.deepEqual(getRideWindowControls?.('macos'), {
        placement: 'left',
        actions: ['close', 'minimize', 'toggleMaximize']
    });
    assert.deepEqual(getRideWindowControls?.('windows'), {
        placement: 'right',
        actions: ['minimize', 'toggleMaximize', 'close']
    });
    assert.deepEqual(getRideWindowControls?.('linux'), {
        placement: 'right',
        actions: ['minimize', 'toggleMaximize', 'close']
    });
    assert.deepEqual(getRideWindowControls?.('unknown'), {
        placement: 'right',
        actions: ['minimize', 'toggleMaximize', 'close']
    });
});

const validSnapshot: RidePerformanceSnapshot = {
    sampledAtMs: 1_723_456_789_000,
    total: { cpuPercent: 12.5, memoryBytes: 1_048_576, processCount: 5 },
    main: { cpuPercent: 2.5, memoryBytes: 262_144, processCount: 1 },
    backend: { cpuPercent: 4, memoryBytes: 393_216, processCount: 1 },
    pluginHost: { cpuPercent: 3, memoryBytes: 196_608, processCount: 2 },
    other: { cpuPercent: 3, memoryBytes: 196_608, processCount: 1 }
};

test('does not invoke native performance sampling in browser mode', async () => {
    let invokeCount = 0;
    const chrome = new nativeChrome.RideNativeChrome({
        isTauri: false,
        invoke: async () => {
            invokeCount++;
            return validSnapshot;
        }
    });

    assert.equal(await chrome.getPerformanceSnapshot(), undefined);
    assert.equal(invokeCount, 0);
});

test('invokes exactly ride_performance_snapshot and returns a valid payload', async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const chrome = new nativeChrome.RideNativeChrome({
        isTauri: true,
        invoke: async (command, args) => {
            calls.push({ command, args });
            return validSnapshot;
        }
    });

    assert.deepEqual(await chrome.getPerformanceSnapshot(), validSnapshot);
    assert.deepEqual(calls, [{ command: 'ride_performance_snapshot', args: undefined }]);
});

test('rejects invalid native performance payloads', async () => {
    const invalidPayloads: Array<{ name: string; payload: unknown }> = [
        { name: 'null payload', payload: null },
        { name: 'array payload', payload: [] },
        { name: 'missing group', payload: { ...validSnapshot, other: undefined } },
        { name: 'negative sampledAtMs', payload: { ...validSnapshot, sampledAtMs: -1 } },
        { name: 'fractional sampledAtMs', payload: { ...validSnapshot, sampledAtMs: 1.5 } },
        { name: 'unsafe sampledAtMs', payload: { ...validSnapshot, sampledAtMs: Number.MAX_SAFE_INTEGER + 1 } },
        { name: 'NaN CPU', payload: { ...validSnapshot, main: { ...validSnapshot.main, cpuPercent: Number.NaN } } },
        { name: 'infinite CPU', payload: { ...validSnapshot, main: { ...validSnapshot.main, cpuPercent: Infinity } } },
        { name: 'negative CPU', payload: { ...validSnapshot, main: { ...validSnapshot.main, cpuPercent: -0.1 } } },
        { name: 'CPU over 100', payload: { ...validSnapshot, main: { ...validSnapshot.main, cpuPercent: 100.1 } } },
        { name: 'negative memory', payload: { ...validSnapshot, backend: { ...validSnapshot.backend, memoryBytes: -1 } } },
        { name: 'fractional memory', payload: { ...validSnapshot, backend: { ...validSnapshot.backend, memoryBytes: 1.5 } } },
        { name: 'unsafe memory', payload: { ...validSnapshot, backend: { ...validSnapshot.backend, memoryBytes: Number.MAX_SAFE_INTEGER + 1 } } },
        { name: 'negative process count', payload: { ...validSnapshot, pluginHost: { ...validSnapshot.pluginHost, processCount: -1 } } },
        { name: 'fractional process count', payload: { ...validSnapshot, pluginHost: { ...validSnapshot.pluginHost, processCount: 1.5 } } },
        { name: 'unsafe process count', payload: { ...validSnapshot, pluginHost: { ...validSnapshot.pluginHost, processCount: Number.MAX_SAFE_INTEGER + 1 } } }
    ];

    for (const invalid of invalidPayloads) {
        const chrome = new nativeChrome.RideNativeChrome({
            isTauri: true,
            invoke: async () => invalid.payload
        });
        await assert.rejects(
            chrome.getPerformanceSnapshot(),
            /invalid native performance snapshot/i,
            invalid.name
        );
    }
});
