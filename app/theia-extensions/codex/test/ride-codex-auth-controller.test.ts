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

class FakePreferences implements RideCodexLegacyPreferenceAccess {
    readonly values = new Map<string, unknown>();
    readonly removals: string[] = [];
    beforeRemove: ((name: string) => void) | undefined;
    removeFailure: string | undefined;

    read(name: string): unknown {
        return this.values.get(name);
    }

    async remove(name: string, expectedValue: string): Promise<boolean> {
        this.beforeRemove?.(name);
        this.removals.push(name);
        if (this.values.get(name) !== expectedValue) {
            return false;
        }
        if (this.removeFailure === name) {
            throw new Error(`delete failed with ${String(this.values.get(name))}`);
        }
        this.values.delete(name);
        return true;
    }
}

class FakePrompt implements RideCodexMigrationPrompt {
    calls: readonly string[][] = [];
    accept = true;
    async confirmLegacyApiKeyMigration(sources: readonly string[]): Promise<boolean> {
        this.calls = [...this.calls, [...sources]];
        return this.accept;
    }
}

class FakeAuthService implements RideCodexAuthControllerService {
    activateCalls = 0;
    readCalls = 0;
    loginCalls: RideCodexLoginRequest[] = [];
    snapshot: RideCodexAuthSnapshot = Object.freeze({ state: 'inactive' });
    loginFailure: Error | undefined;

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
        if (this.loginFailure) {
            throw this.loginFailure;
        }
        this.snapshot = Object.freeze({ state: 'authenticated', account: Object.freeze({ type: 'apiKey' as const }) });
        return Object.freeze({ type: 'apiKey' });
    }

    async status(): Promise<RideCodexAuthSnapshot> {
        return this.snapshot;
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
        controller: new RideCodexAuthController({ preferences, prompt, auth }),
        preferences,
        prompt,
        auth
    };
}
