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
import {
    RuntimeTarget,
    runtimeManifestEntryDigest,
    runtimeManifestEntryForTarget
} from './ride-codex-runtime-manifest';
import { RideCodexRuntimeProbe, RideCodexRuntimeProbeLike } from './ride-codex-runtime-probe';
import type {
    ActiveRuntimePointer,
    RideCodexRuntimeStore,
    ValidatedManagedRuntime
} from './ride-codex-runtime-store';

export interface RideCodexRuntimeFileStat {
    readonly size: number;
    isFile(): boolean;
    isSymbolicLink(): boolean;
}

export interface RideCodexRuntimeFileSystem {
    lstat(path: string): Promise<RideCodexRuntimeFileStat>;
    readFilePrefix(path: string, maxBytes: number): Promise<Uint8Array>;
    readLink(path: string): Promise<string>;
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
    readonly readManagedActiveRuntime?: () => MaybePromise<ValidatedManagedRuntime | undefined>;
    readonly managedRuntimeStore?: Pick<RideCodexRuntimeStore, 'readActiveRuntime'>;
    readonly discoveryTimeoutMs?: number;
    readonly maxSystemProbes?: number;
    readonly signal?: AbortSignal;
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

class ResolutionDeadlineError extends Error {
    constructor(reason: 'deadline' | 'aborted') {
        super(reason === 'aborted'
            ? 'Codex runtime discovery was aborted.'
            : 'Codex runtime discovery timed out at the global deadline.');
        this.name = 'ResolutionDeadlineError';
    }
}

class ResolutionDeadline {
    private readonly expiresAt: number;
    private readonly controller = new AbortController();
    private readonly timer: ReturnType<typeof setTimeout>;
    private readonly onExternalAbort = (): void => this.abort('aborted');
    private failureReason: 'deadline' | 'aborted' | undefined;

    constructor(timeoutMs: number, private readonly signal: AbortSignal | undefined) {
        this.expiresAt = Date.now() + timeoutMs;
        this.timer = setTimeout(() => this.abort('deadline'), timeoutMs);
        this.signal?.addEventListener('abort', this.onExternalAbort, { once: true });
        if (this.signal?.aborted) {
            this.abort('aborted');
        }
    }

    get cancellationSignal(): AbortSignal {
        return this.controller.signal;
    }

    remainingMs(): number {
        this.check();
        return Math.max(1, this.expiresAt - Date.now());
    }

    check(): void {
        if (this.failureReason) {
            throw new ResolutionDeadlineError(this.failureReason);
        }
        if (Date.now() >= this.expiresAt) {
            this.abort('deadline');
            throw new ResolutionDeadlineError('deadline');
        }
    }

    run<T>(operation: () => MaybePromise<T>): Promise<T> {
        try {
            this.check();
        } catch (error) {
            return Promise.reject(error);
        }
        return new Promise<T>((resolve, reject) => {
            let settled = false;
            const cleanup = (): void => {
                this.cancellationSignal.removeEventListener('abort', onAbort);
            };
            const settle = (callback: () => void): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                callback();
            };
            const onAbort = (): void => settle(() => reject(new ResolutionDeadlineError(this.failureReason ?? 'aborted')));
            this.cancellationSignal.addEventListener('abort', onAbort, { once: true });
            if (this.cancellationSignal.aborted) {
                onAbort();
                return;
            }
            Promise.resolve().then(operation).then(
                value => settle(() => resolve(value)),
                error => settle(() => reject(error))
            );
        });
    }

    dispose(): void {
        clearTimeout(this.timer);
        this.signal?.removeEventListener('abort', this.onExternalAbort);
    }

    private abort(reason: 'deadline' | 'aborted'): void {
        if (this.failureReason) {
            return;
        }
        this.failureReason = reason;
        this.controller.abort();
    }
}

interface CodexPackageManifest {
    readonly layoutVersion: unknown;
    readonly version: unknown;
    readonly target: unknown;
    readonly variant: unknown;
    readonly entrypoint: unknown;
}

interface CodexRootPackageManifest {
    readonly name: unknown;
    readonly version: unknown;
    readonly bin: unknown;
}

interface CandidateResolution {
    readonly executable: string;
    readonly manifestVersion?: string;
    readonly binaryTarget: string;
    readonly managedRuntime?: ValidatedManagedRuntime;
}

interface ResolutionContext {
    readonly deadline: ResolutionDeadline;
    readonly maxSystemProbes: number;
    systemProbes: number;
}

const MAX_DIAGNOSTICS = 8;
const MAX_DIAGNOSTIC_LENGTH = 160;
const MAX_SYSTEM_CANDIDATES = RIDE_CODEX_RUNTIME_DISCOVERY_LIMITS.maxCandidates;
const MAX_WRAPPER_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_PACKAGE_JSON_BYTES = 16 * 1024;
const MAX_NATIVE_HEADER_BYTES = 64 * 1024;
const MAX_POSIX_SYMLINK_HOPS = 8;
const MAX_PROVIDER_ENVIRONMENT_BYTES = 128 * 1024;
const MAX_PROVIDER_ENVIRONMENT_ENTRIES = 1_024;
const MAX_PROVIDER_KEY_BYTES = 1_024;
const MAX_PROVIDER_VALUE_BYTES = 64 * 1024;
const MAX_PROVIDER_PATH_BYTES = 32 * 1024;
const MAX_PROVIDER_METADATA_BYTES = 4 * 1024;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SYSTEM_PROBES = 8;
const SYSTEM_DISCOVERY_LIMIT_DIAGNOSTIC = 'System runtime discovery: PATH scan was truncated at safe limits.';
const SYSTEM_PROBE_LIMIT_DIAGNOSTIC = 'System runtime discovery: executable probe limit was reached.';
const SYSTEM_PROVIDER_UNAVAILABLE_DIAGNOSTIC = 'System runtime discovery provider is unavailable or returned invalid data.';
const MANAGED_PROVIDER_UNAVAILABLE_DIAGNOSTIC = 'Managed runtime provider is unavailable or returned invalid data.';
const MANAGED_RUNTIME_KEYS = Object.freeze([
    'directory', 'executable', 'manifestDigest', 'pointer', 'relativePath', 'target', 'version'
].sort());
const ACTIVE_POINTER_KEYS = Object.freeze([
    'executableRelativePath', 'manifestDigest', 'relativePath', 'rootIdentity',
    'schemaVersion', 'target', 'treeDigest', 'treeEntries', 'treePathBytes',
    'treeReadBytes', 'version'
].sort());
const POINTER_IDENTITY_KEYS = Object.freeze(['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'size'].sort());

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
    readLink: path => fs.readlink(path),
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
    private readonly readManagedActiveRuntime: () => MaybePromise<ValidatedManagedRuntime | undefined>;
    private readonly discoveryTimeoutMs: number;
    private readonly maxSystemProbes: number;
    private readonly signal: AbortSignal | undefined;
    private generation = 0;
    private successfulResolution: RideCodexLaunchSpec | undefined;
    private successfulGeneration: number | undefined;
    private inFlightResolution: Promise<RideCodexLaunchSpec> | undefined;
    private inFlightGeneration: number | undefined;
    private queuedResolution: Promise<RideCodexLaunchSpec> | undefined;

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
        this.readManagedActiveRuntime = options.readManagedActiveRuntime
            ?? (options.managedRuntimeStore
                ? async () => options.managedRuntimeStore!.readActiveRuntime()
                : () => undefined);
        this.discoveryTimeoutMs = positiveSafeInteger(options.discoveryTimeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS);
        this.maxSystemProbes = positiveSafeInteger(options.maxSystemProbes, DEFAULT_MAX_SYSTEM_PROBES);
        this.signal = options.signal;
    }

    resolve(): Promise<RideCodexLaunchSpec> {
        if (this.successfulResolution && this.successfulGeneration === this.generation) {
            return Promise.resolve(this.successfulResolution);
        }
        if (this.inFlightResolution && this.inFlightGeneration === this.generation) {
            return this.inFlightResolution;
        }
        if (this.queuedResolution) {
            return this.queuedResolution;
        }
        if (this.inFlightResolution) {
            const previous = this.inFlightResolution;
            let queued!: Promise<RideCodexLaunchSpec>;
            queued = previous.then(
                () => undefined,
                () => undefined
            ).then(() => {
                if (this.queuedResolution === queued) {
                    this.queuedResolution = undefined;
                }
                return this.startResolution(this.generation);
            }).finally(() => {
                if (this.queuedResolution === queued) {
                    this.queuedResolution = undefined;
                }
            });
            this.queuedResolution = queued;
            return queued;
        }
        return this.startResolution(this.generation);
    }

    invalidate(): void {
        this.generation += 1;
        this.successfulResolution = undefined;
        this.successfulGeneration = undefined;
    }

    private startResolution(generation: number): Promise<RideCodexLaunchSpec> {
        const context: ResolutionContext = {
            deadline: new ResolutionDeadline(this.discoveryTimeoutMs, this.signal),
            maxSystemProbes: this.maxSystemProbes,
            systemProbes: 0
        };
        const resolution = this.resolveOnce(context).then(spec => {
            if (this.generation === generation) {
                this.successfulResolution = spec;
                this.successfulGeneration = generation;
            }
            return spec;
        }).finally(() => {
            context.deadline.dispose();
            if (this.inFlightResolution === resolution) {
                this.inFlightResolution = undefined;
                this.inFlightGeneration = undefined;
            }
        });
        this.inFlightResolution = resolution;
        this.inFlightGeneration = generation;
        return resolution;
    }

    private async resolveOnce(context: ResolutionContext): Promise<RideCodexLaunchSpec> {
        context.deadline.check();
        const target = targetForPlatform(this.platform, this.arch);
        let environment: Readonly<Record<string, string | undefined>>;
        try {
            environment = validateProviderEnvironment(this.readEnvironment());
        } catch {
            throw new RideCodexRuntimeConfigurationError(
                'Codex environment provider is unavailable or returned invalid data.'
            );
        }
        context.deadline.check();
        const environmentOverride = readEnvironmentValue(environment, 'RIDE_CODEX_PATH', this.platform);
        if (environmentOverride !== undefined) {
            return this.resolveExplicit(environmentOverride, target, context);
        }

        let userOverride: string | undefined;
        try {
            userOverride = validateOptionalProviderPath(
                await context.deadline.run(() => this.readUserOverride())
            );
        } catch {
            context.deadline.check();
            throw new RideCodexRuntimeConfigurationError(
                'Codex runtime setting provider is unavailable or returned invalid data.'
            );
        }
        if (userOverride !== undefined) {
            return this.resolveExplicit(userOverride, target, context);
        }

        const diagnostics: string[] = [];
        let discovery: RideCodexSystemCandidateDiscovery;
        try {
            discovery = validateSystemCandidateDiscovery(
                await context.deadline.run(() => this.discoverSystemCandidates(environment))
            );
        } catch {
            context.deadline.check();
            addDiagnostic(diagnostics, SYSTEM_PROVIDER_UNAVAILABLE_DIAGNOSTIC);
            discovery = createSystemCandidateDiscovery([], 0, 0, false);
        }
        for (const diagnostic of discovery.diagnostics) {
            addDiagnostic(diagnostics, diagnostic);
        }
        const systemCandidates = discovery.candidates;
        for (let index = 0; index < systemCandidates.length; index += 1) {
            context.deadline.check();
            if (context.systemProbes >= context.maxSystemProbes) {
                addDiagnostic(diagnostics, SYSTEM_PROBE_LIMIT_DIAGNOSTIC);
                break;
            }
            const candidate = normalizeOptionalCandidate(systemCandidates[index]);
            if (!candidate) {
                continue;
            }
            try {
                return await this.resolveCandidate(candidate, 'system', target, diagnostics, context);
            } catch (error) {
                addDiagnostic(diagnostics, `System candidate ${index + 1}: ${reasonFromError(error)}`);
            }
        }

        context.deadline.check();
        let managed: ValidatedManagedRuntime | undefined;
        try {
            managed = validateManagedProviderRuntime(
                await context.deadline.run(() => this.readManagedActiveRuntime())
            );
        } catch {
            context.deadline.check();
            addDiagnostic(diagnostics, MANAGED_PROVIDER_UNAVAILABLE_DIAGNOSTIC);
        }
        if (managed) {
            try {
                this.requireReviewedManagedRuntime(managed, target);
                return await this.resolveCandidate(
                    managed.executable,
                    'managed',
                    target,
                    diagnostics,
                    context,
                    managed
                );
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

    private async resolveExplicit(candidate: string, target: string, context: ResolutionContext): Promise<RideCodexLaunchSpec> {
        const normalized = candidate.trim();
        if (!normalized) {
            throw new RideCodexRuntimeConfigurationError('Codex path is empty.');
        }
        try {
            return await this.resolveCandidate(normalized, 'override', target, [], context);
        } catch (error) {
            throw new RideCodexRuntimeConfigurationError(reasonFromError(error));
        }
    }

    private async resolveCandidate(
        candidate: string,
        source: RideCodexRuntimeSource,
        target: string,
        diagnostics: readonly string[],
        context: ResolutionContext,
        managedRuntime?: ValidatedManagedRuntime
    ): Promise<RideCodexLaunchSpec> {
        const nativeResolution = await this.resolveNativeExecutable(candidate, target, context);
        const resolved: CandidateResolution = managedRuntime
            ? Object.freeze({
                executable: nativeResolution.executable,
                manifestVersion: managedRuntime.version,
                binaryTarget: nativeResolution.binaryTarget,
                managedRuntime
            })
            : nativeResolution;
        if (resolved.binaryTarget !== target) {
            throw new CandidateError('Codex runtime target does not match this platform architecture.');
        }
        if (source === 'system') {
            if (context.systemProbes >= context.maxSystemProbes) {
                throw new CandidateError('System Codex executable probe limit was reached.');
            }
            context.systemProbes += 1;
        }
        let probeResult: Awaited<ReturnType<RideCodexRuntimeProbeLike['probe']>>;
        try {
            probeResult = await this.probe.probe(resolved.executable, {
                signal: context.deadline.cancellationSignal,
                timeoutMs: context.deadline.remainingMs()
            });
        } catch (error) {
            context.deadline.check();
            throw new CandidateError(reasonFromError(error));
        }
        if (!isCompatibleVersion(probeResult.version)
            || (resolved.manifestVersion && resolved.manifestVersion !== probeResult.version)) {
            throw new CandidateError('Codex CLI version is incompatible with the reviewed App Server protocol.');
        }
        return createRideCodexLaunchSpec({
            executable: resolved.executable,
            version: probeResult.version,
            target: resolved.managedRuntime?.target ?? target,
            source,
            diagnostics
        });
    }

    private requireReviewedManagedRuntime(runtime: ValidatedManagedRuntime, currentTarget: string): void {
        if (runtime.target !== currentTarget) {
            throw new CandidateError('Codex managed runtime target does not match this platform architecture.');
        }
        let reviewed;
        try {
            reviewed = runtimeManifestEntryForTarget(runtime.target as RuntimeTarget);
        } catch {
            throw new CandidateError('Codex managed runtime target is not present in the reviewed manifest.');
        }
        if (runtime.version !== reviewed.version) {
            throw new CandidateError('Codex managed runtime version does not match the reviewed manifest.');
        }
        if (runtime.manifestDigest !== runtimeManifestEntryDigest(reviewed)) {
            throw new CandidateError('Codex managed runtime digest does not match the reviewed manifest.');
        }
    }

    private async resolveNativeExecutable(
        candidate: string,
        target: string,
        context: ResolutionContext
    ): Promise<CandidateResolution> {
        const paths = this.platform === 'win32' ? win32 : posix;
        if (!paths.isAbsolute(candidate)) {
            throw new CandidateError('Codex path must be absolute.');
        }
        const normalized = paths.normalize(candidate);
        if (this.platform === 'win32' && isWindowsNetworkPath(normalized)) {
            throw new CandidateError('Windows UNC and network Codex paths are not supported; configure a local native executable.');
        }
        const stat = await this.safeLstat(normalized, context);
        if (stat.isSymbolicLink()) {
            if (this.platform !== 'win32') {
                return this.resolvePosixNpmLauncher(normalized, target, context);
            }
            throw new CandidateError('Codex path must not be a symlink.');
        }
        if (!stat.isFile()) {
            throw new CandidateError('Codex path is not a file.');
        }

        if (this.platform === 'win32') {
            const extension = win32.extname(normalized).toLowerCase();
            if (extension === '.cmd' || extension === '.ps1') {
                return this.resolveWindowsNpmWrapper(normalized, stat, target, context);
            }
            if (extension !== '.exe') {
                throw new CandidateError('Codex path is not a native Windows executable.');
            }
        } else {
            if (/\.(?:cmd|ps1|js)$/i.test(normalized)) {
                throw new CandidateError('Codex path is a script wrapper, not a native executable.');
            }
            if (!await context.deadline.run(() => this.filesystem.isExecutable(normalized))) {
                throw new CandidateError('Codex file is not executable.');
            }
        }
        await this.requireStableRealPath(normalized, context);
        const binaryTarget = await this.requireNativeBinaryTarget(normalized, target, context);
        return { executable: normalized, binaryTarget };
    }

    private async resolveWindowsNpmWrapper(
        wrapper: string,
        wrapperStat: RideCodexRuntimeFileStat,
        target: string,
        context: ResolutionContext
    ): Promise<CandidateResolution> {
        if (wrapperStat.size > MAX_WRAPPER_BYTES) {
            throw new CandidateError('Codex npm launcher exceeds the safe size limit.');
        }
        await this.requireStableRealPath(wrapper, context);
        const body = await this.readBoundedText(wrapper, MAX_WRAPPER_BYTES, 'Codex npm launcher', context);
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
        return this.resolveNpmNativePackageRoots(packageRoots, target, win32, 'bin/codex.exe', context);
    }

    private async resolvePosixNpmLauncher(
        launcher: string,
        target: string,
        context: ResolutionContext
    ): Promise<CandidateResolution> {
        let current = launcher;
        let stat: RideCodexRuntimeFileStat;
        let hops = 0;
        while (true) {
            stat = await this.safeLstat(current, context);
            if (!stat.isSymbolicLink()) {
                break;
            }
            if (hops >= MAX_POSIX_SYMLINK_HOPS) {
                throw new CandidateError('Codex npm launcher exceeds the safe symlink hop limit.');
            }
            let linkTarget: string;
            try {
                linkTarget = await context.deadline.run(() => this.filesystem.readLink(current));
            } catch (error) {
                context.deadline.check();
                throw new CandidateError('Codex npm launcher symlink cannot be read.');
            }
            if (!linkTarget || linkTarget.includes('\0')) {
                throw new CandidateError('Codex npm launcher symlink target is invalid.');
            }
            current = posix.normalize(posix.isAbsolute(linkTarget)
                ? linkTarget
                : posix.resolve(posix.dirname(current), linkTarget));
            hops += 1;
        }
        if (!stat.isFile()) {
            throw new CandidateError('Codex npm launcher target is not a file.');
        }

        let canonicalScript: string;
        try {
            canonicalScript = posix.normalize(await context.deadline.run(() => this.filesystem.realpath(current)));
        } catch (error) {
            context.deadline.check();
            throw new CandidateError('Codex npm launcher canonical path cannot be resolved.');
        }
        const suffix = '/node_modules/@openai/codex/bin/codex.js';
        if (!canonicalScript.endsWith(suffix)) {
            throw new CandidateError('Codex npm launcher does not resolve to a validated @openai/codex package.');
        }
        const packageRoot = posix.dirname(posix.dirname(canonicalScript));
        if (!isPathWithin(posix, packageRoot, canonicalScript)) {
            throw new CandidateError('Codex npm launcher escapes its package root.');
        }

        const packageJsonPath = posix.join(packageRoot, 'package.json');
        const packageJsonStat = await this.safeLstat(packageJsonPath, context);
        if (packageJsonStat.isSymbolicLink() || !packageJsonStat.isFile()) {
            throw new CandidateError('Codex npm package metadata must be a regular file.');
        }
        await this.requireStableRealPath(packageJsonPath, context);
        const rootManifest = await this.readRootPackageManifest(packageJsonPath, context);
        const bin = typeof rootManifest.bin === 'string'
            ? rootManifest.bin
            : rootManifest.bin && typeof rootManifest.bin === 'object' && !Array.isArray(rootManifest.bin)
                ? (rootManifest.bin as Record<string, unknown>).codex
                : undefined;
        if (rootManifest.name !== '@openai/codex'
            || typeof rootManifest.version !== 'string'
            || !isCompatibleVersion(rootManifest.version)
            || bin !== 'bin/codex.js') {
            throw new CandidateError('Codex npm package metadata is invalid or incompatible.');
        }

        const platformPackage = PLATFORM_PACKAGE_BY_TARGET[target];
        if (!platformPackage) {
            throw new CandidateError('Codex target has no supported native npm package.');
        }
        const packageScope = posix.dirname(packageRoot);
        const packageRoots = [
            posix.join(packageScope, platformPackage),
            posix.join(packageRoot, 'node_modules', '@openai', platformPackage),
            packageRoot
        ];
        return this.resolveNpmNativePackageRoots(
            packageRoots,
            target,
            posix,
            'bin/codex',
            context,
            rootManifest.version
        );
    }

    private async resolveNpmNativePackageRoots(
        packageRoots: readonly string[],
        target: string,
        paths: typeof win32,
        expectedEntrypoint: string,
        context: ResolutionContext,
        rootPackageVersion?: string
    ): Promise<CandidateResolution> {
        for (const packageRoot of packageRoots) {
            const normalizedVendorTarget = paths.join(packageRoot, 'vendor', target);
            const manifestPath = paths.join(normalizedVendorTarget, 'codex-package.json');
            let manifestStat: RideCodexRuntimeFileStat;
            try {
                manifestStat = await context.deadline.run(() => this.filesystem.lstat(manifestPath));
            } catch (error) {
                context.deadline.check();
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
            await this.requireStableRealPath(manifestPath, context);
            const manifest = await this.readManifest(manifestPath, context);
            this.validateManifest(manifest, target, paths, expectedEntrypoint);
            if (rootPackageVersion && manifest.version !== rootPackageVersion) {
                throw new CandidateError('Codex native package version does not match @openai/codex.');
            }

            if (manifest.entrypoint !== expectedEntrypoint) {
                throw new CandidateError('Codex package entrypoint is invalid.');
            }
            const entrypoint = paths.resolve(normalizedVendorTarget, manifest.entrypoint);
            if (!isPathWithin(paths, normalizedVendorTarget, entrypoint)) {
                throw new CandidateError('Codex package entrypoint escapes the vendor directory.');
            }
            const executableStat = await this.safeLstat(entrypoint, context);
            if (executableStat.isSymbolicLink()) {
                throw new CandidateError('Codex native executable must not be a symlink.');
            }
            if (!executableStat.isFile()) {
                throw new CandidateError('Codex native executable is not a file.');
            }
            if (this.platform === 'win32' && win32.extname(entrypoint).toLowerCase() !== '.exe') {
                throw new CandidateError('Codex package entrypoint is not a native Windows executable.');
            }
            if (this.platform !== 'win32'
                && !await context.deadline.run(() => this.filesystem.isExecutable(entrypoint))) {
                throw new CandidateError('Codex native package entrypoint is not executable.');
            }
            await this.requireStableRealPath(entrypoint, context);
            const binaryTarget = await this.requireNativeBinaryTarget(entrypoint, target, context);
            return { executable: entrypoint, manifestVersion: manifest.version as string, binaryTarget };
        }
        throw new CandidateError('Codex npm launcher has no compatible native optional package.');
    }

    private async readManifest(path: string, context: ResolutionContext): Promise<CodexPackageManifest> {
        try {
            const value = JSON.parse(await this.readBoundedText(
                path, MAX_MANIFEST_BYTES, 'Codex package manifest', context
            )) as unknown;
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw new Error('invalid');
            }
            return value as CodexPackageManifest;
        } catch (error) {
            if (error instanceof CandidateError) {
                throw error;
            }
            throw new CandidateError('Codex package manifest is invalid JSON.');
        }
    }

    private async readRootPackageManifest(path: string, context: ResolutionContext): Promise<CodexRootPackageManifest> {
        try {
            const value = JSON.parse(await this.readBoundedText(
                path, MAX_PACKAGE_JSON_BYTES, 'Codex npm package metadata', context
            )) as unknown;
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw new Error('invalid');
            }
            return value as CodexRootPackageManifest;
        } catch (error) {
            if (error instanceof CandidateError) {
                throw error;
            }
            throw new CandidateError('Codex npm package metadata is invalid JSON.');
        }
    }

    private validateManifest(
        manifest: CodexPackageManifest,
        target: string,
        paths: typeof win32,
        expectedEntrypoint: string
    ): void {
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
            || paths.isAbsolute(manifest.entrypoint)
            || manifest.entrypoint !== expectedEntrypoint
            || manifest.entrypoint.split(/[\\/]+/).some(segment => segment === '..')) {
            throw new CandidateError('Codex package entrypoint is invalid or escapes its vendor directory.');
        }
    }

    private async readBoundedText(
        path: string,
        maxBytes: number,
        label: string,
        context: ResolutionContext
    ): Promise<string> {
        let bytes: Uint8Array;
        try {
            bytes = await context.deadline.run(() => this.filesystem.readFilePrefix(path, maxBytes + 1));
        } catch (error) {
            context.deadline.check();
            throw new CandidateError(`${label} cannot be read.`);
        }
        if (bytes.byteLength > maxBytes) {
            throw new CandidateError(`${label} exceeds the safe size limit.`);
        }
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
            throw new CandidateError(`${label} is not valid UTF-8.`);
        }
    }

    private async requireNativeBinaryTarget(
        path: string,
        expectedTarget: string,
        context: ResolutionContext
    ): Promise<string> {
        let header: Uint8Array;
        try {
            header = await context.deadline.run(() => this.filesystem.readFilePrefix(path, MAX_NATIVE_HEADER_BYTES));
        } catch (error) {
            context.deadline.check();
            throw new CandidateError('Codex native executable header cannot be read.');
        }
        const targets = readNativeBinaryTargets(this.platform, header);
        if (!targets.includes(expectedTarget)) {
            throw new CandidateError(targets.length === 0
                ? 'Codex path is not a recognized native executable.'
                : 'Codex runtime target does not match this platform architecture.');
        }
        return expectedTarget;
    }

    private async safeLstat(path: string, context: ResolutionContext): Promise<RideCodexRuntimeFileStat> {
        try {
            return await context.deadline.run(() => this.filesystem.lstat(path));
        } catch (error) {
            context.deadline.check();
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new CandidateError('Codex runtime does not exist or is missing a required file.');
            }
            throw new CandidateError('Codex runtime metadata cannot be read.');
        }
    }

    private async requireStableRealPath(path: string, context: ResolutionContext): Promise<void> {
        let realPath: string;
        try {
            realPath = await context.deadline.run(() => this.filesystem.realpath(path));
        } catch (error) {
            context.deadline.check();
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
    const pathValue = readEnvironmentValue(environment, 'PATH', platform);
    if (!pathValue) {
        return createSystemCandidateDiscovery([], 0, 0, false);
    }
    const paths = platform === 'win32' ? win32 : posix;
    const delimiter = platform === 'win32' ? ';' : ':';
    const names = platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.ps1'] : ['codex'];
    const candidates: string[] = [];
    const seen = new Set<string>();
    const seenDirectories = new Set<string>();
    let scannedPathBytes = 0;
    let scannedDirectories = 0;
    let tokenStart = 0;
    let index = 0;
    let truncated = false;

    const addDirectory = (directory: string, hasUnscannedPath: boolean): void => {
        if (!directory || !paths.isAbsolute(directory)) {
            return;
        }
        const normalizedDirectory = paths.normalize(directory);
        const directoryKey = platform === 'win32' ? normalizedDirectory.toLowerCase() : normalizedDirectory;
        if (seenDirectories.has(directoryKey)) {
            return;
        }
        if (scannedDirectories >= RIDE_CODEX_RUNTIME_DISCOVERY_LIMITS.maxDirectories) {
            truncated = true;
            return;
        }
        seenDirectories.add(directoryKey);
        scannedDirectories += 1;
        for (let nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
            if (candidates.length >= RIDE_CODEX_RUNTIME_DISCOVERY_LIMITS.maxCandidates) {
                truncated = hasUnscannedPath || nameIndex < names.length;
                return;
            }
            const name = names[nameIndex];
            const candidate = paths.normalize(paths.join(normalizedDirectory, name));
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
    validateProviderCandidateArray(candidates);
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
    key: string,
    platform: NodeJS.Platform
): string | undefined {
    if (key in environment) {
        return environment[key];
    }
    if (platform !== 'win32') {
        return undefined;
    }
    const matchingKey = Object.keys(environment).find(candidate => candidate.toLowerCase() === key.toLowerCase());
    return matchingKey ? environment[matchingKey] : undefined;
}

function normalizeOptionalCandidate(candidate: string | undefined): string | undefined {
    const trimmed = candidate?.trim();
    return trimmed || undefined;
}

function validateProviderEnvironment(value: unknown): Readonly<Record<string, string | undefined>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Promise) {
        throw new Error('invalid provider environment');
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_PROVIDER_ENVIRONMENT_ENTRIES) {
        throw new Error('provider environment is too large');
    }
    const bounded: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>;
    let totalBytes = 0;
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || descriptor.enumerable !== true
            || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
            || Object.prototype.hasOwnProperty.call(descriptor, 'get')
            || Object.prototype.hasOwnProperty.call(descriptor, 'set')) {
            throw new Error('invalid provider environment entry');
        }
        const entry = descriptor.value;
        if ((entry !== undefined && typeof entry !== 'string') || key.includes('\0') || entry?.includes('\0')) {
            throw new Error('invalid provider environment entry');
        }
        const keyBytes = Buffer.byteLength(key);
        const valueBytes = typeof entry === 'string' ? Buffer.byteLength(entry) : 0;
        if (keyBytes > MAX_PROVIDER_KEY_BYTES || valueBytes > MAX_PROVIDER_VALUE_BYTES
            || totalBytes + keyBytes + valueBytes > MAX_PROVIDER_ENVIRONMENT_BYTES) {
            throw new Error('provider environment is too large');
        }
        bounded[key] = entry;
        totalBytes += keyBytes + valueBytes;
    }
    return Object.freeze(bounded);
}

function validateOptionalProviderPath(value: unknown): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > MAX_PROVIDER_PATH_BYTES) {
        throw new Error('invalid provider path');
    }
    return value;
}

function validateProviderCandidateArray(value: unknown): asserts value is readonly string[] {
    if (!Array.isArray(value)) {
        throw new Error('invalid system candidate provider result');
    }
    const inspected = value.slice(0, MAX_SYSTEM_CANDIDATES + 1);
    for (const candidate of inspected) {
        validateOptionalProviderPath(candidate);
    }
}

function validateManagedProviderRuntime(value: unknown): ValidatedManagedRuntime | undefined {
    if (value === undefined) {
        return undefined;
    }
    const runtime = requireProviderDataRecord(value, MANAGED_RUNTIME_KEYS);
    const pointerRecord = requireProviderDataRecord(runtime.pointer, ACTIVE_POINTER_KEYS);
    const identityRecord = requireProviderDataRecord(pointerRecord.rootIdentity, POINTER_IDENTITY_KEYS);
    const version = requireBoundedProviderString(runtime.version, MAX_PROVIDER_METADATA_BYTES);
    const target = requireBoundedProviderString(runtime.target, MAX_PROVIDER_METADATA_BYTES);
    const manifestDigest = requireBoundedProviderString(runtime.manifestDigest, MAX_PROVIDER_METADATA_BYTES);
    const relativePath = requireBoundedProviderString(runtime.relativePath, MAX_PROVIDER_PATH_BYTES);
    const directory = requireBoundedProviderString(runtime.directory, MAX_PROVIDER_PATH_BYTES);
    const executable = requireBoundedProviderString(runtime.executable, MAX_PROVIDER_PATH_BYTES);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
        || !/^[a-z0-9_-]+$/.test(target)
        || !/^sha256-[a-f0-9]{64}$/.test(manifestDigest)
        || !isPortableProviderRelativePath(relativePath)
        || (!win32.isAbsolute(directory) && !posix.isAbsolute(directory))
        || (!win32.isAbsolute(executable) && !posix.isAbsolute(executable))) {
        throw new Error('invalid managed runtime provider result');
    }
    const pointerVersion = requireBoundedProviderString(pointerRecord.version, MAX_PROVIDER_METADATA_BYTES);
    const pointerTarget = requireBoundedProviderString(pointerRecord.target, MAX_PROVIDER_METADATA_BYTES);
    const pointerManifestDigest = requireBoundedProviderString(pointerRecord.manifestDigest, MAX_PROVIDER_METADATA_BYTES);
    const pointerRelativePath = requireBoundedProviderString(pointerRecord.relativePath, MAX_PROVIDER_PATH_BYTES);
    const executableRelativePath = requireBoundedProviderString(
        pointerRecord.executableRelativePath,
        MAX_PROVIDER_PATH_BYTES
    );
    const treeDigest = requireBoundedProviderString(pointerRecord.treeDigest, MAX_PROVIDER_METADATA_BYTES);
    const treeReadBytes = requireBoundedProviderString(pointerRecord.treeReadBytes, MAX_PROVIDER_METADATA_BYTES);
    if (pointerRecord.schemaVersion !== 1
        || pointerVersion !== version
        || pointerTarget !== target
        || pointerManifestDigest !== manifestDigest
        || pointerRelativePath !== relativePath
        || !isPortableProviderRelativePath(pointerRelativePath)
        || !isPortableProviderRelativePath(executableRelativePath)
        || !/^sha256-[a-f0-9]{64}$/.test(treeDigest)
        || !isCanonicalProviderInteger(treeReadBytes)
        || !Number.isSafeInteger(pointerRecord.treeEntries) || (pointerRecord.treeEntries as number) <= 0
        || !Number.isSafeInteger(pointerRecord.treePathBytes) || (pointerRecord.treePathBytes as number) <= 0) {
        throw new Error('invalid managed runtime provider result');
    }
    const rootIdentity = Object.freeze({
        dev: requireCanonicalProviderInteger(identityRecord.dev),
        ino: requireCanonicalProviderInteger(identityRecord.ino),
        size: requireCanonicalProviderInteger(identityRecord.size),
        birthtimeNs: requireCanonicalProviderInteger(identityRecord.birthtimeNs),
        ctimeNs: requireCanonicalProviderInteger(identityRecord.ctimeNs)
    });
    const pointer: ActiveRuntimePointer = Object.freeze({
        schemaVersion: 1,
        version,
        target,
        manifestDigest,
        relativePath,
        executableRelativePath,
        treeDigest,
        treeEntries: pointerRecord.treeEntries as number,
        treeReadBytes,
        treePathBytes: pointerRecord.treePathBytes as number,
        rootIdentity
    });
    return Object.freeze({
        version,
        target,
        manifestDigest,
        relativePath,
        directory,
        executable,
        pointer
    });
}

function requireProviderDataRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
    if (typeof value !== 'object' || !value || Array.isArray(value) || value instanceof Promise) {
        throw new Error('invalid provider record');
    }
    const keys = Object.keys(value).sort();
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
        throw new Error('invalid provider record');
    }
    const record: Record<string, unknown> = {};
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || descriptor.enumerable !== true
            || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
            || Object.prototype.hasOwnProperty.call(descriptor, 'get')
            || Object.prototype.hasOwnProperty.call(descriptor, 'set')) {
            throw new Error('invalid provider record');
        }
        record[key] = descriptor.value;
    }
    return record;
}

function requireBoundedProviderString(value: unknown, maxBytes: number): string {
    if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > maxBytes) {
        throw new Error('invalid managed runtime provider string');
    }
    return value;
}

function requireCanonicalProviderInteger(value: unknown): string {
    const text = requireBoundedProviderString(value, 40);
    if (!isCanonicalProviderInteger(text)) {
        throw new Error('invalid managed runtime provider integer');
    }
    return text;
}

function isCanonicalProviderInteger(value: string): boolean {
    return /^(?:0|[1-9]\d*)$/.test(value) && value.length <= 40;
}

function isPortableProviderRelativePath(value: string): boolean {
    return value.length > 0 && !value.includes('\\') && !value.startsWith('/')
        && posix.normalize(value) === value
        && value.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

function validateSystemCandidateDiscovery(value: unknown): RideCodexSystemCandidateDiscovery {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('invalid system discovery result');
    }
    const discovery = value as Partial<RideCodexSystemCandidateDiscovery>;
    validateProviderCandidateArray(discovery.candidates);
    if (!Array.isArray(discovery.diagnostics)
        || discovery.diagnostics.some(diagnostic => typeof diagnostic !== 'string')
        || !Number.isSafeInteger(discovery.scannedPathBytes) || discovery.scannedPathBytes! < 0
        || !Number.isSafeInteger(discovery.scannedDirectories) || discovery.scannedDirectories! < 0
        || typeof discovery.truncated !== 'boolean') {
        throw new Error('invalid system discovery result');
    }
    return createSystemCandidateDiscovery(
        discovery.candidates,
        discovery.scannedPathBytes!,
        discovery.scannedDirectories!,
        discovery.truncated
    );
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

export function readNativeBinaryTargets(platform: NodeJS.Platform, header: Uint8Array): readonly string[] {
    const buffer = Buffer.from(header.buffer, header.byteOffset, header.byteLength);
    if (platform === 'win32') {
        if (buffer.length < 0x40 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
            return [];
        }
        const peOffset = buffer.readUInt32LE(0x3c);
        if (peOffset > buffer.length - 6
            || buffer.toString('binary', peOffset, peOffset + 4) !== 'PE\0\0') {
            return [];
        }
        const target = targetForMachine(platform, buffer.readUInt16LE(peOffset + 4));
        return target ? [target] : [];
    }
    if (platform === 'linux') {
        if (buffer.length < 20
            || buffer[0] !== 0x7f || buffer[1] !== 0x45 || buffer[2] !== 0x4c || buffer[3] !== 0x46
            || buffer[4] !== 2 || (buffer[5] !== 1 && buffer[5] !== 2)) {
            return [];
        }
        const machine = buffer[5] === 1 ? buffer.readUInt16LE(18) : buffer.readUInt16BE(18);
        const target = targetForMachine(platform, machine);
        return target ? [target] : [];
    }
    if (platform !== 'darwin' || buffer.length < 8) {
        return [];
    }

    const magicBe = buffer.readUInt32BE(0);
    const magicLe = buffer.readUInt32LE(0);
    if (magicLe === 0xfeedfacf) {
        const target = targetForMachine(platform, buffer.readUInt32LE(4));
        return target ? [target] : [];
    }
    if (magicBe === 0xfeedfacf) {
        const target = targetForMachine(platform, buffer.readUInt32BE(4));
        return target ? [target] : [];
    }

    let littleEndian: boolean;
    let entrySize: number;
    if (magicBe === 0xcafebabe || magicBe === 0xcafebabf) {
        littleEndian = false;
        entrySize = magicBe === 0xcafebabf ? 32 : 20;
    } else if (magicLe === 0xcafebabe || magicLe === 0xcafebabf) {
        littleEndian = true;
        entrySize = magicLe === 0xcafebabf ? 32 : 20;
    } else {
        return [];
    }
    const architectureCount = littleEndian ? buffer.readUInt32LE(4) : buffer.readUInt32BE(4);
    if (architectureCount === 0 || architectureCount > 64 || 8 + (architectureCount * entrySize) > buffer.length) {
        return [];
    }
    const targets = new Set<string>();
    for (let index = 0; index < architectureCount; index += 1) {
        const offset = 8 + (index * entrySize);
        const machine = littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
        const target = targetForMachine(platform, machine);
        if (target) {
            targets.add(target);
        }
    }
    return [...targets];
}

function targetForMachine(platform: NodeJS.Platform, machine: number): string | undefined {
    if (platform === 'win32') {
        return machine === 0x8664
            ? 'x86_64-pc-windows-msvc'
            : machine === 0xaa64 ? 'aarch64-pc-windows-msvc' : undefined;
    }
    if (platform === 'linux') {
        return machine === 62
            ? 'x86_64-unknown-linux-musl'
            : machine === 183 ? 'aarch64-unknown-linux-musl' : undefined;
    }
    if (platform === 'darwin') {
        return machine === 0x01000007
            ? 'x86_64-apple-darwin'
            : machine === 0x0100000c ? 'aarch64-apple-darwin' : undefined;
    }
    return undefined;
}

function isWindowsNetworkPath(path: string): boolean {
    const normalized = path.replace(/\//g, '\\');
    return normalized.startsWith('\\\\') || /^\\\\\?\\UNC\\/i.test(normalized);
}

function positiveSafeInteger(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function reasonFromError(error: unknown): string {
    if (error instanceof CandidateError) {
        return sanitizeReason(error.safeReason);
    }
    if (error instanceof ResolutionDeadlineError) {
        return sanitizeReason(error.message);
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
    const bounded = typeof reason === 'string' ? reason.slice(0, MAX_DIAGNOSTIC_LENGTH * 4) : '';
    const safe = bounded
        .replace(/\b(?:https?|wss?):\/\/[^\s/@:]+:[^\s/@]+@/gi, match => `${match.slice(0, match.indexOf('://') + 3)}[redacted]@`)
        .replace(/\b(?:[A-Z0-9_]*(?:API.?KEY|TOKEN|AUTHORIZATION|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*\S+/gi, '[redacted]')
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
