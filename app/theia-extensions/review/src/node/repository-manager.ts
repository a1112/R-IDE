/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, watch, FSWatcher, createReadStream } from 'node:fs';
import * as path from 'node:path';
import { Repository, RepositoryEvent, RepositorySyncConfiguration } from '../common/repository-protocol';
interface Transaction {
    id: string;
    repositoryId: string;
    originalHead: string;
    branch: string;
    target: string;
    backupRef: string;
    phase: 'prepared' | 'stashing' | 'stashed' | 'updating' | 'updated' | 'restoring' | 'restore-conflict' | 'done' | 'aborted';
    stash?: string;
    updatedHead?: string;
    createdAt: number;
    message?: string;
}
interface Configuration {
    version: 1;
    roots: string[];
    repositories: Repository[];
    cursor: number;
}
const SKIP = new Set(['.git', 'node_modules', '.yarn', '.pnpm', 'dist', 'build', 'target', '.cache', '.next', 'vendor', '.venv']);
const DEFAULT_INTERVAL = 5 * 60 * 1000;
const RETENTION = 90 * 24 * 60 * 60 * 1000;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const identity = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
const oid = (value: string): boolean => /^[a-f0-9]{40,64}$/.test(value);
const message = (error: unknown): string => String(error instanceof Error ? error.message : error).replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@').slice(0, 4000);
function absolute(value: unknown): string {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || value.length > 32768) {
        throw new Error('An absolute filesystem path is required.');
    }
    return path.normalize(value);
}
function inside(parent: string, child: string): boolean {
    const relative = path.relative(identity(parent), identity(child));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function exists(file: string): Promise<boolean> { try {
    await fs.access(file);
    return true;
} catch {
    return false;
} }
/** All Git subprocesses use argument arrays, noninteractive credentials and disabled hooks. */
export class RepositoryManager {
    private readonly dataDir: string;
    private readonly now: () => number;
    private readonly repositories = new Map<string, Repository>();
    private scanRoots: string[] = [];
    private log: RepositoryEvent[] = [];
    private cursor = 0;
    private transactions = new Map<string, Transaction>();
    private queue = new Map<string, Promise<unknown>>();
    private io: Promise<unknown> = Promise.resolve();
    private dirtyClients = new Map<string, string[]>();
    private fingerprints = new Map<string, string>();
    private retries = new Map<string, {
        failures: number;
        next: number;
    }>();
    private watchers = new Map<string, FSWatcher[]>();
    private debounce = new Map<string, ReturnType<typeof setTimeout>>();
    private timer?: ReturnType<typeof setInterval>;
    private running = false;
    private stopped = false;
    private tickTask?: Promise<void>;
    private lastDiscovery = 0;
    private lastTickAt = 0;
    private forceNextCheck = true;
    private initialization?: Promise<void>;
    constructor(options: {
        dataDir: string;
        now?: () => number;
    }) {
        this.dataDir = absolute(options.dataDir);
        this.now = options.now || Date.now;
    }
    initialize(): Promise<void> {
        if (!this.initialization) {
            this.initialization = this.load();
        }
        return this.initialization;
    }
    private async load(): Promise<void> {
        await fs.mkdir(this.dataDir, { recursive: true });
        const configFile = path.join(this.dataDir, 'repositories.json');
        if (await exists(configFile)) {
            const config: Configuration = JSON.parse(await fs.readFile(configFile, 'utf8'));
            if (config.version !== 1 || !Array.isArray(config.roots) || !Array.isArray(config.repositories)) {
                throw new Error('Unsupported repository configuration.');
            }
            this.scanRoots = config.roots.map(absolute);
            for (const repo of config.repositories) {
                absolute(repo.path);
                absolute(repo.gitDir);
                absolute(repo.commonDir);
                if (!/^[a-f0-9]{24}$/.test(repo.id)) {
                    throw new Error('Invalid saved repository identifier.');
                }
                this.repositories.set(repo.id, repo);
            }
            this.cursor = Number.isSafeInteger(config.cursor) ? config.cursor : 0;
        }
        this.log = await this.readLines<RepositoryEvent>('events.jsonl');
        this.cursor = this.log.reduce((cursor, event) => Math.max(cursor, event.id), Math.max(0, this.cursor));
        this.log = this.log.filter(event => event.observedAt >= this.now() - RETENTION);
        await this.atomic('events.jsonl', this.log.map(event => JSON.stringify(event) + '\n').join(''));
        const journal = await this.readLines<Transaction>('transactions.jsonl');
        // Remove a torn final append before future appends; otherwise it would corrupt the next valid record.
        await this.atomic('transactions.jsonl', journal.map(transaction => JSON.stringify(transaction) + '\n').join(''));
        for (const transaction of journal) {
            if (transaction.phase === 'done' || transaction.phase === 'aborted') {
                this.transactions.delete(transaction.repositoryId);
            } else {
                this.transactions.set(transaction.repositoryId, transaction);
            }
        }
        for (const repo of this.repositories.values()) {
            if (this.transactions.has(repo.id)) {
                repo.state = 'paused';
                repo.reason = 'Interrupted synchronization: inspect recovery details and explicitly continue or abort.';
            } else if (repo.state === 'syncing') {
                repo.state = 'paused';
                repo.reason = 'Interrupted synchronization requires inspection.';
            }
        }
        await this.save();
    }
    private async readLines<T>(name: string): Promise<T[]> {
        const file = path.join(this.dataDir, name);
        if (!await exists(file)) {
            return [];
        }
        const lines = (await fs.readFile(file, 'utf8')).split('\n');
        const result: T[] = [];
        for (let index = 0; index < lines.length; index++) {
            if (!lines[index].trim()) {
                continue;
            }
            try {
                result.push(JSON.parse(lines[index]) as T);
            } catch (error) {
                if (index !== lines.length - 1) {
                    throw error;
                }
            } // A torn final append is not a completed journal entry.
        }
        return result;
    }
    private write(task: () => Promise<void>): Promise<void> {
        const next = this.io.then(task);
        this.io = next.catch(() => undefined);
        return next;
    }
    private async atomic(name: string, content: string): Promise<void> {
        const target = path.join(this.dataDir, name);
        const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
        const handle = await fs.open(temporary, 'wx');
        try {
            await handle.writeFile(content, 'utf8');
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await fs.rename(temporary, target);
    }
    private save(): Promise<void> {
        const config: Configuration = { version: 1, roots: [...this.scanRoots], repositories: [...this.repositories.values()].map(copy), cursor: this.cursor };
        return this.write(() => this.atomic('repositories.json', JSON.stringify(config, undefined, 2)));
    }
    private append(name: string, value: unknown): Promise<void> {
        return this.write(async () => {
            const handle = await fs.open(path.join(this.dataDir, name), 'a');
            try {
                await handle.writeFile(JSON.stringify(value) + '\n');
                await handle.sync();
            }
            finally {
                await handle.close();
            }
        });
    }
    private async record(repo: Repository, type: RepositoryEvent['type'], details: Partial<RepositoryEvent> = {}): Promise<void> {
        const event: RepositoryEvent = { ...details, id: ++this.cursor, repositoryId: repo.id, type, observedAt: this.now() };
        this.log.push(event);
        await this.append('events.jsonl', event);
    }
    private async journal(transaction: Transaction): Promise<void> {
        await this.append('transactions.jsonl', copy(transaction));
        if (transaction.phase === 'done' || transaction.phase === 'aborted') {
            this.transactions.delete(transaction.repositoryId);
        } else {
            this.transactions.set(transaction.repositoryId, transaction);
        }
    }
    private git(repoPath: string, args: string[], raw = false): Promise<string> {
        return new Promise((resolve, reject) => {
            const environment: NodeJS.ProcessEnv = { ...process.env };
            for (const key of [
                'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
                'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'
            ]) { delete environment[key]; }
            execFile('git', [
                '-c', `core.hooksPath=${path.join(this.dataDir, 'disabled-hooks')}`, '-c', 'core.fsmonitor=false',
                '-c', 'credential.interactive=never', '-C', repoPath, ...args
            ], {
                encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 32 * 1024 * 1024,
                env: { ...environment, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' }
            }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`${args[0]} failed: ${stderr || error.message}`));
                } else {
                    resolve(raw ? stdout : stdout.trim());
                }
            });
        });
    }
    private async optional(repo: string, args: string[]): Promise<string | undefined> { try {
        return await this.git(repo, args);
    } catch {
        return undefined;
    } }
    private require(id: string): Repository {
        if (typeof id !== 'string' || !this.repositories.has(id)) {
            throw new Error('Unknown repository.');
        }
        return this.repositories.get(id)!;
    }
    private assertActive(): void {
        if (this.stopped) { throw new Error('Repository manager has stopped.'); }
    }
    async roots(): Promise<string[]> { await this.initialize(); return [...this.scanRoots]; }
    async list(): Promise<Repository[]> { await this.initialize(); return [...this.repositories.values()].map(copy); }
    async getRepository(id: string): Promise<Repository> { await this.initialize(); return copy(this.require(id)); }
    async addRoot(input: string): Promise<Repository[]> {
        await this.initialize();
        this.assertActive();
        const root = await fs.realpath(absolute(input));
        if (!(await fs.stat(root)).isDirectory()) {
            throw new Error('Scan root must be a directory.');
        }
        if (!this.scanRoots.some(existing => identity(existing) === identity(root))) {
            this.scanRoots.push(root);
        }
        await this.discover(root);
        await this.save();
        return this.list();
    }
    async removeRoot(input: string): Promise<void> {
        await this.initialize();
        this.assertActive();
        const root = absolute(input);
        this.scanRoots = this.scanRoots.filter(existing => identity(existing) !== identity(root));
        // Retain imported repositories and their recovery records; removing a root only stops discovery.
        await this.save();
    }
    private async discover(root: string, cancelWhenStopped = false): Promise<void> {
        const pending = [root];
        const seen = new Set<string>();
        while (pending.length) {
            if (this.stopped) { return; }
            if (cancelWhenStopped && !this.running) {
                return;
            }
            const directory = pending.pop()!;
            let real: string;
            try {
                real = await fs.realpath(directory);
            } catch {
                continue;
            }
            if (seen.has(identity(real))) {
                continue;
            }
            seen.add(identity(real));
            let entries: import('node:fs').Dirent[];
            try {
                entries = await fs.readdir(real, { withFileTypes: true });
            } catch {
                continue;
            }
            if (entries.some(entry => entry.name === '.git')) {
                const top = await this.optional(real, ['rev-parse', '--show-toplevel']);
                if (top && identity(await fs.realpath(top)) === identity(real)) {
                    const id = createHash('sha256').update(identity(real)).digest('hex').slice(0, 24);
                    if (!this.repositories.has(id)) {
                        const gitDir = await fs.realpath(await this.git(real, ['rev-parse', '--absolute-git-dir']));
                        const common = await this.git(real, ['rev-parse', '--git-common-dir']);
                        const commonDir = await fs.realpath(path.resolve(real, common));
                        const submodule = !!await this.optional(real, ['rev-parse', '--show-superproject-working-tree']);
                        const repo: Repository = {
                            id, path: real, gitDir, commonDir, name: path.basename(real), ahead: 0, behind: 0, dirty: false,
                            enabled: false, intervalMs: DEFAULT_INTERVAL, state: 'idle', submodule
                        };
                        this.repositories.set(id, repo);
                        await this.observe(repo, false);
                        await this.record(repo, 'discovered');
                        if (this.running) {
                            this.watchRepository(repo);
                        }
                    }
                }
            }
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP.has(entry.name)) {
                    pending.push(path.join(real, entry.name));
                }
            }
        }
    }
    private async fingerprint(repo: Repository): Promise<string> {
        const status = await this.git(repo.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], true);
        const hash = createHash('sha256').update(status);
        hash.update(await this.git(repo.path, ['diff', '--binary', '--no-ext-diff', '--no-textconv'], true));
        hash.update(await this.git(repo.path, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv'], true));
        const untracked = (await this.git(repo.path, ['ls-files', '--others', '--exclude-standard', '-z'], true)).split('\0').filter(Boolean);
        for (const relative of untracked) {
            const file = path.resolve(repo.path, relative);
            if (!inside(repo.path, file)) {
                throw new Error('Git returned a file outside the repository.');
            }
            const stat = await fs.lstat(file);
            hash.update(relative);
            if (stat.isSymbolicLink()) {
                hash.update(await fs.readlink(file));
            } else {
                for await (const chunk of createReadStream(file)) { hash.update(chunk); }
            }
        }
        hash.update(await this.optional(repo.path, ['rev-parse', 'HEAD']) || 'unborn');
        hash.update(await this.optional(repo.path, ['symbolic-ref', '--short', 'HEAD']) || 'detached');
        return hash.digest('hex');
    }
    private async observe(repo: Repository, emit = true): Promise<void> {
        const before = copy(repo);
        try {
            repo.head = await this.optional(repo.path, ['rev-parse', '--verify', 'HEAD']);
            repo.branch = await this.optional(repo.path, ['symbolic-ref', '--short', 'HEAD']);
            repo.upstream = await this.optional(repo.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
            repo.dirty = !!await this.git(repo.path, ['status', '--porcelain=v1', '--untracked-files=all']);
            repo.ahead = 0;
            repo.behind = 0;
            if (repo.head && repo.upstream) {
                const counts = (await this.git(repo.path, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).split(/\s+/).map(Number);
                repo.ahead = counts[0];
                repo.behind = counts[1];
            }
            const fingerprint = await this.fingerprint(repo);
            if (emit) {
                if (before.head !== repo.head) {
                    await this.record(repo, 'head-changed', { before: before.head, after: repo.head });
                }
                if (before.branch !== repo.branch) {
                    await this.record(repo, 'branch-changed', { before: before.branch, after: repo.branch });
                }
                const previous = this.fingerprints.get(repo.id);
                if (previous && previous !== fingerprint) {
                    await this.record(repo, 'worktree-changed', { message: 'Observed working tree or index state change.' });
                }
                if (!previous) {
                    await this.record(repo, 'observed', { message: 'Current state observed; changes while the application was closed are not a complete operation history.' });
                }
            }
            this.fingerprints.set(repo.id, fingerprint);
        } catch (error) {
            if (repo.state !== 'paused') {
                repo.state = 'error';
                repo.reason = message(error);
            }
        }
    }
    private serialized<T>(repo: Repository, task: () => Promise<T>): Promise<T> {
        this.assertActive();
        const key = identity(repo.commonDir);
        const next = (this.queue.get(key) || Promise.resolve()).catch(() => undefined).then(() => {
            this.assertActive();
            return task();
        });
        this.queue.set(key, next);
        return next.finally(() => { if (this.queue.get(key) === next) {
            this.queue.delete(key);
        } });
    }
    async withRepositoryLock<T>(id: string, action: () => Promise<T>): Promise<T> {
        await this.initialize();
        return this.serialized(this.require(id), action);
    }
    async refresh(id?: string, checkRemote = false): Promise<Repository[]> {
        await this.initialize();
        this.assertActive();
        if (typeof checkRemote !== 'boolean') { throw new Error('Remote refresh selection must be a boolean.'); }
        const repos = id === undefined ? [...this.repositories.values()] : [this.require(id)];
        await Promise.all(repos.map(repo => this.serialized(repo, async () => {
            if (checkRemote && repo.enabled && repo.state !== 'paused') {
                // The repository lock is already held: calling the public sync() here would nest the same lock.
                await this.synchronize(repo);
            } else {
                await this.observe(repo);
            }
        })));
        await this.save();
        return this.list();
    }
    async configure(id: string, configuration: RepositorySyncConfiguration): Promise<Repository> {
        await this.initialize();
        this.assertActive();
        const repo = this.require(id);
        if (!configuration || typeof configuration.enabled !== 'boolean') {
            throw new Error('enabled must be a boolean.');
        }
        if (configuration.intervalMs !== undefined && (!Number.isSafeInteger(configuration.intervalMs) || configuration.intervalMs < 1000 || configuration.intervalMs > 86400000)) {
            throw new Error('Synchronization interval must be between 1 second and 24 hours.');
        }
        repo.enabled = configuration.enabled;
        repo.intervalMs = configuration.intervalMs || repo.intervalMs;
        await this.save();
        return copy(repo);
    }
    async setDirtyPaths(clientId: string, paths: string[]): Promise<void> {
        this.assertActive();
        if (typeof clientId !== 'string' || !clientId || clientId.length > 256 || !Array.isArray(paths) || paths.length > 10000) {
            throw new Error('Invalid editor client or paths.');
        }
        this.dirtyClients.set(clientId, paths.map(absolute));
    }
    async disconnectClient(clientId: string): Promise<void> {
        // A lost connection cannot prove its unsaved buffers were discarded. Keep its guard until restart.
        if (!this.dirtyClients.get(clientId)?.length) {
            this.dirtyClients.delete(clientId);
        }
    }
    async events(after = 0): Promise<RepositoryEvent[]> {
        await this.initialize();
        if (!Number.isSafeInteger(after) || after < 0) {
            throw new Error('Invalid event cursor.');
        }
        return this.log.filter(event => event.id > after && event.observedAt >= this.now() - RETENTION).map(copy);
    }
    private async blocked(repo: Repository, allowRebase = false): Promise<string | undefined> {
        if (repo.submodule) {
            return 'Submodules require manual updates.';
        }
        if ([...this.dirtyClients.values()].some(files => files.some(file => inside(repo.path, file)))) {
            return 'Unsaved editor contents; save or close the editor before synchronization.';
        }
        for (const directory of new Set([repo.gitDir, repo.commonDir])) {
            for (const file of ['index.lock', 'HEAD.lock', 'packed-refs.lock', 'config.lock', 'shallow.lock']) {
                if (await exists(path.join(directory, file))) {
                    return `Git lock exists: ${file}`;
                }
            }
        }
        for (const file of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'sequencer', ...(allowRebase ? [] : ['rebase-merge', 'rebase-apply'])]) {
            if (await exists(path.join(repo.gitDir, file))) {
                return `Existing Git operation: ${file}`;
            }
        }
        if (!allowRebase && await this.git(repo.path, ['ls-files', '--unmerged'])) {
            return 'Unresolved conflicts require manual resolution.';
        }
        return undefined;
    }
    async sync(id: string): Promise<Repository> {
        await this.initialize();
        const repo = this.require(id);
        return this.serialized(repo, () => this.synchronize(repo));
    }
    private async pause(repo: Repository, reason: string, transaction?: Transaction): Promise<Repository> {
        repo.state = 'paused';
        repo.reason = reason;
        if (transaction) {
            transaction.message = reason;
            await this.journal(transaction);
        }
        await this.record(repo, 'sync-conflict', { operationId: transaction?.id, message: reason });
        await this.save();
        return copy(repo);
    }
    private async synchronize(repo: Repository): Promise<Repository> {
        if (this.transactions.has(repo.id) || repo.state === 'paused') {
            return copy(repo);
        }
        await this.observe(repo);
        let transaction: Transaction | undefined;
        try {
            const blocked = await this.blocked(repo);
            if (blocked || !repo.head || !repo.branch || !repo.upstream) {
                repo.state = 'idle';
                repo.reason = blocked || 'A checked out branch with an upstream is required.';
                await this.save();
                return copy(repo);
            }
            const fingerprint = await this.fingerprint(repo);
            const previous = await this.git(repo.path, ['rev-parse', '@{upstream}']);
            // Save all known remote tips before fetching: commits published on another branch are not rewritten.
            const remoteTips = (await this.git(repo.path, ['for-each-ref', '--format=%(objectname)', 'refs/remotes'])).split(/\s+/).filter(oid);
            repo.state = 'syncing';
            repo.reason = undefined;
            await this.record(repo, 'sync-start');
            await this.save();
            await this.git(repo.path, ['fetch', '--all', '--no-tags']);
            if (await this.fingerprint(repo) !== fingerprint || await this.blocked(repo)) {
                return this.pause(repo, 'External changes or editor activity detected during fetch. Inspect the worktree and resume.');
            }
            const target = await this.git(repo.path, ['rev-parse', '@{upstream}']);
            if (previous !== target) {
                await this.record(repo, 'commits-discovered', { before: previous, after: target });
                if (!await this.isAncestor(repo, previous, target)) {
                    return this.pause(repo, 'Remote history rewrite detected; automatic rebase has been paused.');
                }
            }
            await this.observe(repo);
            if (!repo.behind) {
                repo.state = 'idle';
                repo.reason = undefined;
                repo.lastSync = this.now();
                await this.record(repo, 'sync-success');
                await this.save();
                return copy(repo);
            }
            if (repo.ahead) {
                const localCommits = (await this.git(repo.path, ['rev-list', '@{upstream}..HEAD'])).split(/\s+/).filter(oid);
                const currentTips = (await this.git(repo.path, ['for-each-ref', '--format=%(objectname)', 'refs/remotes'])).split(/\s+/).filter(oid);
                for (const commit of localCommits) {
                    for (const tip of new Set([...remoteTips, ...currentTips])) {
                        if (await this.isAncestor(repo, commit, tip)) {
                            return this.pause(repo, 'Local commits were already published on a remote branch; manual integration is required.');
                        }
                    }
                }
            }
            if (await this.fingerprint(repo) !== fingerprint) {
                return this.pause(repo, 'External worktree changes detected before saving local modifications.');
            }
            const collision = await this.ignoredCollision(repo, target);
            if (collision) { return this.pause(repo, `Ignored local data overlaps the incoming tree: ${collision}`); }
            const operationId = `${this.now()}-${randomBytes(8).toString('hex')}`;
            transaction = {
                id: operationId, repositoryId: repo.id, originalHead: repo.head!, branch: repo.branch!, target,
                backupRef: `refs/ride-review/recovery/${operationId}`, phase: 'prepared', createdAt: this.now()
            };
            await this.journal(transaction);
            await this.git(repo.path, ['update-ref', transaction.backupRef, transaction.originalHead, '']);
            if (repo.dirty) {
                transaction.phase = 'stashing';
                await this.journal(transaction);
                await this.git(repo.path, ['stash', 'push', '--include-untracked', '--message', `ride-review:${operationId}`]);
                transaction.stash = await this.git(repo.path, ['rev-parse', 'refs/stash']);
                if (!oid(transaction.stash)) {
                    throw new Error('Could not verify the saved stash object.');
                }
                const subject = await this.git(repo.path, ['show', '-s', '--format=%s', transaction.stash]);
                if (!subject.includes(`ride-review:${operationId}`)) {
                    transaction.stash = undefined;
                    throw new Error('Concurrent stash change detected; inspect the stash before recovering.');
                }
                await this.git(repo.path, ['update-ref', `${transaction.backupRef}-stash`, transaction.stash]);
                repo.recoveryStash = `${transaction.backupRef}-stash`;
            }
            transaction.phase = 'stashed';
            await this.journal(transaction);
            if (await this.git(repo.path, ['status', '--porcelain=v1'])
                || await this.git(repo.path, ['rev-parse', 'HEAD']) !== transaction.originalHead
                || await this.git(repo.path, ['symbolic-ref', '--short', 'HEAD']) !== transaction.branch || await this.blocked(repo)) {
                return this.pause(repo, 'External changes detected after saving modifications; recovery retained.', transaction);
            }
            transaction.phase = 'updating';
            await this.journal(transaction);
            if (await this.git(repo.path, ['rev-parse', 'HEAD']) !== transaction.originalHead
                || await this.git(repo.path, ['symbolic-ref', '--short', 'HEAD']) !== transaction.branch) {
                return this.pause(repo, 'HEAD or branch changed immediately before update; recovery retained.', transaction);
            }
            if (repo.ahead) {
                await this.git(repo.path, ['-c', 'rebase.autoStash=false', '-c', 'rebase.updateRefs=false', 'rebase', '--rebase-merges', target]);
            } else {
                await this.git(repo.path, ['merge', '--ff-only', '--no-overwrite-ignore', target]);
            }
            transaction.updatedHead = await this.git(repo.path, ['rev-parse', 'HEAD']);
            transaction.phase = 'updated';
            await this.journal(transaction);
            return await this.restore(repo, transaction);
        } catch (error) {
            const reason = message(error);
            if (transaction) {
                return this.pause(repo, reason, transaction);
            }
            const authentication = /auth|credential|permission denied|could not read username/i.test(reason);
            repo.state = authentication ? 'paused' : 'error';
            repo.reason = authentication ? `Authentication required: ${reason}` : reason;
            const failures = (this.retries.get(repo.id)?.failures || 0) + 1;
            this.retries.set(repo.id, { failures, next: this.now() + Math.min(3600000, 30000 * Math.pow(2, Math.min(failures - 1, 7))) });
            await this.record(repo, 'sync-failed', { message: repo.reason });
            await this.save();
            return copy(repo);
        }
    }
    private async isAncestor(repo: Repository, ancestor: string, descendant: string): Promise<boolean> {
        try {
            await this.git(repo.path, ['merge-base', '--is-ancestor', ancestor, descendant]);
            return true;
        } catch {
            return false;
        }
    }
    private async ignoredCollision(repo: Repository, target: string): Promise<string | undefined> {
        const ignored = (await this.git(repo.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], true))
            .split('\0').filter(Boolean).map(identity);
        if (!ignored.length) { return undefined; }
        const tracked = (await this.git(repo.path, ['ls-tree', '-r', '-z', '--name-only', target], true))
            .split('\0').filter(Boolean).map(identity);
        const ignoredSet = new Set(ignored);
        const trackedSet = new Set(tracked);
        const collision = (file: string, candidates: Set<string>): boolean => {
            let candidate = file;
            while (candidate) {
                if (candidates.has(candidate)) { return true; }
                const slash = candidate.lastIndexOf('/');
                candidate = slash >= 0 ? candidate.slice(0, slash) : '';
            }
            return false;
        };
        return ignored.find(file => collision(file, trackedSet)) || tracked.find(file => collision(file, ignoredSet));
    }
    private async ownsActiveRebase(repo: Repository, transaction: Transaction): Promise<boolean> {
        // "updated" is journaled only after Git finishes successfully; an active rebase then is a different operation.
        if (transaction.phase !== 'updating') { return false; }
        const directories: string[] = [];
        for (const name of ['rebase-merge', 'rebase-apply']) {
            const directory = path.join(repo.gitDir, name);
            if (await exists(directory)) { directories.push(directory); }
        }
        if (directories.length !== 1) { return false; }
        try {
            const [branch, originalHead, onto] = await Promise.all(['head-name', 'orig-head', 'onto']
                .map(async name => (await fs.readFile(path.join(directories[0], name), 'utf8')).trim()));
            return branch === `refs/heads/${transaction.branch}` && originalHead === transaction.originalHead && onto === transaction.target;
        } catch {
            // Missing or unreadable metadata cannot prove ownership, including git-am's rebase-apply directory.
            return false;
        }
    }
    private async restore(repo: Repository, transaction: Transaction, aborted = false): Promise<Repository> {
        const expectedHead = aborted ? transaction.originalHead : transaction.updatedHead || transaction.originalHead;
        if (await this.git(repo.path, ['rev-parse', 'HEAD']) !== expectedHead || await this.git(repo.path, ['symbolic-ref', '--short', 'HEAD']) !== transaction.branch) {
            return this.pause(repo, 'HEAD or branch changed before restoration; saved modifications were not applied.', transaction);
        }
        if (transaction.stash) {
            if (await this.git(repo.path, ['status', '--porcelain=v1']) || await this.blocked(repo)) {
                return this.pause(repo, 'Worktree changed before restoring saved modifications; recovery retained.', transaction);
            }
            transaction.phase = 'restoring';
            await this.journal(transaction);
            try {
                await this.git(repo.path, ['stash', 'apply', '--index', transaction.stash]);
            } catch (error) {
                transaction.phase = 'restore-conflict';
                return this.pause(repo, `Saved modifications could not be restored cleanly: ${message(error)}`, transaction);
            }
            if (await this.git(repo.path, ['ls-files', '--unmerged'])) {
                transaction.phase = 'restore-conflict';
                return this.pause(repo, 'Restored modifications contain unresolved conflicts.', transaction);
            }
        }
        return this.complete(repo, transaction, aborted);
    }
    private async complete(repo: Repository, transaction: Transaction, aborted = false): Promise<Repository> {
        // Completion is durable before cleanup. A crash can leave an extra stash, never lose the recovery object.
        transaction.phase = aborted ? 'aborted' : 'done';
        await this.journal(transaction);
        if (transaction.stash) {
            // Protect by a stable ref before removing the convenience stash entry.
            await this.git(repo.path, ['update-ref', `${transaction.backupRef}-stash`, transaction.stash]);
            // Stash ordinals can shift between subprocesses because of external Git. Never drop by ordinal.
            repo.retainedStash = `${transaction.backupRef}-stash`;
        }
        repo.state = 'idle';
        repo.reason = undefined;
        repo.recoveryNeedsConfirmation = undefined;
        repo.recoveryStash = undefined;
        repo.lastSync = this.now();
        this.retries.delete(repo.id);
        await this.observe(repo);
        await this.record(repo, aborted ? 'recovery' : 'sync-success', {
            operationId: transaction.id, before: transaction.originalHead, after: repo.head,
            message: aborted ? 'Rebase aborted and saved modifications restored.' : undefined
        });
        await this.save();
        return copy(repo);
    }
    async recover(id: string, action: 'continue' | 'abort', confirmRestored = false): Promise<Repository> {
        await this.initialize();
        const repo = this.require(id);
        if (action !== 'continue' && action !== 'abort') {
            throw new Error('Recovery action must be continue or abort.');
        }
        if (typeof confirmRestored !== 'boolean') {
            throw new Error('Restoration confirmation must be a boolean.');
        }
        return this.serialized(repo, async () => {
            const transaction = this.transactions.get(id);
            if (!transaction) {
                repo.state = 'idle';
                repo.reason = undefined;
                this.retries.delete(id);
                await this.observe(repo);
                await this.save();
                return copy(repo);
            }
            try {
                const rebase = await exists(path.join(repo.gitDir, 'rebase-merge')) || await exists(path.join(repo.gitDir, 'rebase-apply'));
                const blocked = await this.blocked(repo, rebase);
                if (blocked) {
                    return this.pause(repo, blocked, transaction);
                }
                if (!rebase && await this.git(repo.path, ['symbolic-ref', '--short', 'HEAD']) !== transaction.branch) {
                    return this.pause(repo, 'The branch changed during recovery; return to the original branch first.', transaction);
                }
                if (transaction.phase === 'stashing' && !transaction.stash) {
                    const entries = (await this.git(repo.path, ['stash', 'list', '--format=%H %s'])).split('\n');
                    transaction.stash = entries.find(entry => entry.includes(`ride-review:${transaction.id}`))?.split(' ')[0];
                    if (!transaction.stash) {
                        return this.pause(repo, 'Interrupted stash requires manual inspection; recovery was not discarded.', transaction);
                    }
                    transaction.phase = 'stashed';
                    await this.journal(transaction);
                }
                if (rebase) {
                    if (!await this.ownsActiveRebase(repo, transaction)) {
                        return this.pause(repo, 'The active rebase does not match this synchronization transaction; unrelated Git operation left untouched.', transaction);
                    }
                    await this.git(repo.path, ['-c', 'rebase.updateRefs=false', 'rebase', action === 'abort' ? '--abort' : '--continue']);
                    transaction.updatedHead = await this.git(repo.path, ['rev-parse', 'HEAD']);
                    transaction.phase = 'updated';
                    await this.journal(transaction);
                    return this.restore(repo, transaction, action === 'abort');
                }
                if (transaction.phase === 'restore-conflict' || transaction.phase === 'restoring') {
                    if (action === 'abort') {
                        return this.pause(repo,
                            `Saved modifications are retained at ${transaction.stash}. Resolve the working tree and continue; rollback would overwrite files.`,
                            transaction);
                    }
                    if (await this.git(repo.path, ['ls-files', '--unmerged'])) {
                        return this.pause(repo, 'Resolve and stage every conflict before continuing.', transaction);
                    }
                    if (await this.git(repo.path, ['rev-parse', 'HEAD']) !== (transaction.updatedHead || transaction.originalHead)) {
                        return this.pause(repo, 'HEAD changed during restoration; inspect saved modifications before continuing.', transaction);
                    }
                    if (!await this.git(repo.path, ['status', '--porcelain=v1'])) {
                        return this.restore(repo, transaction);
                    }
                    if (!confirmRestored) {
                        repo.recoveryNeedsConfirmation = true;
                        repo.recoveryStash = `${transaction.backupRef}-stash`;
                        if (transaction.stash) {
                            await this.git(repo.path, ['update-ref', repo.recoveryStash, transaction.stash]);
                        }
                        return this.pause(repo,
                            'Restoration is ambiguous. Verify saved modifications, then explicitly confirm restoration. The recovery stash is retained.', transaction);
                    }
                    return this.complete(repo, transaction);
                }
                const head = await this.git(repo.path, ['rev-parse', 'HEAD']);
                if (action === 'abort' && head !== transaction.originalHead) {
                    return this.pause(repo, 'The branch has already advanced. Recovery refs are retained; no automatic reset is performed.', transaction);
                }
                if (head === transaction.originalHead) {
                    if (action === 'continue') {
                        if (await this.git(repo.path, ['status', '--porcelain=v1'])) {
                            return this.pause(repo, 'Working tree changed during recovery.', transaction);
                        }
                        transaction.phase = 'updating';
                        await this.journal(transaction);
                        const collision = await this.ignoredCollision(repo, transaction.target);
                        if (collision) { return this.pause(repo, `Ignored local data overlaps the incoming tree: ${collision}`, transaction); }
                        if (await this.git(repo.path, ['rev-parse', 'HEAD']) !== transaction.originalHead
                            || await this.git(repo.path, ['symbolic-ref', '--short', 'HEAD']) !== transaction.branch || await this.blocked(repo)) {
                            return this.pause(repo, 'HEAD, branch or worktree guard changed immediately before recovery update.', transaction);
                        }
                        if (await this.isAncestor(repo, head, transaction.target)) {
                            await this.git(repo.path, ['merge', '--ff-only', '--no-overwrite-ignore', transaction.target]);
                        } else {
                            await this.git(repo.path, ['-c', 'rebase.autoStash=false', '-c', 'rebase.updateRefs=false', 'rebase', '--rebase-merges', transaction.target]);
                        }
                        transaction.updatedHead = await this.git(repo.path, ['rev-parse', 'HEAD']);
                    }
                    transaction.phase = 'updated';
                    await this.journal(transaction);
                    return this.restore(repo, transaction, action === 'abort');
                }
                if (transaction.updatedHead === head) {
                    return this.restore(repo, transaction);
                }
                return this.pause(repo, 'Unexpected HEAD after an interrupted update. Recovery refs are retained for manual inspection.', transaction);
            } catch (error) {
                return this.pause(repo, message(error), transaction);
            }
        });
    }
    start(): void {
        if (this.running || this.stopped) {
            return;
        }
        this.running = true;
        this.initialize().then(() => {
            if (!this.running) {
                return;
            }
            for (const repo of this.repositories.values()) {
                this.watchRepository(repo);
            }
            return this.tick();
        }).catch(() => undefined);
        this.timer = setInterval(() => { this.tick().catch(() => undefined); }, 15000);
        this.timer.unref?.();
    }
    private watchRepository(repo: Repository): void {
        if (this.watchers.has(repo.id)) {
            return;
        }
        const changed = () => {
            if (!this.running || this.debounce.has(repo.id)) {
                return;
            }
            this.debounce.set(repo.id, setTimeout(() => {
                this.debounce.delete(repo.id);
                this.refresh(repo.id).catch(() => undefined);
            }, 500));
        };
        const handles: FSWatcher[] = [];
        for (const directory of new Set([repo.path, repo.gitDir, repo.commonDir])) {
            try {
                const handle = watch(directory, { recursive: directory === repo.path }, changed);
                handle.on('error', () => handle.close());
                handles.push(handle);
            } catch { /* Periodic status checks remain authoritative. */ }
        }
        this.watchers.set(repo.id, handles);
    }
    private tick(): Promise<void> {
        if (!this.running) {
            return Promise.resolve();
        }
        const now = this.now();
        if (this.lastTickAt && now - this.lastTickAt > 30000) { this.forceNextCheck = true; }
        this.lastTickAt = now;
        if (this.tickTask) {
            return this.tickTask;
        }
        const task = this.runTick();
        this.tickTask = task;
        return task.finally(() => { if (this.tickTask === task) {
            this.tickTask = undefined;
        } });
    }
    private async runTick(): Promise<void> {
        // A delayed timer after sleep triggers a fresh remote check, as does the first cycle after startup.
        const forceCheck = this.forceNextCheck;
        this.forceNextCheck = false;
        if (this.now() - this.lastDiscovery >= DEFAULT_INTERVAL) {
            for (const root of this.scanRoots) {
                if (this.running) {
                    await this.discover(root, true);
                }
            }
            this.lastDiscovery = this.now();
        }
        const pending = [...this.repositories.values()];
        let index = 0;
        const worker = async (): Promise<void> => {
            while (this.running && index < pending.length) {
                const repo = pending[index++];
                const retry = this.retries.get(repo.id);
                const due = forceCheck || this.now() - (repo.lastSync || 0) >= repo.intervalMs;
                if (repo.enabled && repo.state !== 'paused' && due && (!retry || this.now() >= retry.next)) {
                    await this.sync(repo.id);
                } else {
                    await this.refresh(repo.id);
                }
            }
        };
        // Common-directory serialization still prevents concurrent operations on linked worktrees.
        await Promise.all([worker(), worker(), worker()]);
    }
    async stop(): Promise<void> {
        this.stopped = true;
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        for (const timer of this.debounce.values()) {
            clearTimeout(timer);
        }
        this.debounce.clear();
        for (const handles of this.watchers.values()) {
            for (const handle of handles) {
                handle.close();
            }
        }
        this.watchers.clear();
        await this.initialization?.catch(() => undefined);
        await this.tickTask?.catch(() => undefined);
        await Promise.all([...this.queue.values()].map(task => task.catch(() => undefined)));
        await this.io;
    }
}
