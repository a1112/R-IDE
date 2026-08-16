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
import type { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { StatusBarAlignment, type StatusBar, type StatusBarEntry } from '@theia/core/lib/browser/status-bar/status-bar-types';
import { MarkdownString } from '@theia/core/lib/common/markdown-rendering/markdown-string';
import { RideNativeChrome } from '../src/browser/ride-native-chrome';
import { RidePerformanceContribution } from '../src/browser/ride-performance-contribution';
import type { RidePerformanceSnapshot } from '../src/browser/ride-performance';

class MemoryStorage implements Storage {
    protected readonly values = new Map<string, string>();
    get length(): number { return this.values.size; }
    clear(): void { this.values.clear(); }
    getItem(key: string): string | null { return this.values.get(key) ?? null; }
    key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
    removeItem(key: string): void { this.values.delete(key); }
    setItem(key: string, value: string): void { this.values.set(key, value); }
}

const storedLanguage = new MemoryStorage();
storedLanguage.setItem('localeId', 'en');
Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
        localStorage: storedLanguage,
        location: { search: '' }
    }
});

const snapshot: RidePerformanceSnapshot = {
    sampledAtMs: 1,
    total: { cpuPercent: 2.3, memoryBytes: 684 * 1024 * 1024, processCount: 5 },
    main: { cpuPercent: 0.5, memoryBytes: 100, processCount: 1 },
    backend: { cpuPercent: 0.8, memoryBytes: 200, processCount: 1 },
    pluginHost: { cpuPercent: 0.6, memoryBytes: 300, processCount: 2 },
    other: { cpuPercent: 0.4, memoryBytes: 84, processCount: 1 }
};

interface StatusBarCall {
    id: string;
    entry: StatusBarEntry;
}

class FakeStatusBar implements StatusBar {
    readonly setCalls: StatusBarCall[] = [];
    readonly removed: string[] = [];
    async setBackgroundColor(): Promise<void> { }
    async setColor(): Promise<void> { }
    async setElement(id: string, entry: StatusBarEntry): Promise<void> {
        this.setCalls.push({ id, entry });
    }
    async removeElement(id: string): Promise<void> {
        this.removed.push(id);
    }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

async function flushAsyncWork(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
}

test('keeps the browser footer hidden without native calls', async () => {
    const statusBar = new FakeStatusBar();
    let invokeCount = 0;
    const nativeChrome = new RideNativeChrome({
        isTauri: false,
        invoke: async () => {
            invokeCount++;
            return snapshot;
        }
    });
    const applicationState = {
        reachedState: async () => undefined
    } as unknown as FrontendApplicationStateService;
    const contribution = new RidePerformanceContribution(statusBar, applicationState, nativeChrome);

    contribution.onStart();
    await flushAsyncWork();

    assert.equal(invokeCount, 0);
    assert.deepEqual(statusBar.setCalls, []);
    contribution.dispose();
    assert.deepEqual(statusBar.removed, []);
});

test('waits for ready then publishes the exact right-aligned footer entry', async () => {
    const ready = deferred();
    const statusBar = new FakeStatusBar();
    const commands: string[] = [];
    const nativeChrome = new RideNativeChrome({
        isTauri: true,
        invoke: async command => {
            commands.push(command);
            return snapshot;
        }
    });
    const applicationState = {
        reachedState: (state: string) => {
            assert.equal(state, 'ready');
            return ready.promise;
        }
    } as unknown as FrontendApplicationStateService;
    const contribution = new RidePerformanceContribution(statusBar, applicationState, nativeChrome);

    contribution.onStart();
    contribution.onStart();
    await flushAsyncWork();
    assert.deepEqual(commands, []);
    assert.deepEqual(statusBar.setCalls, []);

    ready.resolve();
    await flushAsyncWork();
    contribution.dispose();
    contribution.onStop();

    assert.deepEqual(commands, ['ride_performance_snapshot']);
    assert.equal(statusBar.setCalls.length, 1);
    const statusCall = statusBar.setCalls[0] as StatusBarCall;
    const { tooltip, ...entryWithoutTooltip } = statusCall.entry;
    assert.deepEqual({ id: statusCall.id, entry: entryWithoutTooltip }, {
        id: 'ride-performance',
        entry: {
            name: 'R-IDE Performance',
            text: '$(pulse) CPU 2.3%  Memory 684 MB',
            alignment: StatusBarAlignment.RIGHT,
            priority: 5,
            accessibilityInformation: {
                label: 'R-IDE Performance: CPU 2.3%, Memory 684 MB'
            }
        }
    });
    assert.ok(MarkdownString.is(tooltip));
    assert.equal(tooltip.isTrusted, false);
    assert.equal(tooltip.supportHtml, false);
    const renderedLines = tooltip.value.split('\\\n').map(line =>
        line.replace(/&nbsp;/g, ' ').replace(/\\-/g, '-')
    );
    assert.deepEqual(renderedLines, [
        'R-IDE Total  CPU 2.3%  Memory 684 MB  5 processes',
        'Main  CPU 0.5%  Memory 100 B  1 process',
        'Backend  CPU 0.8%  Memory 200 B  1 process',
        'Plugin Host  CPU 0.6%  Memory 300 B  2 processes',
        'Other  CPU 0.4%  Memory 84 B  1 process'
    ]);

    assert.deepEqual(statusBar.removed, ['ride-performance']);
});

test('disposal before ready prevents polling and late footer creation', async () => {
    const ready = deferred();
    const statusBar = new FakeStatusBar();
    let invokeCount = 0;
    const nativeChrome = new RideNativeChrome({
        isTauri: true,
        invoke: async () => {
            invokeCount++;
            return snapshot;
        }
    });
    const applicationState = {
        reachedState: () => ready.promise
    } as unknown as FrontendApplicationStateService;
    const contribution = new RidePerformanceContribution(statusBar, applicationState, nativeChrome);

    contribution.onStart();
    contribution.dispose();
    contribution.dispose();
    ready.resolve();
    await flushAsyncWork();

    assert.equal(invokeCount, 0);
    assert.deepEqual(statusBar.setCalls, []);
    assert.deepEqual(statusBar.removed, []);
});

test('treats an unexpected undefined Tauri snapshot as unavailable', async () => {
    const statusBar = new FakeStatusBar();
    const nativeChrome = new RideNativeChrome({
        isTauri: true,
        invoke: async () => undefined
    });
    const applicationState = {
        reachedState: async () => undefined
    } as unknown as FrontendApplicationStateService;
    const contribution = new RidePerformanceContribution(statusBar, applicationState, nativeChrome);

    contribution.onStart();
    await flushAsyncWork();
    await flushAsyncWork();

    assert.deepEqual(statusBar.setCalls, []);
    contribution.dispose();
});
