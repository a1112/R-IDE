import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RideCodexTurnCoordinator, RideCodexTurnHost, RideCodexTurnHostLease } from '../src/node/ride-codex-turn-coordinator';
import { RideCodexThreadCoordinator } from '../src/node/ride-codex-thread-coordinator';

function host() {
    const calls: { method: string; params: any }[] = [];
    const value: RideCodexTurnHost = {
        async acquire(): Promise<RideCodexTurnHostLease> {
            return { generation: 1, release() {}, request(method, params) {
                calls.push({ method, params });
                return { turn: { id: 'turn', status: 'inProgress', items: [] } };
            } };
        },
        onNotification: () => ({ dispose() {} }),
        onStateChange: () => ({ dispose() {} }),
        snapshot: () => ({ state: 'ready', generation: 1 }),
        async restartForRecovery() { return 2; }
    };
    return { value, calls };
}

test('internal review turns force a read-only sandbox and cannot use public turn or resume APIs', async () => {
    const { value, calls } = host();
    const turns = new RideCodexTurnCoordinator({ host: value });
    const threads = new RideCodexThreadCoordinator({ host: value });
    threads.protectReviewThread('review');
    const session = turns.connectReadOnlyClient({ turnEvents() {} }, {
        threadId: 'review', cwd: 'C:\\snapshot', outputSchema: { type: 'object' }
    });
    const ordinary = turns.connectClient({ turnEvents() {} });
    await assert.rejects(ordinary.startTurn({ threadId: 'review', input: [{ type: 'text', text: 'write' }] }));
    await assert.rejects(threads.resumeThread({ threadId: 'review', workspaceRoot: 'C:\\elsewhere' }));
    await session.startTurn({ threadId: 'review', input: [{ type: 'text', text: 'review' }] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.approvalPolicy, 'never');
    assert.deepEqual(calls[0].params.sandboxPolicy, {
        type: 'readOnly', networkAccess: false
    });
    assert.deepEqual(calls[0].params.outputSchema, { type: 'object' });
    await turns.dispose();
    threads.dispose();
});

test('cancelling before the turn lease arrives never starts a late turn', async () => {
    const { value, calls } = host();
    let resolve!: (lease: RideCodexTurnHostLease) => void;
    const acquiring = new Promise<RideCodexTurnHostLease>(done => { resolve = done; });
    value.acquire = () => acquiring;
    const turns = new RideCodexTurnCoordinator({ host: value });
    const session = turns.connectReadOnlyClient({ turnEvents() {} }, {
        threadId: 'review', cwd: 'C:\\snapshot', outputSchema: {}
    });
    const pending = session.startTurn({ threadId: 'review', input: [{ type: 'text', text: 'review' }] });
    const rejection = assert.rejects(pending);
    await session.cancelPending();
    let released = false;
    resolve({ generation: 1, request(method, params) { calls.push({ method, params }); }, release() { released = true; } });
    await rejection;
    await new Promise(done => setImmediate(done));
    assert.equal(calls.length, 0);
    assert.equal(released, true);
    await turns.dispose();
});

test('cancelling an unacknowledged review start holds recovery and never resumes the ephemeral thread', async () => {
    const { value, calls } = host();
    let generation = 1;
    let finishRestart!: (generation: number) => void;
    value.snapshot = () => ({ state: 'ready', generation });
    value.restartForRecovery = () => new Promise(resolve => { finishRestart = resolve; });
    value.acquire = async () => ({ generation, release() {}, request(method, params) {
        calls.push({ method, params });
        if (method === 'turn/start') { return new Promise(() => undefined); }
        return {};
    } });
    const turns = new RideCodexTurnCoordinator({ host: value });
    const session = turns.connectReadOnlyClient({ turnEvents() {} }, { threadId: 'review', cwd: 'C:\\snapshot', outputSchema: {} });
    const pending = session.startTurn({ threadId: 'review', input: [{ type: 'text', text: 'review' }] });
    const rejected = assert.rejects(pending);
    await new Promise(done => setImmediate(done));
    const cancellation = session.cancelPending();
    await new Promise(done => setImmediate(done));
    assert.throws(() => turns.connectClient({ turnEvents() {} }));
    generation = 2;
    finishRestart(generation);
    await cancellation;
    await rejected;
    assert.equal(calls.filter(call => call.method === 'thread/resume').length, 0);
    assert.doesNotThrow(() => turns.connectClient({ turnEvents() {} }));
    await turns.dispose();
});
