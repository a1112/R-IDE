/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fsPromises } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createGzip, gzipSync, gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import { Headers, pack } from 'tar-stream';
import {
    parseRideCodexRuntimeManifest,
    RIDE_CODEX_RUNTIME_MANIFEST,
    RideCodexRuntimeManifestEntry,
    runtimeManifestEntryDigest
} from '../src/node/ride-codex-runtime-manifest';
import {
    createInstallAuthorizationContext,
    InstallAuthorizationContext,
    RideCodexHttpsRequest,
    RideCodexHttpsRequester,
    RideCodexHttpsResponse,
    RideCodexRuntimeFetchCapability,
    RideCodexRuntimeFetchDestination,
    RideCodexRuntimeFetcher,
    RuntimeFetchDestination,
    validateInstallAuthorization
} from '../src/node/ride-codex-runtime-fetcher';
import {
    InstallAuthorization,
    requiredRuntimeStageBytes,
    RIDE_CODEX_RUNTIME_STAGE_SAFETY_MARGIN_BYTES,
    RideCodexRuntimeArchiveExtractor,
    RideCodexRuntimeStager,
    RuntimeFilesystemIdentity,
    runtimeFilesystemIdentitiesEqual
} from '../src/node/ride-codex-runtime-stager';
import { RideCodexRuntimeProbeLike } from '../src/node/ride-codex-runtime-probe';

const EXPECTED_RUNTIMES: readonly RideCodexRuntimeManifestEntry[] = [
    {
        package: '@openai/codex', version: '0.144.0', npmVersion: '0.144.0-win32-x64',
        target: 'x86_64-pc-windows-msvc',
        url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.144.0-win32-x64.tgz',
        integrity: 'sha512-QiholLCYqNeYvNM77HOmPtrOFrY0rQc/N9nXt+sQGXO3rEGmcWjpLzujY4Oegl3CLRHoieWqlep3EqEvFBjoIA==',
        compressedBytes: 145137410, unpackedBytes: 409204884, layoutVersion: 1, entrypoint: 'bin/codex.exe'
    },
    {
        package: '@openai/codex', version: '0.144.0', npmVersion: '0.144.0-win32-arm64',
        target: 'aarch64-pc-windows-msvc',
        url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.144.0-win32-arm64.tgz',
        integrity: 'sha512-e2yGSgwdzrT1SoJMoOzWD58WBEsIaAMZpEchuV2VGkE2T955SG7dn7EyVQTQcy7/rdpE8aEDktZ/1eQQfjkdtQ==',
        compressedBytes: 136015165, unpackedBytes: 356429977, layoutVersion: 1, entrypoint: 'bin/codex.exe'
    },
    {
        package: '@openai/codex', version: '0.144.0', npmVersion: '0.144.0-darwin-x64',
        target: 'x86_64-apple-darwin',
        url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.144.0-darwin-x64.tgz',
        integrity: 'sha512-4p2jxRbN+Khg5UQzpkzT9upFj+qkEF/abmdvrtflkkWmVKP6Nt+yi8ospdqv9PDqvQ9SotPvX7iXaFaeUTrtmA==',
        compressedBytes: 128742068, unpackedBytes: 337146266, layoutVersion: 1, entrypoint: 'bin/codex'
    },
    {
        package: '@openai/codex', version: '0.144.0', npmVersion: '0.144.0-darwin-arm64',
        target: 'aarch64-apple-darwin',
        url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.144.0-darwin-arm64.tgz',
        integrity: 'sha512-rqFAJdOa2I0VRgepVsSZeLxs96+Y+LXTjccOOvH6894FyaFAYPZ/o+6hgpB1iGHxxdoY/DsGa8jrJC8Leqn9Kg==',
        compressedBytes: 120229260, unpackedBytes: 311534939, layoutVersion: 1, entrypoint: 'bin/codex'
    },
    {
        package: '@openai/codex', version: '0.144.0', npmVersion: '0.144.0-linux-x64',
        target: 'x86_64-unknown-linux-musl',
        url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.144.0-linux-x64.tgz',
        integrity: 'sha512-GmKtQeX+cO9lN7mQD1FEVcXYEMLMgMByHwZdvlluH0bj/+c2ind3hwbRtE3eECFDekNhEiB80Ez0FfbkyFQqoA==',
        compressedBytes: 131150753, unpackedBytes: 351492154, layoutVersion: 1, entrypoint: 'bin/codex'
    },
    {
        package: '@openai/codex', version: '0.144.0', npmVersion: '0.144.0-linux-arm64',
        target: 'aarch64-unknown-linux-musl',
        url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.144.0-linux-arm64.tgz',
        integrity: 'sha512-k++xhZrn9P3laO00Q92APG6mdOFDD66nUBo+8ExCa1NXi2pjLEMLC4+UNJTUUtUT1PEflOZ5pDKxPXgzaiFFFg==',
        compressedBytes: 123658222, unpackedBytes: 308463407, layoutVersion: 1, entrypoint: 'bin/codex'
    }
];

test('pins and deeply freezes the exact six-target Codex runtime manifest', async () => {
    const manifestPath = resolve(process.cwd(), 'resources/codex-runtime-manifest.json');
    const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
    const parsed = parseRideCodexRuntimeManifest(raw);

    assert.deepEqual(parsed, RIDE_CODEX_RUNTIME_MANIFEST);
    assert.deepEqual(parsed.runtimes, EXPECTED_RUNTIMES);
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(Object.isFrozen(parsed.runtimes), true);
    assert.ok(parsed.runtimes.every(Object.isFrozen));
    assert.equal(new Set(parsed.runtimes.map(runtime => runtime.target)).size, 6);
    assert.ok(parsed.runtimes.every(runtime => {
        const url = new URL(runtime.url);
        return url.protocol === 'https:'
            && url.hostname === 'registry.npmjs.org'
            && !url.username && !url.password
            && !/latest|\^|~/i.test(`${runtime.version}${runtime.npmVersion}${runtime.url}`)
            && /^sha512-[A-Za-z0-9+/]{86}==$/.test(runtime.integrity);
    }));
});

test('manifest parsing rejects duplicate, mutable, or unsafe runtime metadata', () => {
    const valid = {
        schemaVersion: 1,
        runtimes: EXPECTED_RUNTIMES.map(runtime => ({ ...runtime }))
    };
    const cases: unknown[] = [
        { ...valid, schemaVersion: 2 },
        { ...valid, runtimes: [...valid.runtimes, { ...valid.runtimes[0] }] },
        { ...valid, runtimes: valid.runtimes.map((entry, index) => index ? entry : { ...entry, package: '@evil/codex' }) },
        { ...valid, runtimes: valid.runtimes.map((entry, index) => index ? entry : { ...entry, version: 'latest' }) },
        { ...valid, runtimes: valid.runtimes.map((entry, index) => index ? entry : { ...entry, npmVersion: '^0.144.0' }) },
        { ...valid, runtimes: valid.runtimes.map((entry, index) => index ? entry : { ...entry, url: 'http://registry.npmjs.org/codex.tgz' }) },
        { ...valid, runtimes: valid.runtimes.map((entry, index) => index ? entry : { ...entry, url: 'https://user:pass@registry.npmjs.org/codex.tgz' }) },
        { ...valid, runtimes: valid.runtimes.map((entry, index) => index ? entry : { ...entry, integrity: 'sha512-not-valid' }) },
        { ...valid, runtimes: valid.runtimes.map((entry, index) => index ? entry : { ...entry, compressedBytes: 0 }) },
        { ...valid, runtimes: valid.runtimes.map((entry, index) => index ? entry : { ...entry, entrypoint: '../codex' }) }
    ];
    for (const candidate of cases) {
        assert.throws(() => parseRideCodexRuntimeManifest(candidate), /manifest/i);
    }
});

const AUTHORIZATION = Object.freeze({ consent: Symbol('install-consent') }) as InstallAuthorization;

test('staging rejects missing or invalid authorization before statfs or network access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-invalid-authorization-'));
    let validations = 0;
    let statfsCalls = 0;
    let fetchCalls = 0;
    const stager = new RideCodexRuntimeStager({
        trustedRuntimeBase: root,
        runtimeRoot: join(root, 'runtime'),
        authorizationValidator: async authorization => {
            validations += 1;
            return authorization === AUTHORIZATION;
        },
        statfs: async () => {
            statfsCalls += 1;
            return { bsize: 4096, bavail: 1_000_000 };
        },
        fetcher: {
            authorize: async (authorization, context) => {
                await validateInstallAuthorization(authorization, async candidate => {
                    validations += 1;
                    return candidate === AUTHORIZATION;
                }, context);
                return authorization as RideCodexRuntimeFetchCapability;
            },
            fetchAuthorized: async () => {
                fetchCalls += 1;
                throw new Error('network must not be reached');
            }
        }
    });

    try {
        for (const authorization of [undefined, null, {}, Object.freeze({ wrong: true })]) {
            await assert.rejects(
                stager.stage(authorization as InstallAuthorization, 'x86_64-pc-windows-msvc'),
                /authorization/i
            );
        }
        assert.equal(validations, 1);
        assert.equal(statfsCalls, 0);
        assert.equal(fetchCalls, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('staging checks Node statfs capacity before creating a staging directory or fetching', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-stage-space-'));
    let fetchCalls = 0;
    try {
        const entry = RIDE_CODEX_RUNTIME_MANIFEST.runtimes[0];
        assert.equal(
            requiredRuntimeStageBytes(entry),
            entry.compressedBytes + entry.unpackedBytes + RIDE_CODEX_RUNTIME_STAGE_SAFETY_MARGIN_BYTES
        );
        const stager = new RideCodexRuntimeStager({
            trustedRuntimeBase: root,
            runtimeRoot: root,
            authorizationValidator: authorization => authorization === AUTHORIZATION,
            statfs: async () => ({
                bsize: 1,
                bavail: requiredRuntimeStageBytes(entry) - 1
            }),
            fetcher: {
                authorize: async (authorization, context) => {
                    await validateInstallAuthorization(authorization, candidate => candidate === AUTHORIZATION, context);
                    return authorization as RideCodexRuntimeFetchCapability;
                },
                fetchAuthorized: async () => {
                    fetchCalls += 1;
                    throw new Error('network must not be reached');
                }
            }
        });

        await assert.rejects(stager.stage(AUTHORIZATION, entry.target), /disk|space/i);
        assert.equal(fetchCalls, 0);
        assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(root)), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

class ScriptedRequester implements RideCodexHttpsRequester {
    readonly calls: Array<{ readonly url: string; readonly request: RideCodexHttpsRequest }> = [];

    constructor(private readonly responses: Array<RideCodexHttpsResponse | Error | (() => Promise<RideCodexHttpsResponse>)>) { }

    async open(url: URL, request: RideCodexHttpsRequest): Promise<RideCodexHttpsResponse> {
        this.calls.push({ url: url.href, request });
        const response = this.responses.shift();
        if (!response) {
            throw new Error('unexpected request');
        }
        if (response instanceof Error) {
            throw response;
        }
        return typeof response === 'function' ? response() : response;
    }
}

function sha512Integrity(bytes: Uint8Array): string {
    return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

async function writeFetchDestination(destination: RuntimeFetchDestination, bytes: Uint8Array): Promise<void> {
    await writeFile(typeof destination === 'string' ? destination : destination.path, bytes, { flag: 'wx', mode: 0o600 });
}

function fetchEntry(bytes: Uint8Array, overrides: Partial<RideCodexRuntimeManifestEntry> = {}): RideCodexRuntimeManifestEntry {
    return Object.freeze({
        ...RIDE_CODEX_RUNTIME_MANIFEST.runtimes[4],
        compressedBytes: bytes.byteLength,
        integrity: sha512Integrity(bytes),
        ...overrides
    });
}

function response(
    body: Readable,
    statusCode = 200,
    headers: Readonly<Record<string, string | readonly string[] | undefined>> = {}
): RideCodexHttpsResponse {
    return { statusCode, headers, body };
}

test('fetcher streams an exact response to disk and verifies byte count and SHA-512 SRI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-'));
    const bytes = Buffer.from('small streamed fixture');
    const requester = new ScriptedRequester([
        response(Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]), 200, { 'content-length': String(bytes.length) })
    ]);
    try {
        const destination = join(root, 'runtime.tgz');
        const fetcher = new RideCodexRuntimeFetcher({
            authorizationValidator: authorization => authorization === AUTHORIZATION,
            requester
        });
        const result = await fetcher.fetch(AUTHORIZATION, fetchEntry(bytes), destination);

        assert.deepEqual(await readFile(destination), bytes);
        assert.equal(result.bytes, bytes.length);
        assert.equal(result.integrity, sha512Integrity(bytes));
        assert.equal(requester.calls.length, 1);
        assert.equal(requester.calls[0].url, RIDE_CODEX_RUNTIME_MANIFEST.runtimes[4].url);
        assert.ok(requester.calls[0].request.connectTimeoutMs > 0);
        assert.equal(Object.isFrozen(result), true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('fetch authorization capability is context-bound, instance-bound, unforgeable, and consumed exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-capability-'));
    const otherRoot = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-capability-other-'));
    const bytes = Buffer.from('one-shot capability');
    const requester = new ScriptedRequester([response(Readable.from([bytes]))]);
    let validations = 0;
    let externalAuthorizationConsumed = false;
    const validatedContexts: InstallAuthorizationContext[] = [];
    const first = new RideCodexRuntimeFetcher({
        authorizationValidator: (authorization, context) => {
            validations += 1;
            validatedContexts.push(context);
            if (externalAuthorizationConsumed || authorization !== AUTHORIZATION) {
                return false;
            }
            externalAuthorizationConsumed = true;
            return true;
        },
        requester
    });
    const second = new RideCodexRuntimeFetcher({
        authorizationValidator: () => true,
        requester: new ScriptedRequester([])
    });
    const runtime = fetchEntry(bytes);
    const destinationPath = join(root, 'runtime.tgz');
    const context = createInstallAuthorizationContext(runtime, await realpath(root), destinationPath);
    const capability = await first.authorize(AUTHORIZATION, context);
    const forged = Object.freeze(Object.create(null)) as RideCodexRuntimeFetchCapability;
    const destination: RideCodexRuntimeFetchDestination = Object.freeze({
        path: destinationPath,
        canonicalRoot: await realpath(root)
    });
    try {
        await assert.rejects(
            first.fetchAuthorized(forged, runtime, destination),
            /authorization|capability/i
        );
        await assert.rejects(
            second.fetchAuthorized(capability, runtime, destination),
            /authorization|capability/i
        );
        const result = await first.fetchAuthorized(capability, runtime, destination);
        assert.equal(result.bytes, bytes.length);
        assert.deepEqual(await readFile(destinationPath), bytes);
        const renamedPath = join(root, 'closed-owned-handle.tgz');
        await rename(destinationPath, renamedPath);
        assert.deepEqual(await readFile(renamedPath), bytes);
        await assert.rejects(
            first.fetchAuthorized(capability, runtime, destination),
            /authorization|capability/i
        );
        assert.equal(validations, 1);
        assert.deepEqual(validatedContexts, [context]);
        assert.equal(Object.isFrozen(context), true);
        assert.equal(context.target, runtime.target);
        assert.equal(context.manifestDigest, runtimeManifestEntryDigest(runtime));
        assert.equal(context.canonicalRoot, await realpath(root));
        assert.equal(requester.calls.length, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(otherRoot, { recursive: true, force: true });
    }
});

test('fetch authorization context rejects target, manifest digest, root, and destination substitution before network', async t => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-context-'));
    const otherRoot = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-context-other-'));
    const bytes = Buffer.from('context-bound capability');
    const requester = new ScriptedRequester([]);
    const fetcher = new RideCodexRuntimeFetcher({ authorizationValidator: () => true, requester });
    const runtime = fetchEntry(bytes);
    const canonicalRoot = await realpath(root);
    const otherCanonicalRoot = await realpath(otherRoot);

    const attempt = async (
        name: string,
        candidateRuntime: RideCodexRuntimeManifestEntry,
        destinationRoot: string,
        destinationPath: string,
        authorizedDestination: string = destinationPath
    ): Promise<void> => {
        await t.test(name, async () => {
            const context = createInstallAuthorizationContext(runtime, canonicalRoot, authorizedDestination);
            const capability = await fetcher.authorize(AUTHORIZATION, context);
            const handle = await open(destinationPath, 'wx+', 0o600);
            try {
                await assert.rejects(
                    fetcher.fetchAuthorized(capability, candidateRuntime, Object.freeze({
                        path: destinationPath,
                        canonicalRoot: destinationRoot,
                        handle
                    })),
                    /authorization|context|target|manifest|root|destination/i
                );
            } finally {
                await handle.close();
                await rm(destinationPath, { force: true });
            }
        });
    };

    try {
        await attempt(
            'target B',
            RIDE_CODEX_RUNTIME_MANIFEST.runtimes[5],
            canonicalRoot,
            join(root, 'target-b.tgz')
        );
        await attempt(
            'manifest digest B',
            Object.freeze({ ...runtime, integrity: sha512Integrity(Buffer.from('other digest')) }),
            canonicalRoot,
            join(root, 'digest-b.tgz')
        );
        await attempt(
            'canonical root B', runtime, otherCanonicalRoot, join(otherRoot, 'root-b.tgz'), join(root, 'authorized-root-a.tgz')
        );
        await attempt(
            'destination escape', runtime, canonicalRoot, join(otherRoot, 'escape.tgz'), join(root, 'authorized-escape-a.tgz')
        );
        assert.equal(requester.calls.length, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(otherRoot, { recursive: true, force: true });
    }
});

test('fetch authorization capability rejects a sibling destination before network access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-sibling-destination-'));
    const bytes = Buffer.from('exact destination capability');
    const requester = new ScriptedRequester([response(Readable.from([bytes]))]);
    const fetcher = new RideCodexRuntimeFetcher({ authorizationValidator: () => true, requester });
    const runtime = fetchEntry(bytes);
    const canonicalRoot = await realpath(root);
    const authorizedPath = join(canonicalRoot, 'authorized-runtime.tgz');
    const siblingPath = join(canonicalRoot, 'sibling-runtime.tgz');
    const context = createInstallAuthorizationContext(runtime, canonicalRoot, authorizedPath);
    const capability = await fetcher.authorize(AUTHORIZATION, context);
    const siblingHandle = await open(siblingPath, 'wx+', 0o600);
    try {
        await assert.rejects(
            fetcher.fetchAuthorized(capability, runtime, Object.freeze({
                path: siblingPath,
                canonicalRoot,
                handle: siblingHandle
            })),
            /authorization|context|destination/i
        );
        assert.equal(requester.calls.length, 0);
    } finally {
        await siblingHandle.close().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
    }
});

test('fetch authorization rejects a handle for a file outside the authorized destination before network access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-handle-binding-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-handle-binding-outside-'));
    const bytes = Buffer.from('must not be written outside the authorized root');
    const sentinel = 'outside sentinel must remain unchanged';
    const requester = new ScriptedRequester([response(Readable.from([bytes]))]);
    const fetcher = new RideCodexRuntimeFetcher({ authorizationValidator: () => true, requester });
    const runtime = fetchEntry(bytes);
    const canonicalRoot = await realpath(root);
    const authorizedPath = join(canonicalRoot, 'runtime.tgz');
    const outsidePath = join(outsideRoot, 'outside.tgz');
    await writeFile(authorizedPath, '');
    await writeFile(outsidePath, sentinel);
    const outsideHandle = await open(outsidePath, 'r+');
    try {
        const capability = await fetcher.authorize(
            AUTHORIZATION,
            createInstallAuthorizationContext(runtime, canonicalRoot, authorizedPath)
        );
        await assert.rejects(
            fetcher.fetchAuthorized(capability, runtime, Object.freeze({
                path: authorizedPath,
                canonicalRoot,
                handle: outsideHandle
            })),
            /authorization|destination|handle|identity/i
        );
        assert.equal(requester.calls.length, 0);
        assert.equal(await readFile(outsidePath, 'utf8'), sentinel);

        const authorizedHandle = await open(authorizedPath, 'r+');
        try {
            await assert.rejects(
                fetcher.fetchAuthorized(capability, runtime, Object.freeze({
                    path: authorizedPath,
                    canonicalRoot,
                    handle: authorizedHandle
                })),
                /authorization|capability|already used/i
            );
        } finally {
            await authorizedHandle.close();
        }
    } finally {
        await outsideHandle.close().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
        await rm(outsideRoot, { recursive: true, force: true });
    }
});

test('fetch authorization rejects a structural fake file handle before network access and consumes capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-fake-handle-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-fake-handle-outside-'));
    const bytes = Buffer.from('must remain inside the authorized destination');
    const sentinel = 'outside sentinel must remain unchanged';
    const requester = new ScriptedRequester([response(Readable.from([bytes]))]);
    const fetcher = new RideCodexRuntimeFetcher({ authorizationValidator: () => true, requester });
    const runtime = fetchEntry(bytes);
    const canonicalRoot = await realpath(root);
    const authorizedPath = join(canonicalRoot, 'runtime.tgz');
    const outsidePath = join(outsideRoot, 'outside.tgz');
    await writeFile(authorizedPath, '');
    await writeFile(outsidePath, sentinel);
    const authorizedHandle = await open(authorizedPath, 'r+');
    const outsideHandle = await open(outsidePath, 'r+');
    const fakeHandle = Object.freeze({
        fd: authorizedHandle.fd,
        stat: authorizedHandle.stat.bind(authorizedHandle),
        write: outsideHandle.write.bind(outsideHandle),
        sync: outsideHandle.sync.bind(outsideHandle),
        close: outsideHandle.close.bind(outsideHandle)
    }) as unknown as typeof authorizedHandle;
    try {
        const capability = await fetcher.authorize(
            AUTHORIZATION,
            createInstallAuthorizationContext(runtime, canonicalRoot, authorizedPath)
        );
        await assert.rejects(
            fetcher.fetchAuthorized(capability, runtime, Object.freeze({
                path: authorizedPath,
                canonicalRoot,
                handle: fakeHandle
            })),
            /authorization|destination|handle/i
        );
        assert.equal(requester.calls.length, 0);
        assert.equal(await readFile(outsidePath, 'utf8'), sentinel);
        await assert.rejects(
            fetcher.fetchAuthorized(capability, runtime, Object.freeze({
                path: authorizedPath,
                canonicalRoot,
                handle: authorizedHandle
            })),
            /authorization|capability|already used/i
        );
    } finally {
        await authorizedHandle.close().catch(() => undefined);
        await outsideHandle.close().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
        await rm(outsideRoot, { recursive: true, force: true });
    }
});

test('fetch authorization rejects a closed legacy file handle before network access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-closed-handle-'));
    const bytes = Buffer.from('closed caller handles are never trusted');
    const requester = new ScriptedRequester([response(Readable.from([bytes]))]);
    const fetcher = new RideCodexRuntimeFetcher({ authorizationValidator: () => true, requester });
    const runtime = fetchEntry(bytes);
    const canonicalRoot = await realpath(root);
    const destinationPath = join(canonicalRoot, 'runtime.tgz');
    const closedHandle = await open(destinationPath, 'wx+', 0o600);
    await closedHandle.close();
    const capability = await fetcher.authorize(
        AUTHORIZATION,
        createInstallAuthorizationContext(runtime, canonicalRoot, destinationPath)
    );
    try {
        await assert.rejects(
            fetcher.fetchAuthorized(capability, runtime, Object.freeze({
                path: destinationPath,
                canonicalRoot,
                handle: closedHandle
            })),
            /authorization|destination|handle/i
        );
        assert.equal(requester.calls.length, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('internally owned fetch destination rejects a pre-existing symbolic link before network access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-link-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-link-outside-'));
    const bytes = Buffer.from('links must not be followed');
    const sentinel = 'linked sentinel must remain unchanged';
    const requester = new ScriptedRequester([response(Readable.from([bytes]))]);
    const fetcher = new RideCodexRuntimeFetcher({ authorizationValidator: () => true, requester });
    const runtime = fetchEntry(bytes);
    const canonicalRoot = await realpath(root);
    const destinationPath = join(canonicalRoot, 'runtime.tgz');
    const outsidePath = join(outsideRoot, 'outside.tgz');
    await writeFile(outsidePath, sentinel);
    await symlink(outsidePath, destinationPath, 'file');
    const capability = await fetcher.authorize(
        AUTHORIZATION,
        createInstallAuthorizationContext(runtime, canonicalRoot, destinationPath)
    );
    try {
        await assert.rejects(
            fetcher.fetchAuthorized(capability, runtime, Object.freeze({
                path: destinationPath,
                canonicalRoot
            })),
            /authorization|destination|regular file|opened/i
        );
        assert.equal(requester.calls.length, 0);
        assert.equal(await readFile(outsidePath, 'utf8'), sentinel);
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outsideRoot, { recursive: true, force: true });
    }
});

test('fetcher owns and closes its native destination handle after a successful authorized fetch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-owned-handle-'));
    const bytes = Buffer.from('the fetcher owns this native handle');
    const requester = new ScriptedRequester([response(Readable.from([bytes]))]);
    const fetcher = new RideCodexRuntimeFetcher({ authorizationValidator: () => true, requester });
    const runtime = fetchEntry(bytes);
    const canonicalRoot = await realpath(root);
    const destinationPath = join(canonicalRoot, 'runtime.tgz');
    const renamedPath = join(canonicalRoot, 'renamed-after-close.tgz');
    try {
        const capability = await fetcher.authorize(
            AUTHORIZATION,
            createInstallAuthorizationContext(runtime, canonicalRoot, destinationPath)
        );
        await fetcher.fetchAuthorized(capability, runtime, Object.freeze({
            path: destinationPath,
            canonicalRoot
        }));
        await rename(destinationPath, renamedPath);
        assert.deepEqual(await readFile(renamedPath), bytes);
        assert.equal(requester.calls.length, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('internally owned fetch destination detects path replacement during download and preserves the replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-midstream-replacement-'));
    const bytes = Buffer.from('bytes stay on the originally opened inode');
    const sentinel = 'replacement sentinel must remain unchanged';
    const runtime = fetchEntry(bytes);
    const canonicalRoot = await realpath(root);
    const destinationPath = join(canonicalRoot, 'runtime.tgz');
    const retainedPath = join(canonicalRoot, 'retained-open-inode.tgz');
    const requester = new ScriptedRequester([
        async () => {
            await rename(destinationPath, retainedPath);
            await writeFile(destinationPath, sentinel, { flag: 'wx' });
            return response(Readable.from([bytes]));
        }
    ]);
    const fetcher = new RideCodexRuntimeFetcher({ authorizationValidator: () => true, requester });
    try {
        const capability = await fetcher.authorize(
            AUTHORIZATION,
            createInstallAuthorizationContext(runtime, canonicalRoot, destinationPath)
        );
        await assert.rejects(
            fetcher.fetchAuthorized(capability, runtime, Object.freeze({
                path: destinationPath,
                canonicalRoot
            })),
            /destination|identity|authorized path/i
        );
        assert.equal(requester.calls.length, 1);
        assert.equal(await readFile(destinationPath, 'utf8'), sentinel);
        assert.deepEqual(await readFile(retainedPath), bytes);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('internally owned fetch destination rejects path replacement before network access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-open-handle-'));
    const bytes = Buffer.from('write only to the authorized open inode');
    const requester = new ScriptedRequester([response(Readable.from([bytes]))]);
    const fetcher = new RideCodexRuntimeFetcher({ authorizationValidator: () => true, requester });
    const runtime = fetchEntry(bytes);
    const canonicalRoot = await realpath(root);
    const destinationPath = join(root, 'runtime.tgz');
    try {
        const capability = await fetcher.authorize(
            AUTHORIZATION,
            createInstallAuthorizationContext(runtime, canonicalRoot, destinationPath)
        );
        await writeFile(destinationPath, 'external sentinel', { flag: 'wx' });
        await assert.rejects(
            fetcher.fetchAuthorized(capability, runtime, Object.freeze({
                path: destinationPath,
                canonicalRoot
            })),
            /authorization|destination|regular file|opened/i
        );
        assert.equal(requester.calls.length, 0);
        assert.equal(await readFile(destinationPath, 'utf8'), 'external sentinel');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('runtime filesystem identity preserves bigint values beyond Number safe precision', () => {
    const high = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1);
    const first: RuntimeFilesystemIdentity = Object.freeze({
        dev: high,
        ino: high,
        size: BigInt(0),
        birthtimeNs: high,
        ctimeNs: high
    });
    const second: RuntimeFilesystemIdentity = Object.freeze({ ...first, ino: high + BigInt(1) });
    assert.equal(runtimeFilesystemIdentitiesEqual(first, first), true);
    assert.equal(runtimeFilesystemIdentitiesEqual(first, second), false);
    assert.equal(typeof first.ino, 'bigint');
});

test('fetcher itself rejects missing authorization and same-origin non-manifest paths before network', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-boundary-'));
    const bytes = Buffer.from('boundary');
    const requester = new ScriptedRequester([response(Readable.from([bytes]))]);
    try {
        const fetcher = new RideCodexRuntimeFetcher({
            authorizationValidator: authorization => authorization === AUTHORIZATION,
            requester
        });
        await assert.rejects(
            fetcher.fetch({} as InstallAuthorization, fetchEntry(bytes), join(root, 'unauthorized.tgz')),
            /authorization/i
        );
        await assert.rejects(
            fetcher.fetch(AUTHORIZATION, fetchEntry(bytes, {
                url: 'https://registry.npmjs.org/unreviewed/runtime.tgz'
            }), join(root, 'wrong-path.tgz')),
            /url|manifest|package/i
        );
        assert.equal(requester.calls.length, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('fetcher rejects unsafe redirects, loops, credentials, hash mismatch, and oversized bodies without partial files', async t => {
    const bytes = Buffer.from('expected');
    const cases: ReadonlyArray<{
        readonly name: string;
        readonly entry?: RideCodexRuntimeManifestEntry;
        readonly responses: Array<RideCodexHttpsResponse | Error>;
        readonly expected: RegExp;
    }> = [
        {
            name: 'hash mismatch',
            entry: fetchEntry(bytes, { integrity: sha512Integrity(Buffer.from('different')) }),
            responses: [response(Readable.from([bytes]))], expected: /integrity|hash/i
        },
        {
            name: 'actual body oversize',
            responses: [response(Readable.from([bytes, Buffer.from('!')]))], expected: /size|large|bytes/i
        },
        {
            name: 'content length oversize',
            responses: [response(Readable.from([bytes]), 200, { 'content-length': String(bytes.length + 1) })],
            expected: /length|size|large/i
        },
        {
            name: 'cross origin redirect',
            responses: [response(Readable.from([]), 302, { location: 'https://example.com/runtime.tgz' })],
            expected: /redirect|url|origin/i
        },
        {
            name: 'credential redirect',
            responses: [response(Readable.from([]), 302, { location: 'https://user:pass@registry.npmjs.org/runtime.tgz' })],
            expected: /redirect|url|credential/i
        },
        {
            name: 'redirect loop',
            responses: [response(Readable.from([]), 302, { location: RIDE_CODEX_RUNTIME_MANIFEST.runtimes[4].url })],
            expected: /redirect|loop/i
        }
    ];

    for (const entry of cases) {
        await t.test(entry.name, async () => {
            const root = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-fail-'));
            const destination = join(root, 'partial.tgz');
            try {
                const fetcher = new RideCodexRuntimeFetcher({
                    authorizationValidator: authorization => authorization === AUTHORIZATION,
                    requester: new ScriptedRequester([...entry.responses])
                });
                await assert.rejects(fetcher.fetch(AUTHORIZATION, entry.entry ?? fetchEntry(bytes), destination), entry.expected);
                await assert.rejects(readFile(destination), /ENOENT/);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
    }
});

test('fetcher permits at most three same-origin redirects and validates every hop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-redirect-'));
    const bytes = Buffer.from('redirected');
    const requester = new ScriptedRequester([
        response(Readable.from([]), 302, { location: '/redirect-1.tgz' }),
        response(Readable.from([]), 307, { location: '/redirect-2.tgz' }),
        response(Readable.from([]), 308, { location: '/redirect-3.tgz' }),
        response(Readable.from([bytes]), 200, { 'content-length': String(bytes.length) })
    ]);
    try {
        const destination = join(root, 'runtime.tgz');
        const fetcher = new RideCodexRuntimeFetcher({
            authorizationValidator: authorization => authorization === AUTHORIZATION,
            requester,
            maxRedirects: 3
        });
        await fetcher.fetch(AUTHORIZATION, fetchEntry(bytes), destination);
        assert.equal(requester.calls.length, 4);
        assert.ok(requester.calls.every(call => new URL(call.url).origin === 'https://registry.npmjs.org'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('fetcher destroys a response rejected before streaming begins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-preflight-'));
    const bytes = Buffer.from('preflight');
    const body = Readable.from([bytes]);
    try {
        const fetcher = new RideCodexRuntimeFetcher({
            authorizationValidator: authorization => authorization === AUTHORIZATION,
            requester: new ScriptedRequester([
                response(body, 200, { 'content-length': String(bytes.length + 1) })
            ])
        });
        await assert.rejects(fetcher.fetch(
            AUTHORIZATION,
            fetchEntry(bytes),
            join(root, 'partial.tgz')
        ), /length|size/i);
        assert.equal(body.destroyed, true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('fetcher aborts connect, idle, overall, and stream failures and removes partial files', async t => {
    const bytes = Buffer.from('timeout');
    const cases: ReadonlyArray<{
        readonly name: string;
        readonly requester: ScriptedRequester;
        readonly signal?: AbortSignal;
        readonly options?: { readonly idleTimeoutMs?: number; readonly overallTimeoutMs?: number };
    }> = [
        {
            name: 'external abort',
            requester: new ScriptedRequester([() => new Promise(() => undefined)]),
            signal: AbortSignal.abort()
        },
        {
            name: 'overall timeout',
            requester: new ScriptedRequester([() => new Promise(() => undefined)]),
            options: { overallTimeoutMs: 15 }
        },
        {
            name: 'idle timeout',
            requester: new ScriptedRequester([response(new Readable({ read() { /* stays idle */ } }))]),
            options: { idleTimeoutMs: 15, overallTimeoutMs: 100 }
        },
        {
            name: 'stream error',
            requester: new ScriptedRequester([response(Readable.from((async function* () {
                yield bytes.subarray(0, 2);
                throw new Error('unsafe upstream detail');
            })()))])
        }
    ];
    for (const entry of cases) {
        await t.test(entry.name, async () => {
            const root = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-abort-'));
            const destination = join(root, 'partial.tgz');
            try {
                const fetcher = new RideCodexRuntimeFetcher({
                    authorizationValidator: authorization => authorization === AUTHORIZATION,
                    requester: entry.requester,
                    ...entry.options
                });
                await assert.rejects(fetcher.fetch(AUTHORIZATION, fetchEntry(bytes), destination, entry.signal), /abort|timeout|download|stream/i);
                await assert.rejects(readFile(destination), /ENOENT/);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
    }
});

test('staging consumes a single-use external authorization once before statfs and download', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-stage-capability-'));
    const archive = await tarGz(validArchiveEntries());
    const entry = RIDE_CODEX_RUNTIME_MANIFEST.runtimes[4];
    const capabilities = new WeakSet<object>();
    let validations = 0;
    let authorizationConsumed = false;
    let statfsCalls = 0;
    let fetchCalls = 0;
    const validator = async (authorization: InstallAuthorization): Promise<boolean> => {
        validations += 1;
        if (authorizationConsumed || authorization !== AUTHORIZATION) {
            return false;
        }
        authorizationConsumed = true;
        return true;
    };
    const stager = new RideCodexRuntimeStager({
        trustedRuntimeBase: root,
        runtimeRoot: root,
        authorizationValidator: validator,
        statfs: async () => {
            statfsCalls += 1;
            return { bsize: 1, bavail: requiredRuntimeStageBytes(entry) };
        },
        fetcher: {
            authorize: async (authorization, context) => {
                await validateInstallAuthorization(authorization, validator, context);
                const capability = Object.freeze(Object.create(null)) as RideCodexRuntimeFetchCapability;
                capabilities.add(capability);
                return capability;
            },
            fetchAuthorized: async (capability, _runtime, destination) => {
                if (!capabilities.delete(capability)) {
                    throw new Error('authorization capability is invalid');
                }
                fetchCalls += 1;
                await writeFetchDestination(destination, archive);
                return Object.freeze({ bytes: archive.length, integrity: sha512Integrity(archive) });
            }
        },
        probe: new RecordingProbe()
    });
    try {
        const staged = await stager.stage(AUTHORIZATION, entry.target);
        assert.equal((await stat(staged.executable)).isFile(), true);
        assert.equal(validations, 1);
        assert.equal(statfsCalls, 1);
        assert.equal(fetchCalls, 1);
        await assert.rejects(stager.stage(AUTHORIZATION, entry.target), /authorization/i);
        assert.equal(validations, 2);
        assert.equal(statfsCalls, 1);
        assert.equal(fetchCalls, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('staging rejects symlink or junction ancestors below its trusted runtime base before statfs or download', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ride-codex-trusted-base-'));
    const external = await mkdtemp(join(tmpdir(), 'ride-codex-external-root-'));
    const linkedAncestor = join(base, 'linked');
    let statfsCalls = 0;
    let fetchCalls = 0;
    try {
        await symlink(external, linkedAncestor, process.platform === 'win32' ? 'junction' : 'dir');
        const stager = new RideCodexRuntimeStager({
            trustedRuntimeBase: base,
            runtimeRoot: join(linkedAncestor, 'runtime'),
            authorizationValidator: authorization => authorization === AUTHORIZATION,
            statfs: async () => {
                statfsCalls += 1;
                return { bsize: 1, bavail: Number.MAX_SAFE_INTEGER };
            },
            fetcher: {
                authorize: async authorization => authorization as RideCodexRuntimeFetchCapability,
                fetchAuthorized: async () => {
                    fetchCalls += 1;
                    throw new Error('network must not be reached');
                }
            }
        });
        await assert.rejects(stager.stage(AUTHORIZATION, 'x86_64-pc-windows-msvc'), /root|symlink|junction|reparse|safe/i);
        assert.equal(statfsCalls, 0);
        assert.equal(fetchCalls, 0);
    } finally {
        await rm(base, { recursive: true, force: true });
        await rm(external, { recursive: true, force: true });
    }
});

test('staging detects replacement with an external symlink and cleanup preserves the external sentinel', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ride-codex-root-swap-'));
    const root = join(base, 'runtime');
    const external = await mkdtemp(join(tmpdir(), 'ride-codex-root-swap-external-'));
    const sentinel = join(external, 'sentinel.txt');
    const entry = RIDE_CODEX_RUNTIME_MANIFEST.runtimes[4];
    let replacedStaging: string | undefined;
    await writeFile(sentinel, 'must survive');
    try {
        const stager = new RideCodexRuntimeStager({
            trustedRuntimeBase: base,
            runtimeRoot: root,
            authorizationValidator: authorization => authorization === AUTHORIZATION,
            statfs: async () => ({ bsize: 1, bavail: requiredRuntimeStageBytes(entry) }),
            fetcher: {
                authorize: async authorization => authorization as RideCodexRuntimeFetchCapability,
                fetchAuthorized: async (_capability, _runtime, destination) => {
                    replacedStaging = dirname(typeof destination === 'string' ? destination : destination.path);
                    await rm(replacedStaging, { recursive: true, force: true });
                    await symlink(external, replacedStaging, process.platform === 'win32' ? 'junction' : 'dir');
                    return Object.freeze({ bytes: entry.compressedBytes, integrity: entry.integrity });
                }
            }
        });
        await assert.rejects(stager.stage(AUTHORIZATION, entry.target), /root|staging|replace|symlink|junction|safe/i);
        assert.equal(await readFile(sentinel, 'utf8'), 'must survive');
        assert.ok(replacedStaging);
        await assert.rejects(lstat(replacedStaging!), /ENOENT/);
        const quarantines = (await fsPromises.readdir(root)).filter(name => name.startsWith('.quarantine-'));
        assert.equal(quarantines.length, 1);
        assert.equal((await lstat(join(root, quarantines[0]))).isSymbolicLink(), true);
    } finally {
        await rm(base, { recursive: true, force: true });
        await rm(external, { recursive: true, force: true });
    }
});

test('cleanup atomically quarantines a verify-after replacement and never follows the external target', async t => {
    const base = await mkdtemp(join(tmpdir(), 'ride-codex-cleanup-race-'));
    const root = join(base, 'runtime');
    const external = await mkdtemp(join(tmpdir(), 'ride-codex-cleanup-race-external-'));
    const sentinel = join(external, 'sentinel.txt');
    const entry = RIDE_CODEX_RUNTIME_MANIFEST.runtimes[4];
    const originalRename = fsPromises.rename.bind(fsPromises);
    let stagingDirectory: string | undefined;
    let ownedDirectory: string | undefined;
    let renameRaceTriggered = false;
    await writeFile(sentinel, 'must survive cleanup race');
    t.mock.method(fsPromises, 'rename', async (
        source: Parameters<typeof rename>[0],
        destination: Parameters<typeof rename>[1]
    ) => {
        const sourcePath = String(source);
        const destinationPath = String(destination);
        if (!renameRaceTriggered && stagingDirectory && sourcePath === stagingDirectory
            && destinationPath.includes('.quarantine-')) {
            renameRaceTriggered = true;
            ownedDirectory = `${stagingDirectory}-owned`;
            await originalRename(stagingDirectory, ownedDirectory);
            await symlink(external, stagingDirectory, process.platform === 'win32' ? 'junction' : 'dir');
        }
        return originalRename(source, destination);
    });
    try {
        const stager = new RideCodexRuntimeStager({
            trustedRuntimeBase: base,
            runtimeRoot: root,
            authorizationValidator: authorization => authorization === AUTHORIZATION,
            statfs: async () => ({ bsize: 1, bavail: requiredRuntimeStageBytes(entry) }),
            fetcher: {
                authorize: async authorization => authorization as RideCodexRuntimeFetchCapability,
                fetchAuthorized: async (_capability, _runtime, destination) => {
                    stagingDirectory = dirname(typeof destination === 'string' ? destination : destination.path);
                    throw new Error('force safe cleanup');
                }
            }
        });
        await assert.rejects(stager.stage(AUTHORIZATION, entry.target), /cleanup|quarantine|stage|runtime|safe/i);
        assert.equal(renameRaceTriggered, true);
        assert.equal(await readFile(sentinel, 'utf8'), 'must survive cleanup race');
        assert.ok(ownedDirectory);
        assert.equal((await lstat(ownedDirectory!)).isDirectory(), true);
        const quarantines = (await fsPromises.readdir(root)).filter(name => name.startsWith('.quarantine-'));
        assert.equal(quarantines.length, 1);
        assert.equal((await lstat(join(root, quarantines[0]))).isSymbolicLink(), true);
    } finally {
        t.mock.restoreAll();
        await rm(base, { recursive: true, force: true });
        await rm(external, { recursive: true, force: true });
    }
});

test('staging returns paths rooted in the canonical extension-owned runtime directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ride-codex-canonical-base-'));
    const root = join(base, 'nested', '..', 'runtime');
    try {
        const stager = await createArchiveStager(root, await tarGz(validArchiveEntries()), {
            trustedRuntimeBase: base
        });
        const staged = await stager.stage(AUTHORIZATION, 'x86_64-unknown-linux-musl');
        const canonicalRoot = await realpath(resolve(base, 'runtime'));
        assert.ok(isPathChild(canonicalRoot, staged.stagingDirectory));
        assert.equal(await realpath(staged.stagingDirectory), staged.stagingDirectory);
        assert.ok(isPathChild(staged.stagingDirectory, staged.executable));
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

function isPathChild(parent: string, child: string): boolean {
    const childRelative = relative(parent, child);
    return childRelative !== '' && !childRelative.startsWith('..') && !resolve(childRelative).startsWith('..');
}

test('staging paths are unique children of the extension-owned runtime root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-stage-root-'));
    const observed: string[] = [];
    try {
        const entry = RIDE_CODEX_RUNTIME_MANIFEST.runtimes[0];
        const stager = new RideCodexRuntimeStager({
            trustedRuntimeBase: root,
            runtimeRoot: root,
            authorizationValidator: authorization => authorization === AUTHORIZATION,
            statfs: async () => ({ bsize: 1, bavail: requiredRuntimeStageBytes(entry) }),
            fetcher: {
                authorize: async authorization => authorization as RideCodexRuntimeFetchCapability,
                fetchAuthorized: async (_authorization, _runtime, destination) => {
                    observed.push(typeof destination === 'string' ? destination : destination.path);
                    throw new Error('stop after path observation');
                }
            }
        });
        await assert.rejects(stager.stage(AUTHORIZATION, entry.target), /stage|download|runtime/i);
        await assert.rejects(stager.stage(AUTHORIZATION, entry.target), /stage|download|runtime/i);
        assert.equal(observed.length, 2);
        assert.notEqual(observed[0], observed[1]);
        assert.ok(observed.every(path => {
            const child = relative(root, path);
            return child && !child.startsWith('..') && !resolve(child).startsWith('..');
        }));
        assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(root)), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

interface TarFixtureEntry {
    readonly header: Headers;
    readonly body?: Buffer | string;
}

async function tarGz(entries: readonly TarFixtureEntry[]): Promise<Buffer> {
    const archive = pack();
    const gzip = createGzip();
    archive.pipe(gzip);
    const chunksPromise = (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of gzip) {
            chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    })();
    for (const entry of entries) {
        await new Promise<void>((resolveEntry, rejectEntry) => {
            archive.entry(entry.header, entry.body, error => error ? rejectEntry(error) : resolveEntry());
        });
    }
    archive.finalize();
    return chunksPromise;
}

function elfHeader(arch: 'x64' | 'arm64' = 'x64'): Buffer {
    const header = Buffer.alloc(64);
    header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    header.writeUInt16LE(arch === 'x64' ? 62 : 183, 18);
    return header;
}

function packageManifest(overrides: Readonly<Record<string, unknown>> = {}): string {
    return JSON.stringify({
        layoutVersion: 1,
        version: '0.144.0',
        target: 'x86_64-unknown-linux-musl',
        variant: 'codex',
        entrypoint: 'bin/codex',
        resourcesDir: 'codex-resources',
        pathDir: 'codex-path',
        ...overrides
    });
}

function validArchiveEntries(overrides: {
    readonly binary?: Buffer;
    readonly manifest?: string;
    readonly extras?: readonly TarFixtureEntry[];
} = {}): readonly TarFixtureEntry[] {
    const vendor = 'package/vendor/x86_64-unknown-linux-musl';
    return [
        { header: { name: 'package/', type: 'directory', mode: 0o777, mtime: new Date(0), uid: 42, gid: 42 } },
        { header: { name: 'package/vendor/', type: 'directory' } },
        { header: { name: `${vendor}/`, type: 'directory' } },
        { header: { name: `${vendor}/bin/`, type: 'directory' } },
        { header: { name: `${vendor}/codex-resources/`, type: 'directory' } },
        { header: { name: `${vendor}/codex-path/`, type: 'directory' } },
        { header: { name: `${vendor}/codex-package.json`, type: 'file', mode: 0o777 }, body: overrides.manifest ?? packageManifest() },
        { header: { name: `${vendor}/bin/codex`, type: 'file', mode: 0o000 }, body: overrides.binary ?? elfHeader() },
        ...(overrides.extras ?? [])
    ];
}

class RecordingProbe implements RideCodexRuntimeProbeLike {
    readonly calls: Array<{ readonly executable: string; readonly timeoutMs?: number; readonly signal?: AbortSignal }> = [];

    constructor(private readonly version = '0.144.0') { }

    async probe(executable: string, request: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}): Promise<{ readonly version: string }> {
        this.calls.push({ executable, ...request });
        return Object.freeze({ version: this.version });
    }
}

async function createArchiveStager(
    root: string,
    archive: Buffer,
    options: {
        readonly probe?: RideCodexRuntimeProbeLike;
        readonly maxArchiveEntries?: number;
        readonly trustedRuntimeBase?: string;
    } = {}
): Promise<RideCodexRuntimeStager> {
    const entry = RIDE_CODEX_RUNTIME_MANIFEST.runtimes[4];
    return new RideCodexRuntimeStager({
        trustedRuntimeBase: options.trustedRuntimeBase ?? root,
        runtimeRoot: root,
        authorizationValidator: authorization => authorization === AUTHORIZATION,
        statfs: async () => ({ bsize: 1, bavail: requiredRuntimeStageBytes(entry) }),
        fetcher: {
            authorize: async authorization => authorization as RideCodexRuntimeFetchCapability,
            fetchAuthorized: async (_authorization, _runtime, destination) => {
                await writeFetchDestination(destination, archive);
                return Object.freeze({ bytes: archive.length, integrity: sha512Integrity(archive) });
            }
        },
        probe: options.probe ?? new RecordingProbe(),
        maxArchiveEntries: options.maxArchiveEntries
    });
}

test('valid archive is streamed into a frozen staged runtime without activating it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-valid-stage-'));
    const archive = await tarGz(validArchiveEntries());
    const probe = new RecordingProbe();
    const entry = RIDE_CODEX_RUNTIME_MANIFEST.runtimes[4];
    try {
        const stager = await createArchiveStager(root, archive, { probe });
        const staged = await stager.stage(AUTHORIZATION, 'x86_64-unknown-linux-musl');

        assert.equal(Object.isFrozen(staged), true);
        assert.equal(staged.version, '0.144.0');
        assert.equal(staged.target, 'x86_64-unknown-linux-musl');
        assert.equal(staged.entrypoint, 'bin/codex');
        assert.equal(staged.npmVersion, '0.144.0-linux-x64');
        assert.equal(staged.integrity, RIDE_CODEX_RUNTIME_MANIFEST.runtimes[4].integrity);
        assert.equal(staged.layoutVersion, 1);
        assert.equal(Object.isFrozen(staged.authorizationContext), true);
        assert.equal(Object.isFrozen(staged.stagingIdentity), true);
        assert.equal(staged.authorizationContext.target, staged.target);
        assert.equal(staged.authorizationContext.manifestDigest, runtimeManifestEntryDigest(entry));
        assert.equal(typeof staged.stagingIdentity.ino, 'bigint');
        await staged.revalidate();
        assert.ok(relative(root, staged.stagingDirectory) && !relative(root, staged.stagingDirectory).startsWith('..'));
        assert.equal(staged.packageRoot, join(staged.stagingDirectory, 'package'));
        assert.equal(staged.executable, join(staged.packageRoot, 'vendor', staged.target, 'bin', 'codex'));
        assert.equal(staged.resourcesDirectory, join(staged.packageRoot, 'vendor', staged.target, 'codex-resources'));
        assert.equal(staged.pathDirectory, join(staged.packageRoot, 'vendor', staged.target, 'codex-path'));
        assert.deepEqual(probe.calls.map(call => call.executable), [staged.executable]);
        assert.ok(probe.calls[0].timeoutMs && probe.calls[0].timeoutMs <= 10_000);
        const executableStat = await stat(staged.executable);
        assert.equal(executableStat.isFile(), true);
        if (process.platform !== 'win32') {
            assert.equal(executableStat.mode & 0o100, 0o100);
        }
        assert.deepEqual((await import('node:fs/promises').then(fs => fs.readdir(root))).sort(), [
            relative(root, staged.stagingDirectory)
        ]);
        await assert.rejects(readFile(join(root, 'active')), /ENOENT/);
        await assert.rejects(readFile(join(staged.stagingDirectory, 'runtime.tgz')), /ENOENT/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('staging rejects a runtime tree changed by the probe before returning a staged runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-probe-attestation-'));
    const archive = await tarGz(validArchiveEntries());
    let changedDuringProbe = false;
    const probe: RideCodexRuntimeProbeLike = {
        probe: async executable => {
            const original = join(root, 'original-codex');
            await rename(executable, original);
            await writeFile(executable, Buffer.concat([elfHeader(), Buffer.from('REPLACED-DURING-PROBE')]));
            changedDuringProbe = true;
            return Object.freeze({ version: '0.144.0' });
        }
    };
    try {
        const stager = await createArchiveStager(root, archive, { probe });
        await assert.rejects(
            stager.stage(AUTHORIZATION, 'x86_64-unknown-linux-musl'),
            /attest|tree|identity|changed|safe/i
        );
        assert.equal(changedDuringProbe, true);
        assert.deepEqual(await fsPromises.readdir(root), ['original-codex']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('staged runtime revalidation rejects directory identity drift before Task 7 activation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-stage-revalidate-'));
    const archive = await tarGz(validArchiveEntries());
    let movedDirectory: string | undefined;
    try {
        const stager = await createArchiveStager(root, archive);
        const staged = await stager.stage(AUTHORIZATION, 'x86_64-unknown-linux-musl');
        await staged.revalidate();
        movedDirectory = `${staged.stagingDirectory}-moved`;
        await rename(staged.stagingDirectory, movedDirectory);
        await mkdir(staged.stagingDirectory, { mode: 0o700 });
        await assert.rejects(staged.revalidate(), /replaced|identity|staging|safe/i);
    } finally {
        await rm(root, { recursive: true, force: true });
        if (movedDirectory) {
            await rm(movedDirectory, { recursive: true, force: true });
        }
    }
});

test('staged runtime revalidation attests the complete resource tree before Task 7 activation', async t => {
    const vendor = 'package/vendor/x86_64-unknown-linux-musl';
    const archive = await tarGz(validArchiveEntries({
        extras: [
            { header: { name: `${vendor}/codex-resources/model.json`, type: 'file' }, body: 'trusted resource' },
            { header: { name: `${vendor}/codex-path/helper`, type: 'file' }, body: 'trusted helper' }
        ]
    }));

    const mutateAndReject = async (
        name: string,
        mutate: (staged: Awaited<ReturnType<RideCodexRuntimeStager['stage']>>, root: string) => Promise<void>
    ): Promise<void> => {
        await t.test(name, async () => {
            const root = await mkdtemp(join(tmpdir(), 'ride-codex-tree-attestation-'));
            try {
                const staged = await (await createArchiveStager(root, archive)).stage(
                    AUTHORIZATION,
                    'x86_64-unknown-linux-musl'
                );
                await staged.revalidate();
                await mutate(staged, root);
                await assert.rejects(staged.revalidate(), /attest|tree|identity|content|resource|changed|safe/i);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
    };

    await mutateAndReject('resource content changed', async staged => {
        await writeFile(join(staged.resourcesDirectory, 'model.json'), 'tampered resource');
    });
    await mutateAndReject('resource deleted', async staged => {
        await rm(join(staged.resourcesDirectory, 'model.json'));
    });
    await mutateAndReject('resource added', async staged => {
        await writeFile(join(staged.resourcesDirectory, 'injected.json'), 'injected');
    });
    await mutateAndReject('resource replaced by a hard link', async (staged, root) => {
        const replacement = join(root, 'replacement-resource');
        await writeFile(replacement, 'replacement');
        const resource = join(staged.resourcesDirectory, 'model.json');
        await rm(resource);
        await link(replacement, resource);
    });
});

test('valid npm-style archive does not require explicit directory headers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-implicit-dirs-'));
    const vendor = 'package/vendor/x86_64-unknown-linux-musl';
    const entries = [
        ...validArchiveEntries().filter(entry => entry.header.type !== 'directory'),
        { header: { name: `${vendor}/codex-resources/resource`, type: 'file' as const }, body: 'resource' },
        { header: { name: `${vendor}/codex-path/path-helper`, type: 'file' as const }, body: 'path' }
    ];
    const archive = await tarGz(entries);
    try {
        const stager = await createArchiveStager(root, archive);
        const staged = await stager.stage(AUTHORIZATION, 'x86_64-unknown-linux-musl');
        assert.equal((await stat(staged.executable)).isFile(), true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('archive rejects the first entry-local error emitted after end before reporting extraction success', async t => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-entry-late-error-'));
    const archive = await tarGz(validArchiveEntries());
    const originalOn = EventEmitter.prototype.on;
    let injected = false;
    t.mock.method(EventEmitter.prototype, 'on', function (
        this: EventEmitter,
        event: string | symbol,
        listener: (...args: unknown[]) => void
    ): EventEmitter {
        const result = originalOn.call(this, event, listener as (...args: never[]) => void);
        if (!injected && event === 'error' && listener.name === 'recordEntryError') {
            injected = true;
            this.once('end', () => setImmediate(() => this.emit('error', new Error('late entry failure'))));
        }
        return result;
    });
    try {
        const stager = await createArchiveStager(root, archive);
        await assert.rejects(stager.stage(AUTHORIZATION, 'x86_64-unknown-linux-musl'), /entry|archive|stream|safe/i);
        assert.equal(injected, true);
    } finally {
        t.mock.restoreAll();
        await rm(root, { recursive: true, force: true });
    }
});

test('archive path validation rejects traversal, platform tricks, invalid names, and extra package roots', async t => {
    const cases: ReadonlyArray<{ readonly name: string; readonly path: string }> = [
        { name: 'absolute', path: '/package/escape' },
        { name: 'parent traversal', path: 'package/../escape' },
        { name: 'backslash traversal', path: 'package\\..\\escape' },
        { name: 'Windows drive', path: 'C:/package/escape' },
        { name: 'UNC', path: '//server/share/escape' },
        { name: 'ADS colon', path: 'package/file:stream' },
        { name: 'NUL', path: 'package/file\0suffix' },
        { name: 'overlong', path: `package/${'a'.repeat(4096)}` },
        { name: 'package-root outside', path: 'other/file' },
        { name: 'additional package root', path: 'package-two/file' },
        { name: 'unexpected native target', path: 'package/vendor/aarch64-unknown-linux-musl/bin/codex' }
    ];
    for (const entry of cases) {
        await t.test(entry.name, async () => {
            const root = await mkdtemp(join(tmpdir(), 'ride-codex-bad-path-'));
            let archive: Buffer;
            try {
                archive = await tarGz([
                    ...validArchiveEntries(),
                    { header: { name: entry.path, type: 'file' }, body: 'unsafe' }
                ]);
            } catch {
                archive = await tarGz(validArchiveEntries());
                const extractor = new RideCodexRuntimeArchiveExtractor();
                assert.throws(() => extractor.validateEntryPath(entry.path, 'x86_64-unknown-linux-musl'), /archive|path|entry/i);
                await rm(root, { recursive: true, force: true });
                return;
            }
            try {
                const stager = await createArchiveStager(root, archive);
                await assert.rejects(stager.stage(AUTHORIZATION, 'x86_64-unknown-linux-musl'), /archive|path|target|entry/i);
                assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(root)), []);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
    }
});

test('archive path validation rejects Windows aliases, controls, and non-NFC segments in real tar fixtures', async t => {
    const cases = [
        { name: 'CON device', path: 'package/CON' },
        { name: 'PRN device with extension', path: 'package/prn.txt' },
        { name: 'AUX device case-insensitive', path: 'package/AuX.log' },
        { name: 'NUL device with extension', path: 'package/NUL.bin' },
        { name: 'COM1 device', path: 'package/COM1.txt' },
        { name: 'COM9 device', path: 'package/com9' },
        { name: 'LPT1 device', path: 'package/LPT1.data' },
        { name: 'LPT9 device', path: 'package/lpt9' },
        { name: 'trailing dot', path: 'package/trailing.' },
        { name: 'trailing space', path: 'package/trailing ' },
        { name: 'ASCII control', path: 'package/control\u0001name' },
        { name: 'DEL control', path: 'package/control\u007fname' },
        { name: 'non-NFC Unicode', path: 'package/Cafe\u0301' }
    ] as const;
    for (const entry of cases) {
        await t.test(entry.name, async () => {
            const extractor = new RideCodexRuntimeArchiveExtractor();
            assert.throws(
                () => extractor.validateEntryPath(entry.path, 'x86_64-unknown-linux-musl'),
                /archive|path|entry|alias|Unicode|name/i
            );
            const root = await mkdtemp(join(tmpdir(), 'ride-codex-alias-path-'));
            try {
                const archive = await tarGz(validArchiveEntries({
                    extras: [{ header: { name: entry.path, type: 'file' }, body: 'unsafe alias' }]
                }));
                const stager = await createArchiveStager(root, archive);
                await assert.rejects(stager.stage(AUTHORIZATION, 'x86_64-unknown-linux-musl'), /archive|path|entry|alias|Unicode|name/i);
                assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(root)), []);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
    }
});

test('archive rejects duplicate and case-colliding entries', async t => {
    const cases: readonly TarFixtureEntry[][] = [
        [{ header: { name: 'package/README', type: 'file' }, body: 'one' }, { header: { name: 'package/README', type: 'file' }, body: 'two' }],
        [{ header: { name: 'package/README', type: 'file' }, body: 'one' }, { header: { name: 'package/readme', type: 'file' }, body: 'two' }]
    ];
    for (const [index, extras] of cases.entries()) {
        await t.test(index ? 'case collision' : 'duplicate', async () => {
            const root = await mkdtemp(join(tmpdir(), 'ride-codex-duplicate-'));
            try {
                const stager = await createArchiveStager(root, await tarGz(validArchiveEntries({ extras })));
                await assert.rejects(stager.stage(AUTHORIZATION, 'x86_64-unknown-linux-musl'), /duplicate|collision|archive/i);
                assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(root)), []);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
    }
});

test('archive collision keys use NFC plus Unicode case folding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ride-codex-unicode-collision-'));
    try {
        const archive = await tarGz(validArchiveEntries({
            extras: [
                { header: { name: 'package/Straße', type: 'file' }, body: 'one' },
                { header: { name: 'package/STRASSE', type: 'file' }, body: 'two' }
            ]
        }));
        const stager = await createArchiveStager(root, archive);
        await assert.rejects(stager.stage(AUTHORIZATION, 'x86_64-unknown-linux-musl'), /collision|archive|Unicode/i);
        assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(root)), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('archive rejects links, devices, fifos, and every unexpected tar type', async t => {
    const types = ['symlink', 'link', 'character-device', 'block-device', 'fifo'] as const;
    for (const type of types) {
        await t.test(type, async () => {
            const root = await mkdtemp(join(tmpdir(), 'ride-codex-bad-type-'));
            try {
                const archive = await tarGz(validArchiveEntries({
                    extras: [{
                        header: {
                            name: `package/${type}`,
                            type: type as Headers['type'],
                            linkname: type === 'symlink' || type === 'link' ? 'package/target' : undefined
                        }
                    }]
                }));
                const stager = await createArchiveStager(root, archive);
                await assert.rejects(stager.stage(AUTHORIZATION, 'x86_64-unknown-linux-musl'), /type|link|archive|entry/i);
                assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(root)), []);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
    }
    await t.test('unexpected type', async () => {
        const root = await mkdtemp(join(tmpdir(), 'ride-codex-bad-type-'));
        try {
            const ordinaryPath = 'package/unexpected-type';
            const ordinary = await tarGz(validArchiveEntries({
                extras: [{ header: { name: ordinaryPath, type: 'file' }, body: 'unexpected' }]
            }));
            const stager = await createArchiveStager(root, replaceTarType(ordinary, ordinaryPath, '7'));
            await assert.rejects(stager.stage(AUTHORIZATION, 'x86_64-unknown-linux-musl'), /type|archive|entry/i);
            assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(root)), []);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
    await t.test('unknown type flag', async () => {
        const root = await mkdtemp(join(tmpdir(), 'ride-codex-unknown-type-'));
        try {
            const ordinaryPath = 'package/unknown-type';
            const ordinary = await tarGz(validArchiveEntries({
                extras: [{ header: { name: ordinaryPath, type: 'file' }, body: 'unknown' }]
            }));
            const stager = await createArchiveStager(root, replaceTarType(ordinary, ordinaryPath, 'Z'));
            await assert.rejects(stager.stage(AUTHORIZATION, 'x86_64-unknown-linux-musl'), /type|archive|entry/i);
            assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(root)), []);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

function replaceTarType(archive: Buffer, path: string, typeFlag: string): Buffer {
    const raw = gunzipSync(archive);
    const headerOffset = findTarHeader(raw, path);
    raw[headerOffset + 156] = typeFlag.charCodeAt(0);
    updateTarChecksum(raw, headerOffset);
    return gzipSync(raw);
}

function replaceTarSize(archive: Buffer, path: string, sizeField: Buffer): Buffer {
    assert.equal(sizeField.length, 12);
    const raw = gunzipSync(archive);
    const headerOffset = findTarHeader(raw, path);
    sizeField.copy(raw, headerOffset + 124);
    updateTarChecksum(raw, headerOffset);
    return gzipSync(raw);
}

function updateTarChecksum(raw: Buffer, headerOffset: number): void {
    raw.fill(0x20, headerOffset + 148, headerOffset + 156);
    let checksum = 0;
    for (let index = headerOffset; index < headerOffset + 512; index += 1) {
        checksum += raw[index];
    }
    raw.write(checksum.toString(8).padStart(6, '0'), headerOffset + 148, 6, 'ascii');
    raw[headerOffset + 154] = 0;
    raw[headerOffset + 155] = 0x20;
}

function findTarHeader(raw: Buffer, name: string): number {
    for (let offset = 0; offset + 512 <= raw.length; offset += 512) {
        const end = raw.indexOf(0, offset);
        if (raw.toString('utf8', offset, end < 0 || end > offset + 100 ? offset + 100 : end) === name) {
            return offset;
        }
    }
    throw new Error('fixture tar header was not found');
}

function paxCommentPayload(byteLength: number): Buffer {
    const prefix = `${byteLength} comment=`;
    const valueBytes = byteLength - Buffer.byteLength(prefix) - 1;
    assert.ok(valueBytes > 0);
    const payload = Buffer.from(`${prefix}${'a'.repeat(valueBytes)}\n`);
    assert.equal(payload.length, byteLength);
    return payload;
}

async function hiddenTarExtensionArchive(typeFlag: 'x' | 'g' | 'L' | 'K'): Promise<Buffer> {
    const name = `hidden-${typeFlag}`;
    const payload = typeFlag === 'x' || typeFlag === 'g'
        ? paxCommentPayload(1024 * 1024)
        : Buffer.concat([Buffer.alloc((1024 * 1024) - 1, 0x61), Buffer.from([0])]);
    const archive = await tarGz([
        { header: { name, type: 'file' }, body: payload },
        ...validArchiveEntries()
    ]);
    return replaceTarType(archive, name, typeFlag);
}

function firstTarEndBlock(raw: Buffer): number {
    for (let offset = 0; offset + 512 <= raw.length; offset += 512) {
        if (raw.subarray(offset, offset + 512).every(byte => byte === 0)) {
            return offset;
        }
    }
    throw new Error('fixture tar end marker was not found');
}

function rewriteRawTar(archive: Buffer, rewrite: (raw: Buffer) => Buffer): Buffer {
    return gzipSync(rewrite(gunzipSync(archive)));
}

test('archive rejects hidden PAX and GNU extension records before output or probe', async t => {
    const cases = [
        { name: 'PAX local header', typeFlag: 'x' },
        { name: 'PAX global header', typeFlag: 'g' },
        { name: 'GNU long path', typeFlag: 'L' },
        { name: 'GNU long link path', typeFlag: 'K' }
    ] as const;
    for (const entry of cases) {
        await t.test(entry.name, async () => {
            const root = await mkdtemp(join(tmpdir(), 'ride-codex-hidden-tar-'));
            const probe = new RecordingProbe();
            try {
                const archive = await hiddenTarExtensionArchive(entry.typeFlag);
                assert.ok(gunzipSync(archive).length > 1024 * 1024);
                const stager = await createArchiveStager(root, archive, { probe });
                await assert.rejects(
                    stager.stage(AUTHORIZATION, 'x86_64-unknown-linux-musl'),
                    /forbidden raw tar entry type/i
                );
                assert.equal(probe.calls.length, 0);
                assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(root)), []);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
    }
});

test('raw tar scanner counts all decompressed records and rejects unsafe size encodings', async t => {
    await t.test('raw byte budget includes headers, padding, end markers, and trailing records', async () => {
        const root = await mkdtemp(join(tmpdir(), 'ride-codex-raw-budget-'));
        const archivePath = join(root, 'fixture.tgz');
        const ordinary = await tarGz([
            { header: { name: 'package/', type: 'directory' } },
            { header: { name: 'package/one', type: 'file' }, body: 'x' }
        ]);
        const oversizedRaw = Buffer.concat([gunzipSync(ordinary), Buffer.alloc(64 * 1024)]);
        await writeFile(archivePath, gzipSync(oversizedRaw));
        try {
            const extractor = new RideCodexRuntimeArchiveExtractor({ maxEntries: 1024 });
            await assert.rejects(
                extractor.extract(archivePath, root, fetchEntry(Buffer.from('x'), { unpackedBytes: 1 })),
                /raw tar byte limit/i
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    const sizeCases = [
        { name: 'malformed octal', field: Buffer.from('00000000008 ') },
        { name: 'base-256', field: Buffer.from([0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]) },
        { name: 'declared size exceeds bounded archive range', field: Buffer.from('777777777777') }
    ] as const;
    for (const entry of sizeCases) {
        await t.test(entry.name, async () => {
            const root = await mkdtemp(join(tmpdir(), 'ride-codex-raw-size-'));
            const probe = new RecordingProbe();
            const target = 'package/vendor/x86_64-unknown-linux-musl/codex-package.json';
            try {
                const archive = replaceTarSize(await tarGz(validArchiveEntries()), target, entry.field);
                const stager = await createArchiveStager(root, archive, { probe });
                await assert.rejects(stager.stage(AUTHORIZATION, 'x86_64-unknown-linux-musl'), /size header/i);
                assert.equal(probe.calls.length, 0);
                assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(root)), []);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
    }
});

test('raw tar scanner requires a canonical two-block terminator and rejects truncation or concatenation', async t => {
    const ordinary = await tarGz(validArchiveEntries());
    const ordinaryRaw = gunzipSync(ordinary);
    const endOffset = firstTarEndBlock(ordinaryRaw);
    const executableOffset = findTarHeader(
        ordinaryRaw,
        'package/vendor/x86_64-unknown-linux-musl/bin/codex'
    );
    const invalidCases = [
        {
            name: 'missing end blocks',
            archive: rewriteRawTar(ordinary, raw => raw.subarray(0, endOffset))
        },
        {
            name: 'single end block',
            archive: rewriteRawTar(ordinary, raw => raw.subarray(0, endOffset + 512))
        },
        {
            name: 'truncated header',
            archive: rewriteRawTar(ordinary, raw => raw.subarray(0, executableOffset + 128))
        },
        {
            name: 'truncated file data',
            archive: rewriteRawTar(ordinary, raw => raw.subarray(0, executableOffset + 512 + 16))
        },
        {
            name: 'truncated file padding',
            archive: rewriteRawTar(ordinary, raw => raw.subarray(0, executableOffset + 512 + 128))
        },
        {
            name: 'archive concatenated after two end blocks',
            archive: gzipSync(Buffer.concat([ordinaryRaw, ordinaryRaw]))
        }
    ] as const;
    for (const entry of invalidCases) {
        await t.test(entry.name, async () => {
            const root = await mkdtemp(join(tmpdir(), 'ride-codex-tar-end-'));
            const probe = new RecordingProbe();
            try {
                const stager = await createArchiveStager(root, entry.archive, { probe });
                await assert.rejects(
                    stager.stage(AUTHORIZATION, 'x86_64-unknown-linux-musl'),
                    /tar|archive|end|incomplete|marker/i
                );
                assert.equal(probe.calls.length, 0);
                assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(root)), []);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
    }

    await t.test('extra zero padding remains valid', async () => {
        const root = await mkdtemp(join(tmpdir(), 'ride-codex-tar-padding-'));
        try {
            const archive = gzipSync(Buffer.concat([ordinaryRaw, Buffer.alloc(4 * 512)]));
            const stager = await createArchiveStager(root, archive);
            const staged = await stager.stage(AUTHORIZATION, 'x86_64-unknown-linux-musl');
            assert.equal((await stat(staged.executable)).isFile(), true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

test('archive enforces entry and unpacked byte budgets before retaining output', async t => {
    await t.test('entry count', async () => {
        const root = await mkdtemp(join(tmpdir(), 'ride-codex-entry-limit-'));
        try {
            const stager = await createArchiveStager(root, await tarGz(validArchiveEntries()), { maxArchiveEntries: 2 });
            await assert.rejects(stager.stage(AUTHORIZATION, 'x86_64-unknown-linux-musl'), /raw entry limit/i);
            assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(root)), []);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
    await t.test('declared and actual unpacked bytes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'ride-codex-unpacked-limit-'));
        const archive = await tarGz([{ header: { name: 'package/large', type: 'file' }, body: Buffer.alloc(65) }]);
        const archivePath = join(root, 'fixture.tgz');
        const output = join(root, 'output');
        await writeFile(archivePath, archive);
        try {
            const extractor = new RideCodexRuntimeArchiveExtractor({ maxEntries: 10 });
            await assert.rejects(extractor.extract(
                archivePath,
                output,
                fetchEntry(Buffer.from('x'), { unpackedBytes: 64 })
            ), /unpacked|size|bytes|archive/i);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

test('package manifest and native runtime are bounded and strictly verified before probe', async t => {
    const cases: ReadonlyArray<{
        readonly name: string;
        readonly archive: () => Promise<Buffer>;
        readonly probeVersion?: string;
        readonly expected: RegExp;
    }> = [
        { name: 'manifest over max-plus-one', archive: () => tarGz(validArchiveEntries({ manifest: `${packageManifest()}${' '.repeat(17 * 1024)}` })), expected: /manifest|large|size/i },
        { name: 'layout version', archive: () => tarGz(validArchiveEntries({ manifest: packageManifest({ layoutVersion: 2 }) })), expected: /layout|manifest/i },
        { name: 'npm suffix version', archive: () => tarGz(validArchiveEntries({ manifest: packageManifest({ version: '0.144.0-linux-x64' }) })), expected: /version|manifest/i },
        { name: 'target', archive: () => tarGz(validArchiveEntries({ manifest: packageManifest({ target: 'aarch64-unknown-linux-musl' }) })), expected: /target|manifest/i },
        { name: 'variant', archive: () => tarGz(validArchiveEntries({ manifest: packageManifest({ variant: 'other' }) })), expected: /variant|manifest/i },
        { name: 'entrypoint traversal', archive: () => tarGz(validArchiveEntries({ manifest: packageManifest({ entrypoint: '../codex' }) })), expected: /entrypoint|manifest|escape/i },
        { name: 'resources traversal', archive: () => tarGz(validArchiveEntries({ manifest: packageManifest({ resourcesDir: '../resources' }) })), expected: /resource|manifest|path/i },
        { name: 'path directory absolute', archive: () => tarGz(validArchiveEntries({ manifest: packageManifest({ pathDir: '/tmp/path' }) })), expected: /path|manifest/i },
        {
            name: 'non-NFC resource directory',
            archive: () => tarGz(validArchiveEntries({
                manifest: packageManifest({ resourcesDir: 'code\u0065\u0301x-resources' })
            })),
            expected: /manifest resource or path directory is invalid/i
        },
        { name: 'wrong binary architecture', archive: () => tarGz(validArchiveEntries({ binary: elfHeader('arm64') })), expected: /architecture|target|binary/i },
        { name: 'incompatible probe version', archive: () => tarGz(validArchiveEntries()), probeVersion: '0.143.0', expected: /probe|version|runtime/i }
    ];
    for (const entry of cases) {
        await t.test(entry.name, async () => {
            const root = await mkdtemp(join(tmpdir(), 'ride-codex-package-invalid-'));
            const probe = new RecordingProbe(entry.probeVersion);
            try {
                const stager = await createArchiveStager(root, await entry.archive(), { probe });
                await assert.rejects(stager.stage(AUTHORIZATION, 'x86_64-unknown-linux-musl'), entry.expected);
                assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(root)), []);
                if (entry.name !== 'incompatible probe version') {
                    assert.equal(probe.calls.length, 0);
                }
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
    }
});
