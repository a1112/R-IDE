/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createHash, timingSafeEqual } from 'node:crypto';
import { BigIntStats, constants as fsConstants } from 'node:fs';
import { FileHandle, lstat, open, realpath, rm } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { dirname, isAbsolute, relative, resolve as resolvePath } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
    RideCodexRuntimeManifestEntry,
    RuntimeTarget,
    runtimeManifestEntryDigest
} from './ride-codex-runtime-manifest';

export type InstallAuthorization = Readonly<Record<PropertyKey, unknown>>;

export interface InstallAuthorizationContext {
    readonly target: RuntimeTarget;
    readonly manifestDigest: string;
    readonly canonicalRoot: string;
    readonly destination: string;
}

export type InstallAuthorizationValidator = (
    authorization: InstallAuthorization,
    context: InstallAuthorizationContext
) => boolean | Promise<boolean>;

const RUNTIME_FETCH_CAPABILITY_BRAND: unique symbol = Symbol('ride-codex-runtime-fetch-capability');

export type RideCodexRuntimeFetchCapability = Readonly<{
    readonly [RUNTIME_FETCH_CAPABILITY_BRAND]: true;
}>;

export interface RideCodexHttpsRequest {
    readonly connectTimeoutMs: number;
    readonly signal: AbortSignal;
}

export interface RideCodexHttpsResponse {
    readonly statusCode: number;
    readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    readonly body: Readable;
}

export interface RideCodexHttpsRequester {
    open(url: URL, request: RideCodexHttpsRequest): Promise<RideCodexHttpsResponse>;
}

export interface RideCodexRuntimeFetchResult {
    readonly bytes: number;
    readonly integrity: string;
}

export interface RideCodexRuntimeFetchDestination {
    readonly path: string;
    readonly canonicalRoot: string;
}

export type RuntimeFetchDestination = string | RideCodexRuntimeFetchDestination;

export interface RideCodexRuntimeStagingFetcherLike {
    authorize(
        authorization: InstallAuthorization,
        context: InstallAuthorizationContext
    ): Promise<RideCodexRuntimeFetchCapability>;
    fetchAuthorized(
        capability: RideCodexRuntimeFetchCapability,
        runtime: RideCodexRuntimeManifestEntry,
        destination: RuntimeFetchDestination,
        signal?: AbortSignal
    ): Promise<RideCodexRuntimeFetchResult>;
}

export interface RideCodexRuntimeFetcherLike extends RideCodexRuntimeStagingFetcherLike {
    fetch(
        authorization: InstallAuthorization,
        runtime: RideCodexRuntimeManifestEntry,
        destination: string,
        signal?: AbortSignal
    ): Promise<RideCodexRuntimeFetchResult>;
}

export interface RideCodexRuntimeFetcherOptions {
    readonly authorizationValidator: InstallAuthorizationValidator;
    readonly requester?: RideCodexHttpsRequester;
    readonly connectTimeoutMs?: number;
    readonly idleTimeoutMs?: number;
    readonly overallTimeoutMs?: number;
    readonly maxRedirects?: number;
}

export class RideCodexRuntimeFetchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RideCodexRuntimeFetchError';
    }
}

const ALLOWED_ORIGIN = 'https://registry.npmjs.org';
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_REDIRECTS = 3;

export class RideCodexRuntimeFetcher implements RideCodexRuntimeFetcherLike {
    private readonly authorizationValidator: InstallAuthorizationValidator;
    private readonly requester: RideCodexHttpsRequester;
    private readonly connectTimeoutMs: number;
    private readonly idleTimeoutMs: number;
    private readonly overallTimeoutMs: number;
    private readonly maxRedirects: number;
    private readonly capabilities = new WeakMap<object, InstallAuthorizationContext>();

    constructor(options: RideCodexRuntimeFetcherOptions) {
        this.authorizationValidator = options.authorizationValidator;
        this.requester = options.requester ?? new NodeHttpsRequester();
        this.connectTimeoutMs = positiveDuration(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
        this.idleTimeoutMs = positiveDuration(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
        this.overallTimeoutMs = positiveDuration(options.overallTimeoutMs, DEFAULT_OVERALL_TIMEOUT_MS);
        this.maxRedirects = nonNegativeInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS);
    }

    async fetch(
        authorization: InstallAuthorization,
        runtime: RideCodexRuntimeManifestEntry,
        destination: string,
        signal?: AbortSignal
    ): Promise<RideCodexRuntimeFetchResult> {
        const canonicalRoot = await realpath(dirname(resolvePath(destination))).catch(() => {
            throw new RideCodexRuntimeFetchError('Codex runtime fetch destination root is unavailable.');
        });
        const capability = await this.authorize(
            authorization,
            createInstallAuthorizationContext(runtime, canonicalRoot, destination)
        );
        return this.fetchAuthorized(capability, runtime, destination, signal);
    }

    async authorize(
        authorization: InstallAuthorization,
        context: InstallAuthorizationContext
    ): Promise<RideCodexRuntimeFetchCapability> {
        const normalizedContext = normalizeInstallAuthorizationContext(context);
        await validateInstallAuthorization(authorization, this.authorizationValidator, normalizedContext);
        const capability = Object.freeze(Object.create(null)) as RideCodexRuntimeFetchCapability;
        this.capabilities.set(capability, normalizedContext);
        return capability;
    }

    async fetchAuthorized(
        capability: RideCodexRuntimeFetchCapability,
        runtime: RideCodexRuntimeManifestEntry,
        destination: RuntimeFetchDestination,
        signal?: AbortSignal
    ): Promise<RideCodexRuntimeFetchResult> {
        if (typeof capability !== 'object' || capability === null) {
            throw new RideCodexRuntimeFetchError('Codex runtime fetch authorization capability is invalid or already used.');
        }
        const context = this.capabilities.get(capability);
        if (!context) {
            throw new RideCodexRuntimeFetchError('Codex runtime fetch authorization capability is invalid or already used.');
        }
        this.capabilities.delete(capability);
        const authorizedDestination = validateAuthorizedFetchContext(context, runtime, destination);
        return this.fetchTrusted(runtime, authorizedDestination, signal);
    }

    private async fetchTrusted(
        runtime: RideCodexRuntimeManifestEntry,
        destination: RideCodexRuntimeFetchDestination,
        signal?: AbortSignal
    ): Promise<RideCodexRuntimeFetchResult> {
        const initialUrl = requireAllowedRuntimeUrl(runtime.url, true);
        const expectedUrl = `${ALLOWED_ORIGIN}/@openai/codex/-/codex-${runtime.npmVersion}.tgz`;
        if (runtime.package !== '@openai/codex' || runtime.version !== '0.144.0'
            || runtime.url !== expectedUrl || !runtime.npmVersion.startsWith('0.144.0-')) {
            throw new RideCodexRuntimeFetchError('Codex runtime download URL does not match the reviewed manifest package.');
        }
        const controller = new AbortController();
        let timedOut = false;
        const onExternalAbort = (): void => controller.abort();
        signal?.addEventListener('abort', onExternalAbort, { once: true });
        const overallTimer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, this.overallTimeoutMs);
        if (signal?.aborted) {
            controller.abort();
        }

        let response: RideCodexHttpsResponse | undefined;
        let openedDestination: OpenedRuntimeFetchDestination | undefined;
        let completed = false;
        try {
            openedDestination = await openAuthorizedDestination(destination);
            response = await this.followRedirects(initialUrl, controller.signal);
            validateContentLength(response.headers, runtime.compressedBytes);
            const result = await this.streamAndVerify(
                response.body,
                openedDestination.handle,
                runtime,
                controller.signal,
                () => timedOut
            );
            await openedDestination.handle.sync();
            await validateOpenedDestination(openedDestination);
            completed = true;
            return Object.freeze(result);
        } catch (error) {
            response?.body.destroy();
            if (error instanceof RideCodexRuntimeFetchError) {
                throw error;
            }
            if (timedOut) {
                throw new RideCodexRuntimeFetchError('Codex runtime download timed out.');
            }
            if (signal?.aborted || controller.signal.aborted) {
                throw new RideCodexRuntimeFetchError('Codex runtime download was aborted.');
            }
            throw new RideCodexRuntimeFetchError('Codex runtime download failed.');
        } finally {
            await openedDestination?.handle.close().catch(() => undefined);
            if (openedDestination && !completed) {
                await removeOpenedDestination(openedDestination);
            }
            clearTimeout(overallTimer);
            signal?.removeEventListener('abort', onExternalAbort);
        }
    }

    private async followRedirects(initialUrl: URL, signal: AbortSignal): Promise<RideCodexHttpsResponse> {
        const visited = new Set<string>();
        let current = initialUrl;
        let redirects = 0;
        while (true) {
            if (visited.has(current.href)) {
                throw new RideCodexRuntimeFetchError('Codex runtime download redirect loop was rejected.');
            }
            visited.add(current.href);
            const response = await raceWithAbort(
                this.requester.open(current, { connectTimeoutMs: this.connectTimeoutMs, signal }),
                signal
            );
            if (!isRedirectStatus(response.statusCode)) {
                if (response.statusCode !== 200) {
                    response.body.destroy();
                    throw new RideCodexRuntimeFetchError('Codex runtime registry returned an unexpected status.');
                }
                return response;
            }
            const location = singleHeader(response.headers, 'location');
            response.body.destroy();
            if (!location || redirects >= this.maxRedirects) {
                throw new RideCodexRuntimeFetchError('Codex runtime download exceeded the redirect limit.');
            }
            let redirected: URL;
            try {
                redirected = new URL(location, current);
            } catch {
                throw new RideCodexRuntimeFetchError('Codex runtime download redirect URL is invalid.');
            }
            current = requireAllowedRuntimeUrl(redirected.href, false);
            redirects += 1;
        }
    }

    private async streamAndVerify(
        body: Readable,
        destination: FileHandle,
        runtime: RideCodexRuntimeManifestEntry,
        signal: AbortSignal,
        didOverallTimeout: () => boolean
    ): Promise<RideCodexRuntimeFetchResult> {
        const hash = createHash('sha512');
        let bytes = 0;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        let idleTimedOut = false;
        const resetIdleTimer = (): void => {
            if (idleTimer) {
                clearTimeout(idleTimer);
            }
            idleTimer = setTimeout(() => {
                idleTimedOut = true;
                body.destroy(new RideCodexRuntimeFetchError('Codex runtime download idle timeout was exceeded.'));
            }, this.idleTimeoutMs);
        };
        const verifier = new Transform({
            transform(chunk: Buffer | string, _encoding, callback): void {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                bytes += buffer.length;
                if (bytes > runtime.compressedBytes) {
                    callback(new RideCodexRuntimeFetchError('Codex runtime download exceeded the expected byte size.'));
                    return;
                }
                hash.update(buffer);
                resetIdleTimer();
                callback(null, buffer);
            }
        });
        resetIdleTimer();
        try {
            await pipeline(
                body,
                verifier,
                fileHandleWritable(destination),
                { signal }
            );
        } catch (error) {
            if (idleTimedOut) {
                throw new RideCodexRuntimeFetchError('Codex runtime download idle timeout was exceeded.');
            }
            if (didOverallTimeout()) {
                throw new RideCodexRuntimeFetchError('Codex runtime download timed out.');
            }
            throw error;
        } finally {
            if (idleTimer) {
                clearTimeout(idleTimer);
            }
        }
        if (bytes !== runtime.compressedBytes) {
            throw new RideCodexRuntimeFetchError('Codex runtime download byte size did not match the manifest.');
        }
        const actualDigest = hash.digest();
        const expectedDigest = Buffer.from(runtime.integrity.slice('sha512-'.length), 'base64');
        if (actualDigest.length !== expectedDigest.length || !timingSafeEqual(actualDigest, expectedDigest)) {
            throw new RideCodexRuntimeFetchError('Codex runtime download integrity verification failed.');
        }
        return { bytes, integrity: `sha512-${actualDigest.toString('base64')}` };
    }
}

function fileHandleWritable(handle: FileHandle): Writable {
    let position = 0;
    return new Writable({
        write(chunk: Buffer | string, encoding, callback): void {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
            writeAll(handle, buffer, position).then(
                () => {
                    position += buffer.length;
                    callback();
                },
                error => callback(error as Error)
            );
        }
    });
}

async function writeAll(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
    let offset = 0;
    while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset);
        if (bytesWritten <= 0) {
            throw new RideCodexRuntimeFetchError('Codex runtime download could not be written safely.');
        }
        offset += bytesWritten;
    }
}

export async function validateInstallAuthorization(
    authorization: InstallAuthorization,
    validator: InstallAuthorizationValidator | undefined,
    context: InstallAuthorizationContext
): Promise<void> {
    let keys: readonly PropertyKey[];
    try {
        if (typeof authorization !== 'object' || authorization === null || !validator) {
            throw new Error('missing');
        }
        keys = Reflect.ownKeys(authorization);
    } catch {
        throw new RideCodexRuntimeFetchError('Codex runtime install authorization is required.');
    }
    if (keys.length === 0) {
        throw new RideCodexRuntimeFetchError('Codex runtime install authorization is required.');
    }
    let valid = false;
    try {
        valid = await validator(authorization, context);
    } catch {
        valid = false;
    }
    if (valid !== true) {
        throw new RideCodexRuntimeFetchError('Codex runtime install authorization is invalid.');
    }
}

export function createInstallAuthorizationContext(
    runtime: RideCodexRuntimeManifestEntry,
    canonicalRoot: string,
    destination: string
): InstallAuthorizationContext {
    return normalizeInstallAuthorizationContext(Object.freeze({
        target: runtime.target,
        manifestDigest: runtimeManifestEntryDigest(runtime),
        canonicalRoot,
        destination
    }));
}

function normalizeInstallAuthorizationContext(context: InstallAuthorizationContext): InstallAuthorizationContext {
    if (typeof context !== 'object' || context === null
        || !isRuntimeTarget(context.target)
        || typeof context.manifestDigest !== 'string'
        || !/^sha256-[a-f0-9]{64}$/.test(context.manifestDigest)
        || typeof context.canonicalRoot !== 'string'
        || !isAbsolute(context.canonicalRoot)
        || typeof context.destination !== 'string'
        || !isAbsolute(context.destination)) {
        throw new RideCodexRuntimeFetchError('Codex runtime install authorization context is invalid.');
    }
    const canonicalRoot = resolvePath(context.canonicalRoot);
    const destination = resolvePath(context.destination);
    if (!samePath(canonicalRoot, context.canonicalRoot)
        || !samePath(destination, context.destination)
        || !isStrictChild(canonicalRoot, destination)) {
        throw new RideCodexRuntimeFetchError('Codex runtime install authorization root or destination is not canonical.');
    }
    return Object.freeze({
        target: context.target,
        manifestDigest: context.manifestDigest,
        canonicalRoot,
        destination
    });
}

function validateAuthorizedFetchContext(
    context: InstallAuthorizationContext,
    runtime: RideCodexRuntimeManifestEntry,
    destination: RuntimeFetchDestination
): RideCodexRuntimeFetchDestination {
    const normalizedDestination = normalizeFetchDestination(context, destination);
    const destinationPath = normalizedDestination.path;
    const destinationRoot = normalizedDestination.canonicalRoot;
    if (!safeStringEqual(context.target, runtime.target)
        || !safeStringEqual(context.manifestDigest, runtimeManifestEntryDigest(runtime))
        || !safeStringEqual(normalizePathForComparison(context.canonicalRoot), normalizePathForComparison(destinationRoot))
        || !safeStringEqual(normalizePathForComparison(context.destination), normalizePathForComparison(destinationPath))
        || !isStrictChild(destinationRoot, destinationPath)) {
        throw new RideCodexRuntimeFetchError('Codex runtime fetch does not match its authorized install context.');
    }
    return normalizedDestination;
}

function normalizeFetchDestination(
    context: InstallAuthorizationContext,
    destination: RuntimeFetchDestination
): RideCodexRuntimeFetchDestination {
    if (typeof destination === 'string') {
        return Object.freeze({
            path: resolvePath(destination),
            canonicalRoot: resolvePath(context.canonicalRoot)
        });
    }
    try {
        const keys = Reflect.ownKeys(destination);
        if (keys.length !== 2 || !keys.includes('path') || !keys.includes('canonicalRoot')) {
            throw new Error('unexpected destination shape');
        }
        const pathDescriptor = Object.getOwnPropertyDescriptor(destination, 'path');
        const rootDescriptor = Object.getOwnPropertyDescriptor(destination, 'canonicalRoot');
        if (!pathDescriptor || !('value' in pathDescriptor) || typeof pathDescriptor.value !== 'string'
            || !rootDescriptor || !('value' in rootDescriptor) || typeof rootDescriptor.value !== 'string') {
            throw new Error('unsafe destination properties');
        }
        return Object.freeze({
            path: resolvePath(pathDescriptor.value),
            canonicalRoot: resolvePath(rootDescriptor.value)
        });
    } catch {
        throw new RideCodexRuntimeFetchError(
            'Codex runtime fetch destination is invalid or contains an external file handle.'
        );
    }
}

interface FetchFileObjectIdentity {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly birthtimeNs: bigint;
}

interface OpenedRuntimeFetchDestination extends RideCodexRuntimeFetchDestination {
    readonly handle: FileHandle;
    readonly identity: FetchFileObjectIdentity;
}

async function openAuthorizedDestination(
    destination: RideCodexRuntimeFetchDestination
): Promise<OpenedRuntimeFetchDestination> {
    let handle: FileHandle | undefined;
    try {
        await validateDestinationParent(destination);
        const flags = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL
            | (fsConstants.O_NOFOLLOW ?? 0);
        handle = await open(destination.path, flags, 0o600);
        const identity = fetchFileObjectIdentity(await handle.stat({ bigint: true }));
        const opened = Object.freeze({ ...destination, handle, identity });
        await validateOpenedDestination(opened);
        return opened;
    } catch {
        await handle?.close().catch(() => undefined);
        throw new RideCodexRuntimeFetchError(
            'Codex runtime fetch destination could not be opened as its authorized new regular file.'
        );
    }
}

async function validateDestinationParent(destination: RideCodexRuntimeFetchDestination): Promise<void> {
    const canonicalRoot = await realpath(destination.canonicalRoot);
    const canonicalParent = await realpath(dirname(destination.path));
    if (!samePath(canonicalRoot, destination.canonicalRoot)
        || (!samePath(canonicalRoot, canonicalParent) && !isStrictChild(canonicalRoot, canonicalParent))) {
        throw new RideCodexRuntimeFetchError('Codex runtime fetch destination parent escaped its authorized root.');
    }
}

async function validateOpenedDestination(destination: OpenedRuntimeFetchDestination): Promise<void> {
    try {
        const handleBefore = await destination.handle.stat({ bigint: true });
        const pathBefore = await lstat(destination.path, { bigint: true });
        const canonicalDestination = await realpath(destination.path);
        await validateDestinationParent(destination);
        const handleAfter = await destination.handle.stat({ bigint: true });
        const pathAfter = await lstat(destination.path, { bigint: true });
        if (!handleBefore.isFile() || !handleAfter.isFile()
            || !pathBefore.isFile() || pathBefore.isSymbolicLink()
            || !pathAfter.isFile() || pathAfter.isSymbolicLink()
            || handleBefore.nlink !== BigInt(1) || handleAfter.nlink !== BigInt(1)
            || pathBefore.nlink !== BigInt(1) || pathAfter.nlink !== BigInt(1)
            || !samePath(canonicalDestination, destination.path)
            || !isStrictChild(destination.canonicalRoot, canonicalDestination)
            || !fetchFileObjectIdentitiesEqual(destination.identity, fetchFileObjectIdentity(handleBefore))
            || !fetchFileObjectIdentitiesEqual(destination.identity, fetchFileObjectIdentity(handleAfter))
            || !fetchFileIdentitiesEqual(handleBefore, handleAfter)
            || !fetchFileIdentitiesEqual(handleBefore, pathBefore)
            || !fetchFileIdentitiesEqual(handleBefore, pathAfter)) {
            throw new Error('identity mismatch');
        }
    } catch {
        throw new RideCodexRuntimeFetchError(
            'Codex runtime fetch destination identity changed outside its authorized path.'
        );
    }
}

async function removeOpenedDestination(destination: OpenedRuntimeFetchDestination): Promise<void> {
    try {
        const pathStat = await lstat(destination.path, { bigint: true });
        const canonicalDestination = await realpath(destination.path);
        if (pathStat.isFile() && !pathStat.isSymbolicLink()
            && pathStat.nlink === BigInt(1)
            && samePath(canonicalDestination, destination.path)
            && isStrictChild(destination.canonicalRoot, canonicalDestination)
            && fetchFileObjectIdentitiesEqual(destination.identity, fetchFileObjectIdentity(pathStat))) {
            await rm(destination.path, { force: true });
        }
    } catch {
        // Preserve an unknown or replaced path; the staging boundary owns final cleanup.
    }
}

function fetchFileObjectIdentity(stat: BigIntStats): FetchFileObjectIdentity {
    return Object.freeze({
        dev: stat.dev,
        ino: stat.ino,
        birthtimeNs: stat.birthtimeNs
    });
}

function fetchFileObjectIdentitiesEqual(left: FetchFileObjectIdentity, right: FetchFileObjectIdentity): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.birthtimeNs === right.birthtimeNs;
}

function fetchFileIdentitiesEqual(left: BigIntStats, right: BigIntStats): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.birthtimeNs === right.birthtimeNs
        && left.ctimeNs === right.ctimeNs;
}

function isRuntimeTarget(value: unknown): value is RuntimeTarget {
    return value === 'x86_64-pc-windows-msvc'
        || value === 'aarch64-pc-windows-msvc'
        || value === 'x86_64-apple-darwin'
        || value === 'aarch64-apple-darwin'
        || value === 'x86_64-unknown-linux-musl'
        || value === 'aarch64-unknown-linux-musl';
}

function safeStringEqual(left: string, right: string): boolean {
    const leftDigest = createHash('sha256').update(left, 'utf8').digest();
    const rightDigest = createHash('sha256').update(right, 'utf8').digest();
    return timingSafeEqual(leftDigest, rightDigest);
}

function normalizePathForComparison(path: string): string {
    const normalized = resolvePath(path);
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function samePath(left: string, right: string): boolean {
    return normalizePathForComparison(left) === normalizePathForComparison(right);
}

function isStrictChild(parent: string, child: string): boolean {
    const childRelative = relative(parent, child);
    return childRelative !== '' && !childRelative.startsWith('..') && !isAbsolute(childRelative);
}

class NodeHttpsRequester implements RideCodexHttpsRequester {
    open(url: URL, request: RideCodexHttpsRequest): Promise<RideCodexHttpsResponse> {
        if (request.signal.aborted) {
            return Promise.reject(new RideCodexRuntimeFetchError('Codex runtime download was aborted.'));
        }
        return new Promise<RideCodexHttpsResponse>((resolve, reject) => {
            let settled = false;
            const finishReject = (): void => {
                if (!settled) {
                    settled = true;
                    cleanup();
                    reject(new RideCodexRuntimeFetchError('Codex runtime download connection failed.'));
                }
            };
            const clientRequest = httpsRequest(url, {
                method: 'GET',
                headers: {
                    accept: 'application/octet-stream',
                    'user-agent': 'R-IDE-Codex-Runtime/0.144.0'
                }
            }, incoming => {
                if (settled) {
                    incoming.destroy();
                    return;
                }
                settled = true;
                cleanup();
                resolve({
                    statusCode: incoming.statusCode ?? 0,
                    headers: incoming.headers,
                    body: incoming
                });
            });
            const connectTimer = setTimeout(() => {
                clientRequest.destroy(new RideCodexRuntimeFetchError('Codex runtime download connection timed out.'));
            }, request.connectTimeoutMs);
            const onAbort = (): void => {
                clientRequest.destroy(new RideCodexRuntimeFetchError('Codex runtime download was aborted.'));
            };
            const cleanup = (): void => {
                clearTimeout(connectTimer);
                request.signal.removeEventListener('abort', onAbort);
                clientRequest.removeListener('error', finishReject);
            };
            clientRequest.once('error', finishReject);
            request.signal.addEventListener('abort', onAbort, { once: true });
            if (request.signal.aborted) {
                onAbort();
            } else {
                clientRequest.end();
            }
        });
    }
}

function requireAllowedRuntimeUrl(value: string, initial: boolean): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new RideCodexRuntimeFetchError('Codex runtime download URL is invalid.');
    }
    if (url.protocol !== 'https:' || url.origin !== ALLOWED_ORIGIN || url.username || url.password
        || url.hash || (url.port && url.port !== '443')) {
        throw new RideCodexRuntimeFetchError(
            initial ? 'Codex runtime download URL is not allowed.' : 'Codex runtime redirect origin or credentials are not allowed.'
        );
    }
    return url;
}

function validateContentLength(
    headers: Readonly<Record<string, string | readonly string[] | undefined>>,
    expectedBytes: number
): void {
    const value = singleHeader(headers, 'content-length');
    if (value === undefined) {
        return;
    }
    if (!/^\d+$/.test(value)) {
        throw new RideCodexRuntimeFetchError('Codex runtime download Content-Length is invalid.');
    }
    const length = Number(value);
    if (!Number.isSafeInteger(length) || length !== expectedBytes) {
        throw new RideCodexRuntimeFetchError('Codex runtime download Content-Length does not match the manifest size.');
    }
}

function singleHeader(
    headers: Readonly<Record<string, string | readonly string[] | undefined>>,
    name: string
): string | undefined {
    const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name);
    const value = key ? headers[key] : undefined;
    return typeof value === 'string' ? value : undefined;
}

function isRedirectStatus(statusCode: number): boolean {
    return statusCode === 301 || statusCode === 302 || statusCode === 303
        || statusCode === 307 || statusCode === 308;
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        return Promise.reject(new RideCodexRuntimeFetchError('Codex runtime download was aborted.'));
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
            cleanup();
            reject(new RideCodexRuntimeFetchError('Codex runtime download was aborted.'));
        };
        const cleanup = (): void => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            value => {
                cleanup();
                resolve(value);
            },
            () => {
                cleanup();
                reject(new RideCodexRuntimeFetchError('Codex runtime download connection failed.'));
            }
        );
    });
}

function positiveDuration(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && value! >= 0 ? value! : fallback;
}
