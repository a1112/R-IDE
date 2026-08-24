/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RideCodexJsonlClient, RideCodexJsonlTransport } from '../src/node/ride-codex-jsonl-client';
import { RideCodexJsonlFramer } from '../src/node/ride-codex-jsonl-framer';

interface DisposableLike {
    dispose(): void;
}

class FakeTransport implements RideCodexJsonlTransport {
    closed = false;
    readonly writes: string[] = [];
    closeCalls = 0;
    protected readonly dataListeners = new Set<(chunk: Uint8Array) => void>();
    protected readonly exitListeners = new Set<(reason?: Error) => void>();

    write(data: string): void {
        if (this.closed) {
            throw new Error('write after close');
        }
        this.writes.push(data);
    }

    onData(listener: (chunk: Uint8Array) => void): DisposableLike {
        this.dataListeners.add(listener);
        return { dispose: () => this.dataListeners.delete(listener) };
    }

    onExit(listener: (reason?: Error) => void): DisposableLike {
        this.exitListeners.add(listener);
        return { dispose: () => this.exitListeners.delete(listener) };
    }

    close(): void {
        this.closeCalls += 1;
        this.closed = true;
    }

    emitData(data: string | Uint8Array): void {
        const chunk = typeof data === 'string' ? Buffer.from(data) : data;
        for (const listener of [...this.dataListeners]) {
            listener(chunk);
        }
    }

    exit(reason = new Error('transport exited')): void {
        this.closed = true;
        for (const listener of [...this.exitListeners]) {
            listener(reason);
        }
    }

    get listenerCount(): number {
        return this.dataListeners.size + this.exitListeners.size;
    }
}

function parseWrite(transport: FakeTransport, index: number): Record<string, unknown> {
    return JSON.parse(transport.writes[index]) as Record<string, unknown>;
}

function wait(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

test('frames split and coalesced JSONL, CRLF, and split UTF-8 bytes', () => {
    const framer = new RideCodexJsonlFramer(128);
    const encoded = Buffer.from('{"text":"你"}\r\n{"second":true}\n');
    const character = encoded.indexOf(Buffer.from('你'));

    assert.deepEqual(framer.push(encoded.subarray(0, character + 1)), []);
    const lines = framer.push(encoded.subarray(character + 1));

    assert.deepEqual(lines.map(line => Buffer.from(line).toString('utf8')), [
        '{"text":"你"}',
        '{"second":true}'
    ]);
});

test('rejects an overlong byte line before it can be parsed', async () => {
    const framer = new RideCodexJsonlFramer(4);
    assert.throws(() => framer.push(Buffer.from('12345')), /maximum byte length/i);

    const transport = new FakeTransport();
    const client = new RideCodexJsonlClient(transport, { maxLineBytes: 8 });
    const pending = client.request('initialize', {});

    transport.emitData('{not-json-but-too-long}\n');

    await assert.rejects(pending, /maximum byte length/i);
    assert.equal(transport.closeCalls, 1);
    client.dispose();
});

test('uses monotonic IDs, enforces max pending, and correlates out-of-order responses', async () => {
    const transport = new FakeTransport();
    const client = new RideCodexJsonlClient(transport, { maxPending: 2 });

    const first = client.request('initialize', { clientInfo: { name: 'R-IDE' } });
    const second = client.request('account/read', {});
    await assert.rejects(client.request('model/list', {}), /maximum pending/i);

    assert.equal(parseWrite(transport, 0).id, 1);
    assert.equal(parseWrite(transport, 1).id, 2);
    assert.equal(transport.writes.length, 2);

    transport.emitData('{"id":2,"result":{"account":"ready"}}\n{"id":1,"result":{"initialized":true}}\n');
    assert.deepEqual(await second, { account: 'ready' });
    assert.deepEqual(await first, { initialized: true });
    client.dispose();
});

test('rejects non-reviewed client methods and never wraps request IDs', async () => {
    const transport = new FakeTransport();
    const client = new RideCodexJsonlClient(transport, { initialRequestId: Number.MAX_SAFE_INTEGER });
    const unsafeRequest = client.request as (method: string, params: unknown) => Promise<unknown>;

    await assert.rejects(unsafeRequest('experimentalFeature/list', {}), /unsupported client method/i);
    assert.equal(transport.writes.length, 0);

    const last = client.request('initialize', {});
    assert.equal(parseWrite(transport, 0).id, Number.MAX_SAFE_INTEGER);
    transport.emitData(`${JSON.stringify({ id: Number.MAX_SAFE_INTEGER, result: true })}\n`);
    assert.equal(await last, true);
    await assert.rejects(client.request('account/read', {}), /request ID space exhausted/i);
    assert.equal(transport.writes.length, 1);
    client.dispose();
});

test('dispatches reviewed notifications and bounds deduplicated unknown diagnostics', async () => {
    const transport = new FakeTransport();
    const client = new RideCodexJsonlClient(transport, { maxDiagnostics: 2 });
    const notifications: Array<{ method: string; params: unknown }> = [];
    const diagnostics: Array<{ code: string; message: string }> = [];
    client.onNotification(notification => notifications.push(notification));
    client.onDiagnostic(diagnostic => diagnostics.push(diagnostic));

    transport.emitData(`${JSON.stringify({ method: 'thread/started', params: { thread: 'one' } })}\n`);
    transport.emitData(`${JSON.stringify({ method: 'experimental/secret', params: { apiKey: 'must-not-leak' } })}\n`);
    transport.emitData(`${JSON.stringify({ method: 'experimental/secret', params: { apiKey: 'must-not-leak' } })}\n`);
    transport.emitData(`${JSON.stringify({ method: 'future/one', params: { token: 'also-secret' } })}\n`);
    transport.emitData(`${JSON.stringify({ method: 'future/two', params: {} })}\n`);

    assert.deepEqual(notifications, [{ method: 'thread/started', params: { thread: 'one' } }]);
    assert.equal(diagnostics.length, 2);
    assert.ok(diagnostics.every(diagnostic => diagnostic.code === 'unknown-server-notification'));
    assert.ok(diagnostics.every(diagnostic => diagnostic.message.length <= 160));
    assert.ok(diagnostics.every(diagnostic => !/must-not-leak|also-secret|apiKey|token/.test(diagnostic.message)));

    const pending = client.request('account/read', {});
    transport.emitData(`${JSON.stringify({ id: parseWrite(transport, 0).id, result: { ok: true } })}\n`);
    assert.deepEqual(await pending, { ok: true });
    client.dispose();
});

test('dispatches approved server requests and replies method-not-found to unknown requests', () => {
    const transport = new FakeTransport();
    const client = new RideCodexJsonlClient(transport);
    const requests: Array<{ id: string | number; method: string; params: unknown }> = [];
    client.onServerRequest(request => requests.push(request));

    transport.emitData(`${JSON.stringify({
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'npm test' }
    })}\n`);
    transport.emitData(`${JSON.stringify({
        id: 'approval-2',
        method: 'item/fileChange/requestApproval',
        params: { path: 'README.md' }
    })}\n`);
    transport.emitData(`${JSON.stringify({ id: 42, method: 'item/tool/requestUserInput', params: { secret: 'hidden' } })}\n`);

    assert.deepEqual(requests, [
        {
            id: 'approval-1',
            method: 'item/commandExecution/requestApproval',
            params: { command: 'npm test' }
        },
        {
            id: 'approval-2',
            method: 'item/fileChange/requestApproval',
            params: { path: 'README.md' }
        }
    ]);
    assert.deepEqual(parseWrite(transport, 0), {
        id: 42,
        error: { code: -32601, message: 'Method not found' }
    });

    client.respond('approval-1', { decision: 'accept' });
    client.respond('approval-2', { decision: 'acceptForSession' });
    client.respondError('approval-3', -32000, 'Approval unavailable');
    assert.deepEqual(parseWrite(transport, 1), { id: 'approval-1', result: { decision: 'accept' } });
    assert.deepEqual(parseWrite(transport, 2), {
        id: 'approval-2', result: { decision: 'acceptForSession' }
    });
    assert.deepEqual(parseWrite(transport, 3), {
        id: 'approval-3',
        error: { code: -32000, message: 'Approval unavailable' }
    });
    client.dispose();
});

test('treats reviewed server messages without params as fatal malformed envelopes', async t => {
    const cases: ReadonlyArray<{
        name: string;
        data: string;
        subscribe(client: RideCodexJsonlClient): () => number;
    }> = [
        {
            name: 'reviewed notification',
            data: '{"method":"thread/started"}\n',
            subscribe: client => {
                const notifications: unknown[] = [];
                client.onNotification(notification => notifications.push(notification));
                return () => notifications.length;
            }
        },
        {
            name: 'approved server request',
            data: '{"id":"approval-1","method":"item/commandExecution/requestApproval"}\n',
            subscribe: client => {
                const requests: unknown[] = [];
                client.onServerRequest(request => requests.push(request));
                return () => requests.length;
            }
        }
    ];

    for (const entry of cases) {
        await t.test(entry.name, async () => {
            const transport = new FakeTransport();
            const client = new RideCodexJsonlClient(transport);
            const dispatchCount = entry.subscribe(client);
            const pending = client.request('initialize', {});

            transport.emitData(entry.data);

            await assert.rejects(pending, /protocol|envelope|params/i);
            assert.equal(dispatchCount(), 0);
            assert.equal(client.pendingCount, 0);
            assert.equal(transport.closeCalls, 1);
            assert.equal(transport.listenerCount, 0);
            client.dispose();
            assert.equal(transport.closeCalls, 1);
        });
    }
});

test('rejects remote errors and cleans the pending request', async () => {
    const transport = new FakeTransport();
    const client = new RideCodexJsonlClient(transport);
    const pending = client.request('account/read', {});

    transport.emitData(`${JSON.stringify({ id: 1, error: { code: -32001, message: 'not signed in' } })}\n`);

    await assert.rejects(pending, error => {
        assert.equal((error as { code?: number }).code, -32001);
        assert.match((error as Error).message, /not signed in/);
        return true;
    });
    assert.equal(client.pendingCount, 0);
    client.dispose();
});

test('times out one request without closing the connection or retaining its timer', async () => {
    const transport = new FakeTransport();
    const client = new RideCodexJsonlClient(transport);
    const timedOut = client.request('initialize', {}, 10);
    await assert.rejects(timedOut, /timed out/i);
    assert.equal(client.pendingCount, 0);

    const next = client.request('account/read', {});
    const id = parseWrite(transport, 1).id;
    transport.emitData(`${JSON.stringify({ id, result: 'alive' })}\n`);
    assert.equal(await next, 'alive');
    client.dispose();
});

test('treats malformed JSON, invalid UTF-8, and invalid envelopes as fatal connection data', async t => {
    const cases: ReadonlyArray<{ name: string; data: string | Uint8Array }> = [
        { name: 'malformed JSON', data: '{bad-json}\n' },
        { name: 'invalid UTF-8', data: Uint8Array.from([0xc3, 0x28, 0x0a]) },
        { name: 'missing response payload', data: '{"id":1}\n' },
        { name: 'ambiguous response', data: '{"id":1,"result":true,"error":{"code":1,"message":"bad"}}\n' },
        { name: 'invalid error', data: '{"id":1,"error":{"code":"bad","message":1}}\n' },
        { name: 'invalid method', data: '{"method":1,"params":{}}\n' }
    ];

    for (const entry of cases) {
        await t.test(entry.name, async () => {
            const transport = new FakeTransport();
            const client = new RideCodexJsonlClient(transport);
            const pending = client.request('initialize', {});
            transport.emitData(entry.data);
            await assert.rejects(pending, /protocol|JSON|UTF-8|envelope/i);
            assert.equal(transport.closeCalls, 1);
            assert.equal(client.pendingCount, 0);
            assert.equal(transport.listenerCount, 0);
            client.dispose();
            assert.equal(transport.closeCalls, 1);
        });
    }
});

test('duplicate and unknown response IDs are fatal and reject remaining pending requests once', async t => {
    await t.test('duplicate response', async () => {
        const transport = new FakeTransport();
        const client = new RideCodexJsonlClient(transport);
        const first = client.request('initialize', {});
        const second = client.request('account/read', {});
        transport.emitData('{"id":1,"result":"first"}\n');
        assert.equal(await first, 'first');
        transport.emitData('{"id":1,"result":"duplicate"}\n');
        await assert.rejects(second, /unknown or duplicate response ID/i);
        assert.equal(transport.closeCalls, 1);
        client.dispose();
    });

    await t.test('unknown response', async () => {
        const transport = new FakeTransport();
        const client = new RideCodexJsonlClient(transport);
        const pending = client.request('initialize', {});
        transport.emitData('{"id":999,"result":true}\n');
        await assert.rejects(pending, /unknown or duplicate response ID/i);
        assert.equal(transport.closeCalls, 1);
        client.dispose();
    });
});

test('transport exit and idempotent disposal reject all pending and prevent later writes', async () => {
    const transport = new FakeTransport();
    const client = new RideCodexJsonlClient(transport);
    const first = client.request('initialize', {});
    const second = client.request('account/read', {});

    transport.exit(new Error('exit code: 1'));
    await assert.rejects(first, /exit code: 1/);
    await assert.rejects(second, /exit code: 1/);
    assert.equal(client.pendingCount, 0);
    assert.equal(transport.listenerCount, 0);

    client.dispose();
    client.dispose();
    client.respond('late', {});
    client.respondError('late', -32603, 'late');
    transport.emitData('{"method":"thread/started","params":{}}\n');
    await assert.rejects(client.request('model/list', {}), /closed|disposed/i);
    assert.equal(transport.writes.length, 2);
});

test('dispose rejects pending exactly once, clears listeners, and closes the transport once', async () => {
    const transport = new FakeTransport();
    const client = new RideCodexJsonlClient(transport);
    const pending = client.request('initialize', {}, 20);

    client.dispose();
    client.dispose();
    transport.exit();
    await wait(30);

    await assert.rejects(pending, /disposed/i);
    assert.equal(client.pendingCount, 0);
    assert.equal(transport.listenerCount, 0);
    assert.equal(transport.closeCalls, 1);
});
