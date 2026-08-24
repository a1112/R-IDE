/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { constants as fsConstants, promises as fs } from 'node:fs';
import { posix, win32 } from 'node:path';
import compatibility from '../common/codex-app-server-compatibility.json';
import {
    createRideCodexLaunchSpec,
    RideCodexLaunchSpec,
    RideCodexRuntimeSource
} from './ride-codex-launch-spec';
import { RideCodexRuntimeProbe, RideCodexRuntimeProbeLike } from './ride-codex-runtime-probe';

export interface RideCodexRuntimeFileStat {
    readonly size: number;
    isFile(): boolean;
    isSymbolicLink(): boolean;
}

export interface RideCodexRuntimeFileSystem {
    lstat(path: string): Promise<RideCodexRuntimeFileStat>;
    readTextFile(path: string): Promise<string>;
    readFilePrefix(path: string, maxBytes: number): Promise<Uint8Array>;
    realpath(path: string): Promise<string>;
    isExecutable(path: string): Promise<boolean>;
}

type MaybePromise<T> = T | Promise<T>;

export interface RideCodexRuntimeResolverOptions {
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
    readonly filesystem?: RideCodexRuntimeFileSystem;
    readonly probe?: RideCodexRuntimeProbeLike;
    readonly readEnvironment?: () => Readonly<Record<string, string | undefined>>;
    readonly readUserOverride?: () => MaybePromise<string | undefined>;
    readonly findSystemCandidates?: (
        environment: Readonly<Record<string, string | undefined>>
    ) => MaybePromise<readonly string[]>;
    readonly readManagedActiveRuntime?: () => MaybePromise<string | undefined>;
}

export const RIDE_CODEX_RUNTIME_DISCOVERY_LIMITS = Object.freeze({
    maxPathBytes: 64 * 1024,
    maxDirectories: 512,
    maxCandidates: 512
});

export interface RideCodexSystemCandidateDiscovery {
    readonly candidates: readonly string[];
    readonly diagnostics: readonly string[];
    readonly scannedPathBytes: number;
    readonly scannedDirectories: number;
    readonly truncated: boolean;
}

export class RideCodexRuntimeConfigurationError extends Error {
    readonly diagnostics: readonly string[];

    constructor(reason: string) {
        const safeReason = sanitizeReason(reason);
        super(`Configured Codex runtime is invalid: ${safeReason} Fix RIDE_CODEX_PATH or the Codex runtime setting.`);
        this.name = 'RideCodexRuntimeConfigurationError';
        this.diagnostics = Object.freeze([safeReason]);
    }
}

export class RideCodexRuntimeUnavailableError extends Error {
    readonly diagnostics: readonly string[];

    constructor(diagnostics: readonly string[]) {
        super('No compatible native Codex runtime is available. Install Codex CLI 0.144.0 or configure RIDE_CODEX_PATH.');
        this.name = 'RideCodexRuntimeUnavailableError';
        this.diagnostics = freezeDiagnostics(diagnostics);
    }
}

class CandidateError extends Error {
    constructor(readonly safeReason: string) {
        super(safeReason);
        this.name = 'CandidateError';
    }
}

interface CodexPackageManifest {
    readonly layoutVersion: unknown;
    readonly version: unknown;
    readonly target: unknown;
    readonly variant: unknown;
    readonly entrypoint: unknown;
}

interface CandidateResolution {
    readonly executable: string;
    readonly manifestVersion?: string;
}

const MAX_DIAGNOSTICS = 8;
const MAX_DIAGNOSTIC_LENGTH = 160;
const MAX_SYSTEM_CANDIDATES = RIDE_CODEX_RUNTIME_DISCOVERY_LIMITS.maxCandidates;
const MAX_WRAPPER_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const SYSTEM_DISCOVERY_LIMIT_DIAGNOSTIC = 'System runtime discovery: PATH scan was truncated at safe limits.';

const PLATFORM_PACKAGE_BY_TARGET: Readonly<Record<string, string>> = Object.freeze({
    'x86_64-unknown-linux-musl': 'codex-linux-x64',
    'aarch64-unknown-linux-musl': 'codex-linux-arm64',
    'x86_64-apple-darwin': 'codex-darwin-x64',
    'aarch64-apple-darwin': 'codex-darwin-arm64',
    'x86_64-pc-windows-msvc': 'codex-win32-x64',
    'aarch64-pc-windows-msvc': 'codex-win32-arm64'
});

const defaultFileSystem: RideCodexRuntimeFileSystem = {
    lstat: path => fs.lstat(path),
    readTextFile: path => fs.readFile(path, 'utf8'),
    readFilePrefix: async (path, maxBytes) => {
        const handle = await fs.open(path, 'r');
        try {
            const buffer = Buffer.allocUnsafe(maxBytes);
            const result = await handle.read(buffer, 0, maxBytes, 0);
            return buffer.subarray(0, result.bytesRead);
        } finally {
            await handle.close();
        }
    },
    realpath: path => fs.realpath(path),
    isExecutable: async path => {
        try {
            await fs.access(path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
            return true;
        } catch {
            return false;
        }
    }
};

export class RideCodexRuntimeResolver {
    private readonly platform: NodeJS.Platform;
    private readonly arch: string;
    private readonly filesystem: RideCodexRuntimeFileSystem;
    private readonly probe: RideCodexRuntimeProbeLike;
    private readonly readEnvironment: () => Readonly<Record<string, string | undefined>>;
    private readonly readUserOverride: () => MaybePromise<string | undefined>;
    private readonly discoverSystemCandidates: (
        environment: Readonly<Record<string, string | undefined>>
    ) => MaybePromise<RideCodexSystemCandidateDiscovery>;
    private readonly readManagedActiveRuntime: () => MaybePromise<string | undefined>;
    private resolution: Promise<RideCodexLaunchSpec> | undefined;

    constructor(options: RideCodexRuntimeResolverOptions = {}) {
        this.platform = options.platform ?? process.platform;
        this.arch = options.arch ?? process.arch;
        this.filesystem = options.filesystem ?? defaultFileSystem;
        this.probe = options.probe ?? new RideCodexRuntimeProbe();
        this.readEnvironment = options.readEnvironment ?? (() => process.env);
        this.readUserOverride = options.readUserOverride ?? (() => undefined);
        this.discoverSystemCandidates = options.findSystemCandidates
            ? async environment => boundProvidedSystemCandidates(await options.findSystemCandidates!(environment))
            : environment => discoverDefaultCodexSystemCandidates(environment, this.platform);
        this.readManagedActiveRuntime = options.readManagedActiveRuntime ?? (() => undefined);
    }

    resolve(): Promise<RideCodexLaunchSpec> {
        if (!this.resolution) {
            this.resolution = this.resolveOnce();
        }
        return this.resolution;
    }

    private async resolveOnce(): Promise<RideCodexLaunchSpec> {
        const target = targetForPlatform(this.platform, this.arch);
        const environment = this.readEnvironment();
        const environmentOverride = readEnvironmentValue(environment, 'RIDE_CODEX_PATH');
        if (environmentOverride !== undefined) {
            return this.resolveExplicit(environmentOverride, target);
        }

        const userOverride = await this.readUserOverride();
        if (userOverride !== undefined) {
            return this.resolveExplicit(userOverride, target);
        }

        const discovery = await this.discoverSystemCandidates(environment);
        const diagnostics: string[] = [];
        for (const diagnostic of discovery.diagnostics) {
            addDiagnostic(diagnostics, diagnostic);
        }
        const systemCandidates = discovery.candidates;
        for (let index = 0; index < systemCandidates.length; index += 1) {
            const candidate = normalizeOptionalCandidate(systemCandidates[index]);
            if (!candidate) {
                continue;
            }
            try {
                return await this.resolveCandidate(candidate, 'system', target, diagnostics);
            } catch (error) {
                addDiagnostic(diagnostics, `System candidate ${index + 1}: ${reasonFromError(error)}`);
            }
        }

        const managed = normalizeOptionalCandidate(await this.readManagedActiveRuntime());
        if (managed) {
            try {
                return await this.resolveCandidate(managed, 'managed', target, diagnostics);
            } catch (error) {
                addDiagnostic(diagnostics, `Managed runtime: ${reasonFromError(error)}`);
            }
        } else {
            addDiagnostic(diagnostics, 'Managed runtime: no active runtime is configured.');
        }
        if (systemCandidates.length === 0) {
            addDiagnostic(diagnostics, 'System runtime: Codex was not found on PATH.');
        }
        throw new RideCodexRuntimeUnavailableError(diagnostics);
    }

    private async resolveExplicit(candidate: string, target: string): Promise<RideCodexLaunchSpec> {
        const normalized = candidate.trim();
        if (!normalized) {
            throw new RideCodexRuntimeConfigurationError('Codex path is empty.');
        }
        try {
            return await this.resolveCandidate(normalized, 'override', target, []);
        } catch (error) {
            throw new RideCodexRuntimeConfigurationError(reasonFromError(error));
        }
    }

    private async resolveCandidate(
        candidate: string,
        source: RideCodexRuntimeSource,
        target: string,
        diagnostics: readonly string[]
    ): Promise<RideCodexLaunchSpec> {
        const resolved = await this.resolveNativeExecutable(candidate, target);
        let probeResult: Awaited<ReturnType<RideCodexRuntimeProbeLike['probe']>>;
        try {
            probeResult = await this.probe.probe(resolved.executable, target);
        } catch (error) {
            throw new CandidateError(reasonFromError(error));
        }
        if (probeResult.target !== target) {
            throw new CandidateError('Codex runtime target does not match this platform architecture.');
        }
        if (!isCompatibleVersion(probeResult.version)
            || (resolved.manifestVersion && resolved.manifestVersion !== probeResult.version)) {
            throw new CandidateError('Codex CLI version is incompatible with the reviewed App Server protocol.');
        }
        return createRideCodexLaunchSpec({
            executable: resolved.executable,
            version: probeResult.version,
            target,
            source,
            diagnostics
        });
    }

    private async resolveNativeExecutable(candidate: string, target: string): Promise<CandidateResolution> {
        const paths = this.platform === 'win32' ? win32 : posix;
        if (!paths.isAbsolute(candidate)) {
            throw new CandidateError('Codex path must be absolute.');
        }
        const normalized = paths.normalize(candidate);
        const stat = await this.safeLstat(normalized);
        if (stat.isSymbolicLink()) {
            throw new CandidateError('Codex path must not be a symlink.');
        }
        if (!stat.isFile()) {
            throw new CandidateError('Codex path is not a file.');
        }

        if (this.platform === 'win32') {
            const extension = win32.extname(normalized).toLowerCase();
            if (extension === '.cmd' || extension === '.ps1') {
                return this.resolveWindowsNpmWrapper(normalized, stat, target);
            }
            if (extension !== '.exe') {
                throw new CandidateError('Codex path is not a native Windows executable.');
            }
        } else {
            if (/\.(?:cmd|ps1|js)$/i.test(normalized)) {
                throw new CandidateError('Codex path is a script wrapper, not a native executable.');
            }
            let header: Uint8Array;
            try {
                header = await this.filesystem.readFilePrefix(normalized, 4);
            } catch {
                throw new CandidateError('Codex native executable header cannot be read.');
            }
            if (!isNativePosixBinary(this.platform, header)) {
                throw new CandidateError('Codex path is not a native POSIX executable.');
            }
            if (!await this.filesystem.isExecutable(normalized)) {
                throw new CandidateError('Codex file is not executable.');
            }
        }
        await this.requireStableRealPath(normalized);
        return { executable: normalized };
    }

    private async resolveWindowsNpmWrapper(
        wrapper: string,
        wrapperStat: RideCodexRuntimeFileStat,
        target: string
    ): Promise<CandidateResolution> {
        if (wrapperStat.size > MAX_WRAPPER_BYTES) {
            throw new CandidateError('Codex npm launcher exceeds the safe size limit.');
        }
        await this.requireStableRealPath(wrapper);
        const body = await this.filesystem.readTextFile(wrapper);
        if (!/(?:node_modules[\\/])+@openai[\\/]codex[\\/]bin[\\/]codex\.js/i.test(body)) {
            throw new CandidateError('Codex npm launcher cannot be resolved safely.');
        }

        const platformPackage = PLATFORM_PACKAGE_BY_TARGET[target];
        if (!platformPackage) {
            throw new CandidateError('Codex target has no supported native npm package.');
        }
        const wrapperDirectory = win32.dirname(wrapper);
        const packageRoots = [
            win32.join(wrapperDirectory, 'node_modules', '@openai', platformPackage),
            win32.join(wrapperDirectory, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', platformPackage),
            win32.join(wrapperDirectory, 'node_modules', '@openai', 'codex')
        ];
        for (const packageRoot of packageRoots) {
            const vendorTarget = win32.join(packageRoot, 'vendor', target);
            const manifestPath = win32.join(vendorTarget, 'codex-package.json');
            let manifestStat: RideCodexRuntimeFileStat;
            try {
                manifestStat = await this.filesystem.lstat(manifestPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    continue;
                }
                throw new CandidateError('Codex package manifest cannot be read.');
            }
            if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
                throw new CandidateError('Codex package manifest must be a regular file, not a symlink.');
            }
            if (manifestStat.size > MAX_MANIFEST_BYTES) {
                throw new CandidateError('Codex package manifest exceeds the safe size limit.');
            }
            await this.requireStableRealPath(manifestPath);
            const manifest = await this.readManifest(manifestPath);
            this.validateManifest(manifest, target);

            const expectedEntrypoint = 'bin/codex.exe';
            if (manifest.entrypoint !== expectedEntrypoint) {
                throw new CandidateError('Codex package entrypoint is invalid.');
            }
            const entrypoint = win32.resolve(vendorTarget, manifest.entrypoint);
            if (!isPathWithin(win32, vendorTarget, entrypoint)) {
                throw new CandidateError('Codex package entrypoint escapes the vendor directory.');
            }
            const executableStat = await this.safeLstat(entrypoint);
            if (executableStat.isSymbolicLink()) {
                throw new CandidateError('Codex native executable must not be a symlink.');
            }
            if (!executableStat.isFile()) {
                throw new CandidateError('Codex native executable is not a file.');
            }
            if (win32.extname(entrypoint).toLowerCase() !== '.exe') {
                throw new CandidateError('Codex package entrypoint is not a native Windows executable.');
            }
            await this.requireStableRealPath(entrypoint);
            return { executable: entrypoint, manifestVersion: manifest.version as string };
        }
        throw new CandidateError('Codex npm launcher has no compatible native optional package.');
    }

    private async readManifest(path: string): Promise<CodexPackageManifest> {
        try {
            const value = JSON.parse(await this.filesystem.readTextFile(path)) as unknown;
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw new Error('invalid');
            }
            return value as CodexPackageManifest;
        } catch {
            throw new CandidateError('Codex package manifest is invalid JSON.');
        }
    }

    private validateManifest(manifest: CodexPackageManifest, target: string): void {
        if (manifest.layoutVersion !== 1) {
            throw new CandidateError('Codex package layout version is unsupported.');
        }
        if (typeof manifest.version !== 'string' || !isCompatibleVersion(manifest.version)) {
            throw new CandidateError('Codex package version is incompatible.');
        }
        if (manifest.target !== target) {
            throw new CandidateError('Codex package target does not match this platform architecture.');
        }
        if (manifest.variant !== 'codex') {
            throw new CandidateError('Codex package variant is invalid.');
        }
        if (typeof manifest.entrypoint !== 'string'
            || win32.isAbsolute(manifest.entrypoint)
            || manifest.entrypoint.split(/[\\/]+/).some(segment => segment === '..')) {
            throw new CandidateError('Codex package entrypoint is invalid or escapes its vendor directory.');
        }
    }

    private async safeLstat(path: string): Promise<RideCodexRuntimeFileStat> {
        try {
            return await this.filesystem.lstat(path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new CandidateError('Codex runtime does not exist or is missing a required file.');
            }
            throw new CandidateError('Codex runtime metadata cannot be read.');
        }
    }

    private async requireStableRealPath(path: string): Promise<void> {
        let realPath: string;
        try {
            realPath = await this.filesystem.realpath(path);
        } catch {
            throw new CandidateError('Codex runtime canonical path cannot be resolved.');
        }
        const paths = this.platform === 'win32' ? win32 : posix;
        const expected = paths.normalize(path);
        const actual = paths.normalize(realPath);
        const equal = this.platform === 'win32'
            ? expected.toLowerCase() === actual.toLowerCase()
            : expected === actual;
        if (!equal) {
            throw new CandidateError('Codex runtime canonical path escapes through a symlink.');
        }
    }
}

export function targetForPlatform(platform: NodeJS.Platform, arch: string): string {
    const architecture = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : undefined;
    if (!architecture) {
        throw new Error(`Unsupported Codex architecture: ${arch}.`);
    }
    switch (platform) {
        case 'win32': return `${architecture}-pc-windows-msvc`;
        case 'darwin': return `${architecture}-apple-darwin`;
        case 'linux': return `${architecture}-unknown-linux-musl`;
        default: throw new Error(`Unsupported Codex platform: ${platform}.`);
    }
}

export function discoverDefaultCodexSystemCandidates(
    environment: Readonly<Record<string, string | undefined>>,
    platform: NodeJS.Platform
): RideCodexSystemCandidateDiscovery {
    const pathValue = readEnvironmentValue(environment, 'PATH');
    if (!pathValue) {
        return createSystemCandidateDiscovery([], 0, 0, false);
    }
    const paths = platform === 'win32' ? win32 : posix;
    const delimiter = platform === 'win32' ? ';' : ':';
    const names = platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.ps1'] : ['codex'];
    const candidates: string[] = [];
    const seen = new Set<string>();
    let scannedPathBytes = 0;
    let scannedDirectories = 0;
    let tokenStart = 0;
    let index = 0;
    let truncated = false;

    const addDirectory = (directory: string, hasUnscannedPath: boolean): void => {
        if (scannedDirectories >= RIDE_CODEX_RUNTIME_DISCOVERY_LIMITS.maxDirectories) {
            truncated = true;
            return;
        }
        scannedDirectories += 1;
        if (!directory || !paths.isAbsolute(directory)) {
            return;
        }
        for (let nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
            if (candidates.length >= RIDE_CODEX_RUNTIME_DISCOVERY_LIMITS.maxCandidates) {
                truncated = hasUnscannedPath || nameIndex < names.length;
                return;
            }
            const name = names[nameIndex];
            const candidate = paths.normalize(paths.join(directory, name));
            const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
            if (!seen.has(key)) {
                seen.add(key);
                candidates.push(candidate);
            }
        }
    };

    while (index < pathValue.length && !truncated) {
        const codePoint = pathValue.codePointAt(index)!;
        const codeUnitLength = codePoint > 0xffff ? 2 : 1;
        const byteLength = utf8CodePointByteLength(codePoint);
        if (scannedPathBytes + byteLength > RIDE_CODEX_RUNTIME_DISCOVERY_LIMITS.maxPathBytes) {
            truncated = true;
            break;
        }
        const character = pathValue.slice(index, index + codeUnitLength);
        scannedPathBytes += byteLength;
        if (character === delimiter) {
            addDirectory(pathValue.slice(tokenStart, index), index + codeUnitLength < pathValue.length);
            tokenStart = index + codeUnitLength;
            if (scannedDirectories >= RIDE_CODEX_RUNTIME_DISCOVERY_LIMITS.maxDirectories
                && tokenStart < pathValue.length) {
                truncated = true;
            }
        }
        index += codeUnitLength;
    }

    if (!truncated && index === pathValue.length) {
        addDirectory(pathValue.slice(tokenStart), false);
    }
    return createSystemCandidateDiscovery(
        candidates,
        scannedPathBytes,
        scannedDirectories,
        truncated
    );
}

function boundProvidedSystemCandidates(candidates: readonly string[]): RideCodexSystemCandidateDiscovery {
    const truncated = candidates.length > MAX_SYSTEM_CANDIDATES;
    return createSystemCandidateDiscovery(
        candidates.slice(0, MAX_SYSTEM_CANDIDATES),
        0,
        0,
        truncated
    );
}

function createSystemCandidateDiscovery(
    candidates: readonly string[],
    scannedPathBytes: number,
    scannedDirectories: number,
    truncated: boolean
): RideCodexSystemCandidateDiscovery {
    return Object.freeze({
        candidates: Object.freeze([...candidates]),
        diagnostics: Object.freeze(truncated ? [SYSTEM_DISCOVERY_LIMIT_DIAGNOSTIC] : []),
        scannedPathBytes,
        scannedDirectories,
        truncated
    });
}

function utf8CodePointByteLength(codePoint: number): number {
    if (codePoint <= 0x7f) {
        return 1;
    }
    if (codePoint <= 0x7ff) {
        return 2;
    }
    if (codePoint <= 0xffff) {
        return 3;
    }
    return 4;
}

function readEnvironmentValue(
    environment: Readonly<Record<string, string | undefined>>,
    key: string
): string | undefined {
    if (key in environment) {
        return environment[key];
    }
    const matchingKey = Object.keys(environment).find(candidate => candidate.toLowerCase() === key.toLowerCase());
    return matchingKey ? environment[matchingKey] : undefined;
}

function normalizeOptionalCandidate(candidate: string | undefined): string | undefined {
    const trimmed = candidate?.trim();
    return trimmed || undefined;
}

function isCompatibleVersion(version: string): boolean {
    return compareVersions(version, compatibility.minimumCompatibleCliVersion) >= 0
        && compareVersions(version, compatibility.maximumCompatibleCliVersion) <= 0;
}

function compareVersions(left: string, right: string): number {
    if (!/^\d+\.\d+\.\d+$/.test(left) || !/^\d+\.\d+\.\d+$/.test(right)) {
        return Number.NaN;
    }
    const leftParts = left.split('.').map(Number);
    const rightParts = right.split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
        const difference = leftParts[index] - rightParts[index];
        if (difference !== 0) {
            return difference;
        }
    }
    return 0;
}

function isPathWithin(paths: typeof win32, parent: string, child: string): boolean {
    const relative = paths.relative(parent, child);
    return relative !== '' && !relative.startsWith('..') && !paths.isAbsolute(relative);
}

function isNativePosixBinary(platform: NodeJS.Platform, header: Uint8Array): boolean {
    if (header.byteLength < 4) {
        return false;
    }
    if (platform === 'linux') {
        return header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46;
    }
    if (platform !== 'darwin') {
        return false;
    }
    const magic = Buffer.from(header).readUInt32BE(0);
    return magic === 0xfeedface
        || magic === 0xfeedfacf
        || magic === 0xcefaedfe
        || magic === 0xcffaedfe
        || magic === 0xcafebabe
        || magic === 0xbebafeca
        || magic === 0xcafebabf
        || magic === 0xbfbafeca;
}

function reasonFromError(error: unknown): string {
    if (error instanceof CandidateError) {
        return sanitizeReason(error.safeReason);
    }
    const message = error instanceof Error ? error.message : '';
    if (/app[ -]?server/i.test(message)) {
        return 'Codex App Server command is unavailable.';
    }
    if (/version|compatible/i.test(message)) {
        return 'Codex CLI version is incompatible with the reviewed protocol.';
    }
    if (/target|architecture/i.test(message)) {
        return 'Codex runtime target does not match this platform architecture.';
    }
    if (/timeout/i.test(message)) {
        return 'Codex runtime probe timed out.';
    }
    return 'Codex runtime could not be verified safely.';
}

function sanitizeReason(reason: string): string {
    const safe = reason
        .replace(/(?:OPENAI|CODEX|RIDE)_[A-Z0-9_]+\s*=\s*\S+/gi, '[redacted]')
        .slice(0, MAX_DIAGNOSTIC_LENGTH);
    return safe || 'Codex runtime could not be verified safely.';
}

function addDiagnostic(diagnostics: string[], diagnostic: string): void {
    if (diagnostics.length < MAX_DIAGNOSTICS) {
        diagnostics.push(sanitizeReason(diagnostic));
    }
}

function freezeDiagnostics(diagnostics: readonly string[]): readonly string[] {
    return Object.freeze(diagnostics.slice(0, MAX_DIAGNOSTICS).map(sanitizeReason));
}
