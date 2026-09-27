import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RideCodexTurnCoordinator, RideCodexTurnHost, RideCodexTurnHostLease } from 'theia-ide-codex-ext/lib/node/ride-codex-turn-coordinator';
import { RideCodexThreadCoordinator } from 'theia-ide-codex-ext/lib/node/ride-codex-thread-coordinator';
import { RideCodexNotification } from 'theia-ide-codex-ext/lib/node/ride-codex-jsonl-client';
import { CodexReviewAiRunner, ReviewAiResult } from '../src/node/review-ai';
import { ReviewFile } from '../src/common/review-protocol';

const file: ReviewFile = { path: 'src/example.ts', before: 'old\n', after: 'new\n', status: 'M', read: false, bookmarked: false };
const valid = { summary: 'Changed behavior.', comments: [{ path: file.path, side: 'after', start: 1, end: 1, body: 'Check this condition.', severity: 'warning' }] };
class Host implements RideCodexTurnHost {
    calls: { method: string; params: any }[] = [];
    listeners = new Set<(notification: RideCodexNotification, generation: number) => void>();
    output: unknown = valid;
    autoFinish = true;
    acquired = 0;
    released = 0;
    turnNumber = 0;
    sandbox = 'readOnly';
    async acquire(): Promise<RideCodexTurnHostLease> {
        this.acquired++;
        return { generation: 1, release: () => { this.released++; }, request: async (method, params: any) => {
            this.calls.push({ method, params });
            if (method === 'thread/start') {
                return { thread: { id: `review-${this.calls.length}` }, sandbox: { type: this.sandbox }, approvalPolicy: 'never' };
            }
            if (method === 'turn/start') {
                const id = `turn-${++this.turnNumber}`;
                if (this.autoFinish) {
                    setImmediate(() => this.finish(params.threadId, id));
                }
                return { turn: { id, status: 'inProgress', items: [] } };
            }
            if (method === 'turn/interrupt') { this.emit('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted', items: [] } }); }
            return {};
        } };
    }
    finish(threadId: string, id: string) {
        this.emit('item/completed', { threadId, turnId: id, item: { id: 'answer', type: 'agentMessage', text: JSON.stringify(this.output), phase: 'final_answer' } });
        this.emit('turn/completed', { threadId, turn: { id, status: 'completed', items: [] } });
    }
    emit(method: string, params: unknown) { for (const listener of this.listeners) { listener({ method, params }, 1); } }
    onNotification(listener: (notification: RideCodexNotification, generation: number) => void) { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; }
    onStateChange() { return { dispose() {} }; }
    snapshot() { return { state: 'ready' as const, generation: 1 }; }
    async restartForRecovery() { return 2; }
}
function fixture() {
    const host = new Host();
    const turns = new RideCodexTurnCoordinator({ host });
    const threads = new RideCodexThreadCoordinator({ host });
    const runner = new CodexReviewAiRunner(host, turns, threads, { pollMs: 5, timeoutMs: 500 });
    return { host, turns, threads, runner, async dispose() { await turns.dispose(); threads.dispose(); } };
}

test('review remains lazy and uses the snapshot, read-only policies, schema, model, and explicit coverage', async () => {
    const f = fixture();
    assert.equal(f.host.acquired, 0);
    const result = await f.runner.run({ directory: 'C:\\snapshots\\one', files: [file, { ...file, path: 'image.png', skipped: 'binary' }], model: 'selected-model', signal: new AbortController().signal });
    assert.deepEqual(result.covered, [file.path]);
    assert.equal(result.comments.length, 1);
    const thread = f.host.calls.find(c => c.method === 'thread/start')!.params;
    assert.equal(thread.cwd, 'C:\\snapshots\\one');
    assert.equal(thread.sandbox, 'read-only');
    assert.equal(thread.approvalPolicy, 'never');
    assert.equal(thread.ephemeral, true);
    assert.equal(thread.model, 'selected-model');
    const turn = f.host.calls.find(c => c.method === 'turn/start')!.params;
    assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    assert.equal(turn.outputSchema.type, 'object');
    assert.match(result.summary, /image.png/);
    await f.dispose();
});

test('invalid line positions, paths, sides, severities and ranges cannot become comments', async () => {
    const f = fixture();
    f.host.output = { ...valid, comments: [valid.comments[0], ...[
        { start: 99 }, { path: '../outside.ts' }, { side: 'invalid' }, { severity: 'critical' }, { end: 0 }
    ].map(value => ({ ...valid.comments[0], ...value }))] };
    const result = await f.runner.run({ directory: 'C:\\snapshot', files: [file], signal: new AbortController().signal });
    assert.equal(result.comments.length, 1);
    await f.dispose();
});

test('review queues behind an existing turn and cancellation never interrupts its owner', async () => {
    const f = fixture();
    f.host.autoFinish = false;
    const ordinary = f.turns.connectClient({ turnEvents() {} });
    await ordinary.startTurn({ threadId: 'ordinary', input: [{ type: 'text', text: 'work' }] });
    const abort = new AbortController();
    const progress: string[] = [];
    const pending = f.runner.run({ directory: 'C:\\snapshot', files: [file], signal: abort.signal, onProgress: value => progress.push(value) });
    await new Promise(done => setTimeout(done, 30));
    assert.equal(f.host.calls.filter(c => c.method === 'turn/start').length, 1);
    abort.abort();
    await assert.rejects(pending, /cancel/i);
    assert.equal(f.host.calls.filter(c => c.method === 'turn/interrupt').length, 0);
    assert.ok(progress.some(value => /queued/i.test(value)));
    await f.dispose();
});

test('a queued review starts after the active turn completes', async () => {
    const f = fixture();
    f.host.autoFinish = false;
    const ordinary = f.turns.connectClient({ turnEvents() {} });
    await ordinary.startTurn({ threadId: 'ordinary', input: [{ type: 'text', text: 'work' }] });
    const pending = f.runner.run({ directory: 'C:\\snapshot', files: [file], signal: new AbortController().signal });
    await new Promise(done => setTimeout(done, 20));
    f.host.autoFinish = true;
    f.host.finish('ordinary', 'turn-1');
    assert.deepEqual((await pending).covered, [file.path]);
    await f.dispose();
});

test('cancellation interrupts an active review and a hung review times out', async () => {
    const f = fixture();
    f.host.autoFinish = false;
    const abort = new AbortController();
    const pending = f.runner.run({ directory: 'C:\\snapshot', files: [file], signal: abort.signal });
    await new Promise(done => setTimeout(done, 20));
    abort.abort();
    await assert.rejects(pending, /cancel/i);
    assert.equal(f.host.calls.filter(c => c.method === 'turn/interrupt').length, 1);
    await assert.rejects(f.runner.run({ directory: 'C:\\snapshot', files: [file], signal: new AbortController().signal }), /timed out/i);
    assert.equal(f.host.calls.filter(c => c.method === 'turn/interrupt').length, 2);
    await f.dispose();
});

test('pre-cancelled reviews do not start the runtime and malformed structured responses fail', async () => {
    const f = fixture();
    const abort = new AbortController(); abort.abort();
    await assert.rejects(f.runner.run({ directory: 'C:\\snapshot', files: [file], signal: abort.signal }), /cancel/i);
    assert.equal(f.host.acquired, 0);
    f.host.output = { unexpected: true };
    await assert.rejects(f.runner.run({ directory: 'C:\\snapshot', files: [file], signal: new AbortController().signal }), /structured/i);
    await f.dispose();
});

test('a runtime that does not confirm read-only isolation cannot start a review turn', async () => {
    const f = fixture();
    f.host.sandbox = 'workspaceWrite';
    await assert.rejects(f.runner.run({ directory: 'C:\\snapshot', files: [file], signal: new AbortController().signal }), /read-only/i);
    assert.equal(f.host.calls.filter(c => c.method === 'turn/start').length, 0);
    await f.dispose();
});

test('large and binary files are explicitly excluded without starting the runtime', async () => {
    const f = fixture();
    const result = await f.runner.run({ directory: 'C:\\snapshot', files: [
        { ...file, after: 'x'.repeat(49 * 1024) }, { ...file, path: 'image.png', skipped: 'binary' }
    ], signal: new AbortController().signal });
    assert.deepEqual(result.covered, []);
    assert.equal(f.host.acquired, 0);
    assert.match(result.summary, /context limit/);
    assert.match(result.summary, /binary/);
    await f.dispose();
});

test('completed batches and skip reasons are persisted before a later batch fails', async () => {
    const f = fixture();
    const partials: ReviewAiResult[] = [];
    const input = {
        directory: 'C:\\snapshot', files: [file, { ...file, path: 'image.png', skipped: 'binary' }, { ...file, path: 'second.ts' }],
        signal: new AbortController().signal,
        onPartial: async (partial: ReviewAiResult) => {
            await new Promise(done => setTimeout(done, 10));
            partials.push(partial);
            if (partials.length === 2) { f.host.output = { malformed: true }; }
        }
    };
    await assert.rejects(f.runner.run(input), /structured/i);
    assert.equal(partials.length, 2);
    assert.deepEqual(partials[0].covered, [file.path]);
    assert.equal(partials[0].comments.length, 1);
    assert.equal(partials[0].summary.includes('image.png'), false);
    assert.match(partials[1].summary, /image.png.*binary/);
    await f.dispose();
});
