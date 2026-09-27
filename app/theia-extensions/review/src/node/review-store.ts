/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Review, ReviewComment, ReviewFile, ReviewSummary, ReviewTarget } from '../common/review-protocol';
import type { ReviewAiRunner } from './review-ai';

const MAX_FILE = 1024 * 1024;
const MAX_SNAPSHOT = 50 * 1024 * 1024;

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const environment = { ...process.env };
        for (const key of [
            'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
            'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'
        ]) { delete environment[key]; }
        const child = execFile('git', ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', ...args], {
            cwd, env: { ...environment, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...env },
            encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60000, windowsHide: true
        }, (error, stdout) => error ? reject(error) : resolve(stdout));
        child.stdin?.on('error', reject);
        child.stdin?.end(input);
    });
}
function safePath(value: string): string {
    if (!value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)
        || value.split('/').some(p => p === '..' || p === '.' || !p || p.includes(':') || p.toLowerCase() === '.git')) {
        throw new Error('Invalid snapshot path');
    }
    return value;
}
function safeId(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) { throw new Error('Invalid review id'); }
    return id;
}
function lines(text: string): number { return text ? text.replace(/\n$/, '').split('\n').length : 0; }
function textFile(bytes: Buffer): { text: string; skipped?: string } {
    if (bytes.length > MAX_FILE) { return { text: '', skipped: 'File exceeds 1 MiB' }; }
    if (bytes.includes(0)) { return { text: '', skipped: 'binary file' }; }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) { return { text: '', skipped: 'Non UTF-8 file' }; }
    return { text };
}
interface Content { text: string; skipped?: string; digest: string; mode?: string; }
type Tree = Map<string, Content>;

/** Immutable, content-addressed inputs. User repositories are never written by this store. */
export class ReviewStore {
    private readonly queues = new Map<string, Promise<unknown>>();
    private readonly aiJobs = new Map<string, AbortController>();
    private readonly aiPromises = new Map<string, Promise<void>>();
    private readonly deleted = new Set<string>();
    private readonly pendingAi = new Set<Promise<void>>();
    private aiTail: Promise<void> = Promise.resolve();
    private initialization?: Promise<void>;
    private stopped = false;
    constructor(
        private readonly dataDir: string,
        private readonly repository: (id: string) => Promise<{ path: string }>,
        private readonly lock: <T>(id: string, action: () => Promise<T>) => Promise<T> = async (_id, action) => action(),
        private readonly aiRunner?: ReviewAiRunner
    ) { }

    private async initialize(): Promise<void> {
        if (!this.initialization) {
            this.initialization = (async () => {
                await fs.mkdir(path.join(this.dataDir, 'reviews'), { recursive: true });
                for (const entry of await fs.readdir(path.join(this.dataDir, 'reviews'))) {
                    if (!/^[a-f0-9-]{36}$/.test(entry)) { continue; }
                    const filename = path.join(this.dataDir, 'reviews', entry, 'review.json');
                    try {
                        const review = JSON.parse(await fs.readFile(filename, 'utf8')) as Review;
                        if (review.ai.state === 'running' || review.ai.state === 'queued') {
                            review.ai.state = 'failed'; review.ai.message = 'Application closed during AI review. Retry manually.';
                            await this.save(review);
                        }
                    } catch { /* Incomplete creation is invisible until atomic metadata publication. */ }
                }
            })();
        }
        return this.initialization;
    }

    private directory(id: string): string { return path.join(this.dataDir, 'reviews', safeId(id)); }
    async snapshotDirectory(id: string): Promise<string> { await this.read(id); return path.join(this.directory(id), 'snapshot'); }
    private async save(review: Review): Promise<void> {
        if (this.deleted.has(review.id)) { throw new Error('Review was deleted'); }
        const directory = this.directory(review.id);
        await fs.mkdir(directory, { recursive: true });
        const temporary = path.join(directory, `review.${randomUUID()}.tmp`);
        await fs.writeFile(temporary, JSON.stringify({ ...review, schemaVersion: 1 }));
        await fs.rename(temporary, path.join(directory, 'review.json'));
    }
    private async mutate(id: string, change: (review: Review) => void): Promise<Review> {
        if (this.deleted.has(id)) { throw new Error('Review was deleted'); }
        const previous = this.queues.get(id) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(async () => {
            const review = await this.read(id); change(review); await this.save(review); return review;
        });
        this.queues.set(id, next);
        try { return await next; } finally { if (this.queues.get(id) === next) { this.queues.delete(id); } }
    }
    async read(id: string): Promise<Review> {
        if (this.deleted.has(id)) { throw new Error('Review was deleted'); }
        await this.initialize();
        const stored = JSON.parse(await fs.readFile(path.join(this.directory(id), 'review.json'), 'utf8'));
        if (stored.schemaVersion !== 1 || stored.id !== id) { throw new Error('Unsupported review data'); }
        return stored as Review;
    }
    async list(repositoryId?: string): Promise<ReviewSummary[]> {
        await this.initialize();
        const reviews: ReviewSummary[] = [];
        for (const id of await fs.readdir(path.join(this.dataDir, 'reviews'))) {
            if (!/^[a-f0-9-]{36}$/.test(id)) { continue; }
            try {
                const review = await this.read(id);
                if (!repositoryId || review.repositoryId === repositoryId) {
                    const { title, createdAt, base, head, previousReviewId, ai } = review;
                    reviews.push({ id, repositoryId: review.repositoryId, title, createdAt, base, head, previousReviewId,
                        ai: { state: ai.state, covered: ai.covered, message: ai.message }, fileCount: review.files.length });
                }
            } catch {
                /* An interrupted snapshot has no published review. */
            }
        }
        return reviews.sort((a, b) => b.createdAt - a.createdAt);
    }
    private async resolve(repo: string, ref: string): Promise<string> {
        if (typeof ref !== 'string' || !ref || ref.startsWith('-') || ref.length > 512 || /[\0\r\n]/.test(ref)) { throw new Error('Invalid Git revision'); }
        return (await git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).toString().trim();
    }
    private async committedTree(repo: string, ref: string): Promise<Tree> {
        const result: Tree = new Map();
        if (!ref) { return result; }
        let total = 0;
        const entries = (await git(repo, ['ls-tree', '-rlz', ref])).toString().split('\0').filter(Boolean);
        const pending: { oid: string; filename: string; mode: string }[] = [];
        for (const entry of entries) {
            const match = /^(\d+) (\w+) ([a-f0-9]+) +([\d-]+)\t([\s\S]+)$/.exec(entry);
            if (!match) { throw new Error('Invalid Git tree'); }
            const [, mode, , oid, length, filename] = match;
            safePath(filename);
            if (mode === '120000' || mode === '160000') {
                result.set(filename, { text: '', skipped: mode === '120000' ? 'Symbolic link' : 'Submodule', digest: oid, mode }); continue;
            }
            const size = Number(length);
            if (size > MAX_FILE || total + size > MAX_SNAPSHOT) {
                result.set(filename, { text: '', skipped: size > MAX_FILE ? 'File exceeds 1 MiB' : 'Snapshot exceeds 50 MiB', digest: oid, mode }); continue;
            }
            pending.push({ oid, filename, mode }); total += size;
        }
        // One bounded batch avoids two subprocess launches per file on Windows.
        const blobs = pending.length ? await git(repo, ['cat-file', '--batch'], {}, pending.map(entry => entry.oid).join('\n') + '\n') : Buffer.alloc(0);
        let offset = 0;
        for (const entry of pending) {
            const newline = blobs.indexOf(10, offset);
            const header = blobs.subarray(offset, newline).toString().split(' ');
            const size = Number(header[2]);
            if (newline < 0 || header[0] !== entry.oid || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE) {
                throw new Error('Invalid Git blob batch');
            }
            const bytes = blobs.subarray(newline + 1, newline + 1 + size);
            if (bytes.length !== size) { throw new Error('Incomplete Git blob batch'); }
            offset = newline + size + 2;
            result.set(entry.filename, { ...textFile(bytes), digest: createHash('sha256').update(bytes).digest('hex'), mode: entry.mode });
        }
        return result;
    }
    private async workingTree(repo: string): Promise<Tree> {
        const result: Tree = new Map();
        let total = 0;
        const realRoot = await fs.realpath(repo);
        const modes = new Map<string, string>();
        for (const entry of (await git(repo, ['ls-files', '--stage', '-z'])).toString().split('\0')) {
            const match = /^(\d+) [a-f0-9]+ \d\t([\s\S]+)$/.exec(entry);
            if (match) { modes.set(match[2], match[1]); }
        }
        let fileMode = false;
        try { fileMode = (await git(repo, ['config', '--bool', 'core.filemode'])).toString().trim() === 'true'; } catch { /* Platform default false. */ }
        const filenames = (await git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).toString().split('\0').filter(Boolean);
        for (const filename of new Set(filenames)) {
            safePath(filename);
            const absolute = path.join(repo, filename);
            try {
                const info = await fs.lstat(absolute);
                const mode = fileMode ? (info.mode & 0o111 ? '100755' : '100644') : modes.get(filename) ?? '100644';
                const real = await fs.realpath(absolute);
                const relative = path.relative(realRoot, real);
                if (info.isSymbolicLink() || relative.startsWith('..') || path.isAbsolute(relative)) {
                    result.set(filename, { text: '', skipped: 'Symbolic link', digest: 'link', mode: '120000' }); continue;
                }
                if (!info.isFile()) { result.set(filename, { text: '', skipped: 'Submodule', digest: 'submodule', mode: '160000' }); continue; }
                if (info.size > MAX_FILE || total + info.size > MAX_SNAPSHOT) {
                    result.set(filename, { text: '', skipped: info.size > MAX_FILE ? 'File exceeds 1 MiB' : 'Snapshot exceeds 50 MiB',
                        digest: `${info.size}:${info.mtimeMs}`, mode }); continue;
                }
                const bytes = await fs.readFile(absolute); total += bytes.length;
                result.set(filename, { ...textFile(bytes), digest: createHash('sha256').update(bytes).digest('hex'), mode });
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
        }
        return result;
    }
    async create(repositoryId: string, target: ReviewTarget, previousReviewId?: string): Promise<Review> {
        await this.initialize();
        if (!target || !['working', 'commit', 'branch'].includes(target.kind)) { throw new Error('Invalid review target'); }
        return this.lock(repositoryId, async () => {
            const repo = (await this.repository(repositoryId)).path;
            let base = ''; let head = ''; let before: Tree; let after: Tree;
            let changedWorkingFiles: Set<string> | undefined;
            if (target.kind === 'working') {
                try { base = await this.resolve(repo, 'HEAD'); } catch { /* Unborn repository. */ }
                before = await this.committedTree(repo, base);
                if (base && !previousReviewId) {
                    const changed = await git(repo, ['diff', '--name-only', '-z', base, '--']);
                    const untracked = await git(repo, ['ls-files', '--others', '--exclude-standard', '-z']);
                    changedWorkingFiles = new Set(Buffer.concat([changed, untracked]).toString().split('\0').filter(Boolean));
                }
                after = await this.workingTree(repo);
                const verification = await this.workingTree(repo);
                if (JSON.stringify([...after]) !== JSON.stringify([...verification])) { throw new Error('Repository changed while taking snapshot; retry'); }
                if (changedWorkingFiles) {
                    const changes = await git(repo, ['diff', '--name-only', '-z', base, '--']);
                    const others = await git(repo, ['ls-files', '--others', '--exclude-standard', '-z']);
                    const currentNames = new Set(Buffer.concat([changes, others]).toString().split('\0').filter(Boolean));
                    if (currentNames.size !== changedWorkingFiles.size || [...currentNames].some(name => !changedWorkingFiles!.has(name))) {
                        throw new Error('Changed file list changed while taking snapshot; retry');
                    }
                }
                let current = ''; try { current = await this.resolve(repo, 'HEAD'); } catch { /* Unborn */ }
                if (current !== base) { throw new Error('HEAD changed while taking snapshot; retry'); }
                head = `working:${createHash('sha256').update(JSON.stringify([...after])).digest('hex')}`;
            } else {
                head = await this.resolve(repo, target.kind === 'commit' ? target.commit : target.head);
                if (target.kind === 'branch') { base = await this.resolve(repo, target.base); } else {
                    const parents = (await git(repo, ['rev-list', '--parents', '-n', '1', head])).toString().trim().split(' ');
                    base = parents[1] ?? '';
                }
                before = await this.committedTree(repo, base); after = await this.committedTree(repo, head);
            }
            let previous: Review | undefined;
            if (previousReviewId) {
                previous = await this.read(previousReviewId);
                if (previous.repositoryId !== repositoryId) { throw new Error('Previous review belongs to another repository'); }
                base = previous.head;
                before = await this.readSavedTree(previousReviewId);
            }
            const id = randomUUID(); const snapshot = path.join(this.directory(id), 'snapshot');
            await fs.mkdir(snapshot, { recursive: true });
            const snapshotNames = new Set<string>();
            for (const [filename, content] of after) {
                if (content.skipped) { continue; }
                const canonical = process.platform === 'win32' ? filename.toLowerCase() : filename;
                if (snapshotNames.has(canonical)) { throw new Error('Case-colliding file paths cannot be materialized on this filesystem'); }
                snapshotNames.add(canonical);
                const absolute = path.join(snapshot, safePath(filename));
                await fs.mkdir(path.dirname(absolute), { recursive: true }); await fs.writeFile(absolute, content.text);
            }
            const files: ReviewFile[] = [];
            for (const filename of [...new Set([...before.keys(), ...after.keys()])].sort()) {
                if (changedWorkingFiles && !changedWorkingFiles.has(filename)) { continue; }
                const old = before.get(filename); const current = after.get(filename);
                if (old?.digest === current?.digest && old?.skipped === current?.skipped && old?.mode === current?.mode) { continue; }
                files.push({ path: filename, before: old?.text ?? '', after: current?.text ?? '',
                    status: !old ? 'added' : !current ? 'deleted' : 'modified', skipped: current?.skipped ?? old?.skipped,
                    beforeMode: old?.mode, afterMode: current?.mode,
                    read: false, bookmarked: false });
            }
            const review: Review = { id, repositoryId, title: `${target.kind} · ${head.slice(0, 12)}`, createdAt: Date.now(), base, head,
                target, previousReviewId, files, comments: [], ai: { state: 'idle', covered: [] } };
            await fs.writeFile(path.join(this.directory(id), 'tree.json'), JSON.stringify([...after]));
            await this.save(review);
            return review;
        });
    }
    private async readSavedTree(id: string): Promise<Tree> {
        return new Map(JSON.parse(await fs.readFile(path.join(this.directory(id), 'tree.json'), 'utf8')));
    }
    async markFile(id: string, filename: string, flags: { read?: boolean; bookmarked?: boolean }): Promise<Review> {
        return this.mutate(id, review => {
            const file = review.files.find(f => f.path === filename); if (!file) { throw new Error('Unknown review file'); }
            for (const key of ['read', 'bookmarked'] as const) {
                if (flags[key] !== undefined) { if (typeof flags[key] !== 'boolean') { throw new Error('Invalid file flag'); } file[key] = flags[key]!; }
            }
        });
    }
    private validateComment(review: Review, comment: Omit<ReviewComment, 'id' | 'source' | 'resolved'>): void {
        const file = review.files.find(f => f.path === comment.path);
        if (!file || file.skipped || !['before', 'after'].includes(comment.side) || !Number.isInteger(comment.start)
            || !Number.isInteger(comment.end) || comment.start < 1 || comment.end < comment.start || comment.end > lines(file[comment.side])
            || typeof comment.body !== 'string' || !comment.body.trim() || comment.body.length > 20000
            || (comment.severity !== undefined && !['info', 'warning', 'error'].includes(comment.severity))) {
            throw new Error('Invalid comment location or content');
        }
    }
    private applyAiComments(review: Review, candidates: Array<Omit<ReviewComment, 'id' | 'source' | 'resolved'>>): number {
        const valid = candidates.filter(comment => {
            try { this.validateComment(review, comment); return true; } catch { return false; }
        });
        const key = (comment: Omit<ReviewComment, 'id' | 'source' | 'resolved'>): string =>
            JSON.stringify([comment.path, comment.side, comment.start, comment.end, comment.body, comment.severity]);
        const prior = new Map(review.comments.filter(c => c.source === 'ai').map(c => [key(c), c]));
        review.comments = review.comments.filter(c => c.source !== 'ai').concat(valid.map(comment =>
            prior.get(key(comment)) ?? { ...comment, id: randomUUID(), source: 'ai' as const, resolved: false }));
        return valid.length;
    }
    async comment(id: string, comment: Omit<ReviewComment, 'id' | 'source' | 'resolved'>): Promise<Review> {
        return this.mutate(id, review => { this.validateComment(review, comment);
            review.comments.push({ ...comment, id: randomUUID(), source: 'human', resolved: false }); });
    }
    async resolveComment(id: string, commentId: string, resolved: boolean): Promise<Review> {
        return this.mutate(id, review => {
            const comment = review.comments.find(c => c.id === commentId);
            if (!comment || typeof resolved !== 'boolean') { throw new Error('Invalid comment'); } comment.resolved = resolved;
        });
    }
    async delete(id: string): Promise<void> {
        await this.read(id);
        this.deleted.add(id);
        this.aiJobs.get(id)?.abort();
        await this.aiPromises.get(id)?.catch(() => undefined);
        await this.queues.get(id)?.catch(() => undefined);
        await fs.rm(this.directory(id), { recursive: true, force: true });
    }
    async exportMarkdown(id: string): Promise<string> {
        const review = await this.read(id);
        return [`# ${review.title}`, '', `Base: ${review.base || '(empty)'}  Head: ${review.head}`, '',
            ...review.files.map(f => `- [${f.read ? 'x' : ' '}] ${f.path}${f.skipped ? ` — ${f.skipped}` : ''}`
                + (f.beforeMode !== f.afterMode ? ` (mode ${f.beforeMode ?? 'absent'} → ${f.afterMode ?? 'absent'})` : '')), '',
            ...review.comments.flatMap(c => [`## ${c.path}:${c.start}-${c.end} (${c.side})`, '',
                `${c.resolved ? '[Resolved] ' : ''}${c.severity ?? 'info'} · ${c.source}`, '', c.body, '']),
            '## AI coverage', '', `${review.ai.state}: ${review.ai.covered.join(', ') || '(none)'}`, '', review.ai.summary ?? '', review.ai.message ?? ''].join('\n');
    }
    async history(repositoryId: string): Promise<{ oid: string; subject: string; author: string; date: string }[]> {
        const repo = (await this.repository(repositoryId)).path;
        const output = (await git(repo, ['log', '-100', '--format=%H%x00%s%x00%an%x00%aI%x00'])).toString();
        const parts = output.split('\0'); const result = [];
        for (let i = 0; i + 3 < parts.length; i += 4) { result.push({ oid: parts[i].trim(), subject: parts[i + 1], author: parts[i + 2], date: parts[i + 3] }); }
        return result;
    }
    async blame(id: string, filename: string): Promise<string> {
        const review = await this.read(id);
        if (!review.files.some(f => f.path === filename && !f.skipped)) { throw new Error('Unknown text file'); }
        const repo = (await this.repository(review.repositoryId)).path;
        const ref = review.head.startsWith('working:') ? review.base : review.head;
        if (!ref || ref.startsWith('working:')) { throw new Error('No committed blame for this snapshot'); }
        return (await git(repo, ['blame', '--date=short', ref, '--', safePath(filename)])).toString();
    }
    async startAi(id: string, model?: string): Promise<Review> {
        if (this.stopped || !this.aiRunner) { throw new Error('AI review unavailable'); }
        if (model !== undefined && (typeof model !== 'string' || model.length > 256 || !model.trim())) { throw new Error('Invalid model'); }
        if (this.aiJobs.has(id)) { return this.read(id); }
        const controller = new AbortController(); this.aiJobs.set(id, controller);
        let queued: Review;
        try { queued = await this.mutate(id, review => { review.ai = { state: 'queued', covered: [] }; }); } catch (error) {
            this.aiJobs.delete(id); throw error;
        }
        const job = this.aiTail.catch(() => undefined).then(async () => {
            try {
                if (controller.signal.aborted) { return; }
                const review = await this.mutate(id, r => { r.ai.state = 'running'; });
                const output = await this.aiRunner!.run({ directory: await this.snapshotDirectory(id), files: review.files, model, signal: controller.signal,
                    onPartial: partial => this.mutate(id, r => {
                        if (controller.signal.aborted) { return; }
                        this.applyAiComments(r, partial.comments);
                        r.ai.covered = partial.covered.filter(p => r.files.some(f => f.path === p && !f.skipped));
                        r.ai.summary = partial.summary;
                    }).then(() => undefined),
                    onProgress: progress => {
                        if (!controller.signal.aborted) {
                            this.mutate(id, r => {
                                if (controller.signal.aborted) { return; }
                                r.ai.message = progress;
                                r.ai.state = progress.startsWith('Queued:') ? 'queued' : 'running';
                            }).catch(() => undefined);
                        }
                    }
                });
                if (controller.signal.aborted) { return; }
                await this.mutate(id, r => {
                    if (controller.signal.aborted) { return; }
                    const validCount = this.applyAiComments(r, output.comments);
                    r.ai = { state: 'completed', summary: output.summary, covered: output.covered.filter(p => r.files.some(f => f.path === p && !f.skipped)),
                        message: validCount !== output.comments.length ? 'Invalid AI locations were excluded.' : undefined };
                });
            } catch (error) {
                if (!controller.signal.aborted) {
                    await this.mutate(id, r => { r.ai.state = 'failed'; r.ai.message = error instanceof Error ? error.message : 'AI review failed'; });
                }
            } finally { this.aiJobs.delete(id); }
        });
        this.aiTail = job; this.pendingAi.add(job); this.aiPromises.set(id, job);
        job.finally(() => { this.pendingAi.delete(job); this.aiPromises.delete(id); }).catch(() => undefined);
        return queued;
    }
    async cancelAi(id: string): Promise<Review> {
        const controller = this.aiJobs.get(id); controller?.abort();
        return this.mutate(id, review => { if (review.ai.state === 'queued' || review.ai.state === 'running') { review.ai.state = 'cancelled'; } });
    }
    async stop(): Promise<void> {
        this.stopped = true;
        await Promise.all([...this.aiJobs.keys()].map(id => this.cancelAi(id)));
        await Promise.allSettled([...this.pendingAi]);
    }
}
