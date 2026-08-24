/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createHash, randomUUID } from 'node:crypto';
import { BigIntStats, constants as fsConstants, promises as fs } from 'node:fs';
import { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract, Headers } from 'tar-stream';
import {
    createInstallAuthorizationContext,
    InstallAuthorization,
    InstallAuthorizationContext,
    InstallAuthorizationValidator,
    RideCodexRuntimeFetcher,
    RideCodexRuntimeFetchDestination,
    RideCodexRuntimeStagingFetcherLike
} from './ride-codex-runtime-fetcher';
import {
    RideCodexRuntimeManifestEntry,
    RuntimeTarget,
    runtimeManifestEntryForTarget
} from './ride-codex-runtime-manifest';
import { RideCodexRuntimeProbe, RideCodexRuntimeProbeLike } from './ride-codex-runtime-probe';
import { readNativeBinaryTargets } from './ride-codex-runtime-resolver';

export { InstallAuthorization } from './ride-codex-runtime-fetcher';

export const RIDE_CODEX_RUNTIME_STAGE_SAFETY_MARGIN_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_ENTRIES = 32_768;
const MAX_ARCHIVE_PATH_BYTES = 1024;
const MAX_PACKAGE_MANIFEST_BYTES = 16 * 1024;
const MAX_NATIVE_HEADER_BYTES = 4096;
const RUNTIME_PROBE_TIMEOUT_MS = 10_000;
const TAR_BLOCK_BYTES = 512;
const MAX_TAR_OVERHEAD_BYTES = 64 * 1024;
const MAX_RUNTIME_TREE_ENTRIES = 262_144;
const MAX_RUNTIME_TREE_TOTAL_PATH_BYTES = 16 * 1024 * 1024;
const RUNTIME_TREE_READ_BUFFER_BYTES = 64 * 1024;

export interface RideCodexStatFs {
    readonly bsize: number | bigint;
    readonly bavail: number | bigint;
}

export interface StagedRuntime {
    readonly stagingDirectory: string;
    readonly packageRoot: string;
    readonly executable: string;
    readonly resourcesDirectory: string;
    readonly pathDirectory: string;
    readonly package: '@openai/codex';
    readonly version: string;
    readonly npmVersion: string;
    readonly target: RuntimeTarget;
    readonly integrity: string;
    readonly compressedBytes: number;
    readonly unpackedBytes: number;
    readonly layoutVersion: 1;
    readonly entrypoint: string;
    readonly authorizationContext: InstallAuthorizationContext;
    readonly stagingIdentity: RuntimeFilesystemIdentity;
    revalidate(): Promise<void>;
}

export interface RuntimeFilesystemIdentity {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly birthtimeNs: bigint;
    readonly ctimeNs: bigint;
}

export interface RideCodexRuntimeStagerOptions {
    readonly trustedRuntimeBase: string;
    readonly runtimeRoot: string;
    readonly authorizationValidator: InstallAuthorizationValidator;
    readonly statfs?: (path: string) => Promise<RideCodexStatFs>;
    readonly fetcher?: RideCodexRuntimeStagingFetcherLike;
    readonly probe?: RideCodexRuntimeProbeLike;
    readonly maxArchiveEntries?: number;
    readonly signal?: AbortSignal;
}

export class RideCodexRuntimeStageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RideCodexRuntimeStageError';
    }
}

export class RideCodexRuntimeStager {
    private readonly trustedRuntimeBase: string;
    private readonly runtimeRoot: string;
    private readonly statfs: (path: string) => Promise<RideCodexStatFs>;
    private readonly fetcher: RideCodexRuntimeStagingFetcherLike;
    private readonly probe: RideCodexRuntimeProbeLike;
    private readonly extractor: RideCodexRuntimeArchiveExtractor;
    private readonly maxTreeEntries: number;
    private readonly signal?: AbortSignal;

    constructor(options: RideCodexRuntimeStagerOptions) {
        if (!isAbsolute(options.trustedRuntimeBase) || !isAbsolute(options.runtimeRoot)) {
            throw new RideCodexRuntimeStageError('Codex runtime base and root must be absolute extension-owned paths.');
        }
        this.trustedRuntimeBase = resolve(options.trustedRuntimeBase);
        this.runtimeRoot = resolve(options.runtimeRoot);
        requireSameOrChild(this.trustedRuntimeBase, this.runtimeRoot);
        this.statfs = options.statfs ?? (async path => fs.statfs(path));
        this.fetcher = options.fetcher ?? new RideCodexRuntimeFetcher({
            authorizationValidator: options.authorizationValidator
        });
        this.probe = options.probe ?? new RideCodexRuntimeProbe();
        const maxArchiveEntries = positiveSafeInteger(options.maxArchiveEntries, DEFAULT_MAX_ARCHIVE_ENTRIES);
        this.extractor = new RideCodexRuntimeArchiveExtractor({ maxEntries: maxArchiveEntries });
        this.maxTreeEntries = boundedTreeEntryLimit(maxArchiveEntries);
        this.signal = options.signal;
    }

    async stage(authorization: InstallAuthorization, target: RuntimeTarget): Promise<StagedRuntime> {
        const runtime = runtimeManifestEntryForTarget(target);
        const rootBoundary = await RuntimeRootBoundary.create(this.trustedRuntimeBase, this.runtimeRoot);
        const stagingDirectory = join(rootBoundary.canonicalRoot, `.staging-${randomUUID()}`);
        requireStrictChild(rootBoundary.canonicalRoot, stagingDirectory);
        const archive = join(stagingDirectory, 'runtime.tgz');
        requireStrictChild(stagingDirectory, archive);
        const authorizationContext = createInstallAuthorizationContext(
            runtime,
            rootBoundary.canonicalRoot,
            archive
        );
        const capability = await this.fetcher.authorize(authorization, authorizationContext);
        let stagingBoundary: RuntimeStagingBoundary | undefined;
        let archiveHandle: FileHandle | undefined;
        try {
            const capacity = await this.statfs(rootBoundary.canonicalRoot);
            if (availableBytes(capacity) < BigInt(requiredRuntimeStageBytes(runtime))) {
                throw new RideCodexRuntimeStageError('Insufficient disk space to stage the managed Codex runtime.');
            }
            await rootBoundary.verify();
            await fs.mkdir(stagingDirectory, { mode: 0o700 });
            stagingBoundary = await rootBoundary.captureStaging(stagingDirectory);
            await stagingBoundary.verify();
            await stagingBoundary.verify();
            archiveHandle = await openNewOwnedFile(archive, stagingBoundary);
            const destination: RideCodexRuntimeFetchDestination = Object.freeze({
                path: archive,
                canonicalRoot: rootBoundary.canonicalRoot,
                handle: archiveHandle
            });
            await this.fetcher.fetchAuthorized(capability, runtime, destination, this.signal);
            await archiveHandle.sync();
            const archiveIdentity = filesystemIdentity(await archiveHandle.stat({ bigint: true }));
            await archiveHandle.close();
            archiveHandle = undefined;
            await stagingBoundary.verify();
            const archiveReader = await openVerifiedFile(archive, stagingBoundary, archiveIdentity);
            try {
                await this.extractor.extract(
                    Object.freeze({ path: archive, handle: archiveReader }),
                    stagingDirectory,
                    runtime,
                    () => stagingBoundary!.verify()
                );
            } finally {
                await archiveReader.close().catch(() => undefined);
            }
            await stagingBoundary.verify();
            await fs.rm(archive, { force: true });
            await stagingBoundary.verify();
            const staged = await this.verifyStagedRuntime(stagingBoundary, runtime, authorizationContext);
            await stagingBoundary.verify();
            return staged;
        } catch (error) {
            await archiveHandle?.close().catch(() => undefined);
            await stagingBoundary?.cleanup();
            if (error instanceof RideCodexRuntimeStageError) {
                throw error;
            }
            throw new RideCodexRuntimeStageError('Codex managed runtime staging failed safely.');
        }
    }

    private async verifyStagedRuntime(
        stagingBoundary: RuntimeStagingBoundary,
        runtime: RideCodexRuntimeManifestEntry,
        authorizationContext: InstallAuthorizationContext
    ): Promise<StagedRuntime> {
        const stagingDirectory = stagingBoundary.canonicalStaging;
        await stagingBoundary.verify();
        const packageRoot = join(stagingDirectory, 'package');
        const vendorRoot = join(packageRoot, 'vendor', runtime.target);
        const manifestPath = join(vendorRoot, 'codex-package.json');
        const manifest = await readPackageManifest(manifestPath);
        await stagingBoundary.verify();
        validatePackageManifest(manifest, runtime);
        const resourcesDirectory = join(vendorRoot, manifest.resourcesDir);
        const pathDirectory = join(vendorRoot, manifest.pathDir);
        await requireSafeDirectory(resourcesDirectory, vendorRoot);
        await requireSafeDirectory(pathDirectory, vendorRoot);
        await stagingBoundary.verify();

        const executable = resolve(vendorRoot, runtime.entrypoint);
        requireStrictChild(vendorRoot, executable);
        const executableStat = await safeLstat(executable, 'Codex native executable is missing.');
        if (!executableStat.isFile() || executableStat.isSymbolicLink()) {
            throw new RideCodexRuntimeStageError('Codex native executable must be a regular file.');
        }
        const header = await readPrefix(executable, MAX_NATIVE_HEADER_BYTES);
        await stagingBoundary.verify();
        const platform = platformForTarget(runtime.target);
        const binaryTargets = readNativeBinaryTargets(platform, header);
        if (!binaryTargets.includes(runtime.target)) {
            throw new RideCodexRuntimeStageError('Codex native binary architecture does not match the staged target.');
        }
        if (platform !== 'win32') {
            await fs.chmod(executable, 0o700);
        }
        let probeResult: { readonly version: string };
        try {
            probeResult = await this.probe.probe(executable, {
                timeoutMs: RUNTIME_PROBE_TIMEOUT_MS,
                ...(this.signal ? { signal: this.signal } : {})
            });
        } catch {
            throw new RideCodexRuntimeStageError('Codex staged runtime probe failed.');
        }
        if (probeResult.version !== runtime.version) {
            throw new RideCodexRuntimeStageError('Codex staged runtime probe returned an incompatible version.');
        }
        await stagingBoundary.verify();
        const treeAttestation = await attestRuntimeTree(
            stagingDirectory,
            this.maxTreeEntries,
            MAX_ARCHIVE_PATH_BYTES,
            runtime.unpackedBytes
        );
        await stagingBoundary.verify();
        const revalidate = async (): Promise<void> => {
            try {
                await stagingBoundary.verify();
                const currentTree = await attestRuntimeTree(
                    stagingDirectory,
                    this.maxTreeEntries,
                    MAX_ARCHIVE_PATH_BYTES,
                    runtime.unpackedBytes
                );
                if (!runtimeTreeAttestationsEqual(treeAttestation, currentTree)) {
                    throw new RideCodexRuntimeStageError('Codex staged runtime tree attestation changed.');
                }
                await stagingBoundary.verify();
            } catch {
                throw new RideCodexRuntimeStageError('Codex staged runtime tree attestation changed or is unsafe.');
            }
        };
        return Object.freeze({
            stagingDirectory,
            packageRoot,
            executable,
            resourcesDirectory,
            pathDirectory,
            package: runtime.package,
            version: runtime.version,
            npmVersion: runtime.npmVersion,
            target: runtime.target,
            integrity: runtime.integrity,
            compressedBytes: runtime.compressedBytes,
            unpackedBytes: runtime.unpackedBytes,
            layoutVersion: runtime.layoutVersion,
            entrypoint: runtime.entrypoint,
            authorizationContext,
            stagingIdentity: stagingBoundary.identity,
            revalidate
        });
    }
}

type DirectoryStat = BigIntStats;

class RuntimeRootBoundary {
    private constructor(
        readonly canonicalRoot: string,
        private readonly rootIdentity: RuntimeFilesystemIdentity
    ) { }

    static async create(trustedRuntimeBase: string, runtimeRoot: string): Promise<RuntimeRootBoundary> {
        const baseStat = await safeLstat(trustedRuntimeBase, 'Codex trusted runtime base is missing.');
        requireRegularDirectory(baseStat, 'Codex trusted runtime base is not a safe extension-owned directory.');
        const canonicalBase = await safeRealpath(trustedRuntimeBase, 'Codex trusted runtime base could not be resolved safely.');
        if (!samePath(trustedRuntimeBase, canonicalBase)) {
            throw new RideCodexRuntimeStageError('Codex trusted runtime base has a symlink, junction, or reparse ancestor.');
        }
        requireSameOrChild(trustedRuntimeBase, runtimeRoot);
        const child = relative(trustedRuntimeBase, runtimeRoot);
        const segments = child ? child.split(/[\\/]/) : [];
        let current = canonicalBase;
        for (const segment of segments) {
            current = resolve(current, segment);
            requireSameOrChild(canonicalBase, current);
            try {
                await fs.mkdir(current, { mode: 0o700 });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                    throw error;
                }
            }
            const stat = await safeLstat(current, 'Codex runtime root ancestor is missing.');
            requireRegularDirectory(stat, 'Codex runtime root ancestor is a symlink, junction, reparse point, or non-directory.');
            const canonical = await safeRealpath(current, 'Codex runtime root ancestor could not be resolved safely.');
            if (!samePath(current, canonical)) {
                throw new RideCodexRuntimeStageError('Codex runtime root ancestor resolved outside its canonical path.');
            }
            await fs.chmod(current, 0o700);
        }
        const canonicalRoot = current;
        const rootStat = await safeLstat(canonicalRoot, 'Codex runtime root is missing.');
        requireRegularDirectory(rootStat, 'Codex runtime root is not a safe extension-owned directory.');
        return new RuntimeRootBoundary(canonicalRoot, filesystemIdentity(rootStat));
    }

    async verify(): Promise<void> {
        await verifyDirectoryIdentity(
            this.canonicalRoot,
            this.canonicalRoot,
            this.rootIdentity,
            'Codex runtime root was replaced or escaped its canonical boundary.'
        );
    }

    async captureStaging(stagingDirectory: string): Promise<RuntimeStagingBoundary> {
        await this.verify();
        const canonicalStaging = resolve(stagingDirectory);
        requireStrictChild(this.canonicalRoot, canonicalStaging);
        const stagingStat = await safeLstat(canonicalStaging, 'Codex runtime staging directory is missing.');
        requireRegularDirectory(stagingStat, 'Codex runtime staging directory is not safe.');
        const realStaging = await safeRealpath(canonicalStaging, 'Codex runtime staging directory could not be resolved safely.');
        if (!samePath(canonicalStaging, realStaging) || !isStrictChild(this.canonicalRoot, realStaging)) {
            throw new RideCodexRuntimeStageError('Codex runtime staging directory escaped its canonical root.');
        }
        return new RuntimeStagingBoundary(this, canonicalStaging, filesystemIdentity(stagingStat));
    }
}

class RuntimeStagingBoundary {
    constructor(
        private readonly root: RuntimeRootBoundary,
        readonly canonicalStaging: string,
        private readonly stagingIdentity: RuntimeFilesystemIdentity
    ) { }

    get identity(): RuntimeFilesystemIdentity {
        return this.stagingIdentity;
    }

    async verify(): Promise<void> {
        await this.root.verify();
        await verifyDirectoryIdentity(
            this.canonicalStaging,
            this.canonicalStaging,
            this.stagingIdentity,
            'Codex runtime staging directory was replaced or escaped its canonical boundary.'
        );
        requireStrictChild(this.root.canonicalRoot, this.canonicalStaging);
    }

    async cleanup(): Promise<void> {
        await this.root.verify();
        let quarantine: string | undefined;
        for (let attempt = 0; attempt < 16; attempt += 1) {
            const candidate = join(this.root.canonicalRoot, `.quarantine-${randomUUID()}`);
            requireStrictChild(this.root.canonicalRoot, candidate);
            try {
                await fs.rename(this.canonicalStaging, candidate);
                quarantine = candidate;
                break;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === 'ENOENT') {
                    return;
                }
                if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && attempt < 15) {
                    await new Promise<void>(resolveImmediate => setTimeout(resolveImmediate, 5));
                    continue;
                }
                if (code !== 'EEXIST') {
                    throw new RideCodexRuntimeStageError('Codex runtime staging cleanup could not be quarantined safely.');
                }
            }
        }
        if (!quarantine) {
            throw new RideCodexRuntimeStageError('Codex runtime staging cleanup quarantine names were exhausted.');
        }
        const movedStat = await safeLstat(quarantine, 'Codex runtime cleanup quarantine is missing.');
        const movedCanonical = await safeRealpath(quarantine, 'Codex runtime cleanup quarantine could not be resolved safely.');
        if (!movedStat.isDirectory() || movedStat.isSymbolicLink()
            || !samePath(movedCanonical, quarantine)
            || !runtimeDirectoryIdentitiesEqual(filesystemIdentity(movedStat), this.stagingIdentity)) {
            throw new RideCodexRuntimeStageError(
                'Codex runtime cleanup quarantined a replaced object and left it isolated for safe diagnosis.'
            );
        }
        await this.root.verify();
        await fs.rm(quarantine, { recursive: true, force: true });
        await this.root.verify();
    }
}

function requireRegularDirectory(stat: DirectoryStat, message: string): void {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new RideCodexRuntimeStageError(message);
    }
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

export function runtimeFilesystemIdentitiesEqual(
    left: RuntimeFilesystemIdentity,
    right: RuntimeFilesystemIdentity
): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.birthtimeNs === right.birthtimeNs
        && left.ctimeNs === right.ctimeNs;
}

function runtimeDirectoryIdentitiesEqual(
    left: RuntimeFilesystemIdentity,
    right: RuntimeFilesystemIdentity
): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.birthtimeNs === right.birthtimeNs;
}

async function safeRealpath(path: string, message: string): Promise<string> {
    try {
        return await fs.realpath(path);
    } catch {
        throw new RideCodexRuntimeStageError(message);
    }
}

async function verifyDirectoryIdentity(
    path: string,
    expectedCanonicalPath: string,
    expectedIdentity: RuntimeFilesystemIdentity,
    message: string
): Promise<void> {
    const stat = await safeLstat(path, message);
    requireRegularDirectory(stat, message);
    const canonical = await safeRealpath(path, message);
    const actualIdentity = filesystemIdentity(stat);
    if (!samePath(canonical, expectedCanonicalPath)
        || !runtimeDirectoryIdentitiesEqual(actualIdentity, expectedIdentity)) {
        throw new RideCodexRuntimeStageError(message);
    }
}

type RuntimeTreeEntryType = 'directory' | 'file';

interface RuntimeTreeAttestationEntry {
    readonly path: string;
    readonly type: RuntimeTreeEntryType;
    readonly identity: RuntimeFilesystemIdentity;
    readonly size: bigint;
    readonly digest: string;
}

interface RuntimeTreeAttestation {
    readonly entries: readonly RuntimeTreeAttestationEntry[];
    readonly totalReadBytes: bigint;
    readonly totalPathBytes: number;
}

function boundedTreeEntryLimit(maxArchiveEntries: number): number {
    return Math.min(MAX_RUNTIME_TREE_ENTRIES, Math.max(16, (maxArchiveEntries * 2) + 16));
}

async function attestRuntimeTree(
    root: string,
    maxEntries: number,
    maxPathBytes: number,
    maxReadBytes: number
): Promise<RuntimeTreeAttestation> {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0
        || !Number.isSafeInteger(maxPathBytes) || maxPathBytes <= 0
        || !Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0) {
        throw new RideCodexRuntimeStageError('Codex staged runtime tree attestation limits are invalid.');
    }
    const canonicalRoot = resolve(root);
    const entries: RuntimeTreeAttestationEntry[] = [];
    let totalReadBytes = BigInt(0);
    let totalPathBytes = 0;
    const maxReadBytesBigInt = BigInt(maxReadBytes);

    const addEntry = (entry: RuntimeTreeAttestationEntry): void => {
        const pathBytes = Buffer.byteLength(entry.path);
        if (pathBytes <= 0 || pathBytes > maxPathBytes) {
            throw new RideCodexRuntimeStageError('Codex staged runtime tree path exceeded its attestation limit.');
        }
        if (entries.length >= maxEntries) {
            throw new RideCodexRuntimeStageError('Codex staged runtime tree exceeded its attestation entry limit.');
        }
        if (totalPathBytes > MAX_RUNTIME_TREE_TOTAL_PATH_BYTES - pathBytes) {
            throw new RideCodexRuntimeStageError('Codex staged runtime tree exceeded its attestation path budget.');
        }
        totalPathBytes += pathBytes;
        entries.push(Object.freeze(entry));
    };

    const visit = async (absolutePath: string, relativePath: string): Promise<void> => {
        const stat = await safeLstat(absolutePath, 'Codex staged runtime tree entry is missing.');
        const canonical = await safeRealpath(absolutePath, 'Codex staged runtime tree entry could not be resolved safely.');
        if (!samePath(canonical, absolutePath)
            || (!samePath(absolutePath, canonicalRoot) && !isStrictChild(canonicalRoot, absolutePath))) {
            throw new RideCodexRuntimeStageError('Codex staged runtime tree entry escaped its canonical boundary.');
        }
        if (stat.isSymbolicLink()) {
            throw new RideCodexRuntimeStageError('Codex staged runtime tree contains a forbidden link.');
        }
        if (stat.isDirectory()) {
            if (entries.length >= maxEntries) {
                throw new RideCodexRuntimeStageError('Codex staged runtime tree exceeded its attestation entry limit.');
            }
            const children: Array<{ readonly name: string }> = [];
            const directory = await fs.opendir(absolutePath);
            try {
                while (true) {
                    const child = await directory.read();
                    if (!child) {
                        break;
                    }
                    if (children.length >= maxEntries - entries.length - 1) {
                        throw new RideCodexRuntimeStageError('Codex staged runtime tree exceeded its attestation entry limit.');
                    }
                    children.push(Object.freeze({ name: child.name }));
                }
            } finally {
                await directory.close().catch(() => undefined);
            }
            children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
            const namesDigest = createHash('sha256');
            for (const child of children) {
                if (!isPortablePathSegment(child.name)) {
                    throw new RideCodexRuntimeStageError('Codex staged runtime tree contains an unsafe path segment.');
                }
                namesDigest.update(child.name, 'utf8').update('\0');
            }
            addEntry(Object.freeze({
                path: relativePath,
                type: 'directory',
                identity: filesystemIdentity(stat),
                size: stat.size,
                digest: `sha256-${namesDigest.digest('hex')}`
            }));
            for (const child of children) {
                const childRelativePath = relativePath === '.' ? child.name : `${relativePath}/${child.name}`;
                await visit(join(absolutePath, child.name), childRelativePath);
            }
            const after = await safeLstat(absolutePath, 'Codex staged runtime tree directory changed during attestation.');
            if (!after.isDirectory() || after.isSymbolicLink()
                || !runtimeFilesystemIdentitiesEqual(filesystemIdentity(stat), filesystemIdentity(after))) {
                throw new RideCodexRuntimeStageError('Codex staged runtime tree directory changed during attestation.');
            }
            return;
        }
        if (!stat.isFile() || stat.nlink !== BigInt(1)) {
            throw new RideCodexRuntimeStageError('Codex staged runtime tree contains a non-regular or linked file.');
        }
        const remainingBytes = maxReadBytesBigInt - totalReadBytes;
        if (stat.size < BigInt(0) || stat.size > remainingBytes || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new RideCodexRuntimeStageError('Codex staged runtime tree exceeded its attestation byte limit.');
        }
        const handle = await fs.open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        try {
            const openedStat = await handle.stat({ bigint: true });
            if (!openedStat.isFile() || openedStat.nlink !== BigInt(1)
                || !runtimeFilesystemIdentitiesEqual(filesystemIdentity(stat), filesystemIdentity(openedStat))) {
                throw new RideCodexRuntimeStageError('Codex staged runtime tree file identity changed during attestation.');
            }
            const digest = createHash('sha256');
            const buffer = Buffer.allocUnsafe(RUNTIME_TREE_READ_BUFFER_BYTES);
            const expectedBytes = Number(openedStat.size);
            let position = 0;
            while (position < expectedBytes) {
                const length = Math.min(buffer.length, expectedBytes - position);
                const { bytesRead } = await handle.read(buffer, 0, length, position);
                if (bytesRead <= 0) {
                    throw new RideCodexRuntimeStageError('Codex staged runtime tree file was truncated during attestation.');
                }
                digest.update(buffer.subarray(0, bytesRead));
                position += bytesRead;
            }
            const extra = Buffer.allocUnsafe(1);
            if ((await handle.read(extra, 0, 1, position)).bytesRead !== 0) {
                throw new RideCodexRuntimeStageError('Codex staged runtime tree file grew during attestation.');
            }
            const afterOpened = await handle.stat({ bigint: true });
            const afterPath = await safeLstat(absolutePath, 'Codex staged runtime tree file changed during attestation.');
            if (!afterPath.isFile() || afterPath.isSymbolicLink() || afterPath.nlink !== BigInt(1)
                || !runtimeFilesystemIdentitiesEqual(filesystemIdentity(openedStat), filesystemIdentity(afterOpened))
                || !runtimeFilesystemIdentitiesEqual(filesystemIdentity(openedStat), filesystemIdentity(afterPath))) {
                throw new RideCodexRuntimeStageError('Codex staged runtime tree file changed during attestation.');
            }
            totalReadBytes += openedStat.size;
            addEntry(Object.freeze({
                path: relativePath,
                type: 'file',
                identity: filesystemIdentity(openedStat),
                size: openedStat.size,
                digest: `sha256-${digest.digest('hex')}`
            }));
        } finally {
            await handle.close().catch(() => undefined);
        }
    };

    await visit(canonicalRoot, '.');
    return Object.freeze({
        entries: Object.freeze(entries),
        totalReadBytes,
        totalPathBytes
    });
}

function runtimeTreeAttestationsEqual(left: RuntimeTreeAttestation, right: RuntimeTreeAttestation): boolean {
    if (left.totalReadBytes !== right.totalReadBytes
        || left.totalPathBytes !== right.totalPathBytes
        || left.entries.length !== right.entries.length) {
        return false;
    }
    return left.entries.every((entry, index) => {
        const candidate = right.entries[index];
        return candidate !== undefined
            && entry.path === candidate.path
            && entry.type === candidate.type
            && entry.size === candidate.size
            && entry.digest === candidate.digest
            && runtimeFilesystemIdentitiesEqual(entry.identity, candidate.identity);
    });
}

async function openNewOwnedFile(path: string, boundary: RuntimeStagingBoundary): Promise<FileHandle> {
    await boundary.verify();
    const flags = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(path, flags, 0o600);
    try {
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile()) {
            throw new RideCodexRuntimeStageError('Codex runtime archive destination is not a regular file.');
        }
        const canonical = await safeRealpath(path, 'Codex runtime archive destination could not be resolved safely.');
        if (!samePath(canonical, path) || !isStrictChild(boundary.canonicalStaging, canonical)) {
            throw new RideCodexRuntimeStageError('Codex runtime archive destination escaped its staging boundary.');
        }
        await boundary.verify();
        return handle;
    } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
    }
}

async function openVerifiedFile(
    path: string,
    boundary: RuntimeStagingBoundary,
    expectedIdentity: RuntimeFilesystemIdentity
): Promise<FileHandle> {
    await boundary.verify();
    const handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
        const openedStat = await handle.stat({ bigint: true });
        const pathStat = await safeLstat(path, 'Codex runtime archive is missing.');
        const canonical = await safeRealpath(path, 'Codex runtime archive could not be resolved safely.');
        if (!openedStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink()
            || !runtimeFilesystemIdentitiesEqual(filesystemIdentity(openedStat), expectedIdentity)
            || !runtimeFilesystemIdentitiesEqual(filesystemIdentity(pathStat), expectedIdentity)
            || !samePath(canonical, path)
            || !isStrictChild(boundary.canonicalStaging, canonical)) {
            throw new RideCodexRuntimeStageError('Codex runtime archive identity changed before extraction.');
        }
        await boundary.verify();
        return handle;
    } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
    }
}

function samePath(left: string, right: string): boolean {
    const resolvedLeft = resolve(left);
    const resolvedRight = resolve(right);
    return process.platform === 'win32'
        ? resolvedLeft.toLocaleLowerCase('en-US') === resolvedRight.toLocaleLowerCase('en-US')
        : resolvedLeft === resolvedRight;
}

export interface RideCodexRuntimeArchiveExtractorOptions {
    readonly maxEntries?: number;
}

interface RuntimeArchiveSource {
    readonly path: string;
    readonly handle: FileHandle;
}

export class RideCodexRuntimeArchiveExtractor {
    private readonly maxEntries: number;

    constructor(options: RideCodexRuntimeArchiveExtractorOptions = {}) {
        this.maxEntries = positiveSafeInteger(options.maxEntries, DEFAULT_MAX_ARCHIVE_ENTRIES);
    }

    async extract(
        archive: string | RuntimeArchiveSource,
        stagingDirectory: string,
        runtime: RideCodexRuntimeManifestEntry,
        verifyStaging: () => Promise<void> = async () => undefined
    ): Promise<void> {
        const stagingRoot = resolve(stagingDirectory);
        const seenEntries = new Set<string>();
        const canonicalNames = new Map<string, string>();
        let entryCount = 0;
        let unpackedBytes = 0;
        const tarExtractor = extract({ allowUnknownFormat: false });
        tarExtractor.on('entry', (header, entry, next) => {
            let firstEntryError: Error | undefined;
            const recordEntryError = (error: Error): void => {
                firstEntryError ??= error;
            };
            entry.on('error', recordEntryError);
            void this.processEntry(
                header,
                entry,
                stagingRoot,
                runtime,
                seenEntries,
                canonicalNames,
                () => {
                    entryCount += 1;
                    if (entryCount > this.maxEntries) {
                        throw new RideCodexRuntimeStageError('Codex runtime archive exceeded the entry limit.');
                    }
                },
                declaredSize => {
                    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0
                        || unpackedBytes + declaredSize > runtime.unpackedBytes) {
                        throw new RideCodexRuntimeStageError('Codex runtime archive exceeded the unpacked byte limit.');
                    }
                    unpackedBytes += declaredSize;
                },
                verifyStaging
            ).then(async () => {
                await new Promise<void>(resolveEntryTurn => {
                    setImmediate(() => setImmediate(resolveEntryTurn));
                });
                if (firstEntryError) {
                    throw new RideCodexRuntimeStageError('Codex runtime archive entry stream failed safely.');
                }
            }).finally(() => {
                entry.removeListener('error', recordEntryError);
            }).then(() => next(), error => next(error));
        });
        try {
            await pipeline(
                typeof archive === 'string'
                    ? (await import('node:fs')).createReadStream(archive)
                    : Readable.from(readFileHandleChunks(archive.handle)),
                createGunzip(),
                new TarHeaderGuard(this.maxEntries, maxRawTarBytes(runtime.unpackedBytes)),
                tarExtractor
            );
        } catch (error) {
            if (error instanceof RideCodexRuntimeStageError) {
                throw error;
            }
            throw new RideCodexRuntimeStageError('Codex runtime archive is invalid or could not be extracted safely.');
        }
        if (canonicalNames.get('package') !== 'package') {
            throw new RideCodexRuntimeStageError('Codex runtime archive has no package root.');
        }
    }

    validateEntryPath(name: string, target: RuntimeTarget): string {
        if (typeof name !== 'string' || !name || name.includes('\0') || name.includes('\\') || name.includes(':')
            || Buffer.byteLength(name) > MAX_ARCHIVE_PATH_BYTES
            || name.startsWith('/') || name.startsWith('//') || /^[A-Za-z]:/.test(name)) {
            throw new RideCodexRuntimeStageError('Codex runtime archive entry path is unsafe.');
        }
        const segments = name.split('/');
        if (segments[segments.length - 1] === '') {
            segments.pop();
        }
        if (segments.length === 0 || segments.some(segment => !segment || segment === '.' || segment === '..')) {
            throw new RideCodexRuntimeStageError('Codex runtime archive entry path contains traversal.');
        }
        if (segments.some(segment => !isPortablePathSegment(segment))) {
            throw new RideCodexRuntimeStageError('Codex runtime archive entry path contains an unsafe Windows or Unicode alias.');
        }
        if (segments[0] !== 'package') {
            throw new RideCodexRuntimeStageError('Codex runtime archive contains an additional package root.');
        }
        if (segments[1] === 'vendor' && segments.length >= 3 && segments[2] !== target) {
            throw new RideCodexRuntimeStageError('Codex runtime archive contains an unexpected native target.');
        }
        return segments.join('/');
    }

    private async processEntry(
        header: Headers,
        entry: PassThrough,
        stagingRoot: string,
        runtime: RideCodexRuntimeManifestEntry,
        seenEntries: Set<string>,
        canonicalNames: Map<string, string>,
        countEntry: () => void,
        countDeclaredBytes: (size: number) => void,
        verifyStaging: () => Promise<void>
    ): Promise<void> {
        countEntry();
        const normalized = this.validateEntryPath(header.name, runtime.target);
        registerArchiveName(normalized, seenEntries, canonicalNames);
        const type = header.type;
        if (type !== 'file' && type !== 'directory') {
            entry.resume();
            throw new RideCodexRuntimeStageError('Codex runtime archive contains a forbidden entry type or link.');
        }
        const declaredSize = header.size ?? 0;
        countDeclaredBytes(declaredSize);
        const output = resolve(stagingRoot, ...normalized.split('/'));
        requireStrictChild(stagingRoot, output);
        if (type === 'directory') {
            if (declaredSize !== 0) {
                entry.resume();
                throw new RideCodexRuntimeStageError('Codex runtime archive directory has unexpected content.');
            }
            await ensureSafeDirectory(stagingRoot, normalized.split('/'), verifyStaging);
            await consumeEntry(entry, 0);
            await verifyStaging();
            return;
        }
        await ensureSafeDirectory(stagingRoot, normalized.split('/').slice(0, -1), verifyStaging);
        await verifyStaging();
        const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
            | (fsConstants.O_NOFOLLOW ?? 0);
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
        try {
            handle = await fs.open(output, flags, 0o600);
            const openedStat = await handle.stat({ bigint: true });
            if (!openedStat.isFile()) {
                throw new RideCodexRuntimeStageError('Codex runtime archive output is not a regular file.');
            }
            const outputCanonical = await safeRealpath(
                output,
                'Codex runtime archive output could not be resolved safely.'
            );
            const outputPathStat = await safeLstat(output, 'Codex runtime archive output is missing.');
            if (!samePath(outputCanonical, output)
                || !isStrictChild(stagingRoot, outputCanonical)
                || !outputPathStat.isFile()
                || outputPathStat.isSymbolicLink()
                || !runtimeFilesystemIdentitiesEqual(
                    filesystemIdentity(openedStat),
                    filesystemIdentity(outputPathStat)
                )) {
                throw new RideCodexRuntimeStageError('Codex runtime archive output escaped its staging boundary.');
            }
            await verifyStaging();
            let actualBytes = 0;
            let position = 0;
            for await (const chunk of entry) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                actualBytes += buffer.length;
                if (actualBytes > declaredSize || actualBytes > runtime.unpackedBytes) {
                    throw new RideCodexRuntimeStageError('Codex runtime archive entry exceeded its declared size.');
                }
                let offset = 0;
                while (offset < buffer.length) {
                    const { bytesWritten } = await handle.write(
                        buffer,
                        offset,
                        buffer.length - offset,
                        position + offset
                    );
                    if (bytesWritten <= 0) {
                        throw new RideCodexRuntimeStageError('Codex runtime archive output could not be written safely.');
                    }
                    offset += bytesWritten;
                }
                position += buffer.length;
            }
            if (actualBytes !== declaredSize) {
                throw new RideCodexRuntimeStageError('Codex runtime archive entry size did not match its declaration.');
            }
            await handle.chmod(0o600);
            await handle.sync();
            await verifyStaging();
        } finally {
            await handle?.close().catch(() => undefined);
        }
    }
}

class TarHeaderGuard extends Transform {
    private pending = Buffer.alloc(0);
    private contentBlocksRemaining = 0;
    private rawBytes = 0;
    private entryCount = 0;
    private zeroBlocks = 0;

    constructor(
        private readonly maxEntries: number,
        private readonly maxRawBytes: number
    ) {
        super();
    }

    override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        const buffer = Buffer.from(chunk);
        try {
            if (buffer.length > this.maxRawBytes - this.rawBytes) {
                throw new RideCodexRuntimeStageError('Codex runtime archive exceeded the raw tar byte limit.');
            }
            this.rawBytes += buffer.length;
            this.pending = this.pending.length ? Buffer.concat([this.pending, buffer]) : buffer;
            while (this.pending.length >= TAR_BLOCK_BYTES) {
                const block = this.pending.subarray(0, TAR_BLOCK_BYTES);
                this.pending = this.pending.subarray(TAR_BLOCK_BYTES);
                if (this.contentBlocksRemaining > 0) {
                    this.contentBlocksRemaining -= 1;
                } else {
                    this.validateHeaderBlock(block);
                }
                this.push(block);
            }
            callback();
        } catch (error) {
            callback(error as Error);
        }
    }

    override _flush(callback: (error?: Error | null) => void): void {
        if (this.pending.length !== 0 || this.contentBlocksRemaining !== 0) {
            callback(new RideCodexRuntimeStageError('Codex runtime archive ended on an incomplete tar block.'));
            return;
        }
        if (this.zeroBlocks < 2) {
            callback(new RideCodexRuntimeStageError('Codex runtime archive is missing its two-block end marker.'));
            return;
        }
        callback();
    }

    private validateHeaderBlock(block: Buffer): void {
        if (block.every(byte => byte === 0)) {
            this.zeroBlocks += 1;
            return;
        }
        if (this.zeroBlocks > 0) {
            throw new RideCodexRuntimeStageError('Codex runtime archive contains data after its end marker.');
        }
        this.entryCount += 1;
        if (this.entryCount > this.maxEntries) {
            throw new RideCodexRuntimeStageError('Codex runtime archive exceeded the raw entry limit.');
        }
        validateTarTextField(block.subarray(0, 100));
        validateTarTextField(block.subarray(345, 500));
        const typeFlag = block[156];
        if (typeFlag !== 0 && typeFlag !== 0x30 && typeFlag !== 0x35) {
            throw new RideCodexRuntimeStageError('Codex runtime archive contains a forbidden raw tar entry type.');
        }
        const size = parseCanonicalTarSize(block.subarray(124, 136));
        if (size > this.maxRawBytes) {
            throw new RideCodexRuntimeStageError('Codex runtime archive has an unsafe size header.');
        }
        if (typeFlag === 0x35 && size !== 0) {
            throw new RideCodexRuntimeStageError('Codex runtime archive directory has unexpected raw content.');
        }
        this.contentBlocksRemaining = Math.ceil(size / TAR_BLOCK_BYTES);
    }
}

function maxRawTarBytes(unpackedBytes: number): number {
    if (!Number.isSafeInteger(unpackedBytes) || unpackedBytes < 0
        || unpackedBytes > Number.MAX_SAFE_INTEGER - MAX_TAR_OVERHEAD_BYTES) {
        throw new RideCodexRuntimeStageError('Codex runtime manifest unpacked size exceeds the raw tar range.');
    }
    return unpackedBytes + MAX_TAR_OVERHEAD_BYTES;
}

function parseCanonicalTarSize(field: Buffer): number {
    if (field.length !== 12 || (field[0] & 0x80) !== 0) {
        throw new RideCodexRuntimeStageError('Codex runtime archive has an unsupported size header.');
    }
    let value = BigInt(0);
    let digits = 0;
    let padding = false;
    for (const byte of field) {
        if (byte === 0 || byte === 0x20) {
            padding = true;
            continue;
        }
        if (padding || byte < 0x30 || byte > 0x37) {
            throw new RideCodexRuntimeStageError('Codex runtime archive has a malformed octal size header.');
        }
        value = (value * BigInt(8)) + BigInt(byte - 0x30);
        digits += 1;
    }
    if (digits === 0 || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RideCodexRuntimeStageError('Codex runtime archive has an unsafe size header.');
    }
    return Number(value);
}

function validateTarTextField(field: Buffer): void {
    const terminator = field.indexOf(0);
    if (terminator >= 0 && field.subarray(terminator + 1).some(byte => byte !== 0)) {
        throw new RideCodexRuntimeStageError('Codex runtime archive header contains non-canonical NUL path data.');
    }
}

async function* readFileHandleChunks(handle: FileHandle): AsyncGenerator<Buffer> {
    let position = 0;
    while (true) {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) {
            return;
        }
        position += bytesRead;
        yield buffer.subarray(0, bytesRead);
    }
}

export function requiredRuntimeStageBytes(runtime: RideCodexRuntimeManifestEntry): number {
    const required = runtime.compressedBytes + runtime.unpackedBytes + RIDE_CODEX_RUNTIME_STAGE_SAFETY_MARGIN_BYTES;
    if (!Number.isSafeInteger(required)) {
        throw new RideCodexRuntimeStageError('Codex runtime manifest sizes exceed the supported staging range.');
    }
    return required;
}

interface CodexPackageManifest {
    readonly layoutVersion: unknown;
    readonly version: unknown;
    readonly target: unknown;
    readonly variant: unknown;
    readonly entrypoint: unknown;
    readonly resourcesDir: unknown;
    readonly pathDir: unknown;
}

const PACKAGE_MANIFEST_KEYS = Object.freeze([
    'entrypoint', 'layoutVersion', 'pathDir', 'resourcesDir', 'target', 'variant', 'version'
]);

async function readPackageManifest(path: string): Promise<CodexPackageManifest> {
    let bytes: Buffer;
    try {
        bytes = await readPrefix(path, MAX_PACKAGE_MANIFEST_BYTES + 1);
    } catch {
        throw new RideCodexRuntimeStageError('Codex package manifest is missing or unreadable.');
    }
    if (bytes.length > MAX_PACKAGE_MANIFEST_BYTES) {
        throw new RideCodexRuntimeStageError('Codex package manifest exceeded the size limit.');
    }
    let value: unknown;
    try {
        value = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
        throw new RideCodexRuntimeStageError('Codex package manifest is invalid JSON.');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)
        || !sameKeys(Object.keys(value).sort(), PACKAGE_MANIFEST_KEYS)) {
        throw new RideCodexRuntimeStageError('Codex package manifest has an invalid shape.');
    }
    return value as CodexPackageManifest;
}

function validatePackageManifest(
    manifest: CodexPackageManifest,
    runtime: RideCodexRuntimeManifestEntry
): asserts manifest is CodexPackageManifest & {
    readonly resourcesDir: string;
    readonly pathDir: string;
} {
    if (manifest.layoutVersion !== 1) {
        throw new RideCodexRuntimeStageError('Codex package manifest layout version is unsupported.');
    }
    if (manifest.version !== runtime.version) {
        throw new RideCodexRuntimeStageError('Codex package manifest version is invalid.');
    }
    if (manifest.target !== runtime.target) {
        throw new RideCodexRuntimeStageError('Codex package manifest target is invalid.');
    }
    if (manifest.variant !== 'codex') {
        throw new RideCodexRuntimeStageError('Codex package manifest variant is invalid.');
    }
    if (manifest.entrypoint !== runtime.entrypoint || !isSafeManifestRelativePath(manifest.entrypoint)) {
        throw new RideCodexRuntimeStageError('Codex package manifest entrypoint is invalid or escapes the package.');
    }
    if (!isSafeManifestRelativePath(manifest.resourcesDir)
        || !isSafeManifestRelativePath(manifest.pathDir)
        || manifest.resourcesDir === manifest.pathDir) {
        throw new RideCodexRuntimeStageError('Codex package manifest resource or path directory is invalid.');
    }
}

function isSafeManifestRelativePath(value: unknown): value is string {
    if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || value.includes(':')
        || Buffer.byteLength(value) > 256 || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
        return false;
    }
    const segments = value.split('/');
    return segments.every(segment => segment && segment !== '.' && segment !== '..' && isPortablePathSegment(segment));
}

function isPortablePathSegment(segment: string): boolean {
    if (segment.normalize('NFC') !== segment || /[\u0000-\u001f\u007f]/u.test(segment)
        || segment.endsWith('.') || segment.endsWith(' ')) {
        return false;
    }
    const basename = segment.split('.', 1)[0];
    return !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(basename);
}

function unicodeCaseFold(value: string): string {
    return value
        .normalize('NFC')
        .toLocaleUpperCase('en-US')
        .toLocaleLowerCase('en-US')
        .normalize('NFC');
}

async function readPrefix(path: string, maxBytes: number): Promise<Buffer> {
    const handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

async function safeLstat(path: string, message: string): Promise<BigIntStats> {
    try {
        return await fs.lstat(path, { bigint: true });
    } catch {
        throw new RideCodexRuntimeStageError(message);
    }
}

async function requireSafeDirectory(path: string, parent: string): Promise<void> {
    requireStrictChild(parent, path);
    const stat = await safeLstat(path, 'Codex package directory is missing.');
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new RideCodexRuntimeStageError('Codex package directory is not a safe regular directory.');
    }
}

function registerArchiveName(
    normalized: string,
    seenEntries: Set<string>,
    canonicalNames: Map<string, string>
): void {
    if (seenEntries.has(normalized)) {
        throw new RideCodexRuntimeStageError('Codex runtime archive contains a duplicate entry.');
    }
    seenEntries.add(normalized);
    const segments = normalized.split('/');
    for (let index = 1; index <= segments.length; index += 1) {
        const prefix = segments.slice(0, index).join('/');
        const folded = unicodeCaseFold(prefix);
        const existing = canonicalNames.get(folded);
        if (existing && existing !== prefix) {
            throw new RideCodexRuntimeStageError('Codex runtime archive contains a case-colliding entry.');
        }
        canonicalNames.set(folded, prefix);
    }
}

async function ensureSafeDirectory(
    root: string,
    segments: readonly string[],
    verifyStaging: () => Promise<void> = async () => undefined
): Promise<void> {
    let current = root;
    for (const segment of segments) {
        await verifyStaging();
        current = resolve(current, segment);
        requireStrictChild(root, current);
        try {
            await fs.mkdir(current, { mode: 0o700 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
        }
        const stat = await fs.lstat(current, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new RideCodexRuntimeStageError('Codex runtime archive directory encountered a symlink or non-directory.');
        }
        await fs.chmod(current, 0o700);
        const canonical = await safeRealpath(current, 'Codex runtime archive directory could not be resolved safely.');
        if (!samePath(canonical, current) || !isStrictChild(root, canonical)) {
            throw new RideCodexRuntimeStageError('Codex runtime archive directory escaped its staging boundary.');
        }
        await verifyStaging();
    }
}

async function consumeEntry(entry: PassThrough, expectedBytes: number): Promise<void> {
    let bytes = 0;
    for await (const chunk of entry) {
        bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        if (bytes > expectedBytes) {
            throw new RideCodexRuntimeStageError('Codex runtime archive entry exceeded its declared size.');
        }
    }
    if (bytes !== expectedBytes) {
        throw new RideCodexRuntimeStageError('Codex runtime archive entry size did not match its declaration.');
    }
}

function platformForTarget(target: RuntimeTarget): NodeJS.Platform {
    if (target.endsWith('-pc-windows-msvc')) {
        return 'win32';
    }
    if (target.endsWith('-apple-darwin')) {
        return 'darwin';
    }
    return 'linux';
}

function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
    return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function positiveSafeInteger(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function availableBytes(stat: RideCodexStatFs): bigint {
    const blockSize = toNonNegativeBigInt(stat.bsize);
    const availableBlocks = toNonNegativeBigInt(stat.bavail);
    return blockSize * availableBlocks;
}

function toNonNegativeBigInt(value: number | bigint): bigint {
    if (typeof value === 'bigint') {
        if (value < BigInt(0)) {
            throw new RideCodexRuntimeStageError('Codex runtime disk capacity could not be determined safely.');
        }
        return value;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RideCodexRuntimeStageError('Codex runtime disk capacity could not be determined safely.');
    }
    return BigInt(value);
}

function requireStrictChild(parent: string, child: string): void {
    if (!isStrictChild(parent, child)) {
        throw new RideCodexRuntimeStageError('Codex runtime staging path escaped the extension-owned root.');
    }
}

function requireSameOrChild(parent: string, child: string): void {
    if (!samePath(parent, child) && !isStrictChild(parent, child)) {
        throw new RideCodexRuntimeStageError('Codex runtime root escaped its trusted extension-owned base.');
    }
}

function isStrictChild(parent: string, child: string): boolean {
    const childRelative = relative(parent, child);
    return childRelative !== '' && !childRelative.startsWith('..') && !isAbsolute(childRelative);
}
