import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ReviewStore } from '../src/node/review-store';

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
async function fixture(t: { after(fn: () => Promise<void>): void }): Promise<{ root: string; repo: string; store: ReviewStore }> {
    const root = await mkdtemp(join(tmpdir(), 'ride-review-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repo = join(root, '代码 repo');
    await mkdir(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.name', 'Review Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(repo, 'a.ts'), 'const a = 1;\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'initial');
    const store = new ReviewStore(join(root, 'data'), async () => ({ path: repo }));
    return { root, repo, store };
}
test('working review freezes tracked and untracked content without changing the index', async t => {
    const { repo, store } = await fixture(t);
    await writeFile(join(repo, 'a.ts'), 'const a = 2;\n'); git(repo, 'add', 'a.ts');
    await writeFile(join(repo, 'a.ts'), 'const a = 3;\n');
    await writeFile(join(repo, 'new.ts'), 'new file\n');
    const status = git(repo, 'status', '--porcelain');
    const review = await store.create('repo', { kind: 'working' });
    assert.equal(review.files.find(f => f.path === 'a.ts')?.after, 'const a = 3;\n');
    assert.equal(review.files.find(f => f.path === 'new.ts')?.before, '');
    await writeFile(join(repo, 'a.ts'), 'later\n');
    assert.equal((await store.read(review.id)).files.find(f => f.path === 'a.ts')?.after, 'const a = 3;\n');
    assert.equal(git(repo, 'status', '--porcelain'), status);
    assert.equal(await readFile(join(await store.snapshotDirectory(review.id), 'a.ts'), 'utf8'), 'const a = 3;\n');
});
test('comments validate snapshot path and line ranges, persist flags, and export', async t => {
    const { repo, store } = await fixture(t);
    await writeFile(join(repo, 'a.ts'), 'const a = 2;\n');
    const review = await store.create('repo', { kind: 'working' });
    await assert.rejects(store.comment(review.id, { path: '../escape', side: 'after', start: 1, end: 1, body: 'bad' }));
    await assert.rejects(store.comment(review.id, { path: 'a.ts', side: 'after', start: 99, end: 99, body: 'bad' }));
    const updated = await store.comment(review.id, { path: 'a.ts', side: 'after', start: 1, end: 1, body: 'Check constant' });
    await store.markFile(review.id, 'a.ts', { read: true, bookmarked: true });
    assert.equal(updated.comments[0].source, 'human');
    assert.equal((await store.read(review.id)).files[0].read, true);
    assert.match(await store.exportMarkdown(review.id), /Check constant/);
});
test('commit review supports initial commit and branch review freezes resolved refs', async t => {
    const { repo, store } = await fixture(t);
    const initial = await store.create('repo', { kind: 'commit', commit: 'HEAD' });
    assert.equal(initial.files[0].before, '');
    await writeFile(join(repo, 'a.ts'), 'updated\n'); git(repo, 'commit', '-am', 'update');
    const review = await store.create('repo', { kind: 'branch', base: 'HEAD~1', head: 'HEAD' });
    assert.equal(review.files[0].after, 'updated\n');
    assert.equal((await store.history('repo')).length, 2);
    assert.match(await store.blame(review.id, 'a.ts'), /updated/);
});
test('binary and symlink files are not materialized for AI; invalid refs are rejected', async t => {
    const { repo, store } = await fixture(t);
    await writeFile(join(repo, 'binary'), Buffer.from([0, 1, 2]));
    const review = await store.create('repo', { kind: 'working' });
    assert.match(review.files[0].skipped ?? '', /binary/);
    await assert.rejects(store.create('repo', { kind: 'commit', commit: '--help' }));
    await assert.rejects(store.read('../outside'));
});

test('unchanged CRLF checkout does not become a working change', async t => {
    const { repo, store } = await fixture(t);
    git(repo, 'config', 'core.autocrlf', 'true');
    await writeFile(join(repo, 'a.ts'), 'const a = 1;\r\n');
    assert.equal(git(repo, 'diff', '--name-only'), '');
    assert.equal((await store.create('repo', { kind: 'working' })).files.length, 0);
});

test('snapshot Git commands ignore inherited repository overrides', async t => {
    const { root, repo, store } = await fixture(t);
    const other = join(root, 'other');
    await mkdir(other); git(other, 'init', '-b', 'other');
    await writeFile(join(repo, 'a.ts'), 'expected snapshot\n');
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other, '.git');
    try {
        const review = await store.create('repo', { kind: 'working' });
        assert.equal(review.files.find(f => f.path === 'a.ts')?.after, 'expected snapshot\n');
        assert.ok(review.base);
    } finally {
        if (previous === undefined) { delete process.env.GIT_DIR; } else { process.env.GIT_DIR = previous; }
    }
});

test('incremental review compares with frozen previous contents', async t => {
    const { repo, store } = await fixture(t);
    await writeFile(join(repo, 'a.ts'), 'first\n');
    const first = await store.create('repo', { kind: 'working' });
    await writeFile(join(repo, 'a.ts'), 'second\n');
    const second = await store.create('repo', { kind: 'working' }, first.id);
    assert.equal(second.files[0].before, 'first\n');
    assert.equal(second.files[0].after, 'second\n');
    assert.equal((await store.read(first.id)).files[0].after, 'first\n');
});

test('AI jobs queue, cancellation preserves human comments, and a cancelled job can be retried', async t => {
    const { root, repo } = await fixture(t);
    await writeFile(join(repo, 'a.ts'), 'changed\n');
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    const store = new ReviewStore(join(root, 'ai-data'), async () => ({ path: repo }), undefined, {
        run: async input => {
            calls++;
            if (calls === 1) {
                started();
                await new Promise<void>(resolve => { finish = resolve; input.signal.addEventListener('abort', () => resolve(), { once: true }); });
            }
            return { summary: 'Reviewed', covered: ['a.ts'], comments: [] };
        }
    });
    t.after(() => store.stop());
    const first = await store.create('repo', { kind: 'working' });
    const second = await store.create('repo', { kind: 'working' });
    await store.comment(second.id, { path: 'a.ts', side: 'after', start: 1, end: 1, body: 'Keep human note' });
    await store.startAi(first.id); await entered;
    assert.equal((await store.startAi(second.id)).ai.state, 'queued');
    await store.cancelAi(second.id); finish();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(calls, 1);
    assert.equal((await store.read(second.id)).ai.state, 'cancelled');
    await store.startAi(second.id);
    for (let i = 0; i < 100 && (await store.read(second.id)).ai.state !== 'completed'; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    const reviewed = await store.read(second.id);
    assert.equal(reviewed.ai.state, 'completed');
    assert.equal(reviewed.comments[0].body, 'Keep human note');
});

test('restart marks unfinished AI work failed without losing snapshot metadata', async t => {
    const { root, repo, store } = await fixture(t);
    await writeFile(join(repo, 'a.ts'), 'changed\n');
    const review = await store.create('repo', { kind: 'working' });
    const filename = join(root, 'data', 'reviews', review.id, 'review.json');
    const stored = JSON.parse(await readFile(filename, 'utf8'));
    stored.ai.state = 'running'; await writeFile(filename, JSON.stringify(stored));
    const reopened = new ReviewStore(join(root, 'data'), async () => ({ path: repo }));
    assert.equal((await reopened.read(review.id)).ai.state, 'failed');
    assert.equal((await reopened.read(review.id)).files[0].after, 'changed\n');
});

test('deleting a review cannot be undone by pending metadata mutations', async t => {
    const { root, repo, store } = await fixture(t);
    await writeFile(join(repo, 'a.ts'), 'changed\n');
    const review = await store.create('repo', { kind: 'working' });
    await Promise.allSettled([
        ...Array.from({ length: 20 }, () => store.markFile(review.id, 'a.ts', { read: true })),
        store.delete(review.id)
    ]);
    assert.equal((await new ReviewStore(join(root, 'data'), async () => ({ path: repo })).list()).length, 0);
    await assert.rejects(store.read(review.id));
});

test('completed AI batches and resolved findings survive a later batch failure', async t => {
    const { root, repo } = await fixture(t);
    await writeFile(join(repo, 'a.ts'), 'changed\n');
    let reviewId = '';
    const finding = { path: 'a.ts', side: 'after' as const, start: 1, end: 1, body: 'Review this line', severity: 'warning' as const };
    const result = { summary: 'First batch', covered: ['a.ts'], comments: [finding] };
    const store = new ReviewStore(join(root, 'partial'), async () => ({ path: repo }), undefined, {
        run: async input => {
            await input.onPartial?.(result);
            const current = await store.read(reviewId);
            await store.resolveComment(reviewId, current.comments[0].id, true);
            await input.onPartial?.(result);
            throw new Error('Later batch failed');
        }
    });
    t.after(() => store.stop());
    reviewId = (await store.create('repo', { kind: 'working' })).id;
    await store.startAi(reviewId);
    for (let i = 0; i < 100 && (await store.read(reviewId)).ai.state !== 'failed'; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    const review = await store.read(reviewId);
    assert.equal(review.ai.state, 'failed');
    assert.deepEqual(review.ai.covered, ['a.ts']);
    assert.equal(review.ai.summary, 'First batch');
    assert.equal(review.comments[0].resolved, true);
});

test('tracked build directory files remain reviewable and list returns metadata only', async t => {
    const { repo, store } = await fixture(t);
    await mkdir(join(repo, 'build'));
    await writeFile(join(repo, 'build', 'tracked.ts'), 'source\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'track build source');
    await writeFile(join(repo, 'build', 'tracked.ts'), 'changed\n');
    const review = await store.create('repo', { kind: 'working' });
    assert.equal(review.files[0].path, 'build/tracked.ts');
    const summaries = await store.list('repo');
    assert.equal(summaries[0].fileCount, 1);
    assert.equal('files' in summaries[0], false);
});

test('mode-only changes appear in working, commit and branch reviews', async t => {
    const { repo, store } = await fixture(t);
    git(repo, 'config', 'core.filemode', 'false');
    git(repo, 'update-index', '--chmod=+x', 'a.ts');
    const working = await store.create('repo', { kind: 'working' });
    assert.equal(working.files.length, 1);
    assert.equal(working.files[0].beforeMode, '100644');
    assert.equal(working.files[0].afterMode, '100755');
    git(repo, 'commit', '-m', 'make executable');
    for (const target of [{ kind: 'commit' as const, commit: 'HEAD' }, { kind: 'branch' as const, base: 'HEAD~1', head: 'HEAD' }]) {
        const review = await store.create('repo', target);
        assert.equal(review.files.length, 1);
        assert.equal(review.files[0].afterMode, '100755');
    }
});
