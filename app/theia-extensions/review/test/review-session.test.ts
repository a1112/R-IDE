/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepositorySession } from '../src/browser/review-session';

test('repository startup publishes dirty buffers before enabling backend timers', async () => {
    const calls: unknown[] = [];
    const session = new RepositorySession({
        setDirtyPaths: async paths => { calls.push(paths); },
        ready: async () => { calls.push('ready'); }
    }, () => ['C:/repo/unsaved.ts']);
    await session.reconnect();
    assert.deepEqual(calls, [['C:/repo/unsaved.ts'], 'ready']);
});

test('failed dirty publication never enables sync; later connection retries recover', async () => {
    let attempts = 0;
    let ready = 0;
    const session = new RepositorySession({
        setDirtyPaths: async () => { if (++attempts === 1) { throw new Error('disconnected'); } },
        ready: async () => { ready++; }
    }, () => ['C:/repo/unsaved.ts']);
    await assert.rejects(() => session.reconnect(), /disconnected/);
    assert.equal(ready, 0);
    await session.reconnect();
    assert.equal(ready, 1);
});

test('dirty buffer updates serialize, read fresh paths and recover after a rejected RPC', async () => {
    const calls: string[][] = [];
    let paths = ['C:/repo/first.ts'];
    const session = new RepositorySession({ setDirtyPaths: async value => { calls.push(value); }, ready: async () => undefined }, () => paths);
    await session.publishDirty();
    paths = ['C:/repo/second.ts'];
    await session.publishDirty();
    paths = [];
    await session.publishDirty();
    assert.deepEqual(calls, [['C:/repo/first.ts'], ['C:/repo/second.ts'], []]);
});

test('shutdown prevents pending publication from starting synchronization', async () => {
    let release!: () => void;
    let ready = 0;
    const session = new RepositorySession({
        setDirtyPaths: async () => new Promise<void>(resolve => { release = resolve; }),
        ready: async () => { ready++; }
    }, () => []);
    const pending = session.reconnect();
    await new Promise(resolve => setImmediate(resolve));
    session.stop();
    release();
    await pending;
    await session.reconnect();
    assert.equal(ready, 0);
});

test('dirty guards retain the same frontend identity when the RPC reconnects and files are saved', async () => {
    const identities: (string | undefined)[] = [];
    let dirty = ['C:/repo/unsaved.ts'];
    const paths: string[][] = [];
    const sessionId = '60e6cf02-88be-4a4e-bcae-c755557c52c9';
    const session = new RepositorySession({
        setDirtyPaths: async (value, identity) => { paths.push(value); identities.push(identity); },
        ready: async () => undefined
    }, () => dirty, sessionId);
    await session.reconnect();
    await session.reconnect();
    dirty = [];
    await session.publishDirty();
    assert.deepEqual(identities, [sessionId, sessionId, sessionId]);
    assert.deepEqual(paths, [['C:/repo/unsaved.ts'], ['C:/repo/unsaved.ts'], []]);
});
