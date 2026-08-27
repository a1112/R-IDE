/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    RideCodexSdkAdapter,
    RideCodexSdkClient,
    RideCodexSdkEvent,
    RideCodexSdkError,
    RideCodexSdkRuntime,
    RideCodexSdkThread
} from '../src/node/ride-codex-sdk-adapter';
import { RideCodexLaunchSpec } from '../src/node/ride-codex-launch-spec';

interface FakeRun {
    readonly input: string;
    readonly events: AsyncGenerator<RideCodexSdkEvent>;
}

class FakeThread implements RideCodexSdkThread {
    id: string | null;
    readonly runs: FakeRun[] = [];
    readonly #eventBatches: RideCodexSdkEvent[][];

    constructor(id: string | null, eventBatches: RideCodexSdkEvent[][]) {
        this.id = id;
        this.#eventBatches = eventBatches;
    }

    async runStreamed(input: string): Promise<{ events: AsyncGenerator<RideCodexSdkEvent> }> {
        const batch = this.#eventBatches.shift() ?? [
            { type: 'thread.started', thread_id: 'fallback-thread' },
            { type: 'item.completed', item: { type: 'agent_message', id: 'fallback-message', text: 'done' } },
            { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } }
        ];
        const events = this.createEvents(batch);
        this.runs.push({ input, events });
        return { events };
    }

    async *createEvents(batch: RideCodexSdkEvent[]): AsyncGenerator<RideCodexSdkEvent> {
        for (const event of batch) {
            if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
                this.id = event.thread_id;
            }
            yield event;
        }
    }
}

class FakeClient implements RideCodexSdkClient {
    readonly started: FakeThread[] = [];
    readonly resumed: FakeThread[] = [];
    readonly #eventBatches: RideCodexSdkEvent[][];

    constructor(eventBatches: RideCodexSdkEvent[][]) {
        this.#eventBatches = eventBatches;
    }

    startThread(): RideCodexSdkThread {
        const thread = new FakeThread(null, this.#eventBatches);
        this.started.push(thread);
        return thread;
    }

    resumeThread(id: string): RideCodexSdkThread {
        const thread = new FakeThread(id, this.#eventBatches);
        this.resumed.push(thread);
        return thread;
    }
}

function launchSpec(executable = 'X:/codex.exe'): RideCodexLaunchSpec {
    return Object.freeze({
        executable,
        version: '0.144.0',
        target: 'windows-x64',
        source: 'system',
        environment: Object.freeze({}),
        diagnostics: Object.freeze([])
    });
}

function fixtureSdkAdapter(options: {
    readonly loads?: string[];
    readonly executable?: string;
    readonly maxThreads?: number;
    readonly maxClients?: number;
    readonly batches?: RideCodexSdkEvent[][];
} = {}) {
    const loads = options.loads ?? [];
    const clients: FakeClient[] = [];
    let lastOptions: Record<string, unknown> | undefined;
    const runtime: RideCodexSdkRuntime = {
        createCodexClient: clientOptions => {
            lastOptions = { ...clientOptions };
            const client = new FakeClient(options.batches ?? [[
                { type: 'thread.started', thread_id: 'thread-one' },
                { type: 'item.completed', item: { type: 'agent_message', id: 'message-one', text: 'done' } },
                { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2 } }
            ]]);
            clients.push(client);
            return client;
        }
    };
    const adapter = new RideCodexSdkAdapter({
        resolveLaunchSpec: async () => launchSpec(options.executable),
        loadRuntime: async () => {
            loads.push('codex-sdk-runtime.mjs');
            return runtime;
        },
        maxThreads: options.maxThreads,
        maxClients: options.maxClients
    });
    return { adapter, clients, get lastOptions() { return lastOptions; } };
}

test('imports SDK only on explicit compatibility use and shares the resolved CLI', async () => {
    const loads: string[] = [];
    const fixture = fixtureSdkAdapter({ loads, executable: 'X:/codex.exe', maxThreads: 8 });
    assert.deepEqual(loads, []);
    const result = await fixture.adapter.run({ channel: 'sdk', threadKey: 'one', input: 'test' });
    assert.deepEqual(loads, ['codex-sdk-runtime.mjs']);
    assert.equal(fixture.lastOptions?.codexPathOverride, 'X:/codex.exe');
    assert.equal(result.channel, 'sdk');
    assert.equal(result.threadId, 'thread-one');
    assert.equal(result.finalResponse, 'done');
});

test('forwards the ephemeral API key without retaining it in diagnostics', async () => {
    const diagnostics: string[] = [];
    const adapter = new RideCodexSdkAdapter({
        resolveLaunchSpec: async () => launchSpec(),
        loadRuntime: async () => ({
            createCodexClient: options => {
                assert.equal(options.apiKey, 'sk-test-123456789');
                return new FakeClient([]);
            }
        }),
        onDiagnostic: diagnostic => diagnostics.push(diagnostic.code)
    });
    await adapter.run({ channel: 'sdk', threadKey: 'one', input: 'test', apiKey: 'sk-test-123456789' });
    assert.deepEqual(diagnostics, []);
});

test('rejects automatic SDK continuation for an active App Server turn', async () => {
    const diagnostics: string[] = [];
    const adapter = new RideCodexSdkAdapter({
        resolveLaunchSpec: async () => {
            throw new Error('must not resolve the CLI while App Server is active');
        },
        onDiagnostic: diagnostic => diagnostics.push(diagnostic.code)
    });
    await assert.rejects(
        adapter.run({ channel: 'sdk', threadKey: 'one', input: 'continue', appServerTurnActive: true }),
        /App Server turn is still active/
    );
    assert.deepEqual(diagnostics, ['app-server-turn-active']);
});

test('reuses bounded threads and evicts the least recently used idle thread', async () => {
    const fixture = fixtureSdkAdapter({ maxThreads: 1 });
    await fixture.adapter.run({ channel: 'sdk', threadKey: 'one', input: 'first' });
    await fixture.adapter.run({ channel: 'sdk', threadKey: 'two', input: 'second' });
    assert.equal(fixture.clients[0].started.length, 2);
    assert.equal(fixture.clients[0].started[0].runs.length, 1);
    assert.equal(fixture.clients[0].started[1].runs.length, 1);
});

test('bounds client records and evicts the oldest idle client', async () => {
    const fixture = fixtureSdkAdapter({ maxClients: 1 });
    await fixture.adapter.run({ channel: 'sdk', threadKey: 'one', input: 'first', apiKey: 'first-key' });
    await fixture.adapter.run({ channel: 'sdk', threadKey: 'two', input: 'second', apiKey: 'second-key' });
    assert.equal(fixture.clients.length, 2);
});

test('preserves a safe runtime-unavailable diagnostic without falling back to App Server', async () => {
    const diagnostics: string[] = [];
    const adapter = new RideCodexSdkAdapter({
        resolveLaunchSpec: async () => launchSpec(),
        loadRuntime: async () => {
            throw new Error('runtime load failed');
        },
        onDiagnostic: diagnostic => diagnostics.push(diagnostic.code)
    });
    await assert.rejects(
        adapter.run({ channel: 'sdk', threadKey: 'runtime', input: 'test' }),
        error => {
            assert.ok(error instanceof RideCodexSdkError);
            assert.equal(error.code, 'runtime-unavailable');
            return true;
        }
    );
    assert.deepEqual(diagnostics, ['runtime-unavailable']);
});

test('aborts a streamed SDK run immediately and removes the abort listener', async () => {
    let release: (() => void) | undefined;
    let returned = false;
    let markStreamStarted: (() => void) | undefined;
    const streamStarted = new Promise<void>(resolve => { markStreamStarted = resolve; });
    const controller = new AbortController();
    const thread: RideCodexSdkThread = {
        id: 'thread-abort',
        runStreamed: async () => ({
            events: (async function* () {
                try {
                    await new Promise<void>(resolve => {
                        release = resolve;
                        markStreamStarted?.();
                    });
                    yield { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } };
                } finally {
                    returned = true;
                }
            })()
        })
    };
    const adapter = new RideCodexSdkAdapter({
        resolveLaunchSpec: async () => launchSpec(),
        loadRuntime: async () => ({
            createCodexClient: () => ({
                startThread: () => thread,
                resumeThread: () => thread
            })
        })
    });
    const run = adapter.run({ channel: 'sdk', threadKey: 'abort', input: 'wait', signal: controller.signal });
    await streamStarted;
    controller.abort();
    await assert.rejects(run, /cancelled/);
    release?.();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    assert.equal(returned, true);
});
