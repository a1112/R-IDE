/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { randomUUID } from 'node:crypto';
import { BigIntStats, constants as fsConstants, promises as fs } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { InstallPresentation } from '../common/ride-codex-installation';
import {
    attestPublishedRuntime,
    PublishedRuntimeAttestation,
    RuntimeFilesystemIdentity,
    runtimeFilesystemIdentitiesEqual,
    StagedRuntime
} from './ride-codex-runtime-stager';

export type PointerWriteKind = 'activate' | 'rollback';

export interface RideCodexRuntimeStoreTestHooks {
    beforePointerSync?(kind: PointerWriteKind, temporaryPath: string): void | Promise<void>;
    beforePointerRename?(kind: PointerWriteKind, temporaryPath: string): void | Promise<void>;
    afterPointerRename?(kind: PointerWriteKind, activePath: string): void | Promise<void>;
}

export interface RideCodexRuntimeStoreOptions {
    readonly trustedRuntimeBase: string;
    readonly runtimeRoot: string;
    readonly testHooks?: RideCodexRuntimeStoreTestHooks;
}

export interface ValidatedManagedRuntime {
    readonly version: string;
    readonly target: string;
    readonly manifestDigest: string;
    readonly relativePath: string;
    readonly directory: string;
    readonly executable: string;
    readonly pointer: ActiveRuntimePointer;
}

export interface PublishedManagedRuntime extends ValidatedManagedRuntime {
    readonly pointer: ActiveRuntimePointer;
}

interface SerializedRuntimeIdentity {
    readonly dev: string;
    readonly ino: string;
    readonly size: string;
    readonly birthtimeNs: string;
    readonly ctimeNs: string;
}

export interface ActiveRuntimePointer {
    readonly schemaVersion: 1;
    readonly version: string;
    readonly target: string;
    readonly manifestDigest: string;
    readonly relativePath: string;
    readonly executableRelativePath: string;
    readonly treeDigest: string;
    readonly treeEntries: number;
    readonly treeReadBytes: string;
    readonly treePathBytes: number;
    readonly rootIdentity: SerializedRuntimeIdentity;
}

const ACTIVE_POINTER = 'active.json';
const VERSIONS_DIRECTORY = 'versions';
const MAX_POINTER_BYTES = 16 * 1024;
const MAX_DIRECTORY_ENTRIES = 4096;
const MAX_DELETE_TREE_ENTRIES = 262_144;
const MAX_RUNTIME_BYTES = 2 * 1024 * 1024 * 1024;
const POINTER_KEYS = Object.freeze([
    'executableRelativePath', 'manifestDigest', 'relativePath', 'rootIdentity',
    'schemaVersion', 'target', 'treeDigest', 'treeEntries', 'treePathBytes',
    'treeReadBytes', 'version'
].sort());
const IDENTITY_KEYS = Object.freeze(['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'size'].sort());
const ROOT_LOCKS = new Map<string, RootLock>();

export class RideCodexRuntimeStoreError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RideCodexRuntimeStoreError';
    }
}

export class RideCodexRuntimeStore {
    readonly installRoot: string;
    private readonly trustedRuntimeBase: string;
    private readonly testHooks: RideCodexRuntimeStoreTestHooks;

    constructor(options: RideCodexRuntimeStoreOptions) {
        if (!isAbsolute(options.trustedRuntimeBase) || !isAbsolute(options.runtimeRoot)
            || isNetworkPath(options.trustedRuntimeBase) || isNetworkPath(options.runtimeRoot)) {
            throw new RideCodexRuntimeStoreError('Codex runtime store paths must be absolute local paths.');
        }
        this.trustedRuntimeBase = resolve(options.trustedRuntimeBase);
        this.installRoot = resolve(options.runtimeRoot);
        requireSameOrChild(this.trustedRuntimeBase, this.installRoot);
        this.testHooks = options.testHooks ?? Object.freeze({});
    }

    async withTransaction<T>(operation: () => Promise<T>): Promise<T> {
        const key = pathKey(this.installRoot);
        let lock = ROOT_LOCKS.get(key);
        if (!lock) {
            lock = new RootLock(key);
            ROOT_LOCKS.set(key, lock);
        }
        return lock.run(operation);
    }

    async recover(): Promise<void> {
        const boundary = await this.ensureWritableBoundary();
        const entries = await boundedDirectoryEntries(boundary.root);
        for (const entry of entries) {
            if (!entry.startsWith('.staging-')
                && !entry.startsWith('active.json.tmp-')
                && !entry.startsWith('.install-quarantine-')) {
                continue;
            }
            const candidate = join(boundary.root, entry);
            requireStrictChild(boundary.root, candidate);
            await quarantineAndDelete(candidate, boundary.root, boundary);
        }
    }

    async activeVersion(): Promise<string | undefined> {
        return (await this.readActiveRuntime())?.version;
    }

    async versions(): Promise<readonly string[]> {
        const boundary = await this.openReadOnlyBoundary();
        if (!boundary) {
            return Object.freeze([]);
        }
        const versionsRoot = await boundary.requireVersions(false);
        if (!versionsRoot) {
            return Object.freeze([]);
        }
        const versions = new Set<string>();
        for (const entry of await boundedDirectoryEntries(versionsRoot)) {
            const parsed = parseVersionDirectoryName(entry);
            if (!parsed) {
                continue;
            }
            const candidate = join(versionsRoot, entry);
            const stat = await fs.lstat(candidate, { bigint: true }).catch(() => undefined);
            if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
                continue;
            }
            const canonical = await fs.realpath(candidate).catch(() => undefined);
            if (!canonical || !samePath(canonical, candidate)) {
                continue;
            }
            versions.add(parsed.version);
        }
        return Object.freeze([...versions].sort(compareVersions));
    }

    async readActiveRuntime(): Promise<ValidatedManagedRuntime | undefined> {
        const boundary = await this.openReadOnlyBoundary();
        if (!boundary) {
            return undefined;
        }
        const activePath = join(boundary.root, ACTIVE_POINTER);
        const bytes = await readBoundedRegularFile(activePath, MAX_POINTER_BYTES, true);
        if (!bytes) {
            return undefined;
        }
        const pointer = parseActivePointer(bytes);
        return this.validatePointer(pointer, boundary);
    }

    async revalidate(runtime: ValidatedManagedRuntime): Promise<ValidatedManagedRuntime> {
        const boundary = await this.openReadOnlyBoundary();
        if (!boundary) {
            throw new RideCodexRuntimeStoreError('Codex managed runtime store is missing.');
        }
        const validated = await this.validatePointer(runtime.pointer, boundary);
        if (validated.relativePath !== runtime.relativePath
            || validated.version !== runtime.version
            || validated.target !== runtime.target
            || validated.manifestDigest !== runtime.manifestDigest) {
            throw new RideCodexRuntimeStoreError('Codex managed runtime changed before revalidation.');
        }
        return validated;
    }

    private async validatePointer(
        pointer: ActiveRuntimePointer,
        boundary: StoreBoundary
    ): Promise<ValidatedManagedRuntime> {
        const versionsRoot = await boundary.requireVersions(false);
        if (!versionsRoot) {
            throw new RideCodexRuntimeStoreError('Codex active runtime versions directory is missing.');
        }
        const expectedRelativePath = versionRelativePath(pointer.version, pointer.target, pointer.manifestDigest);
        if (pointer.relativePath !== expectedRelativePath
            || pointer.executableRelativePath !== expectedExecutableRelativePath(pointer.target)) {
            throw new RideCodexRuntimeStoreError('Codex active runtime pointer path is inconsistent.');
        }
        const directory = resolve(boundary.root, ...pointer.relativePath.split('/'));
        requireStrictChild(versionsRoot, directory);
        const stat = await safeLstat(directory, 'Codex active runtime directory is missing.');
        requireRegularDirectory(stat, 'Codex active runtime directory is unsafe.');
        const canonical = await safeRealpath(directory, 'Codex active runtime directory could not be resolved safely.');
        if (!samePath(canonical, directory)
            || !runtimeFilesystemIdentitiesEqual(filesystemIdentity(stat), deserializeIdentity(pointer.rootIdentity))) {
            throw new RideCodexRuntimeStoreError('Codex active runtime directory identity is invalid.');
        }
        const readBytes = parseBoundedBigInt(pointer.treeReadBytes, MAX_RUNTIME_BYTES, 'tree byte count');
        const attestation = await attestPublishedRuntime(directory, Number(readBytes), pointer.treeEntries);
        if (!attestationsMatchPointer(attestation, pointer)) {
            throw new RideCodexRuntimeStoreError('Codex active runtime attestation is invalid.');
        }
        const executable = resolve(directory, ...pointer.executableRelativePath.split('/'));
        requireStrictChild(directory, executable);
        const executableStat = await safeLstat(executable, 'Codex active runtime executable is missing.');
        if (!executableStat.isFile() || executableStat.isSymbolicLink() || executableStat.nlink !== BigInt(1)) {
            throw new RideCodexRuntimeStoreError('Codex active runtime executable is unsafe.');
        }
        const executableCanonical = await safeRealpath(executable, 'Codex active runtime executable could not be resolved safely.');
        if (!samePath(executableCanonical, executable)) {
            throw new RideCodexRuntimeStoreError('Codex active runtime executable escaped its verified directory.');
        }
        await boundary.verify();
        return Object.freeze({
            version: pointer.version,
            target: pointer.target,
            manifestDigest: pointer.manifestDigest,
            relativePath: pointer.relativePath,
            directory,
            executable,
            pointer
        });
    }

    async publish(staged: StagedRuntime, presentation: InstallPresentation): Promise<PublishedManagedRuntime> {
        const boundary = await this.ensureWritableBoundary();
        if (!samePath(presentation.installRoot, boundary.root)
            || staged.version !== presentation.version
            || staged.target !== presentation.target
            || staged.authorizationContext.target !== presentation.target
            || staged.authorizationContext.manifestDigest !== presentation.manifestDigest
            || !samePath(staged.authorizationContext.canonicalRoot, boundary.root)) {
            throw new RideCodexRuntimeStoreError('Codex staged runtime does not match its consented presentation.');
        }
        await staged.revalidate();
        const staging = resolve(staged.stagingDirectory);
        requireStrictChild(boundary.root, staging);
        if (!/^\.staging-[0-9a-f-]+$/i.test(staging.slice(boundary.root.length + 1))) {
            throw new RideCodexRuntimeStoreError('Codex staged runtime has a non-canonical staging path.');
        }
        const stagingStat = await safeLstat(staging, 'Codex staged runtime directory is missing.');
        requireRegularDirectory(stagingStat, 'Codex staged runtime directory is unsafe.');
        const stagingCanonical = await safeRealpath(staging, 'Codex staged runtime directory could not be resolved safely.');
        if (!samePath(stagingCanonical, staging)
            || !stableDirectoryIdentityEqual(filesystemIdentity(stagingStat), staged.stagingIdentity)) {
            throw new RideCodexRuntimeStoreError('Codex staged runtime identity is invalid.');
        }
        const executableRelativePath = safeRelativeRuntimePath(staging, staged.executable);
        if (executableRelativePath !== expectedExecutableRelativePath(presentation.target)) {
            throw new RideCodexRuntimeStoreError('Codex staged runtime executable path is inconsistent.');
        }
        const versionsRoot = await boundary.requireVersions(true);
        const relativePath = versionRelativePath(presentation.version, presentation.target, presentation.manifestDigest);
        const directory = resolve(boundary.root, ...relativePath.split('/'));
        requireStrictChild(versionsRoot!, directory);
        if (await pathExists(directory)) {
            throw new RideCodexRuntimeStoreError('Codex runtime version directory already exists.');
        }
        await boundary.verify();
        let moved = false;
        try {
            await fs.rename(staging, directory);
            moved = true;
            const movedStat = await safeLstat(directory, 'Codex published runtime directory is missing.');
            requireRegularDirectory(movedStat, 'Codex published runtime directory is unsafe.');
            if (!stableDirectoryIdentityEqual(filesystemIdentity(movedStat), staged.stagingIdentity)
                || !samePath(await safeRealpath(directory, 'Codex published runtime could not be resolved safely.'), directory)) {
                throw new RideCodexRuntimeStoreError('Codex published runtime identity changed during activation.');
            }
            const attestation = await attestPublishedRuntime(directory, staged.unpackedBytes);
            const executable = resolve(directory, ...executableRelativePath.split('/'));
            requireStrictChild(directory, executable);
            const pointer = createActivePointer(presentation, relativePath, executableRelativePath, attestation);
            await boundary.verify();
            return Object.freeze({
                version: presentation.version,
                target: presentation.target,
                manifestDigest: presentation.manifestDigest,
                relativePath,
                directory,
                executable,
                pointer
            });
        } catch (error) {
            if (moved) {
                await quarantineAndDelete(directory, boundary.root, boundary).catch(() => undefined);
            }
            throw error;
        }
    }

    async activate(
        published: PublishedManagedRuntime,
        expectedPrevious?: ValidatedManagedRuntime
    ): Promise<ValidatedManagedRuntime | undefined> {
        const previous = await this.readActiveRuntime();
        if ((previous?.relativePath ?? undefined) !== (expectedPrevious?.relativePath ?? undefined)
            || (previous?.manifestDigest ?? undefined) !== (expectedPrevious?.manifestDigest ?? undefined)) {
            throw new RideCodexRuntimeStoreError('Codex active runtime changed before activation.');
        }
        await this.writeActivePointer(published.pointer, 'activate');
        return previous;
    }

    async restore(
        previous: ValidatedManagedRuntime | undefined,
        failed: PublishedManagedRuntime
    ): Promise<void> {
        const current = await this.readActiveRuntime();
        if (!current || current.relativePath !== failed.relativePath) {
            throw new RideCodexRuntimeStoreError('Codex active runtime changed before rollback.');
        }
        if (previous) {
            await this.revalidate(previous);
            await this.writeActivePointer(previous.pointer, 'rollback');
            return;
        }
        const boundary = await this.ensureWritableBoundary();
        const activePath = join(boundary.root, ACTIVE_POINTER);
        await quarantineAndDelete(activePath, boundary.root, boundary);
        await syncDirectory(boundary.root);
    }

    async discard(published: PublishedManagedRuntime): Promise<void> {
        const boundary = await this.ensureWritableBoundary();
        const current = await this.readActiveRuntime();
        if (current?.relativePath === published.relativePath) {
            throw new RideCodexRuntimeStoreError('Codex active runtime cannot be discarded.');
        }
        const stat = await safeLstat(published.directory, 'Codex failed runtime directory is missing.');
        if (!stableDirectoryIdentityEqual(filesystemIdentity(stat), deserializeIdentity(published.pointer.rootIdentity))) {
            throw new RideCodexRuntimeStoreError('Codex failed runtime identity changed before cleanup.');
        }
        await quarantineAndDelete(published.directory, boundary.root, boundary);
    }

    async cleanupObsolete(keepRelativePaths: ReadonlySet<string>): Promise<void> {
        const boundary = await this.ensureWritableBoundary();
        const versionsRoot = await boundary.requireVersions(true);
        for (const entry of await boundedDirectoryEntries(versionsRoot!)) {
            const parsed = parseVersionDirectoryName(entry);
            if (!parsed) {
                continue;
            }
            const relativePath = `${VERSIONS_DIRECTORY}/${entry}`;
            if (keepRelativePaths.has(relativePath)) {
                continue;
            }
            const candidate = join(versionsRoot!, entry);
            const stat = await safeLstat(candidate, 'Codex obsolete runtime entry is missing.');
            if (!stat.isDirectory() || stat.isSymbolicLink()
                || !samePath(await safeRealpath(candidate, 'Codex obsolete runtime entry is unsafe.'), candidate)) {
                throw new RideCodexRuntimeStoreError('Codex obsolete runtime cleanup refused an unsafe entry.');
            }
            await quarantineAndDelete(candidate, boundary.root, boundary);
        }
    }

    private async writeActivePointer(pointer: ActiveRuntimePointer, kind: PointerWriteKind): Promise<void> {
        const boundary = await this.ensureWritableBoundary();
        const temporaryPath = join(boundary.root, `active.json.tmp-${randomUUID()}`);
        requireStrictChild(boundary.root, temporaryPath);
        const bytes = Buffer.from(`${JSON.stringify(pointer)}\n`, 'utf8');
        if (bytes.length > MAX_POINTER_BYTES) {
            throw new RideCodexRuntimeStoreError('Codex active runtime pointer exceeded its size limit.');
        }
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
        try {
            handle = await fs.open(
                temporaryPath,
                fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
                0o600
            );
            await handle.writeFile(bytes);
            await this.testHooks.beforePointerSync?.(kind, temporaryPath);
            await handle.sync();
        } finally {
            await handle?.close().catch(() => undefined);
        }
        const tempStat = await safeLstat(temporaryPath, 'Codex active runtime temporary pointer is missing.');
        if (!tempStat.isFile() || tempStat.isSymbolicLink() || tempStat.nlink !== BigInt(1)) {
            throw new RideCodexRuntimeStoreError('Codex active runtime temporary pointer is unsafe.');
        }
        await syncDirectory(boundary.root);
        await this.testHooks.beforePointerRename?.(kind, temporaryPath);
        const activePath = join(boundary.root, ACTIVE_POINTER);
        await fs.rename(temporaryPath, activePath);
        await this.testHooks.afterPointerRename?.(kind, activePath);
        await syncDirectory(boundary.root);
        await boundary.verify();
    }

    private async ensureWritableBoundary(): Promise<StoreBoundary> {
        const base = await validateExistingDirectory(this.trustedRuntimeBase, 'Codex trusted runtime base is unavailable.');
        let current = base.path;
        const child = relative(this.trustedRuntimeBase, this.installRoot);
        for (const segment of child ? child.split(/[\\/]/) : []) {
            current = resolve(current, segment);
            requireSameOrChild(base.path, current);
            await fs.mkdir(current, { mode: 0o700 }).catch(error => {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                    throw error;
                }
            });
            await validateExistingDirectory(current, 'Codex runtime store ancestor is unsafe.');
        }
        const root = await validateExistingDirectory(this.installRoot, 'Codex runtime store root is unsafe.');
        const boundary = new StoreBoundary(root.path, root.identity);
        await boundary.requireVersions(true);
        return boundary;
    }

    private async openReadOnlyBoundary(): Promise<StoreBoundary | undefined> {
        try {
            await validateExistingDirectory(this.trustedRuntimeBase, 'Codex trusted runtime base is unsafe.');
            const root = await validateExistingDirectory(this.installRoot, 'Codex runtime store root is unsafe.');
            return new StoreBoundary(root.path, root.identity);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return undefined;
            }
            if (error instanceof RideCodexRuntimeStoreError && /unavailable|missing/i.test(error.message)) {
                return undefined;
            }
            throw error;
        }
    }
}

class RootLock {
    private tail = Promise.resolve();
    private users = 0;

    constructor(private readonly key: string) { }

    async run<T>(operation: () => Promise<T>): Promise<T> {
        this.users += 1;
        const previous = this.tail;
        let release!: () => void;
        const current = new Promise<void>(resolveRelease => { release = resolveRelease; });
        this.tail = previous.catch(() => undefined).then(() => current);
        await previous.catch(() => undefined);
        try {
            return await operation();
        } finally {
            release();
            this.users -= 1;
            if (this.users === 0 && ROOT_LOCKS.get(this.key) === this) {
                ROOT_LOCKS.delete(this.key);
            }
        }
    }
}

class StoreBoundary {
    constructor(readonly root: string, private readonly identity: RuntimeFilesystemIdentity) { }

    async verify(): Promise<void> {
        const current = await validateExistingDirectory(this.root, 'Codex runtime store root changed.');
        if (!stableDirectoryIdentityEqual(current.identity, this.identity)) {
            throw new RideCodexRuntimeStoreError('Codex runtime store root identity changed.');
        }
    }

    async requireVersions(create: boolean): Promise<string | undefined> {
        await this.verify();
        const versions = join(this.root, VERSIONS_DIRECTORY);
        if (create) {
            await fs.mkdir(versions, { mode: 0o700 }).catch(error => {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                    throw error;
                }
            });
        }
        try {
            const validated = await validateExistingDirectory(versions, 'Codex runtime versions directory is unsafe.');
            requireStrictChild(this.root, validated.path);
            return validated.path;
        } catch (error) {
            if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') {
                return undefined;
            }
            throw error;
        }
    }
}

function createActivePointer(
    presentation: InstallPresentation,
    relativePath: string,
    executableRelativePath: string,
    attestation: PublishedRuntimeAttestation
): ActiveRuntimePointer {
    return Object.freeze({
        schemaVersion: 1,
        version: presentation.version,
        target: presentation.target,
        manifestDigest: presentation.manifestDigest,
        relativePath,
        executableRelativePath,
        treeDigest: attestation.treeDigest,
        treeEntries: attestation.entries,
        treeReadBytes: attestation.totalReadBytes.toString(),
        treePathBytes: attestation.totalPathBytes,
        rootIdentity: serializeIdentity(attestation.rootIdentity)
    });
}

function parseActivePointer(bytes: Buffer): ActiveRuntimePointer {
    const source = bytes.toString('utf8');
    let candidate: unknown;
    try {
        candidate = JSON.parse(source) as unknown;
    } catch {
        throw new RideCodexRuntimeStoreError('Codex active runtime pointer is invalid JSON.');
    }
    const record = requireExactRecord(candidate, POINTER_KEYS, 'Codex active runtime pointer has an invalid shape.');
    const identity = requireExactRecord(record.rootIdentity, IDENTITY_KEYS, 'Codex active runtime identity has an invalid shape.');
    if (record.schemaVersion !== 1
        || typeof record.version !== 'string' || !isVersion(record.version)
        || typeof record.target !== 'string' || !isTarget(record.target)
        || typeof record.manifestDigest !== 'string' || !isDigest(record.manifestDigest)
        || typeof record.relativePath !== 'string' || !isSafeRelativePath(record.relativePath)
        || typeof record.executableRelativePath !== 'string' || !isSafeRelativePath(record.executableRelativePath)
        || typeof record.treeDigest !== 'string' || !isDigest(record.treeDigest)
        || !Number.isSafeInteger(record.treeEntries) || (record.treeEntries as number) <= 0 || (record.treeEntries as number) > 262_144
        || typeof record.treeReadBytes !== 'string'
        || !Number.isSafeInteger(record.treePathBytes) || (record.treePathBytes as number) <= 0
        || (record.treePathBytes as number) > 16 * 1024 * 1024) {
        throw new RideCodexRuntimeStoreError('Codex active runtime pointer values are invalid.');
    }
    const parsedIdentity = deserializeIdentity(identity as unknown as SerializedRuntimeIdentity);
    if (parsedIdentity.dev < BigInt(0) || parsedIdentity.ino < BigInt(0) || parsedIdentity.size < BigInt(0)) {
        throw new RideCodexRuntimeStoreError('Codex active runtime identity values are invalid.');
    }
    parseBoundedBigInt(record.treeReadBytes, MAX_RUNTIME_BYTES, 'tree byte count');
    const pointer: ActiveRuntimePointer = Object.freeze({
        schemaVersion: 1,
        version: record.version,
        target: record.target,
        manifestDigest: record.manifestDigest,
        relativePath: record.relativePath,
        executableRelativePath: record.executableRelativePath,
        treeDigest: record.treeDigest,
        treeEntries: record.treeEntries as number,
        treeReadBytes: record.treeReadBytes,
        treePathBytes: record.treePathBytes as number,
        rootIdentity: Object.freeze({
            dev: identity.dev as string,
            ino: identity.ino as string,
            size: identity.size as string,
            birthtimeNs: identity.birthtimeNs as string,
            ctimeNs: identity.ctimeNs as string
        })
    });
    if (source !== `${JSON.stringify(pointer)}\n`) {
        throw new RideCodexRuntimeStoreError('Codex active runtime pointer is not canonical JSON.');
    }
    return pointer;
}

async function quarantineAndDelete(candidate: string, root: string, boundary: StoreBoundary): Promise<void> {
    requireStrictChild(root, candidate);
    const before = await safeLstat(candidate, 'Codex runtime cleanup target is missing.');
    if ((!before.isDirectory() && !before.isFile()) || before.isSymbolicLink()) {
        throw new RideCodexRuntimeStoreError('Codex runtime cleanup refused a link or special entry.');
    }
    const canonical = await safeRealpath(candidate, 'Codex runtime cleanup target could not be resolved safely.');
    if (!samePath(canonical, candidate)) {
        throw new RideCodexRuntimeStoreError('Codex runtime cleanup target escaped its verified root.');
    }
    const quarantine = join(root, `.install-quarantine-${randomUUID()}`);
    requireStrictChild(root, quarantine);
    await boundary.verify();
    await fs.rename(candidate, quarantine);
    const moved = await safeLstat(quarantine, 'Codex runtime cleanup quarantine is missing.');
    if (moved.isSymbolicLink() || !samePath(await safeRealpath(quarantine, 'Codex runtime cleanup quarantine is unsafe.'), quarantine)
        || !stableObjectIdentityEqual(filesystemIdentity(before), filesystemIdentity(moved))) {
        throw new RideCodexRuntimeStoreError('Codex runtime cleanup quarantined a replaced object.');
    }
    await boundary.verify();
    await verifySafeDeletionTree(quarantine, root);
    await fs.rm(quarantine, { recursive: before.isDirectory(), force: true });
    await boundary.verify();
}

async function verifySafeDeletionTree(candidate: string, root: string): Promise<void> {
    let visited = 0;
    const visit = async (path: string): Promise<void> => {
        visited += 1;
        if (visited > MAX_DELETE_TREE_ENTRIES) {
            throw new RideCodexRuntimeStoreError('Codex runtime cleanup tree exceeded its safe entry limit.');
        }
        requireStrictChild(root, path);
        const before = await safeLstat(path, 'Codex runtime cleanup tree entry is missing.');
        if (before.isSymbolicLink()
            || (!before.isDirectory() && !before.isFile())
            || (before.isFile() && before.nlink !== BigInt(1))) {
            throw new RideCodexRuntimeStoreError('Codex runtime cleanup tree contains a forbidden link or special entry.');
        }
        const canonical = await safeRealpath(path, 'Codex runtime cleanup tree entry could not be resolved safely.');
        if (!samePath(canonical, path)) {
            throw new RideCodexRuntimeStoreError('Codex runtime cleanup tree escaped its verified root.');
        }
        if (!before.isDirectory()) {
            return;
        }
        for (const child of await boundedDirectoryEntries(path, MAX_DELETE_TREE_ENTRIES)) {
            await visit(join(path, child));
        }
        const after = await safeLstat(path, 'Codex runtime cleanup tree directory changed.');
        if (!after.isDirectory() || after.isSymbolicLink()
            || !stableDirectoryIdentityEqual(filesystemIdentity(before), filesystemIdentity(after))) {
            throw new RideCodexRuntimeStoreError('Codex runtime cleanup tree directory identity changed.');
        }
    };
    await visit(candidate);
}

async function readBoundedRegularFile(path: string, maxBytes: number, optional: boolean): Promise<Buffer | undefined> {
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
        handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch (error) {
        if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw new RideCodexRuntimeStoreError('Codex active runtime pointer is unavailable.');
    }
    try {
        const opened = await handle.stat({ bigint: true });
        const pathStat = await fs.lstat(path, { bigint: true });
        if (!opened.isFile() || opened.nlink !== BigInt(1) || !pathStat.isFile() || pathStat.isSymbolicLink()
            || !runtimeFilesystemIdentitiesEqual(filesystemIdentity(opened), filesystemIdentity(pathStat))
            || opened.size < BigInt(1) || opened.size > BigInt(maxBytes)) {
            throw new RideCodexRuntimeStoreError('Codex active runtime pointer is unsafe or oversized.');
        }
        const buffer = Buffer.alloc(Number(opened.size));
        let offset = 0;
        while (offset < buffer.length) {
            const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (bytesRead <= 0) {
                throw new RideCodexRuntimeStoreError('Codex active runtime pointer was truncated.');
            }
            offset += bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        if (!runtimeFilesystemIdentitiesEqual(filesystemIdentity(opened), filesystemIdentity(after))) {
            throw new RideCodexRuntimeStoreError('Codex active runtime pointer changed while reading.');
        }
        return buffer;
    } finally {
        await handle.close().catch(() => undefined);
    }
}

async function validateExistingDirectory(path: string, message: string): Promise<{ path: string; identity: RuntimeFilesystemIdentity }> {
    let stat: BigIntStats;
    try {
        stat = await fs.lstat(path, { bigint: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw error;
        }
        throw new RideCodexRuntimeStoreError(message);
    }
    requireRegularDirectory(stat, message);
    let canonical: string;
    try {
        canonical = await fs.realpath(path);
    } catch {
        throw new RideCodexRuntimeStoreError(message);
    }
    if (!samePath(canonical, resolve(path))) {
        throw new RideCodexRuntimeStoreError(message);
    }
    return Object.freeze({ path: canonical, identity: filesystemIdentity(stat) });
}

function requireExactRecord(value: unknown, keys: readonly string[], message: string): Record<string, unknown> {
    if (typeof value !== 'object' || !value || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new RideCodexRuntimeStoreError(message);
    }
    const actual = Object.keys(value).sort();
    if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
        throw new RideCodexRuntimeStoreError(message);
    }
    const result: Record<string, unknown> = {};
    for (const key of actual) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            throw new RideCodexRuntimeStoreError(message);
        }
        result[key] = descriptor.value;
    }
    return result;
}

function versionRelativePath(version: string, target: string, digest: string): string {
    if (!isVersion(version) || !isTarget(target) || !isDigest(digest)) {
        throw new RideCodexRuntimeStoreError('Codex runtime version identity is invalid.');
    }
    return `${VERSIONS_DIRECTORY}/v-${version}--${target}--${digest.slice('sha256-'.length, 'sha256-'.length + 16)}`;
}

function expectedExecutableRelativePath(target: string): string {
    if (!isTarget(target)) {
        throw new RideCodexRuntimeStoreError('Codex runtime target is invalid.');
    }
    return `package/vendor/${target}/bin/${target.includes('windows') ? 'codex.exe' : 'codex'}`;
}

function parseVersionDirectoryName(name: string): { version: string } | undefined {
    const match = /^v-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)--([a-z0-9_-]+)--([a-f0-9]{16})$/.exec(name);
    return match && isVersion(match[1]) && isTarget(match[2]) ? Object.freeze({ version: match[1] }) : undefined;
}

function safeRelativeRuntimePath(root: string, path: string): string {
    const resolvedRoot = resolve(root);
    const resolvedPath = resolve(path);
    requireStrictChild(resolvedRoot, resolvedPath);
    const portable = relative(resolvedRoot, resolvedPath).split(/[/\\]/).join('/');
    if (!isSafeRelativePath(portable)) {
        throw new RideCodexRuntimeStoreError('Codex runtime executable path is unsafe.');
    }
    return portable;
}

function isSafeRelativePath(value: string): boolean {
    if (!value || value.length > 4096 || value.includes('\\') || value.startsWith('/') || value.includes('\0')) {
        return false;
    }
    const normalized = posix.normalize(value);
    return normalized === value && !normalized.startsWith('../') && normalized !== '..'
        && normalized.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..'
            && !/[\u0000-\u001f\u007f]/.test(segment));
}

function serializeIdentity(identity: RuntimeFilesystemIdentity): SerializedRuntimeIdentity {
    return Object.freeze({
        dev: identity.dev.toString(),
        ino: identity.ino.toString(),
        size: identity.size.toString(),
        birthtimeNs: identity.birthtimeNs.toString(),
        ctimeNs: identity.ctimeNs.toString()
    });
}

function deserializeIdentity(identity: SerializedRuntimeIdentity): RuntimeFilesystemIdentity {
    try {
        return Object.freeze({
            dev: parseCanonicalBigInt(identity.dev),
            ino: parseCanonicalBigInt(identity.ino),
            size: parseCanonicalBigInt(identity.size),
            birthtimeNs: parseCanonicalBigInt(identity.birthtimeNs),
            ctimeNs: parseCanonicalBigInt(identity.ctimeNs)
        });
    } catch {
        throw new RideCodexRuntimeStoreError('Codex active runtime identity values are invalid.');
    }
}

function parseCanonicalBigInt(value: unknown): bigint {
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value) || value.length > 40) {
        throw new Error('invalid bigint');
    }
    return BigInt(value);
}

function parseBoundedBigInt(value: string, maximum: number, field: string): bigint {
    let parsed: bigint;
    try {
        parsed = parseCanonicalBigInt(value);
    } catch {
        throw new RideCodexRuntimeStoreError(`Codex active runtime ${field} is invalid.`);
    }
    if (parsed <= BigInt(0) || parsed > BigInt(maximum)) {
        throw new RideCodexRuntimeStoreError(`Codex active runtime ${field} exceeds its safe limit.`);
    }
    return parsed;
}

function attestationsMatchPointer(attestation: PublishedRuntimeAttestation, pointer: ActiveRuntimePointer): boolean {
    return attestation.treeDigest === pointer.treeDigest
        && attestation.entries === pointer.treeEntries
        && attestation.totalReadBytes.toString() === pointer.treeReadBytes
        && attestation.totalPathBytes === pointer.treePathBytes
        && runtimeFilesystemIdentitiesEqual(attestation.rootIdentity, deserializeIdentity(pointer.rootIdentity));
}

function filesystemIdentity(stat: BigIntStats): RuntimeFilesystemIdentity {
    return Object.freeze({
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        birthtimeNs: stat.birthtimeNs,
        ctimeNs: stat.ctimeNs
    });
}

function stableDirectoryIdentityEqual(left: RuntimeFilesystemIdentity, right: RuntimeFilesystemIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function stableObjectIdentityEqual(left: RuntimeFilesystemIdentity, right: RuntimeFilesystemIdentity): boolean {
    return stableDirectoryIdentityEqual(left, right) && left.size === right.size;
}

function requireRegularDirectory(stat: BigIntStats, message: string): void {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new RideCodexRuntimeStoreError(message);
    }
}

async function safeLstat(path: string, message: string): Promise<BigIntStats> {
    try {
        return await fs.lstat(path, { bigint: true });
    } catch {
        throw new RideCodexRuntimeStoreError(message);
    }
}

async function safeRealpath(path: string, message: string): Promise<string> {
    try {
        return await fs.realpath(path);
    } catch {
        throw new RideCodexRuntimeStoreError(message);
    }
}

async function boundedDirectoryEntries(path: string, maximum = MAX_DIRECTORY_ENTRIES): Promise<readonly string[]> {
    const entries: string[] = [];
    const directory = await fs.opendir(path);
    try {
        while (true) {
            const entry = await directory.read();
            if (!entry) {
                return Object.freeze(entries);
            }
            if (entries.length >= maximum) {
                throw new RideCodexRuntimeStoreError('Codex runtime store exceeded its directory entry limit.');
            }
            entries.push(entry.name);
        }
    } finally {
        await directory.close().catch(() => undefined);
    }
}

async function syncDirectory(path: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
        handle = await fs.open(path, fsConstants.O_RDONLY);
        await handle.sync();
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(code ?? '')) {
            throw error;
        }
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await fs.lstat(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

function isVersion(value: string): boolean {
    return value.length <= 64 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function isTarget(value: string): boolean {
    return [
        'x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc',
        'x86_64-apple-darwin', 'aarch64-apple-darwin',
        'x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl'
    ].includes(value);
}

function isDigest(value: string): boolean {
    return /^sha256-[a-f0-9]{64}$/.test(value);
}

function compareVersions(left: string, right: string): number {
    return left.localeCompare(right, 'en', { numeric: true });
}

function requireSameOrChild(parent: string, candidate: string): void {
    const child = relative(resolve(parent), resolve(candidate));
    if (child === '' || (!child.startsWith('..') && !isAbsolute(child))) {
        return;
    }
    throw new RideCodexRuntimeStoreError('Codex runtime store escaped its extension-owned base.');
}

function requireStrictChild(parent: string, candidate: string): void {
    const child = relative(resolve(parent), resolve(candidate));
    if (!child || child.startsWith('..') || isAbsolute(child)) {
        throw new RideCodexRuntimeStoreError('Codex runtime store path escaped its verified boundary.');
    }
}

function samePath(left: string, right: string): boolean {
    return pathKey(resolve(left)) === pathKey(resolve(right));
}

function pathKey(path: string): string {
    return process.platform === 'win32' ? path.toLowerCase() : path;
}

function isNetworkPath(path: string): boolean {
    return path.startsWith('\\\\') || path.startsWith('//');
}
