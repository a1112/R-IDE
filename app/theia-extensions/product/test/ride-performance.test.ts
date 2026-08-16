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
import {
    formatBytes,
    formatPerformanceSnapshot,
    PerformanceViewState,
    RidePerformancePoller,
    RidePerformanceSnapshot,
    RideUsageGroup
} from '../src/browser/ride-performance';

function usage(cpuPercent = 0, memoryBytes = 0, processCount = 0): RideUsageGroup {
    return { cpuPercent, memoryBytes, processCount };
}

function snapshot(overrides: Partial<RidePerformanceSnapshot> = {}): RidePerformanceSnapshot {
    return {
        sampledAtMs: 1_700_000_000_000,
        total: usage(),
        main: usage(),
        backend: usage(),
        pluginHost: usage(),
        other: usage(),
        ...overrides
    };
}

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T | PromiseLike<T>): void;
    reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
}

class FakeIntervals {
    readonly delays: number[] = [];
    readonly cleared: unknown[] = [];
    protected callback: (() => void) | undefined;
    protected readonly handle = { type: 'performance-interval' };

    set = (callback: () => void, delay: number): unknown => {
        this.callback = callback;
        this.delays.push(delay);
        return this.handle;
    };

    clear = (handle: unknown): void => {
        this.cleared.push(handle);
        if (handle === this.handle) {
            this.callback = undefined;
        }
    };

    tick(): void {
        this.callback?.();
    }
}

function createPoller(
    fetchSnapshot: () => Promise<RidePerformanceSnapshot>,
    updates: PerformanceViewState[],
    intervals = new FakeIntervals(),
    locale = 'zh-cn'
): { poller: RidePerformancePoller; intervals: FakeIntervals } {
    return {
        poller: new RidePerformancePoller({
            fetchSnapshot,
            onUpdate: state => {
                updates.push(state);
            },
            setInterval: intervals.set,
            clearInterval: intervals.clear,
            locale
        }),
        intervals
    };
}

test('formats compact Chinese totals and exact multiline role breakdown', () => {
    const view = formatPerformanceSnapshot(snapshot({
        total: usage(2.34, 717_225_984, 6),
        main: usage(0.4, 100_000_000, 1),
        backend: usage(0.8, 200_000_000, 1),
        pluginHost: usage(0.7, 300_000_000, 2),
        other: usage(0.44, 117_225_984, 2)
    }), 'zh-cn');

    assert.equal(view.text, '$(pulse) CPU 2.3%  内存 684 MB');
    assert.equal(view.tooltip, [
        'R-IDE 总计  CPU 2.3%  内存 684 MB  6 个进程',
        '主进程  CPU 0.4%  内存 95 MB  1 个进程',
        '后端  CPU 0.8%  内存 191 MB  1 个进程',
        '插件宿主  CPU 0.7%  内存 286 MB  2 个进程',
        '其他  CPU 0.4%  内存 112 MB  2 个进程'
    ].join('\n'));
    assert.equal(view.available, true);
});

test('formats binary byte units through gigabytes', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1_023), '1023 B');
    assert.equal(formatBytes(1_024), '1 KB');
    assert.equal(formatBytes(1_536), '1.5 KB');
    assert.equal(formatBytes(10 * 1_024 * 1_024), '10 MB');
    assert.equal(formatBytes(1.5 * 1_024 * 1_024 * 1_024), '1.5 GB');
});

test('promotes rounded unit boundaries and formats terabytes', () => {
    assert.equal(formatBytes(1_024 ** 2 - 1), '1 MB');
    assert.equal(formatBytes(1_024 ** 3 - 1), '1 GB');
    assert.equal(formatBytes(1_024 ** 4), '1 TB');
    assert.equal(formatBytes(1.5 * 1_024 ** 4), '1.5 TB');
});

test('formats English labels and process-count grammar', () => {
    const view = formatPerformanceSnapshot(snapshot({
        total: usage(12.96, 1.5 * 1_024 ** 3, 4),
        main: usage(1, 1_024, 1),
        backend: usage(2, 2_048, 1),
        pluginHost: usage(3, 3_072, 2),
        other: usage()
    }), 'en-US');

    assert.equal(view.text, '$(pulse) CPU 13.0%  Memory 1.5 GB');
    assert.equal(view.tooltip, [
        'R-IDE Total  CPU 13.0%  Memory 1.5 GB  4 processes',
        'Main  CPU 1.0%  Memory 1 KB  1 process',
        'Backend  CPU 2.0%  Memory 2 KB  1 process',
        'Plugin Host  CPU 3.0%  Memory 3 KB  2 processes',
        'Other  CPU 0.0%  Memory 0 B  0 processes'
    ].join('\n'));
});

test('keeps zero-process groups visible in the tooltip', () => {
    const view = formatPerformanceSnapshot(snapshot(), 'zh-CN');

    assert.match(view.tooltip, /主进程.*0 个进程/);
    assert.match(view.tooltip, /后端.*0 个进程/);
    assert.match(view.tooltip, /插件宿主.*0 个进程/);
    assert.match(view.tooltip, /其他.*0 个进程/);
});

test('starts one immediate request and installs one 2000 ms interval', async () => {
    let calls = 0;
    const updates: PerformanceViewState[] = [];
    const context = createPoller(async () => {
        calls++;
        return snapshot({ total: usage(1, 1_024, 1) });
    }, updates);

    context.poller.start();
    context.poller.start();
    await flushPromises();

    assert.equal(calls, 1);
    assert.deepEqual(context.intervals.delays, [2_000]);
    assert.equal(updates.length, 1);
});

test('skips interval ticks while a request is pending', async () => {
    const first = deferred<RidePerformanceSnapshot>();
    let calls = 0;
    const updates: PerformanceViewState[] = [];
    const context = createPoller(() => {
        calls++;
        return first.promise;
    }, updates);

    context.poller.start();
    context.intervals.tick();
    context.intervals.tick();
    assert.equal(calls, 1);

    first.resolve(snapshot());
    await flushPromises();
    context.intervals.tick();
    assert.equal(calls, 2);
});

test('retains the latest value for two failures and publishes unavailable on the third', async () => {
    const results: Array<RidePerformanceSnapshot | Error> = [
        snapshot({ total: usage(2.34, 717_225_984, 6) }),
        new Error('first'),
        new Error('second'),
        new Error('third')
    ];
    const updates: PerformanceViewState[] = [];
    const context = createPoller(async () => {
        const result = results.shift();
        if (result instanceof Error) {
            throw result;
        }
        assert.ok(result);
        return result;
    }, updates);

    context.poller.start();
    await flushPromises();
    context.intervals.tick();
    await flushPromises();
    context.intervals.tick();
    await flushPromises();
    context.intervals.tick();
    await flushPromises();

    assert.deepEqual(updates.map(update => update.text), [
        '$(pulse) CPU 2.3%  内存 684 MB',
        '$(pulse) CPU 2.3%  内存 684 MB',
        '$(pulse) CPU 2.3%  内存 684 MB',
        '$(pulse) 性能数据不可用'
    ]);
    assert.equal(updates[updates.length - 1]?.available, false);
    assert.equal(updates[updates.length - 1]?.tooltip, 'R-IDE 性能数据暂不可用');
});

test('does not repeatedly publish unavailable after the third failure', async () => {
    const updates: PerformanceViewState[] = [];
    const context = createPoller(async () => {
        throw new Error('unavailable');
    }, updates);

    context.poller.start();
    await flushPromises();
    context.intervals.tick();
    await flushPromises();
    context.intervals.tick();
    await flushPromises();
    context.intervals.tick();
    await flushPromises();
    context.intervals.tick();
    await flushPromises();

    assert.equal(updates.length, 1);
    assert.equal(updates[0].available, false);
});

test('a synchronous publication throw is called once and does not count as a fetch failure', async () => {
    const fetchResults: Array<RidePerformanceSnapshot | Error> = [
        snapshot({ total: usage(6, 6_144, 2) }),
        new Error('first fetch failure'),
        new Error('second fetch failure')
    ];
    const published: PerformanceViewState[] = [];
    let publicationCalls = 0;
    const intervals = new FakeIntervals();
    const poller = new RidePerformancePoller({
        fetchSnapshot: async () => {
            const result = fetchResults.shift();
            if (result instanceof Error) {
                throw result;
            }
            assert.ok(result);
            return result;
        },
        onUpdate: state => {
            publicationCalls++;
            if (publicationCalls === 1) {
                throw new Error('status bar unavailable');
            }
            published.push(state);
        },
        setInterval: intervals.set,
        clearInterval: intervals.clear,
        locale: 'en'
    });

    poller.start();
    await flushPromises();
    intervals.tick();
    await flushPromises();
    intervals.tick();
    await flushPromises();

    assert.equal(publicationCalls, 3);
    assert.deepEqual(published.map(state => state.available), [true, true]);
});

test('awaits and catches asynchronous publication rejection without a false fetch failure', async () => {
    const publication = deferred<void>();
    let fetchCalls = 0;
    let publicationCalls = 0;
    const intervals = new FakeIntervals();
    const poller = new RidePerformancePoller({
        fetchSnapshot: async () => {
            fetchCalls++;
            return snapshot({ total: usage(fetchCalls, 1_024, 1) });
        },
        onUpdate: async () => {
            publicationCalls++;
            if (publicationCalls === 1) {
                await publication.promise;
            }
        },
        setInterval: intervals.set,
        clearInterval: intervals.clear,
        locale: 'en'
    });

    poller.start();
    await flushPromises();
    intervals.tick();
    assert.equal(fetchCalls, 1, 'publication remains part of the non-overlapping request');

    publication.reject(new Error('async status bar unavailable'));
    await flushPromises();
    intervals.tick();
    await flushPromises();

    assert.equal(fetchCalls, 2);
    assert.equal(publicationCalls, 2);
});

test('does not publish invented values before a third initial failure', async () => {
    const updates: PerformanceViewState[] = [];
    const context = createPoller(async () => {
        throw new Error('unavailable');
    }, updates, new FakeIntervals(), 'en');

    context.poller.start();
    await flushPromises();
    context.intervals.tick();
    await flushPromises();
    assert.deepEqual(updates, []);

    context.intervals.tick();
    await flushPromises();
    assert.deepEqual(updates, [{
        available: false,
        text: '$(pulse) Performance unavailable',
        tooltip: 'R-IDE performance data is temporarily unavailable'
    }]);
});

test('a success after unavailable resets failures and publishes live data', async () => {
    let shouldFail = true;
    const updates: PerformanceViewState[] = [];
    const context = createPoller(async () => {
        if (shouldFail) {
            throw new Error('unavailable');
        }
        return snapshot({ total: usage(4, 2_048, 2) });
    }, updates);

    context.poller.start();
    await flushPromises();
    context.intervals.tick();
    await flushPromises();
    context.intervals.tick();
    await flushPromises();
    shouldFail = false;
    context.intervals.tick();
    await flushPromises();
    shouldFail = true;
    context.intervals.tick();
    await flushPromises();

    assert.deepEqual(updates.map(update => update.available), [false, true, true]);
    assert.equal(updates[1].text, '$(pulse) CPU 4.0%  内存 2 KB');
    assert.equal(updates[2].text, updates[1].text);
});

test('dispose clears the interval once and prevents later ticks', async () => {
    let calls = 0;
    const updates: PerformanceViewState[] = [];
    const context = createPoller(async () => {
        calls++;
        return snapshot();
    }, updates);

    context.poller.start();
    await flushPromises();
    context.poller.dispose();
    context.poller.dispose();
    context.intervals.tick();
    await flushPromises();

    assert.equal(calls, 1);
    assert.equal(context.intervals.cleared.length, 1);
});

test('dispose suppresses resolution and rejection effects from in-flight requests', async () => {
    const pendingSuccess = deferred<RidePerformanceSnapshot>();
    const successUpdates: PerformanceViewState[] = [];
    const success = createPoller(() => pendingSuccess.promise, successUpdates);
    success.poller.start();
    success.poller.dispose();
    pendingSuccess.resolve(snapshot({ total: usage(9, 9_999, 1) }));
    await flushPromises();
    assert.deepEqual(successUpdates, []);

    const pendingFailure = deferred<RidePerformanceSnapshot>();
    const failureUpdates: PerformanceViewState[] = [];
    const failure = createPoller(() => pendingFailure.promise, failureUpdates);
    failure.poller.start();
    failure.poller.dispose();
    pendingFailure.reject(new Error('late failure'));
    await flushPromises();
    assert.deepEqual(failureUpdates, []);
});
