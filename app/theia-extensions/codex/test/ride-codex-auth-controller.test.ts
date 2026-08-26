/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    RideCodexAuthSnapshot,
    RideCodexLoginRequest,
    RideCodexLoginResult
} from '../src/common/ride-codex-auth';
import {
    LEGACY_CODEX_API_KEY_PREFERENCES,
    RideCodexAuthController,
    RideCodexAuthClientRelay,
    RideCodexAuthControllerService,
    RideCodexLegacyPreferenceAccess,
    RideCodexMigrationPrompt
} from '../src/browser/ride-codex-auth-controller';

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void };

class FakePreferences implements RideCodexLegacyPreferenceAccess {
    readonly values = new Map<string, unknown>();
    readonly removals: string[] = [];
    readonly removeGates = new Map<string, Deferred<void>>();
    readonly readCounts = new Map<string, number>();
    beforeRead: ((name: string, count: number) => void) | undefined;
    beforeRemove: ((name: string) => void) | undefined;
    afterRemove: ((name: string) => void) | undefined;
    removeFailure: string | undefined;

    read(name: string): unknown {
        const count = (this.readCounts.get(name) ?? 0) + 1;
        this.readCounts.set(name, count);
        this.beforeRead?.(name, count);
        return this.values.get(name);
    }

    async remove(name: string, expectedValue: string): Promise<boolean> {
        this.beforeRemove?.(name);
        this.removals.push(name);
        await this.removeGates.get(name)?.promise;
        if (this.values.get(name) !== expectedValue) {
            return false;
        }
        if (this.removeFailure === name) {
            throw new Error(`delete failed with ${String(this.values.get(name))}`);
        }
        this.values.delete(name);
        this.afterRemove?.(name);
        return true;
    }
}

class FakePrompt implements RideCodexMigrationPrompt {
    calls: readonly string[][] = [];
    accept = true;
    confirmation: Promise<boolean> | undefined;
    async confirmLegacyApiKeyMigration(sources: readonly string[]): Promise<boolean> {
        this.calls = [...this.calls, [...sources]];
        return this.confirmation ?? this.accept;
    }
}

class FakeAuthService implements RideCodexAuthControllerService {
    activateCalls = 0;
    readCalls = 0;
    statusCalls = 0;
    loginCalls: RideCodexLoginRequest[] = [];
    snapshot: RideCodexAuthSnapshot = Object.freeze({ state: 'inactive' });
    loginFailure: Error | undefined;
    loginGate: Deferred<void> | undefined;
    statusGate: Deferred<RideCodexAuthSnapshot> | undefined;

    async activate(): Promise<RideCodexAuthSnapshot> {
        this.activateCalls += 1;
        this.snapshot = Object.freeze({ state: 'unauthenticated' });
        return this.snapshot;
    }

    async readAccount(): Promise<RideCodexAuthSnapshot> {
        this.readCalls += 1;
        return this.snapshot;
    }

    async login(request: RideCodexLoginRequest): Promise<RideCodexLoginResult> {
        this.loginCalls.push(request);
        await this.loginGate?.promise;
        if (this.loginFailure) {
            throw this.loginFailure;
        }
        this.snapshot = Object.freeze({ state: 'authenticated', account: Object.freeze({ type: 'apiKey' as const }) });
        return Object.freeze({ type: 'apiKey' });
    }

    async status(): Promise<RideCodexAuthSnapshot> {
        this.statusCalls += 1;
        return this.statusGate?.promise ?? this.snapshot;
    }
}

test('controller construction is inert and no-key activation follows the normal account read path', async () => {
    const { controller, auth, prompt } = harness();
    assert.equal(auth.activateCalls, 0);
    assert.equal(auth.loginCalls.length, 0);
    assert.equal(prompt.calls.length, 0);
    assert.equal(controller.snapshot().state, 'inactive');

    const result = await controller.activate();
    assert.equal(result.state, 'ready');
    assert.equal(auth.activateCalls, 1);
    assert.equal(auth.readCalls, 1);
    assert.equal(prompt.calls.length, 0);
});

test('no-key activation failures become bounded secret-free controller state', async () => {
    const { controller, auth } = harness();
    const secret = 'sk-normal-activation-failure';
    auth.activate = async () => { throw new Error(`remote failed with ${secret}`); };
    const result = await controller.activate();
    assert.equal(result.state, 'recovery-required');
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.ok((result.message?.length ?? 0) <= 160);
});

test('accepted migration logs in ephemerally, verifies authenticated state, and deletes exact keys', async () => {
    const { controller, preferences, auth, prompt } = harness();
    const key = 'sk-legacy-task9-accept';
    preferences.values.set(LEGACY_CODEX_API_KEY_PREFERENCES[0], key);
    preferences.values.set(LEGACY_CODEX_API_KEY_PREFERENCES[1], key);

    const result = await controller.activate();
    assert.equal(result.state, 'migrated');
    assert.deepEqual(prompt.calls, [[LEGACY_CODEX_API_KEY_PREFERENCES[0], LEGACY_CODEX_API_KEY_PREFERENCES[1]]]);
    assert.equal(auth.loginCalls.length, 1);
    assert.deepEqual(auth.loginCalls[0], { type: 'apiKey', apiKey: key });
    assert.deepEqual(preferences.removals, [LEGACY_CODEX_API_KEY_PREFERENCES[0], LEGACY_CODEX_API_KEY_PREFERENCES[1]]);
    assert.equal(JSON.stringify(result).includes(key), false);
});

test('declined migration prompts once and leaves Codex and all legacy values untouched', async () => {
    const { controller, preferences, auth, prompt } = harness();
    prompt.accept = false;
    preferences.values.set(LEGACY_CODEX_API_KEY_PREFERENCES[0], 'sk-declined-task9');

    assert.equal((await controller.activate()).state, 'manual');
    assert.equal((await controller.activate()).state, 'manual');
    assert.equal(prompt.calls.length, 1);
    assert.equal(auth.activateCalls, 0);
    assert.equal(auth.loginCalls.length, 0);
    assert.equal(preferences.removals.length, 0);
    assert.equal(preferences.values.has(LEGACY_CODEX_API_KEY_PREFERENCES[0]), true);
});

test('conflicting legacy keys fail closed without prompting, login, or deletion', async () => {
    const { controller, preferences, auth, prompt } = harness();
    preferences.values.set(LEGACY_CODEX_API_KEY_PREFERENCES[0], 'sk-first-conflict');
    preferences.values.set(LEGACY_CODEX_API_KEY_PREFERENCES[2], 'sk-second-conflict');

    const result = await controller.activate();
    assert.equal(result.state, 'manual');
    assert.equal(prompt.calls.length, 0);
    assert.equal(auth.loginCalls.length, 0);
    assert.equal(preferences.removals.length, 0);
    assert.equal(JSON.stringify(result).includes('sk-first-conflict'), false);
});

test('descriptor-unsafe, non-string, empty and oversized legacy values fail closed', async () => {
    for (const value of [{ apiKey: 'sk-object' }, '', 'x'.repeat(8 * 1024 + 1)]) {
        const { controller, preferences, auth } = harness();
        preferences.values.set(LEGACY_CODEX_API_KEY_PREFERENCES[0], value);
        const result = await controller.activate();
        assert.equal(result.state, 'manual');
        assert.equal(auth.loginCalls.length, 0);
    }
});

test('preference deletion rechecks the original value and reports a bounded manual race', async () => {
    const { controller, preferences } = harness();
    const source = LEGACY_CODEX_API_KEY_PREFERENCES[0];
    preferences.values.set(source, 'sk-original-task9');
    preferences.beforeRemove = name => preferences.values.set(name, 'sk-changed-task9');

    const result = await controller.activate();
    assert.equal(result.state, 'recovery-required');
    assert.equal(preferences.values.get(source), 'sk-changed-task9');
    assert.equal(JSON.stringify(result).includes('sk-changed-task9'), false);
});

test('partial deletion failure never reports completion and does not leak the key', async () => {
    const { controller, preferences } = harness();
    const key = 'sk-delete-failure-task9';
    preferences.values.set(LEGACY_CODEX_API_KEY_PREFERENCES[0], key);
    preferences.values.set(LEGACY_CODEX_API_KEY_PREFERENCES[1], key);
    preferences.removeFailure = LEGACY_CODEX_API_KEY_PREFERENCES[1];

    const result = await controller.activate();
    assert.equal(result.state, 'recovery-required');
    assert.equal(preferences.values.has(LEGACY_CODEX_API_KEY_PREFERENCES[0]), false);
    assert.equal(preferences.values.get(LEGACY_CODEX_API_KEY_PREFERENCES[1]), key);
    assert.ok((result.message?.length ?? 0) <= 160);
    assert.equal(JSON.stringify(result).includes(key), false);
});

test('login must produce authenticated account state before plaintext is removed', async () => {
    const { controller, preferences, auth } = harness();
    const key = 'sk-not-confirmed-task9';
    preferences.values.set(LEGACY_CODEX_API_KEY_PREFERENCES[0], key);
    auth.login = async request => {
        auth.loginCalls.push(request);
        auth.snapshot = Object.freeze({ state: 'unauthenticated' });
        return Object.freeze({ type: 'apiKey' });
    };

    const result = await controller.activate();
    assert.equal(result.state, 'recovery-required');
    assert.equal(preferences.values.get(LEGACY_CODEX_API_KEY_PREFERENCES[0]), key);
    assert.equal(preferences.removals.length, 0);
});

test('concurrent activation shares one migration and dispose while prompting preserves plaintext for manual handling', async () => {
    const { controller, preferences, auth, prompt } = harness();
    const key = 'sk-prompt-dispose-task9';
    const confirmation = deferred<boolean>();
    prompt.confirmation = confirmation.promise;
    preferences.values.set(LEGACY_CODEX_API_KEY_PREFERENCES[0], key);

    const first = controller.activate();
    const second = controller.activate();
    assert.equal(first, second);
    await eventually(() => prompt.calls.length === 1);
    controller.dispose();
    controller.dispose();
    confirmation.resolve(true);

    const result = await first;
    assert.equal(result.state, 'manual');
    assert.equal(auth.loginCalls.length, 0);
    assert.equal(preferences.removals.length, 0);
    assert.equal(preferences.values.get(LEGACY_CODEX_API_KEY_PREFERENCES[0]), key);
    await assert.rejects(controller.activate(), /disposed/i);
});

test('dispose while an irreversible login is pending ignores its result and does not confirm or delete plaintext', async () => {
    const { controller, preferences, auth } = harness();
    const key = 'sk-login-dispose-task9';
    auth.loginGate = deferred<void>();
    preferences.values.set(LEGACY_CODEX_API_KEY_PREFERENCES[0], key);

    const activation = controller.activate();
    await eventually(() => auth.loginCalls.length === 1);
    controller.dispose();
    auth.loginGate.resolve();

    const result = await activation;
    assert.equal(result.state, 'manual');
    assert.equal(auth.statusCalls, 0);
    assert.equal(preferences.removals.length, 0);
    assert.equal(preferences.values.get(LEGACY_CODEX_API_KEY_PREFERENCES[0]), key);
});

test('dispose while account confirmation is pending prevents the first preference deletion', async () => {
    const { controller, preferences, auth } = harness();
    const key = 'sk-status-dispose-task9';
    auth.statusGate = deferred<RideCodexAuthSnapshot>();
    preferences.values.set(LEGACY_CODEX_API_KEY_PREFERENCES[0], key);

    const activation = controller.activate();
    await eventually(() => auth.statusCalls === 1);
    auth.statusGate.resolve(Object.freeze({
        state: 'authenticated',
        account: Object.freeze({ type: 'apiKey' as const })
    }));
    controller.dispose();

    const result = await activation;
    assert.equal(result.state, 'manual');
    assert.equal(preferences.removals.length, 0);
    assert.equal(preferences.values.get(LEGACY_CODEX_API_KEY_PREFERENCES[0]), key);
});

test('dispose between preference deletions reports partial recovery and leaves remaining plaintext untouched', async () => {
    const { controller, preferences } = harness();
    const key = 'sk-between-delete-dispose-task9';
    for (const name of LEGACY_CODEX_API_KEY_PREFERENCES) {
        preferences.values.set(name, key);
    }
    preferences.afterRemove = name => {
        if (name === LEGACY_CODEX_API_KEY_PREFERENCES[0]) {
            controller.dispose();
        }
    };

    const result = await controller.activate();
    assert.equal(result.state, 'recovery-required');
    assert.deepEqual(preferences.removals, [LEGACY_CODEX_API_KEY_PREFERENCES[0]]);
    assert.equal(preferences.values.has(LEGACY_CODEX_API_KEY_PREFERENCES[0]), false);
    assert.equal(preferences.values.get(LEGACY_CODEX_API_KEY_PREFERENCES[1]), key);
    assert.equal(preferences.values.get(LEGACY_CODEX_API_KEY_PREFERENCES[2]), key);
});

test('dispose immediately before each preference deletion stops at that exact boundary', async () => {
    for (let disposeIndex = 0; disposeIndex < LEGACY_CODEX_API_KEY_PREFERENCES.length; disposeIndex += 1) {
        const { controller, preferences } = harness();
        const key = `sk-before-delete-dispose-${disposeIndex}-task9`;
        for (const name of LEGACY_CODEX_API_KEY_PREFERENCES) {
            preferences.values.set(name, key);
        }
        const target = LEGACY_CODEX_API_KEY_PREFERENCES[disposeIndex];
        preferences.beforeRead = (name, count) => {
            if (name === target && count === 2) {
                controller.dispose();
            }
        };

        const result = await controller.activate();
        assert.equal(result.state, disposeIndex === 0 ? 'manual' : 'recovery-required');
        assert.deepEqual(preferences.removals, LEGACY_CODEX_API_KEY_PREFERENCES.slice(0, disposeIndex));
        for (const untouched of LEGACY_CODEX_API_KEY_PREFERENCES.slice(disposeIndex)) {
            assert.equal(preferences.values.get(untouched), key);
        }
    }
});

test('dispose during each preference deletion never continues with a later key or reports migrated', async () => {
    for (const gatedIndex of [0, 1, 2]) {
        const { controller, preferences } = harness();
        const key = `sk-mid-delete-dispose-${gatedIndex}-task9`;
        for (const name of LEGACY_CODEX_API_KEY_PREFERENCES) {
            preferences.values.set(name, key);
        }
        const gatedName = LEGACY_CODEX_API_KEY_PREFERENCES[gatedIndex];
        const gate = deferred<void>();
        preferences.removeGates.set(gatedName, gate);

        const activation = controller.activate();
        await eventually(() => preferences.removals.includes(gatedName));
        controller.dispose();
        gate.resolve();

        const result = await activation;
        assert.equal(result.state, 'recovery-required');
        assert.deepEqual(preferences.removals, LEGACY_CODEX_API_KEY_PREFERENCES.slice(0, gatedIndex + 1));
        assert.equal(preferences.values.has(gatedName), false);
        for (const untouched of LEGACY_CODEX_API_KEY_PREFERENCES.slice(gatedIndex + 1)) {
            assert.equal(preferences.values.get(untouched), key);
        }
    }
});

test('frontend auth relay revalidates and deeply freezes RPC snapshots', () => {
    const relay = new RideCodexAuthClientRelay();
    let received: RideCodexAuthSnapshot | undefined;
    relay.attach({ authStateChanged: snapshot => { received = snapshot; } });
    const mutable = {
        state: 'authenticated' as const,
        account: { type: 'chatgpt' as const, email: 'person@example.com', plan: 'plus' as const }
    };
    relay.authStateChanged(mutable);
    mutable.account.email = 'changed@example.com';
    assert.deepEqual(received?.account, { type: 'chatgpt', email: 'person@example.com', plan: 'plus' });
    assert.ok(Object.isFrozen(received));
    assert.ok(Object.isFrozen(received?.account));
});

test('frontend auth relay attachment is disposable and a stale disposer cannot detach a replacement listener', () => {
    const relay = new RideCodexAuthClientRelay();
    const first: RideCodexAuthSnapshot[] = [];
    const second: RideCodexAuthSnapshot[] = [];
    const firstAttachment = relay.attach({ authStateChanged: snapshot => first.push(snapshot) });
    const secondAttachment = relay.attach({ authStateChanged: snapshot => second.push(snapshot) });

    firstAttachment.dispose();
    relay.authStateChanged(Object.freeze({ state: 'unauthenticated' }));
    assert.equal(first.length, 0);
    assert.equal(second.length, 1);

    secondAttachment.dispose();
    relay.authStateChanged(Object.freeze({ state: 'authenticated', account: Object.freeze({ type: 'apiKey' }) }));
    assert.equal(second.length, 1);
});

function harness(): {
    controller: RideCodexAuthController;
    preferences: FakePreferences;
    prompt: FakePrompt;
    auth: FakeAuthService;
} {
    const preferences = new FakePreferences();
    const prompt = new FakePrompt();
    const auth = new FakeAuthService();
    return {
        controller: new RideCodexAuthController({ preferences, prompt, auth, relay: new RideCodexAuthClientRelay() }),
        preferences,
        prompt,
        auth
    };
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function tick(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
}

async function eventually(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) {
            return;
        }
        await tick();
    }
    assert.fail('condition was not reached');
}
