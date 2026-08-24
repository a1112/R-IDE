/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { constants as fsConstants, createReadStream, promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract, Headers } from 'tar-stream';
import {
    InstallAuthorization,
    InstallAuthorizationValidator,
    RideCodexRuntimeFetcher,
    RideCodexRuntimeFetcherLike,
    validateInstallAuthorization
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
}

export interface RideCodexRuntimeStagerOptions {
    readonly runtimeRoot: string;
    readonly authorizationValidator: InstallAuthorizationValidator;
    readonly statfs?: (path: string) => Promise<RideCodexStatFs>;
    readonly fetcher?: RideCodexRuntimeFetcherLike;
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
    private readonly runtimeRoot: string;
    private readonly authorizationValidator: InstallAuthorizationValidator;
    private readonly statfs: (path: string) => Promise<RideCodexStatFs>;
    private readonly fetcher: RideCodexRuntimeFetcherLike;
    private readonly probe: RideCodexRuntimeProbeLike;
    private readonly extractor: RideCodexRuntimeArchiveExtractor;
    private readonly signal?: AbortSignal;

    constructor(options: RideCodexRuntimeStagerOptions) {
        if (!isAbsolute(options.runtimeRoot)) {
            throw new RideCodexRuntimeStageError('Codex runtime root must be an absolute extension-owned path.');
        }
        this.runtimeRoot = resolve(options.runtimeRoot);
        this.authorizationValidator = options.authorizationValidator;
        this.statfs = options.statfs ?? (async path => fs.statfs(path));
        this.fetcher = options.fetcher ?? new RideCodexRuntimeFetcher({
            authorizationValidator: options.authorizationValidator
        });
        this.probe = options.probe ?? new RideCodexRuntimeProbe();
        this.extractor = new RideCodexRuntimeArchiveExtractor({ maxEntries: options.maxArchiveEntries });
        this.signal = options.signal;
    }

    async stage(authorization: InstallAuthorization, target: RuntimeTarget): Promise<StagedRuntime> {
        await validateInstallAuthorization(authorization, this.authorizationValidator);
        const runtime = runtimeManifestEntryForTarget(target);
        let stagingDirectory: string | undefined;
        try {
            await fs.mkdir(this.runtimeRoot, { recursive: true, mode: 0o700 });
            const rootStat = await fs.lstat(this.runtimeRoot);
            if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
                throw new RideCodexRuntimeStageError('Codex runtime root is not a safe extension-owned directory.');
            }
            const capacity = await this.statfs(this.runtimeRoot);
            if (availableBytes(capacity) < BigInt(requiredRuntimeStageBytes(runtime))) {
                throw new RideCodexRuntimeStageError('Insufficient disk space to stage the managed Codex runtime.');
            }
            stagingDirectory = await fs.mkdtemp(join(this.runtimeRoot, '.staging-'));
            requireStrictChild(this.runtimeRoot, stagingDirectory);
            const archive = join(stagingDirectory, 'runtime.tgz');
            requireStrictChild(stagingDirectory, archive);
            await this.fetcher.fetch(authorization, runtime, archive, this.signal);
            await this.extractor.extract(archive, stagingDirectory, runtime);
            const staged = await this.verifyStagedRuntime(stagingDirectory, runtime);
            await fs.rm(archive, { force: true });
            return staged;
        } catch (error) {
            if (stagingDirectory && isStrictChild(this.runtimeRoot, stagingDirectory)) {
                await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
            }
            if (error instanceof RideCodexRuntimeStageError) {
                throw error;
            }
            throw new RideCodexRuntimeStageError('Codex managed runtime staging failed safely.');
        }
    }

    private async verifyStagedRuntime(
        stagingDirectory: string,
        runtime: RideCodexRuntimeManifestEntry
    ): Promise<StagedRuntime> {
        const packageRoot = join(stagingDirectory, 'package');
        const vendorRoot = join(packageRoot, 'vendor', runtime.target);
        const manifestPath = join(vendorRoot, 'codex-package.json');
        const manifest = await readPackageManifest(manifestPath);
        validatePackageManifest(manifest, runtime);
        const resourcesDirectory = join(vendorRoot, manifest.resourcesDir);
        const pathDirectory = join(vendorRoot, manifest.pathDir);
        await requireSafeDirectory(resourcesDirectory, vendorRoot);
        await requireSafeDirectory(pathDirectory, vendorRoot);

        const executable = resolve(vendorRoot, runtime.entrypoint);
        requireStrictChild(vendorRoot, executable);
        const executableStat = await safeLstat(executable, 'Codex native executable is missing.');
        if (!executableStat.isFile() || executableStat.isSymbolicLink()) {
            throw new RideCodexRuntimeStageError('Codex native executable must be a regular file.');
        }
        const header = await readPrefix(executable, MAX_NATIVE_HEADER_BYTES);
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
            entrypoint: runtime.entrypoint
        });
    }
}

export interface RideCodexRuntimeArchiveExtractorOptions {
    readonly maxEntries?: number;
}

export class RideCodexRuntimeArchiveExtractor {
    private readonly maxEntries: number;

    constructor(options: RideCodexRuntimeArchiveExtractorOptions = {}) {
        this.maxEntries = positiveSafeInteger(options.maxEntries, DEFAULT_MAX_ARCHIVE_ENTRIES);
    }

    async extract(
        archive: string,
        stagingDirectory: string,
        runtime: RideCodexRuntimeManifestEntry
    ): Promise<void> {
        const stagingRoot = resolve(stagingDirectory);
        const seenEntries = new Set<string>();
        const canonicalNames = new Map<string, string>();
        let entryCount = 0;
        let unpackedBytes = 0;
        const tarExtractor = extract({ allowUnknownFormat: false });
        tarExtractor.on('entry', (header, entry, next) => {
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
                }
            ).then(() => next(), error => next(error));
        });
        try {
            await pipeline(createReadStream(archive), createGunzip(), new TarHeaderGuard(), tarExtractor);
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
        countDeclaredBytes: (size: number) => void
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
            await ensureSafeDirectory(stagingRoot, normalized.split('/'));
            await consumeEntry(entry, 0);
            return;
        }
        await ensureSafeDirectory(stagingRoot, normalized.split('/').slice(0, -1));
        const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
            | (fsConstants.O_NOFOLLOW ?? 0);
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
        try {
            handle = await fs.open(output, flags, 0o600);
            const openedStat = await handle.stat();
            if (!openedStat.isFile()) {
                throw new RideCodexRuntimeStageError('Codex runtime archive output is not a regular file.');
            }
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
        } finally {
            await handle?.close().catch(() => undefined);
        }
    }
}

class TarHeaderGuard extends Transform {
    private pending = Buffer.alloc(0);
    private contentBlocksRemaining = 0;

    override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        const buffer = Buffer.from(chunk);
        this.pending = this.pending.length ? Buffer.concat([this.pending, buffer]) : buffer;
        try {
            while (this.pending.length >= 512) {
                const block = this.pending.subarray(0, 512);
                this.pending = this.pending.subarray(512);
                if (this.contentBlocksRemaining > 0) {
                    this.contentBlocksRemaining -= 1;
                } else if (!block.every(byte => byte === 0)) {
                    validateTarTextField(block.subarray(0, 100));
                    validateTarTextField(block.subarray(345, 500));
                    const sizeText = block.subarray(124, 136).toString('ascii').replace(/[\0 ]+$/g, '');
                    if (!/^[0-7]+$/.test(sizeText)) {
                        throw new RideCodexRuntimeStageError('Codex runtime archive has an invalid size header.');
                    }
                    const size = Number.parseInt(sizeText, 8);
                    if (!Number.isSafeInteger(size) || size < 0) {
                        throw new RideCodexRuntimeStageError('Codex runtime archive has an unsafe size header.');
                    }
                    this.contentBlocksRemaining = Math.ceil(size / 512);
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
        callback();
    }
}

function validateTarTextField(field: Buffer): void {
    const terminator = field.indexOf(0);
    if (terminator >= 0 && field.subarray(terminator + 1).some(byte => byte !== 0)) {
        throw new RideCodexRuntimeStageError('Codex runtime archive header contains non-canonical NUL path data.');
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
    return segments.every(segment => segment && segment !== '.' && segment !== '..');
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

async function safeLstat(path: string, message: string): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
    try {
        return await fs.lstat(path);
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
        const folded = prefix.toLocaleLowerCase('en-US');
        const existing = canonicalNames.get(folded);
        if (existing && existing !== prefix) {
            throw new RideCodexRuntimeStageError('Codex runtime archive contains a case-colliding entry.');
        }
        canonicalNames.set(folded, prefix);
    }
}

async function ensureSafeDirectory(root: string, segments: readonly string[]): Promise<void> {
    let current = root;
    for (const segment of segments) {
        current = resolve(current, segment);
        requireStrictChild(root, current);
        try {
            await fs.mkdir(current, { mode: 0o700 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
        }
        const stat = await fs.lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new RideCodexRuntimeStageError('Codex runtime archive directory encountered a symlink or non-directory.');
        }
        await fs.chmod(current, 0o700);
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

function isStrictChild(parent: string, child: string): boolean {
    const childRelative = relative(parent, child);
    return childRelative !== '' && !childRelative.startsWith('..') && !isAbsolute(childRelative);
}
