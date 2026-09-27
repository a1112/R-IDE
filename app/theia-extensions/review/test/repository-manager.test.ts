import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RepositoryManager } from '../src/node/repository-manager';
import { ReviewStore } from '../src/node/review-store';

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function fixture() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ride-review-'));
    const remote = path.join(dir, 'remote.git');
    const source = path.join(dir, 'source');
    const roots = path.join(dir, 'repos 中文');
    const local = path.join(roots, 'local project');
    await fs.mkdir(roots);
    git(dir, 'init', '--bare', '--initial-branch=main', remote);
    git(dir, 'clone', remote, source);
    for (const repo of [source]) { git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'core.autocrlf', 'false'); }
    await fs.writeFile(path.join(source, 'file.txt'), 'base\n');
    git(source, 'add', '.'); git(source, 'commit', '-m', 'base'); git(source, 'push', '-u', 'origin', 'main');
    git(dir, 'clone', remote, local);
    git(local, 'config', 'user.name', 'Test'); git(local, 'config', 'user.email', 'test@example.invalid');
    git(local, 'config', 'core.autocrlf', 'false');
    const dataDir = path.join(dir, 'data');
    const manager = new RepositoryManager({ dataDir });
    await manager.initialize();
    const [repo] = await manager.addRoot(roots);
    const advance = async (name = 'remote.txt', content = 'remote\n') => {
        await fs.writeFile(path.join(source, name), content);
        git(source, 'add', '.'); git(source, 'commit', '-m', 'remote change'); git(source, 'push');
    };
    return { dir, remote, source, roots, local, dataDir, manager, repo, advance, close: async () => { await manager.stop(); await fs.rm(dir, { recursive: true, force: true }); } };
}

test('discovers canonical worktrees once and leaves automatic updates opt-in', async () => {
    const f = await fixture();
    try {
        const worktree = path.join(f.roots, 'worktree');
        git(f.local, 'worktree', 'add', '-b', 'feature', worktree);
        const repos = await f.manager.addRoot(f.roots);
        assert.equal(repos.length, 2);
        assert.equal(new Set(repos.map(r => r.commonDir)).size, 1);
        assert.ok(repos.every(r => !r.enabled));
        assert.equal((await f.manager.addRoot(f.local)).length, 2);
    } finally { await f.close(); }
});

test('fast forwards and records durable cursor events', async () => {
    const f = await fixture();
    try {
        await f.advance();
        const result = await f.manager.sync(f.repo.id);
        assert.equal(result.state, 'idle');
        assert.equal(git(f.local, 'rev-parse', 'HEAD'), git(f.source, 'rev-parse', 'HEAD'));
        const events = await f.manager.events();
        assert.ok(events.some(e => e.type === 'sync-success'));
        assert.equal((await f.manager.events(events[events.length - 1].id)).length, 0);
        const restarted = new RepositoryManager({ dataDir: f.dataDir });
        await restarted.initialize();
        assert.equal((await restarted.list()).length, 1);
        assert.ok((await restarted.events()).some(e => e.type === 'sync-success'));
        await restarted.stop();
    } finally { await f.close(); }
});

test('preserves staged, unstaged and untracked changes while updating', async () => {
    const f = await fixture();
    try {
        await fs.writeFile(path.join(f.local, 'file.txt'), 'staged\n'); git(f.local, 'add', 'file.txt');
        await fs.appendFile(path.join(f.local, 'file.txt'), 'unstaged\n');
        await fs.writeFile(path.join(f.local, 'untracked.txt'), 'keep\n');
        await f.advance();
        const result = await f.manager.sync(f.repo.id);
        assert.equal(result.state, 'idle', result.reason || 'sync succeeds');
        assert.equal(git(f.local, 'show', ':file.txt'), 'staged');
        assert.equal(await fs.readFile(path.join(f.local, 'file.txt'), 'utf8'), 'staged\nunstaged\n');
        assert.equal(await fs.readFile(path.join(f.local, 'untracked.txt'), 'utf8'), 'keep\n');
        assert.match(git(f.local, 'stash', 'list'), /ride-review/);
        assert.ok(result.retainedStash);
    } finally { await f.close(); }
});

test('rebases unpublished commits and retains the original head recovery ref', async () => {
    const f = await fixture();
    try {
        await fs.writeFile(path.join(f.local, 'local.txt'), 'local\n'); git(f.local, 'add', '.'); git(f.local, 'commit', '-m', 'local');
        const oldHead = git(f.local, 'rev-parse', 'HEAD');
        await f.advance();
        const result = await f.manager.sync(f.repo.id);
        assert.equal(result.state, 'idle', result.reason || 'sync succeeds');
        assert.equal(result.ahead, 1);
        assert.equal(git(f.local, 'show', 'HEAD:local.txt'), 'local');
        assert.ok(git(f.local, 'for-each-ref', '--format=%(objectname)', 'refs/ride-review').includes(oldHead));
    } finally { await f.close(); }
});

test('pauses conflicts, preserves stash and resumes only by explicit recovery', async () => {
    const f = await fixture();
    try {
        await fs.writeFile(path.join(f.local, 'file.txt'), 'local\n'); git(f.local, 'add', '.'); git(f.local, 'commit', '-m', 'conflicting local');
        await fs.writeFile(path.join(f.local, 'untracked.txt'), 'precious');
        await f.advance('file.txt', 'remote\n');
        const result = await f.manager.sync(f.repo.id);
        assert.equal(result.state, 'paused');
        assert.match(result.reason || '', /conflict|rebase/i);
        const restarted = new RepositoryManager({ dataDir: f.dataDir });
        await restarted.initialize();
        assert.equal((await restarted.getRepository(f.repo.id)).state, 'paused');
        assert.equal((await restarted.sync(f.repo.id)).state, 'paused');
        const restored = await restarted.recover(f.repo.id, 'abort');
        assert.equal(restored.state, 'idle', restored.reason || 'recovery succeeds');
        assert.equal(git(f.local, 'show', 'HEAD:file.txt'), 'local');
        assert.equal(await fs.readFile(path.join(f.local, 'untracked.txt'), 'utf8'), 'precious');
        await restarted.stop();
    } finally { await f.close(); }
});

test('defers dirty editors, existing Git operations and index locks', async () => {
    const f = await fixture();
    try {
        await f.advance();
        const original = git(f.local, 'rev-parse', 'HEAD');
        await f.manager.setDirtyPaths('window', [path.join(f.local, 'file.txt')]);
        assert.match((await f.manager.sync(f.repo.id)).reason || '', /unsaved/i);
        assert.equal(git(f.local, 'rev-parse', 'HEAD'), original);
        await f.manager.setDirtyPaths('window', []);
        await f.manager.disconnectClient('window');
        await fs.writeFile(path.join(f.repo.gitDir, 'index.lock'), 'external');
        assert.match((await f.manager.sync(f.repo.id)).reason || '', /lock/i);
        await fs.unlink(path.join(f.repo.gitDir, 'index.lock'));
        git(f.local, 'branch', '--unset-upstream');
        assert.match((await f.manager.sync(f.repo.id)).reason || '', /upstream/i);
    } finally { await f.close(); }
});

test('detects remote history rewrites before touching the worktree', async () => {
    const f = await fixture();
    try {
        await f.advance(); await f.manager.sync(f.repo.id);
        git(f.source, 'reset', '--hard', 'HEAD~1');
        await fs.writeFile(path.join(f.source, 'rewrite.txt'), 'rewrite');
        git(f.source, 'add', '.'); git(f.source, 'commit', '-m', 'rewritten history');
        git(f.source, 'push', '--force');
        const original = git(f.local, 'rev-parse', 'HEAD');
        const result = await f.manager.sync(f.repo.id);
        assert.equal(result.state, 'paused');
        assert.match(result.reason || '', /rewrit/i);
        assert.equal(git(f.local, 'rev-parse', 'HEAD'), original);
    } finally { await f.close(); }
});

test('rejects malformed RPC inputs and unknown ids', async () => {
    const f = await fixture();
    try {
        await assert.rejects(f.manager.addRoot('relative'), /absolute/i);
        await assert.rejects(f.manager.sync('--upload-pack=evil'), /repository/i);
        await assert.rejects(f.manager.configure(f.repo.id, { enabled: true, intervalMs: -1 }), /interval/i);
        await assert.rejects(f.manager.setDirtyPaths('window', ['relative']), /absolute/i);
    } finally { await f.close(); }
});

test('does not rebase a local commit already published on another remote branch', async () => {
    const f = await fixture();
    try {
        await fs.writeFile(path.join(f.local, 'published.txt'), 'published'); git(f.local, 'add', '.'); git(f.local, 'commit', '-m', 'published');
        git(f.local, 'push', 'origin', 'HEAD:published');
        const head = git(f.local, 'rev-parse', 'HEAD');
        await f.advance();
        const result = await f.manager.sync(f.repo.id);
        assert.equal(result.state, 'paused');
        assert.match(result.reason || '', /published/i);
        assert.equal(git(f.local, 'rev-parse', 'HEAD'), head);
    } finally { await f.close(); }
});

test('stash conflicts preserve recovery objects and manual resolutions survive continue', async () => {
    const f = await fixture();
    try {
        await fs.writeFile(path.join(f.local, 'file.txt'), 'local dirty\n');
        await f.advance('file.txt', 'remote\n');
        const result = await f.manager.sync(f.repo.id);
        assert.equal(result.state, 'paused');
        assert.match(result.reason || '', /restor/i);
        assert.ok(git(f.local, 'stash', 'list').includes('ride-review'));
        await fs.writeFile(path.join(f.local, 'file.txt'), 'resolved\n'); git(f.local, 'add', 'file.txt');
        const pending = await f.manager.recover(f.repo.id, 'continue');
        assert.equal(pending.state, 'paused');
        assert.equal(pending.recoveryNeedsConfirmation, true);
        const restored = await f.manager.recover(f.repo.id, 'continue', true);
        assert.equal(restored.state, 'idle');
        assert.equal(await fs.readFile(path.join(f.local, 'file.txt'), 'utf8'), 'resolved\n');
    } finally { await f.close(); }
});

test('restoration never applies saved edits to a concurrently changed HEAD', async () => {
    const f = await fixture();
    try {
        const originalHead = git(f.local, 'rev-parse', 'HEAD');
        await fs.writeFile(path.join(f.local, 'file.txt'), 'saved local\n');
        git(f.local, 'stash', 'push', '-m', 'saved');
        const stash = git(f.local, 'rev-parse', 'refs/stash');
        await fs.writeFile(path.join(f.local, 'external.txt'), 'external'); git(f.local, 'add', '.'); git(f.local, 'commit', '-m', 'external');
        const result = await f.manager['restore'](f.repo, { id: 'concurrent', repositoryId: f.repo.id, originalHead, branch: 'main', target: originalHead, updatedHead: originalHead, backupRef: 'refs/ride-review/recovery/concurrent', stash, phase: 'updated', createdAt: Date.now() });
        assert.equal(result.state, 'paused');
        assert.match(result.reason || '', /HEAD|branch/i);
        assert.equal(git(f.local, 'show', 'HEAD:file.txt'), 'base');
        assert.equal((await fs.readFile(path.join(f.local, 'file.txt'), 'utf8')).trim(), 'base');
        assert.ok(git(f.local, 'stash', 'list').includes('saved'));
    } finally { await f.close(); }
});

test('an interrupted restoration with a clean tree retries the exact stash instead of claiming success', async () => {
    const f = await fixture();
    try {
        const head = git(f.local, 'rev-parse', 'HEAD');
        await fs.writeFile(path.join(f.local, 'file.txt'), 'saved local\n'); git(f.local, 'stash', 'push', '-m', 'saved');
        const stash = git(f.local, 'rev-parse', 'refs/stash');
        await fs.appendFile(path.join(f.dataDir, 'transactions.jsonl'), JSON.stringify({ id: 'restore-interrupted', repositoryId: f.repo.id, originalHead: head, branch: 'main', target: head, updatedHead: head, backupRef: 'refs/ride-review/recovery/restore-interrupted', phase: 'restoring', stash, createdAt: Date.now() }) + '\n');
        const restarted = new RepositoryManager({ dataDir: f.dataDir }); await restarted.initialize();
        const restored = await restarted.recover(f.repo.id, 'continue');
        assert.equal(restored.state, 'idle');
        assert.equal(await fs.readFile(path.join(f.local, 'file.txt'), 'utf8'), 'saved local\n');
        await restarted.stop();
    } finally { await f.close(); }
});

test('restart pauses a transaction prepared before a process interruption', async () => {
    const f = await fixture();
    try {
        const head = git(f.local, 'rev-parse', 'HEAD');
        await fs.appendFile(path.join(f.dataDir, 'transactions.jsonl'), JSON.stringify({ id: 'interrupted', repositoryId: f.repo.id, originalHead: head, branch: 'main', target: head, backupRef: 'refs/ride-review/recovery/interrupted', phase: 'prepared', createdAt: Date.now() }) + '\n');
        const restarted = new RepositoryManager({ dataDir: f.dataDir });
        await restarted.initialize();
        assert.equal((await restarted.sync(f.repo.id)).state, 'paused');
        assert.equal((await restarted.recover(f.repo.id, 'abort')).state, 'idle');
        assert.equal(git(f.local, 'rev-parse', 'HEAD'), head);
        await restarted.stop();
    } finally { await f.close(); }
});

test('network failure leaves local modifications untouched', async () => {
    const f = await fixture();
    try {
        const head = git(f.local, 'rev-parse', 'HEAD');
        await fs.writeFile(path.join(f.local, 'file.txt'), 'do not lose\n');
        git(f.local, 'remote', 'set-url', 'origin', path.join(f.dir, 'missing-remote'));
        const result = await f.manager.sync(f.repo.id);
        assert.equal(result.state, 'error');
        assert.equal(git(f.local, 'rev-parse', 'HEAD'), head);
        assert.equal(await fs.readFile(path.join(f.local, 'file.txt'), 'utf8'), 'do not lose\n');
        assert.equal(git(f.local, 'stash', 'list'), '');
    } finally { await f.close(); }
});

test('a shared common-directory lock serializes snapshot work and sync', async () => {
    const f = await fixture();
    try {
        await f.advance();
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        const order: string[] = [];
        const reading = f.manager.withRepositoryLock(f.repo.id, async () => { order.push('snapshot'); entered(); await gate; order.push('snapshot-finished'); });
        await started;
        const syncing = f.manager.sync(f.repo.id).then(() => { order.push('sync-finished'); });
        release(); await Promise.all([reading, syncing]);
        assert.deepEqual(order, ['snapshot', 'snapshot-finished', 'sync-finished']);
    } finally { await f.close(); }
});

test('a torn transaction append is repaired before another recovery append', async () => {
    const f = await fixture();
    try {
        const head = git(f.local, 'rev-parse', 'HEAD');
        const transaction = { id: 'torn', repositoryId: f.repo.id, originalHead: head, branch: 'main', target: head,
            backupRef: 'refs/ride-review/recovery/torn', phase: 'prepared', createdAt: Date.now() };
        await fs.writeFile(path.join(f.dataDir, 'transactions.jsonl'), JSON.stringify(transaction) + '\n{"id":');
        const restarted = new RepositoryManager({ dataDir: f.dataDir }); await restarted.initialize();
        await restarted.recover(f.repo.id, 'abort'); await restarted.stop();
        const again = new RepositoryManager({ dataDir: f.dataDir });
        await again.initialize();
        assert.equal((await again.getRepository(f.repo.id)).state, 'idle');
        await again.stop();
    } finally { await f.close(); }
});

test('disconnected unsaved editors remain guarded until their paths are cleared', async () => {
    const f = await fixture();
    try {
        await f.manager.setDirtyPaths('window', [path.join(f.local, 'file.txt')]);
        await f.manager.disconnectClient('window');
        assert.match((await f.manager.sync(f.repo.id)).reason || '', /unsaved/i);
        await f.manager.setDirtyPaths('window', []);
        assert.equal((await f.manager.sync(f.repo.id)).reason, undefined);
    } finally { await f.close(); }
});

test('Git context environment variables cannot redirect synchronization to another repository', async () => {
    const f = await fixture();
    const previousDir = process.env.GIT_DIR;
    const previousWorktree = process.env.GIT_WORK_TREE;
    try {
        await f.advance();
        process.env.GIT_DIR = path.join(f.source, '.git');
        process.env.GIT_WORK_TREE = f.source;
        await f.manager.sync(f.repo.id);
        delete process.env.GIT_DIR; delete process.env.GIT_WORK_TREE;
        assert.equal(git(f.local, 'rev-parse', 'HEAD'), git(f.source, 'rev-parse', 'HEAD'));
    } finally {
        if (previousDir === undefined) { delete process.env.GIT_DIR; } else { process.env.GIT_DIR = previousDir; }
        if (previousWorktree === undefined) { delete process.env.GIT_WORK_TREE; } else { process.env.GIT_WORK_TREE = previousWorktree; }
        await f.close();
    }
});

test('never drops an ordinal stash entry that external Git can concurrently replace', async () => {
    const f = await fixture();
    try {
        await fs.writeFile(path.join(f.local, 'file.txt'), 'saved local\n'); await f.advance();
        const gitCall = f.manager['git'].bind(f.manager);
        const drops: string[][] = [];
        f.manager['git'] = async (repo, args, raw) => {
            if (args[0] === 'stash' && args[1] === 'drop') { drops.push(args); }
            return gitCall(repo, args, raw);
        };
        assert.equal((await f.manager.sync(f.repo.id)).state, 'idle');
        assert.deepEqual(drops, []);
        assert.match(git(f.local, 'stash', 'list'), /ride-review/);
    } finally { await f.close(); }
});

test('remote tracked files cannot overwrite ignored local data', async () => {
    const f = await fixture();
    try {
        await fs.writeFile(path.join(f.repo.gitDir, 'info', 'exclude'), 'secret.txt\nignored-dir/\n');
        await fs.writeFile(path.join(f.local, 'secret.txt'), 'precious secret');
        await fs.mkdir(path.join(f.local, 'ignored-dir'));
        await fs.writeFile(path.join(f.local, 'ignored-dir', 'data.txt'), 'precious directory');
        await fs.writeFile(path.join(f.source, 'secret.txt'), 'remote');
        await f.advance('ignored-dir', 'remote file replacing directory');
        const head = git(f.local, 'rev-parse', 'HEAD');
        const result = await f.manager.sync(f.repo.id);
        assert.equal(result.state, 'paused');
        assert.match(result.reason || '', /ignored/i);
        assert.equal(await fs.readFile(path.join(f.local, 'secret.txt'), 'utf8'), 'precious secret');
        assert.equal(await fs.readFile(path.join(f.local, 'ignored-dir', 'data.txt'), 'utf8'), 'precious directory');
        assert.equal(git(f.local, 'rev-parse', 'HEAD'), head);
    } finally { await f.close(); }
});

test('a slow repository does not stall unrelated repository synchronization', async () => {
    const f = await fixture();
    let release!: () => void;
    let firstEntered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { firstEntered = resolve; });
    let task: Promise<void> | undefined;
    try {
        git(f.dir, 'clone', f.remote, path.join(f.roots, 'second'));
        const repos = await f.manager.addRoot(f.roots);
        for (const repo of repos) { await f.manager.configure(repo.id, { enabled: true }); }
        let secondStarted = false;
        f.manager['sync'] = async id => {
            if (id === f.repo.id) { firstEntered(); await gate; }
            else { secondStarted = true; }
            return f.manager.getRepository(id);
        };
        f.manager['running'] = true; f.manager['lastDiscovery'] = Date.now();
        task = f.manager['runTick']();
        await entered;
        assert.equal(secondStarted, true);
    } finally { release(); await task; await f.close(); }
});

test('shutdown rejects queued and later jobs while an active operation finishes', async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    try {
        const active = f.manager.withRepositoryLock(f.repo.id, async () => { entered(); await gate; });
        await started;
        const queued = f.manager.sync(f.repo.id);
        const rejected = assert.rejects(queued, /stopped/i);
        const stopping = f.manager.stop();
        release(); await active; await stopping; await rejected;
        await assert.rejects(f.manager.sync(f.repo.id), /stopped/i);
        await assert.rejects(f.manager.addRoot(f.roots), /stopped/i);
        await assert.rejects(f.manager.withRepositoryLock(f.repo.id, async () => undefined), /stopped/i);
    } finally { release(); await f.close(); }
});

test('startup checks recently synchronized repositories immediately', async () => {
    const f = await fixture();
    try {
        await f.manager.configure(f.repo.id, { enabled: true });
        f.manager['require'](f.repo.id).lastSync = Date.now();
        let checks = 0;
        f.manager['sync'] = async () => { checks++; return f.repo; };
        f.manager['running'] = true; f.manager['lastDiscovery'] = Date.now();
        await f.manager['runTick']();
        assert.equal(checks, 1);
        await f.manager['runTick']();
        assert.equal(checks, 1);
        f.manager['lastTickAt'] = Date.now() - 45000;
        await f.manager['tick']();
        assert.equal(checks, 2);
    } finally { await f.close(); }
});

test('recovery never aborts or continues an unrelated external rebase', async () => {
    const f = await fixture();
    try {
        const base = git(f.local, 'rev-parse', 'HEAD');
        await fs.writeFile(path.join(f.local, 'file.txt'), 'local branch\n');
        git(f.local, 'add', '.'); git(f.local, 'commit', '-m', 'local change');
        const originalHead = git(f.local, 'rev-parse', 'HEAD');
        await f.advance('file.txt', 'remote conflict\n');
        git(f.local, 'fetch');
        const target = git(f.local, 'rev-parse', 'origin/main');
        git(f.local, 'checkout', '-b', 'external');
        assert.throws(() => git(f.local, 'rebase', 'origin/main'), /conflict|rebase/i);
        const rebaseDir = path.join(f.repo.gitDir, 'rebase-merge');
        const metadata = async () => Promise.all(['head-name', 'orig-head', 'onto'].map(name => fs.readFile(path.join(rebaseDir, name), 'utf8')));
        const originalMetadata = await metadata();
        assert.deepEqual(originalMetadata.map(value => value.trim()), ['refs/heads/external', originalHead, target]);
        const originalStatus = git(f.local, 'status', '--porcelain=v1');
        const originalContents = await fs.readFile(path.join(f.local, 'file.txt'), 'utf8');
        const transaction = { id: 'external-rebase', repositoryId: f.repo.id, originalHead, branch: 'main', target,
            backupRef: 'refs/ride-review/recovery/external-rebase', phase: 'updating' as const, createdAt: Date.now() };
        await fs.appendFile(path.join(f.dataDir, 'transactions.jsonl'), JSON.stringify(transaction) + '\n');
        const restarted = new RepositoryManager({ dataDir: f.dataDir }); await restarted.initialize();
        for (const mismatch of [
            { phase: 'updating' as const, branch: 'main', originalHead, target },
            { phase: 'stashed' as const, branch: 'external', originalHead, target },
            { phase: 'updating' as const, branch: 'external', originalHead: base, target },
            { phase: 'updating' as const, branch: 'external', originalHead, target: base }
        ]) {
            Object.assign(restarted['transactions'].get(f.repo.id)!, mismatch);
            for (const action of ['abort', 'continue'] as const) {
                const result = await restarted.recover(f.repo.id, action);
                assert.equal(result.state, 'paused');
                assert.match(result.reason || '', /unrelated|does not match/i);
                assert.deepEqual(await metadata(), originalMetadata);
                assert.equal(git(f.local, 'status', '--porcelain=v1'), originalStatus);
                assert.equal(await fs.readFile(path.join(f.local, 'file.txt'), 'utf8'), originalContents);
            }
        }
        await restarted.stop();
    } finally { await f.close(); }
});

test('a same-HEAD branch checkout after stashing cannot redirect the update', async () => {
    const f = await fixture();
    try {
        await fs.writeFile(path.join(f.local, 'file.txt'), 'saved local\n'); await f.advance();
        const originalHead = git(f.local, 'rev-parse', 'HEAD');
        const gitCall = f.manager['git'].bind(f.manager);
        f.manager['git'] = async (repo, args, raw) => {
            const result = await gitCall(repo, args, raw);
            if (args[0] === 'stash' && args[1] === 'push') { git(f.local, 'checkout', '-b', 'external-same-head'); }
            return result;
        };
        const result = await f.manager.sync(f.repo.id);
        assert.equal(result.state, 'paused');
        assert.equal(git(f.local, 'rev-parse', 'external-same-head'), originalHead);
        assert.equal(git(f.local, 'rev-parse', 'main'), originalHead);
        assert.match(git(f.local, 'stash', 'list'), /ride-review/);
    } finally { await f.close(); }
});

test('repository sync preserves frozen review comments and creates an incremental review of incoming files', async () => {
    const f = await fixture();
    let snapshotLocks = 0;
    const store = new ReviewStore(f.dataDir, id => f.manager.getRepository(id), (id, action) => {
        snapshotLocks++;
        return f.manager.withRepositoryLock(id, action);
    });
    try {
        await fs.writeFile(path.join(f.local, 'file.txt'), 'staged local\n'); git(f.local, 'add', 'file.txt');
        await fs.appendFile(path.join(f.local, 'file.txt'), 'unstaged local\n');
        await fs.writeFile(path.join(f.local, 'notes.txt'), 'untracked notes\n');
        const originalStatus = git(f.local, 'status', '--porcelain=v1');
        const originalIndex = git(f.local, 'show', ':file.txt');
        const first = await store.create(f.repo.id, { kind: 'working' });
        await store.comment(first.id, { path: 'file.txt', side: 'after', start: 2, end: 2, body: 'Keep this review anchored to the local second line' });
        await store.markFile(first.id, 'file.txt', { read: true, bookmarked: true });
        const frozenReview = await store.read(first.id);
        const snapshotDirectory = await store.snapshotDirectory(first.id);
        const frozenContent = await fs.readFile(path.join(snapshotDirectory, 'file.txt'), 'utf8');
        assert.equal(frozenContent, 'staged local\nunstaged local\n');
        assert.equal(git(f.local, 'status', '--porcelain=v1'), originalStatus);

        await f.advance('incoming.ts', 'export const incoming = true;\n');
        const synchronized = await f.manager.sync(f.repo.id);
        assert.equal(synchronized.state, 'idle', synchronized.reason || 'synchronization succeeds');
        assert.equal(git(f.local, 'rev-parse', 'HEAD'), git(f.source, 'rev-parse', 'HEAD'));
        assert.equal(git(f.local, 'status', '--porcelain=v1'), originalStatus);
        assert.equal(git(f.local, 'show', ':file.txt'), originalIndex);
        assert.equal(await fs.readFile(path.join(f.local, 'file.txt'), 'utf8'), frozenContent);
        assert.equal(await fs.readFile(path.join(f.local, 'notes.txt'), 'utf8'), 'untracked notes\n');
        assert.deepEqual(await store.read(first.id), frozenReview);
        assert.equal(await fs.readFile(path.join(snapshotDirectory, 'file.txt'), 'utf8'), frozenContent);
        await assert.rejects(fs.access(path.join(snapshotDirectory, 'incoming.ts')));

        const incremental = await store.create(f.repo.id, { kind: 'working' }, first.id);
        assert.equal(snapshotLocks, 2);
        assert.equal(incremental.previousReviewId, first.id);
        const incoming = incremental.files.find(file => file.path === 'incoming.ts');
        assert.ok(incoming);
        assert.equal(incoming.before, '');
        assert.equal(incoming.after, 'export const incoming = true;\n');
        assert.deepEqual(await store.read(first.id), frozenReview);
        assert.equal(git(f.local, 'status', '--porcelain=v1'), originalStatus);
        assert.equal(git(f.local, 'show', ':file.txt'), originalIndex);
        assert.ok((await f.manager.events()).some(event => event.repositoryId === f.repo.id && event.type === 'sync-success'));
    } finally { await store.stop(); await f.close(); }
});

test('explicit remote refresh updates enabled repositories before their interval while leaving disabled repositories untouched', async () => {
    const f = await fixture();
    try {
        const disabledPath = path.join(f.roots, 'disabled');
        git(f.dir, 'clone', f.remote, disabledPath);
        const repositories = await f.manager.addRoot(f.roots);
        const disabled = repositories.find(repo => repo.id !== f.repo.id)!;
        const disabledHead = git(disabledPath, 'rev-parse', 'HEAD');
        await f.manager.configure(f.repo.id, { enabled: true, intervalMs: 86400000 });
        assert.equal((await f.manager.sync(f.repo.id)).state, 'idle');
        const lastSync = (await f.manager.getRepository(f.repo.id)).lastSync!;
        assert.ok(Date.now() - lastSync < 86400000);
        await f.advance();
        await f.manager.refresh();
        assert.notEqual(git(f.local, 'rev-parse', 'HEAD'), git(f.source, 'rev-parse', 'HEAD'));
        await f.manager.refresh(undefined, true);
        assert.equal(git(f.local, 'rev-parse', 'HEAD'), git(f.source, 'rev-parse', 'HEAD'));
        assert.equal(git(disabledPath, 'rev-parse', 'HEAD'), disabledHead);
        assert.equal(git(disabledPath, 'rev-parse', 'origin/main'), disabledHead);
        assert.equal((await f.manager.getRepository(disabled.id)).enabled, false);
    } finally { await f.close(); }
});
