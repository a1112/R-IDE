/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fsPromises } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
    createRideCodexInstallPresentation,
    InstallPresentation,
    InstallProgress
} from '../src/common/ride-codex-installation';
import {
    createRideCodexRuntimeInstallPresentation,
    InstallConsentToken,
    RideCodexInstallConsent
} from '../src/node/ride-codex-install-consent';
import {
    RideCodexManagedInstaller,
    RideCodexManagedInstallError
} from '../src/node/ride-codex-managed-installer';
import {
    createInstallAuthorizationContext,
    InstallAuthorization,
    InstallAuthorizationValidator,
    RideCodexRuntimeFetchCapability,
    RideCodexRuntimeFetchDestination,
    RideCodexRuntimeFetcher
} from '../src/node/ride-codex-runtime-fetcher';
import {
    RideCodexRuntimeManifestEntry,
    RuntimeTarget,
    runtimeManifestEntryDigest,
    runtimeManifestEntryForTarget
} from '../src/node/ride-codex-runtime-manifest';
import {
    RideCodexRuntimeStoreTransaction,
    RideCodexRuntimeStore,
    RideCodexRuntimeStoreTestHooks
} from '../src/node/ride-codex-runtime-store';
import { RideCodexRuntimeResolver } from '../src/node/ride-codex-runtime-resolver';
import {
    attestPublishedRuntime,
    RideCodexRuntimeStager,
    StagedRuntime
} from '../src/node/ride-codex-runtime-stager';

const TARGET: RuntimeTarget = 'x86_64-pc-windows-msvc';

test('requires matching consent, switches atomically, rolls back, and retains two versions', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-install-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const consent = new RideCodexInstallConsent({ clock: () => 100 });
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const installer = new RideCodexManagedInstaller({
        consent,
        store,
        validatePresentation: () => true,
        stager: {
            stage: async (_authorization, _target, presentation) => createStagedRuntime(runtimeRoot, presentation)
        },
        handshake: async (_runtime, options) => {
            if (options.failHandshake) {
                throw new Error('untrusted command output must not escape');
            }
        }
    });

    try {
        await installer.install(consent.issue(presentationFor('0.143.0', runtimeRoot)));
        await assert.rejects(installer.install(undefined), /consent/i);

        const token = consent.issue(presentationFor('0.144.0', runtimeRoot));
        await installer.install(token);
        assert.equal(await store.activeVersion(), '0.144.0');

        await assert.rejects(
            installer.install(consent.issue(presentationFor('0.145.0', runtimeRoot)), { failHandshake: true }),
            /handshake/i
        );
        assert.equal(await store.activeVersion(), '0.144.0');
        assert.deepEqual(await store.versions(), ['0.143.0', '0.144.0']);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('consent is short-lived, single-use, instance-bound, immutable, and bound to every displayed field', async () => {
    let now = 10;
    const root = join(tmpdir(), 'ride-codex-consent-root');
    const consent = new RideCodexInstallConsent({ clock: () => now, ttlMs: 25 });
    const original = presentationFor('0.144.0', root);

    const replayed = consent.issue(original);
    assert.equal(consent.consume(replayed, original).presentation.version, '0.144.0');
    assert.throws(() => consent.consume(replayed, original), /already used|consent/i);

    const expired = consent.issue(original);
    now = 36;
    assert.throws(() => consent.consume(expired, original), /expired/i);
    assert.throws(() => consent.consume(expired, original), /already used|consent/i);
    now = 20;

    const foreign = consent.issue(original);
    const anotherConsent = new RideCodexInstallConsent({ clock: () => now });
    assert.throws(() => anotherConsent.consume(foreign, original), /invalid|consent/i);

    const opaque = consent.issue(original);
    assert.equal(Object.isFrozen(opaque), true);
    assert.equal(Reflect.set(opaque, 'version', '0.145.0'), false);
    assert.equal(consent.consume(opaque, original).presentation.version, '0.144.0');

    const mutable: InstallPresentation = { ...original };
    const snapshotted = consent.issue(mutable);
    (mutable as { version: string }).version = '0.145.0';
    assert.equal(consent.consume(snapshotted, original).presentation.version, '0.144.0');

    const mismatches: readonly Partial<Record<keyof InstallPresentation, unknown>>[] = [
        { source: 'unreviewed-mirror' },
        { version: '0.145.0' },
        { target: 'aarch64-pc-windows-msvc' },
        { urlOrigin: 'https://example.invalid' },
        { installRoot: join(root, 'other') },
        { requiredSpaceBytes: 2048 },
        { rollbackPolicy: 'retain-everything' },
        { manifestDigest: `sha256-${'f'.repeat(64)}` }
    ];
    for (const mismatch of mismatches) {
        const token = consent.issue(original);
        const expected = { ...original, ...mismatch } as InstallPresentation;
        assert.throws(() => consent.consume(token, expected), /invalid|match|consent/i);
        assert.throws(() => consent.consume(token, original), /already used|consent/i);
    }

    const concurrent = consent.issue(original);
    const results = await Promise.allSettled([
        Promise.resolve().then(() => consent.consume(concurrent, original)),
        Promise.resolve().then(() => consent.consume(concurrent, original))
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
});

test('consent snapshots descriptors without invoking accessors or proxy traps', () => {
    const root = join(tmpdir(), 'ride-codex-consent-descriptors');
    const original = presentationFor('0.144.0', root);
    const consent = new RideCodexInstallConsent();
    let getterCalls = 0;
    const accessor = { ...original } as InstallPresentation;
    Object.defineProperty(accessor, 'version', {
        enumerable: true,
        get: () => {
            getterCalls += 1;
            return '0.144.0';
        }
    });
    assert.throws(() => consent.issue(accessor), /presentation|unsafe/i);
    assert.equal(getterCalls, 0);

    let proxyTraps = 0;
    const proxy = new Proxy({ ...original }, {
        ownKeys: target => {
            proxyTraps += 1;
            return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor: (target, property) => {
            proxyTraps += 1;
            return Reflect.getOwnPropertyDescriptor(target, property);
        }
    });
    assert.throws(() => consent.issue(proxy), /presentation|unsafe/i);
    assert.equal(proxyTraps, 0);

    assert.throws(() => consent.issue({ ...original, extra: true } as InstallPresentation), /presentation|shape/i);
});

test('delegated authorization retains TTL, rejects clock rollback, and is concurrently one-shot', async () => {
    let now = 10;
    const root = join(tmpdir(), 'ride-codex-authorization-ttl');
    const presentation = presentationFor('0.144.0', root);
    const consent = new RideCodexInstallConsent({ clock: () => now, ttlMs: 25 });
    const context = Object.freeze({
        target: presentation.target,
        manifestDigest: presentation.manifestDigest,
        canonicalRoot: root,
        destination: join(root, '.staging-test', 'runtime.tgz')
    });

    const expired = consent.consume(consent.issue(presentation), presentation).authorization;
    now = 36;
    assert.equal(await consent.authorizationValidator(expired, context), false);
    assert.equal(await consent.authorizationValidator(expired, context), false);

    now = 20;
    const rolledBack = consent.consume(consent.issue(presentation), presentation).authorization;
    now = 19;
    assert.equal(await consent.authorizationValidator(rolledBack, context), false);
    assert.equal(await consent.authorizationValidator(rolledBack, context), false);

    now = 30;
    const concurrent = consent.consume(consent.issue(presentation), presentation).authorization;
    const results = await Promise.all([
        Promise.resolve().then(() => consent.authorizationValidator(concurrent, context)),
        Promise.resolve().then(() => consent.authorizationValidator(concurrent, context))
    ]);
    assert.equal(results.filter(result => result === false).length, 1);
    const lease = results.find(result => result !== false);
    assert.equal(typeof lease, 'object');
    assert.equal(Object.isFrozen(lease), true);
});

test('real consent authorization crosses the real fetcher gate before the stager capacity check', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-real-authorization-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const runtime = runtimeManifestEntryForTarget(TARGET);
    const presentation = createRideCodexRuntimeInstallPresentation(runtime, runtimeRoot);
    const consent = new RideCodexInstallConsent({ clock: () => 10 });
    const consumed = consent.consume(consent.issue(presentation), presentation);
    let statfsCalls = 0;
    let networkCalls = 0;
    const fetcher = new RideCodexRuntimeFetcher({
        authorizationValidator: consent.authorizationValidator,
        requester: {
            open: async () => {
                networkCalls += 1;
                throw new Error('network must remain unreachable');
            }
        }
    });
    const stager = new RideCodexRuntimeStager({
        trustedRuntimeBase,
        runtimeRoot,
        authorizationValidator: consent.authorizationValidator,
        fetcher,
        statfs: async () => {
            statfsCalls += 1;
            return { bsize: 1, bavail: 0 };
        }
    });

    try {
        assert.equal(Object.isFrozen(consumed.authorization), true);
        assert.equal(Reflect.ownKeys(consumed.authorization).length, 1);
        assert.equal(JSON.stringify(consumed.authorization), '{}');
        await assert.rejects(stager.stage(consumed.authorization, TARGET), /disk space/i);
        assert.equal(statfsCalls, 1);
        assert.equal(networkCalls, 0);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('fetch capability rechecks delegated lease expiry before network and remains one-shot', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-lease-'));
    const stagingDirectory = join(runtimeRoot, '.staging-lease');
    await mkdir(stagingDirectory);
    const runtime = runtimeManifestEntryForTarget(TARGET);
    const presentation = createRideCodexRuntimeInstallPresentation(runtime, runtimeRoot);
    let now = 10;
    const consent = new RideCodexInstallConsent({ clock: () => now, ttlMs: 25 });
    const consumed = consent.consume(consent.issue(presentation), presentation);
    const destination = join(stagingDirectory, 'runtime.tgz');
    let networkCalls = 0;
    const fetcher = new RideCodexRuntimeFetcher({
        authorizationValidator: consent.authorizationValidator,
        requester: {
            open: async () => {
                networkCalls += 1;
                throw new Error('expired authorization reached the network');
            }
        }
    });

    try {
        now = 34;
        const capability = await fetcher.authorize(
            consumed.authorization,
            createInstallAuthorizationContext(runtime, await realpath(runtimeRoot), destination)
        );
        now = 36;
        await assert.rejects(
            fetcher.fetchAuthorized(capability, runtime, Object.freeze({
                path: destination,
                canonicalRoot: await realpath(runtimeRoot)
            })),
            /authorization|expired/i
        );
        assert.equal(networkCalls, 0);
        await assert.rejects(
            fetcher.fetchAuthorized(capability, runtime, destination),
            /invalid|already used/i
        );
    } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
    }
});

test('fetch capability rejects delegated lease clock rollback before network', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-clock-'));
    const stagingDirectory = join(runtimeRoot, '.staging-clock');
    await mkdir(stagingDirectory);
    const runtime = runtimeManifestEntryForTarget(TARGET);
    const presentation = createRideCodexRuntimeInstallPresentation(runtime, runtimeRoot);
    let now = 10;
    const consent = new RideCodexInstallConsent({ clock: () => now, ttlMs: 25 });
    const consumed = consent.consume(consent.issue(presentation), presentation);
    const destination = join(stagingDirectory, 'runtime.tgz');
    let networkCalls = 0;
    const fetcher = new RideCodexRuntimeFetcher({
        authorizationValidator: consent.authorizationValidator,
        requester: {
            open: async () => {
                networkCalls += 1;
                throw new Error('rolled-back clock reached the network');
            }
        }
    });

    try {
        now = 20;
        const capability = await fetcher.authorize(
            consumed.authorization,
            createInstallAuthorizationContext(runtime, await realpath(runtimeRoot), destination)
        );
        now = 19;
        await assert.rejects(
            fetcher.fetchAuthorized(capability, runtime, Object.freeze({
                path: destination,
                canonicalRoot: await realpath(runtimeRoot)
            })),
            /authorization|expired/i
        );
        assert.equal(networkCalls, 0);
    } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
    }
});

test('lease expiring while the destination opens is rejected at the exact network boundary', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-boundary-'));
    const stagingDirectory = join(runtimeRoot, '.staging-boundary');
    await mkdir(stagingDirectory);
    const runtime = runtimeManifestEntryForTarget(TARGET);
    const destination = join(stagingDirectory, 'runtime.tgz');
    const readings = [1, 1, 2];
    let clockReads = 0;
    let networkCalls = 0;
    const fetcher = new RideCodexRuntimeFetcher({
        authorizationValidator: async () => Object.freeze({
            issuedAt: 1,
            expiresAt: 2,
            now: () => readings[Math.min(clockReads++, readings.length - 1)]
        }),
        requester: {
            open: async () => {
                networkCalls += 1;
                throw new Error('expired lease reached the network');
            }
        }
    });
    const authorization = Object.freeze({ approved: true });

    try {
        const capability = await fetcher.authorize(
            authorization,
            createInstallAuthorizationContext(runtime, await realpath(runtimeRoot), destination)
        );
        await assert.rejects(
            fetcher.fetchAuthorized(capability, runtime, Object.freeze({
                path: destination,
                canonicalRoot: await realpath(runtimeRoot)
            })),
            /authorization|expired/i
        );
        assert.equal(networkCalls, 0);
        await assert.rejects(stat(destination), /ENOENT/);
        await assert.rejects(
            fetcher.fetchAuthorized(capability, runtime, destination),
            /invalid|already used/i
        );
    } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
    }
});

test('each redirect hop rechecks the delegated lease before opening the next request', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'ride-codex-fetch-redirect-lease-'));
    const stagingDirectory = join(runtimeRoot, '.staging-redirect-lease');
    await mkdir(stagingDirectory);
    const runtime = runtimeManifestEntryForTarget(TARGET);
    const destination = join(stagingDirectory, 'runtime.tgz');
    let now = 1;
    let networkCalls = 0;
    const fetcher = new RideCodexRuntimeFetcher({
        authorizationValidator: async () => Object.freeze({ issuedAt: 1, expiresAt: 2, now: () => now }),
        requester: {
            open: async () => {
                networkCalls += 1;
                if (networkCalls === 1) {
                    now = 2;
                    return Object.freeze({
                        statusCode: 302,
                        headers: Object.freeze({ location: '/second-hop.tgz' }),
                        body: Readable.from([])
                    });
                }
                throw new Error('expired redirect lease reached another network hop');
            }
        }
    });

    try {
        const capability = await fetcher.authorize(
            Object.freeze({ approved: true }),
            createInstallAuthorizationContext(runtime, await realpath(runtimeRoot), destination)
        );
        await assert.rejects(
            fetcher.fetchAuthorized(capability, runtime, Object.freeze({
                path: destination,
                canonicalRoot: await realpath(runtimeRoot)
            })),
            /authorization|expired/i
        );
        assert.equal(networkCalls, 1);
        await assert.rejects(stat(destination), /ENOENT/);
    } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
    }
});

test('queued installs recheck delegated consent TTL before staging side effects', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-queued-consent-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let now = 10;
    const consent = new RideCodexInstallConsent({ clock: () => now, ttlMs: 25 });
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    let releaseLock!: () => void;
    let markLocked!: () => void;
    const locked = new Promise<void>(resolveLocked => { markLocked = resolveLocked; });
    const release = new Promise<void>(resolveRelease => { releaseLock = resolveRelease; });
    const holderPresentation = presentationFor('0.144.0', runtimeRoot);
    const holderConsent = consent.consume(consent.issue(holderPresentation));
    const holder = store.withAuthorizedTransaction(
        holderConsent.transactionAuthorization,
        holderConsent.presentation,
        async () => {
        markLocked();
        await release;
        }
    );
    await locked;

    let stagingEffects = 0;
    let delegatedAuthorization: Parameters<typeof consent.authorizationValidator>[0] | undefined;
    let delegatedContext: Parameters<typeof consent.authorizationValidator>[1] | undefined;
    const installer = new RideCodexManagedInstaller({
        consent,
        store,
        validatePresentation: () => true,
        stager: {
            stage: async (authorization, _target, presentation) => {
                delegatedAuthorization = authorization;
                delegatedContext = Object.freeze({
                    target: presentation.target,
                    manifestDigest: presentation.manifestDigest,
                    canonicalRoot: runtimeRoot,
                    destination: join(runtimeRoot, '.staging-test', 'runtime.tgz')
                });
                if (!await consent.authorizationValidator(authorization, delegatedContext)) {
                    throw new Error('delegated consent expired before staging');
                }
                stagingEffects += 1;
                return createStagedRuntime(runtimeRoot, presentation);
            }
        },
        handshake: async () => undefined
    });
    try {
        const pending = installer.install(consent.issue(presentationFor('0.144.0', runtimeRoot)));
        now = 36;
        releaseLock();
        await holder;
        await assert.rejects(pending, /activation|consent/i);
        assert.equal(stagingEffects, 0);
        assert.equal(delegatedAuthorization, undefined);
        assert.equal(delegatedContext, undefined);
    } finally {
        releaseLock();
        await holder.catch(() => undefined);
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('official presentation derives every consent field from the reviewed manifest and delegated authorization is one-shot', async () => {
    const root = join(tmpdir(), 'ride-codex-official-presentation');
    const runtime = runtimeManifestEntryForTarget(TARGET);
    const presentation = createRideCodexRuntimeInstallPresentation(runtime, root);
    assert.equal(presentation.source, 'official-npm-registry');
    assert.equal(presentation.version, runtime.version);
    assert.equal(presentation.target, runtime.target);
    assert.equal(presentation.urlOrigin, new URL(runtime.url).origin);
    assert.equal(presentation.installRoot, root);
    assert.ok(presentation.requiredSpaceBytes > runtime.compressedBytes + runtime.unpackedBytes);
    assert.equal(presentation.rollbackPolicy, 'retain-new-and-previous-valid');
    assert.match(presentation.manifestDigest, /^sha256-[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(presentation), true);

    const consent = new RideCodexInstallConsent();
    const consumed = consent.consume(consent.issue(presentation), presentation);
    const context = Object.freeze({
        target: runtime.target,
        manifestDigest: presentation.manifestDigest,
        canonicalRoot: root,
        destination: join(root, '.staging-test', 'runtime.tgz')
    });
    const lease = await consent.authorizationValidator(consumed.authorization, context);
    assert.equal(typeof lease, 'object');
    assert.equal(Object.isFrozen(lease), true);
    assert.equal(await consent.authorizationValidator(consumed.authorization, context), false);
});

test('default installer rejects a consented presentation that differs from the reviewed manifest before disk or stage', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-reviewed-presentation-'));
    const runtimeRoot = join(trustedRuntimeBase, 'not-created');
    const runtime = runtimeManifestEntryForTarget(TARGET);
    const reviewed = createRideCodexRuntimeInstallPresentation(runtime, runtimeRoot);
    const mismatched = createRideCodexInstallPresentation({
        ...reviewed,
        requiredSpaceBytes: reviewed.requiredSpaceBytes + 1
    });
    const consent = new RideCodexInstallConsent();
    let stageCalls = 0;
    const installer = new RideCodexManagedInstaller({
        consent,
        store: new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot }),
        stager: {
            stage: async (_authorization, _target, presentation) => {
                stageCalls += 1;
                return createStagedRuntime(runtimeRoot, presentation);
            }
        },
        handshake: async () => undefined
    });
    try {
        await assert.rejects(installer.install(consent.issue(mismatched)), /consent|manifest/i);
        assert.equal(stageCalls, 0);
        await assert.rejects(stat(runtimeRoot), /ENOENT/);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('managed installation rejects UNC and network-share roots before issuing consent or touching disk', () => {
    const unc = '\\\\server\\share\\r-ide\\codex';
    assert.throws(() => createRideCodexInstallPresentation({
        source: 'official-npm-registry',
        version: '0.144.0',
        target: TARGET,
        urlOrigin: 'https://registry.npmjs.org',
        installRoot: unc,
        requiredSpaceBytes: 1024,
        rollbackPolicy: 'retain-new-and-previous-valid',
        manifestDigest: `sha256-${'a'.repeat(64)}`
    }), /presentation|root|path/i);
    assert.throws(() => new RideCodexRuntimeStore({
        trustedRuntimeBase: '\\\\server\\share\\r-ide',
        runtimeRoot: unc
    }), /local|network|path/i);
});

test('invalid or reused consent is rejected before store recovery, capacity checks, network, or staging', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-consent-order-'));
    const runtimeRoot = join(trustedRuntimeBase, 'not-created');
    const consent = new RideCodexInstallConsent();
    let stageCalls = 0;
    const installer = new RideCodexManagedInstaller({
        consent,
        store: new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot }),
        validatePresentation: () => true,
        stager: {
            stage: async (_authorization, _target, presentation) => {
                stageCalls += 1;
                return createStagedRuntime(runtimeRoot, presentation);
            }
        },
        handshake: async () => undefined
    });
    try {
        await assert.rejects(installer.install(undefined), /consent/i);
        const foreign = new RideCodexInstallConsent().issue(presentationFor('0.144.0', runtimeRoot));
        await assert.rejects(installer.install(foreign), /consent/i);
        assert.equal(stageCalls, 0);
        await assert.rejects(stat(runtimeRoot), /ENOENT/);

        const token: InstallConsentToken = consent.issue(presentationFor('0.144.0', runtimeRoot));
        const [left, right] = await Promise.allSettled([installer.install(token), installer.install(token)]);
        assert.equal([left, right].filter(result => result.status === 'fulfilled').length, 1);
        assert.equal([left, right].filter(result => result.status === 'rejected').length, 1);
        assert.equal(stageCalls, 1);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('pointer write interruption and rename failure preserve the previous active runtime and stale temps recover', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-pointer-fault-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let syncFailure = false;
    let renameFailure = false;
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            beforePointerSync: kind => {
                if (kind === 'activate' && syncFailure) {
                    syncFailure = false;
                    throw new Error('simulated interrupted pointer write');
                }
            },
            beforePointerRename: kind => {
                if (kind === 'activate' && renameFailure) {
                    renameFailure = false;
                    throw new Error('simulated rename failure');
                }
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    const installer = createInstaller(runtimeRoot, consent, store);
    try {
        await installer.install(consent.issue(presentationFor('0.143.0', runtimeRoot)));
        syncFailure = true;
        await assert.rejects(installer.install(consent.issue(presentationFor('0.144.0', runtimeRoot))), /activation/i);
        assert.equal(await store.activeVersion(), '0.143.0');
        assert.equal((await readdir(runtimeRoot)).some(name => name.startsWith('active.json.tmp-')), true);

        await installer.install(consent.issue(presentationFor('0.144.0', runtimeRoot)));
        assert.equal((await readdir(runtimeRoot)).some(name => name.startsWith('active.json.tmp-')), false);
        renameFailure = true;
        await assert.rejects(installer.install(consent.issue(presentationFor('0.145.0', runtimeRoot))), /activation/i);
        assert.equal(await store.activeVersion(), '0.144.0');
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('a pointer rename that committed before a later durability error is recognized and handshaken', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-pointer-commit-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let failAfterCommit = false;
    let handshakes = 0;
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            afterPointerRename: kind => {
                if (kind === 'activate' && failAfterCommit) {
                    failAfterCommit = false;
                    throw new Error('simulated parent directory sync failure after commit');
                }
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    const installer = new RideCodexManagedInstaller({
        consent,
        store,
        validatePresentation: () => true,
        stager: {
            stage: async (authorization, _target, presentation) => createStagedRuntime(
                runtimeRoot,
                presentation,
                authorization,
                consent.authorizationValidator
            )
        },
        handshake: async () => { handshakes += 1; }
    });
    try {
        await installer.install(consent.issue(presentationFor('0.143.0', runtimeRoot)));
        failAfterCommit = true;
        await installer.install(consent.issue(presentationFor('0.144.0', runtimeRoot)));
        assert.equal(await store.activeVersion(), '0.144.0');
        assert.equal(handshakes, 2);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('activation reattests the committed candidate before handshake and restores the previous runtime on mutation', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-activation-postcondition-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let mutateCandidate = false;
    let handshakes = 0;
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            beforePointerRename: async kind => {
                if (kind !== 'activate' || !mutateCandidate) {
                    return;
                }
                mutateCandidate = false;
                const versions = await readdir(join(runtimeRoot, 'versions'));
                const candidate = versions.find(name => name.startsWith('v-0.144.0--'));
                assert.ok(candidate);
                await writeFile(
                    join(runtimeRoot, 'versions', candidate, 'package', 'vendor', TARGET, 'bin', 'codex.exe'),
                    'MUTATED-BEFORE-HANDSHAKE'
                );
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    const installer = new RideCodexManagedInstaller({
        consent,
        store,
        validatePresentation: () => true,
        stager: {
            stage: async (authorization, _target, presentation) => createStagedRuntime(
                runtimeRoot,
                presentation,
                authorization,
                consent.authorizationValidator
            )
        },
        handshake: async () => { handshakes += 1; }
    });
    try {
        await installer.install(consent.issue(presentationFor('0.143.0', runtimeRoot)));
        handshakes = 0;
        mutateCandidate = true;
        await assert.rejects(
            installer.install(consent.issue(presentationFor('0.144.0', runtimeRoot))),
            /activation|attestation|rollback/i
        );
        assert.equal(handshakes, 0);
        assert.equal(await store.activeVersion(), '0.143.0');
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('rollback reattests the committed previous runtime and never reports a mutated pointer as valid', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-rollback-postcondition-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let mutatePrevious = false;
    let previousExecutable = '';
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            beforePointerRename: async kind => {
                if (kind === 'rollback' && mutatePrevious) {
                    mutatePrevious = false;
                    await writeFile(previousExecutable, 'MUTATED-PREVIOUS-RUNTIME');
                }
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        previousExecutable = (await store.readActiveRuntime())!.executable;
        mutatePrevious = true;
        await assert.rejects(
            createInstaller(runtimeRoot, consent, store).install(
                consent.issue(presentationFor('0.144.0', runtimeRoot)),
                { failHandshake: true }
            ),
            error => {
                assert.ok(error instanceof RideCodexManagedInstallError);
                assert.deepEqual(error.diagnostics.map(diagnostic => diagnostic.code), [
                    'handshake-failed', 'rollback-failed'
                ]);
                return true;
            }
        );
        await assert.rejects(store.readActiveRuntime(), /attestation|runtime/i);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('recovery rolls back a committed pending activation, including a first install with no previous runtime', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-pending-recovery-'));
    const outside = await mkdtemp(join(tmpdir(), 'ride-codex-pending-outside-'));
    const sentinel = join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'preserve');
    try {
        const runtimeRoot = join(trustedRuntimeBase, 'managed');
        const consent = new RideCodexInstallConsent();
        const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        const previous = await store.readActiveRuntime();
        assert.ok(previous);
        const presentation = presentationFor('0.144.0', runtimeRoot);
        await withAuthorizedStoreTransaction(store, presentation, async transaction => {
            const published = await store.publish(
                transaction,
                await createStagedRuntime(runtimeRoot, presentation),
                presentation
            );
            await store.activate(transaction, published, previous);
        });
        assert.equal(await store.activeVersion(), '0.143.0');
        assert.equal(await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false), true);

        const restarted = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
        await restarted.recover();
        assert.equal(await restarted.activeVersion(), '0.143.0');
        assert.equal(await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false), false);

        const firstBase = await mkdtemp(join(tmpdir(), 'ride-codex-pending-first-'));
        try {
            const firstRoot = join(firstBase, 'managed');
            const firstStore = new RideCodexRuntimeStore({ trustedRuntimeBase: firstBase, runtimeRoot: firstRoot });
            const firstPresentation = presentationFor('0.144.0', firstRoot);
            await withAuthorizedStoreTransaction(firstStore, firstPresentation, async transaction => {
                const firstPublished = await firstStore.publish(
                    transaction,
                    await createStagedRuntime(firstRoot, firstPresentation),
                    firstPresentation
                );
                await firstStore.activate(transaction, firstPublished, undefined);
            });
            await new RideCodexRuntimeStore({ trustedRuntimeBase: firstBase, runtimeRoot: firstRoot }).recover();
            assert.equal(await firstStore.activeVersion(), undefined);
        } finally {
            await rm(firstBase, { recursive: true, force: true });
        }
        assert.equal(await readFile(sentinel, 'utf8'), 'preserve');
    } finally {
        await Promise.all([
            rm(trustedRuntimeBase, { recursive: true, force: true }),
            rm(outside, { recursive: true, force: true })
        ]);
    }
});

test('recovery rejects malformed pending journals without deleting runtime or external data', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-pending-invalid-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const outside = await mkdtemp(join(tmpdir(), 'ride-codex-pending-invalid-outside-'));
    const sentinel = join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'preserve');
    const consent = new RideCodexInstallConsent();
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        const previous = await store.readActiveRuntime();
        assert.ok(previous);
        const presentation = presentationFor('0.144.0', runtimeRoot);
        await withAuthorizedStoreTransaction(store, presentation, async transaction => {
            const published = await store.publish(
                transaction,
                await createStagedRuntime(runtimeRoot, presentation),
                presentation
            );
            await store.activate(transaction, published, previous);
        });
        const pendingPath = join(runtimeRoot, 'pending-activation.json');
        const validPending = await readFile(pendingPath, 'utf8');
        const parsed = JSON.parse(validPending) as Record<string, unknown>;
        const candidate = parsed.candidate as Record<string, unknown>;
        const malformed = [
            '{not-json',
            Buffer.alloc(64 * 1024 + 1, 0x61),
            validPending.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
            `${JSON.stringify({
                ...parsed,
                candidate: { ...candidate, relativePath: 'versions/v-9.9.9--x86_64-pc-windows-msvc--aaaaaaaaaaaaaaaa' }
            })}\n`
        ];
        const stale = join(runtimeRoot, '.staging-must-not-delete');
        await mkdir(stale);
        await writeFile(join(stale, 'local-sentinel.txt'), 'preserve');
        for (const bytes of malformed) {
            await writeFile(pendingPath, bytes);
            await assert.rejects(store.recover(), /pending|journal|transaction|invalid|oversized/i);
            assert.equal(await readFile(join(stale, 'local-sentinel.txt'), 'utf8'), 'preserve');
            assert.equal(await readFile(sentinel, 'utf8'), 'preserve');
        }
        await writeFile(pendingPath, validPending);
        await store.recover();
        assert.equal(await store.activeVersion(), '0.143.0');
    } finally {
        await Promise.all([
            rm(trustedRuntimeBase, { recursive: true, force: true }),
            rm(outside, { recursive: true, force: true })
        ]);
    }
});

test('successful handshake finalizes its journal and finalize failure rolls back without reporting ready', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-finalize-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let failFinalize = false;
    const progress: InstallProgress[] = [];
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            beforePendingFinalize: () => {
                if (failFinalize) {
                    failFinalize = false;
                    throw new Error('simulated pending journal finalize failure');
                }
            }
        } as never
    });
    const consent = new RideCodexInstallConsent();
    const installer = new RideCodexManagedInstaller({
        consent,
        store,
        validatePresentation: () => true,
        stager: { stage: async (_authorization, _target, presentation) => createStagedRuntime(runtimeRoot, presentation) },
        handshake: async () => undefined,
        onProgress: update => progress.push(update)
    });
    try {
        await installer.install(consent.issue(presentationFor('0.143.0', runtimeRoot)));
        assert.equal(await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false), false);
        progress.length = 0;
        failFinalize = true;
        await assert.rejects(
            installer.install(consent.issue(presentationFor('0.144.0', runtimeRoot))),
            /finalize|activation|rollback/i
        );
        assert.equal(await store.activeVersion(), '0.143.0');
        assert.equal(progress.some(update => update.state === 'ready'), false);
        assert.equal(await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false), false);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('post-move attestation failure removes the failed version and never changes active state', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-publish-failure-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const consent = new RideCodexInstallConsent();
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const installer = new RideCodexManagedInstaller({
        consent,
        store,
        validatePresentation: () => true,
        stager: {
            stage: async (_authorization, _target, presentation) => Object.freeze({
                ...await createStagedRuntime(runtimeRoot, presentation),
                unpackedBytes: 1
            })
        },
        handshake: async () => undefined
    });
    try {
        await assert.rejects(
            installer.install(consent.issue(presentationFor('0.144.0', runtimeRoot))),
            /activation/i
        );
        assert.equal(await store.activeVersion(), undefined);
        assert.deepEqual(await store.versions(), []);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('same-root installs serialize, different roots proceed independently, and locks release after failure', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-locks-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const consent = new RideCodexInstallConsent();
    let activeStages = 0;
    let maximumActiveStages = 0;
    let failFirst = true;
    const installer = new RideCodexManagedInstaller({
        consent,
        store,
        validatePresentation: () => true,
        stager: {
            stage: async (_authorization, _target, presentation) => {
                activeStages += 1;
                maximumActiveStages = Math.max(maximumActiveStages, activeStages);
                await delay(20);
                activeStages -= 1;
                if (failFirst) {
                    failFirst = false;
                    throw new Error('expected first staging failure');
                }
                return createStagedRuntime(runtimeRoot, presentation);
            }
        },
        handshake: async () => undefined
    });
    try {
        const results = await Promise.allSettled([
            installer.install(consent.issue(presentationFor('0.143.0', runtimeRoot))),
            installer.install(consent.issue(presentationFor('0.144.0', runtimeRoot)))
        ]);
        assert.equal(results[0].status, 'rejected');
        assert.equal(results[1].status, 'fulfilled');
        assert.equal(maximumActiveStages, 1);
        assert.equal(await store.activeVersion(), '0.144.0');
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }

    const baseA = await mkdtemp(join(tmpdir(), 'ride-codex-lock-a-'));
    const baseB = await mkdtemp(join(tmpdir(), 'ride-codex-lock-b-'));
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>(resolveBoth => { release = resolveBoth; });
    const makeParallel = (base: string): { consent: RideCodexInstallConsent; installer: RideCodexManagedInstaller } => {
        const root = join(base, 'managed');
        const localConsent = new RideCodexInstallConsent();
        return {
            consent: localConsent,
            installer: new RideCodexManagedInstaller({
                consent: localConsent,
                store: new RideCodexRuntimeStore({ trustedRuntimeBase: base, runtimeRoot: root }),
                validatePresentation: () => true,
                stager: {
                    stage: async (_authorization, _target, presentation) => {
                        entered += 1;
                        if (entered === 2) {
                            release();
                        }
                        await bothEntered;
                        return createStagedRuntime(root, presentation);
                    }
                },
                handshake: async () => undefined
            })
        };
    };
    const left = makeParallel(baseA);
    const right = makeParallel(baseB);
    try {
        await Promise.race([
            Promise.all([
                left.installer.install(left.consent.issue(presentationFor('0.144.0', join(baseA, 'managed')))),
                right.installer.install(right.consent.issue(presentationFor('0.144.0', join(baseB, 'managed'))))
            ]),
            delay(1_000).then(() => {
                release();
                throw new Error('different runtime roots were globally serialized');
            })
        ]);
        assert.equal(entered, 2);
    } finally {
        release();
        await Promise.all([
            rm(baseA, { recursive: true, force: true }),
            rm(baseB, { recursive: true, force: true })
        ]);
    }
});

test('handshake rollback restores the previous pointer and reports bounded primary plus rollback diagnostics', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-rollback-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let failRollback = false;
    const progress: InstallProgress[] = [];
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            beforePointerRename: kind => {
                if (kind === 'rollback' && failRollback) {
                    throw new Error('C:\\Users\\private OPENAI_API_KEY=secret');
                }
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    const installer = new RideCodexManagedInstaller({
        consent,
        store,
        validatePresentation: () => true,
        stager: { stage: async (_authorization, _target, presentation) => createStagedRuntime(runtimeRoot, presentation) },
        handshake: async (_runtime, options) => {
            if (options.failHandshake) {
                throw new Error('archive bytes and secret command output');
            }
        },
        onProgress: update => progress.push(update)
    });
    try {
        await installer.install(consent.issue(presentationFor('0.143.0', runtimeRoot)));
        progress.length = 0;
        await assert.rejects(
            installer.install(consent.issue(presentationFor('0.144.0', runtimeRoot)), { failHandshake: true }),
            error => {
                assert.ok(error instanceof RideCodexManagedInstallError);
                assert.deepEqual(error.diagnostics.map(diagnostic => diagnostic.code), ['handshake-failed']);
                assert.doesNotMatch(JSON.stringify(error.diagnostics), /archive|secret|Users|OPENAI_API_KEY|private/i);
                return true;
            }
        );
        assert.equal(await store.activeVersion(), '0.143.0');
        assert.deepEqual(progress.map(update => update.state), [
            'downloading', 'verifying', 'activating', 'rolled-back', 'failed'
        ]);

        failRollback = true;
        await assert.rejects(
            installer.install(consent.issue(presentationFor('0.144.0', runtimeRoot)), { failHandshake: true }),
            error => {
                assert.ok(error instanceof RideCodexManagedInstallError);
                assert.deepEqual(error.diagnostics.map(diagnostic => diagnostic.code), [
                    'handshake-failed', 'rollback-failed'
                ]);
                assert.ok(JSON.stringify(error.diagnostics).length < 1024);
                assert.doesNotMatch(JSON.stringify(error.diagnostics), /archive|secret|Users|OPENAI_API_KEY|private/i);
                return true;
            }
        );
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('rollback committed before a later durability error is recognized and the failed version is removed', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-rollback-commit-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let failAfterRollbackCommit = false;
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            afterPointerRename: kind => {
                if (kind === 'rollback' && failAfterRollbackCommit) {
                    failAfterRollbackCommit = false;
                    throw new Error('simulated rollback parent sync failure');
                }
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    const installer = createInstaller(runtimeRoot, consent, store);
    try {
        await installer.install(consent.issue(presentationFor('0.143.0', runtimeRoot)));
        failAfterRollbackCommit = true;
        await assert.rejects(
            installer.install(consent.issue(presentationFor('0.144.0', runtimeRoot)), { failHandshake: true }),
            error => {
                assert.ok(error instanceof RideCodexManagedInstallError);
                assert.deepEqual(error.diagnostics.map(diagnostic => diagnostic.code), ['handshake-failed']);
                return true;
            }
        );
        assert.equal(await store.activeVersion(), '0.143.0');
        assert.deepEqual(await store.versions(), ['0.143.0']);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('first-install handshake failure leaves no active pointer or failed version', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-first-rollback-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const consent = new RideCodexInstallConsent();
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const installer = createInstaller(runtimeRoot, consent, store);
    try {
        await assert.rejects(
            installer.install(consent.issue(presentationFor('0.144.0', runtimeRoot)), { failHandshake: true }),
            /handshake/i
        );
        assert.equal(await store.activeVersion(), undefined);
        assert.deepEqual(await store.versions(), []);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('rollback refuses a previous runtime changed during handshake and leaves the new pointer intact', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-rollback-revalidate-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const consent = new RideCodexInstallConsent();
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const initialInstaller = createInstaller(runtimeRoot, consent, store);
    try {
        await initialInstaller.install(consent.issue(presentationFor('0.143.0', runtimeRoot)));
        const previous = await store.readActiveRuntime();
        assert.ok(previous);
        const installer = new RideCodexManagedInstaller({
            consent,
            store,
            validatePresentation: () => true,
            stager: { stage: async (_authorization, _target, presentation) => createStagedRuntime(runtimeRoot, presentation) },
            handshake: async () => {
                await writeFile(join(previous.directory, 'changed-during-handshake'), 'tampered');
                throw new Error('handshake failed');
            }
        });
        await assert.rejects(
            installer.install(consent.issue(presentationFor('0.144.0', runtimeRoot))),
            error => {
                assert.ok(error instanceof RideCodexManagedInstallError);
                assert.deepEqual(error.diagnostics.map(diagnostic => diagnostic.code), [
                    'handshake-failed', 'rollback-failed'
                ]);
                return true;
            }
        );
        const rawPointer = JSON.parse(await readFile(join(runtimeRoot, 'active.json'), 'utf8')) as { version: string };
        assert.equal(rawPointer.version, '0.144.0');
        await assert.rejects(store.activeVersion(), /attestation|runtime|pending/i);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('successful activation retains the previous version only when it still passes full attestation', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-retain-valid-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const consent = new RideCodexInstallConsent();
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    await createInstaller(runtimeRoot, consent, store).install(
        consent.issue(presentationFor('0.143.0', runtimeRoot))
    );
    const previous = await store.readActiveRuntime();
    assert.ok(previous);
    const installer = new RideCodexManagedInstaller({
        consent,
        store,
        validatePresentation: () => true,
        stager: { stage: async (_authorization, _target, presentation) => createStagedRuntime(runtimeRoot, presentation) },
        handshake: async () => {
            await writeFile(join(previous.directory, 'changed-before-retention'), 'tampered');
        }
    });
    try {
        await installer.install(consent.issue(presentationFor('0.144.0', runtimeRoot)));
        assert.equal(await store.activeVersion(), '0.144.0');
        assert.deepEqual(await store.versions(), ['0.144.0']);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('recovery deletes only verified stale entries and cleanup never follows external links or non-canonical names', async t => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-recovery-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const outside = await mkdtemp(join(tmpdir(), 'ride-codex-outside-'));
    const sentinel = join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'preserve');
    await mkdir(join(runtimeRoot, '.staging-stale'), { recursive: true });
    await writeFile(join(runtimeRoot, 'active.json.tmp-stale'), 'partial');
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    try {
        await store.recover();
        assert.equal((await readdir(runtimeRoot)).some(name => name.startsWith('.staging-stale')), false);
        assert.equal((await readdir(runtimeRoot)).some(name => name.startsWith('active.json.tmp-stale')), false);

        const versionsRoot = join(runtimeRoot, 'versions');
        const nonCanonical = join(versionsRoot, 'do-not-delete');
        await mkdir(nonCanonical);
        await writeFile(join(nonCanonical, 'sentinel.txt'), 'local');
        assert.equal(
            (store as unknown as { cleanupObsolete?: unknown }).cleanupObsolete,
            undefined
        );
        assert.equal(await readFile(join(nonCanonical, 'sentinel.txt'), 'utf8'), 'local');

        const linkedVersion = join(
            versionsRoot,
            `v-9.9.9--${TARGET}--${'a'.repeat(16)}`
        );
        try {
            await symlink(outside, linkedVersion, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
            if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
                t.skip('This host does not permit creating a test junction/symlink.');
                return;
            }
            throw error;
        }
        assert.equal(await readFile(sentinel, 'utf8'), 'preserve');

        const stagingLink = join(runtimeRoot, '.staging-external');
        await symlink(outside, stagingLink, process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(store.recover(), /link|cleanup|safe/i);
        assert.equal(await readFile(sentinel, 'utf8'), 'preserve');
    } finally {
        await Promise.all([
            rm(trustedRuntimeBase, { recursive: true, force: true }),
            rm(outside, { recursive: true, force: true })
        ]);
    }
});

test('recovery refuses a stale tree containing a nested link before recursive deletion', async t => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-nested-link-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const outside = await mkdtemp(join(tmpdir(), 'ride-codex-nested-outside-'));
    const sentinel = join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'preserve');
    const stale = join(runtimeRoot, '.staging-stale');
    await mkdir(stale, { recursive: true });
    try {
        await symlink(outside, join(stale, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            t.skip('This host does not permit creating a test junction/symlink.');
            await Promise.all([
                rm(trustedRuntimeBase, { recursive: true, force: true }),
                rm(outside, { recursive: true, force: true })
            ]);
            return;
        }
        throw error;
    }
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    try {
        await assert.rejects(store.recover(), /link|cleanup|safe/i);
        assert.equal(await readFile(sentinel, 'utf8'), 'preserve');
    } finally {
        await Promise.all([
            rm(trustedRuntimeBase, { recursive: true, force: true }),
            rm(outside, { recursive: true, force: true })
        ]);
    }
});

test('successful activation keeps exactly the new and previous valid versions', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-retention-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const consent = new RideCodexInstallConsent();
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const installer = createInstaller(runtimeRoot, consent, store);
    try {
        for (const version of ['0.142.0', '0.143.0', '0.144.0']) {
            await installer.install(consent.issue(presentationFor(version, runtimeRoot)));
        }
        assert.equal(await store.activeVersion(), '0.144.0');
        assert.deepEqual(await store.versions(), ['0.143.0', '0.144.0']);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('active pointer parsing and runtime validation fail closed for malformed, oversized, linked, escaped, or inconsistent data', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-pointer-validate-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const consent = new RideCodexInstallConsent();
    const installer = createInstaller(runtimeRoot, consent, store);
    const activePath = join(runtimeRoot, 'active.json');
    try {
        await installer.install(consent.issue(presentationFor('0.144.0', runtimeRoot)));
        const validBytes = await readFile(activePath);
        const valid = JSON.parse(validBytes.toString('utf8')) as Record<string, unknown>;
        const duplicateVersion = validBytes.toString('utf8').replace(
            `"version":"${String(valid.version)}"`,
            `"version":"9.9.9","version":"${String(valid.version)}"`
        );

        const invalidPointers: readonly (string | Record<string, unknown>)[] = [
            '{not-json',
            duplicateVersion,
            { ...valid, unexpected: true },
            { ...valid, relativePath: '../outside' },
            { ...valid, version: '0.145.0' },
            { ...valid, executableRelativePath: '../../outside.exe' },
            {
                ...valid,
                executableRelativePath: `package/vendor/${String(valid.target)}/codex-resources/helper.bin`
            },
            { ...valid, treeDigest: `sha256-${'0'.repeat(64)}` }
        ];
        for (const invalid of invalidPointers) {
            await writeFile(activePath, typeof invalid === 'string' ? invalid : JSON.stringify(invalid));
            await assert.rejects(store.readActiveRuntime(), /pointer|runtime|attestation|invalid/i);
            await writeFile(activePath, validBytes);
        }

        await writeFile(activePath, Buffer.alloc(16 * 1024 + 1, 0x61));
        await assert.rejects(store.readActiveRuntime(), /pointer|oversized|unsafe/i);
        await writeFile(activePath, validBytes);

        const outsidePointer = join(trustedRuntimeBase, 'outside-active.json');
        await writeFile(outsidePointer, validBytes);
        await rm(activePath);
        await link(outsidePointer, activePath);
        await assert.rejects(store.readActiveRuntime(), /pointer|unsafe/i);
        await rm(activePath);
        await writeFile(activePath, validBytes);

        const active = await store.readActiveRuntime();
        assert.ok(active);
        await writeFile(join(active.directory, 'unexpected-resource.bin'), 'changed');
        await assert.rejects(store.readActiveRuntime(), /attestation|runtime/i);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('managed resolver remains lazy, performs no writes without a pointer, and consumes only a validated active runtime', async () => {
    const emptyBase = await mkdtemp(join(tmpdir(), 'ride-codex-resolver-empty-'));
    const emptyRoot = join(emptyBase, 'managed');
    const emptyStore = new RideCodexRuntimeStore({ trustedRuntimeBase: emptyBase, runtimeRoot: emptyRoot });
    let managedReads = 0;
    const lazyStore = {
        readActiveRuntime: async () => {
            managedReads += 1;
            return emptyStore.readActiveRuntime();
        }
    };
    const emptyResolver = new RideCodexRuntimeResolver({
        platform: 'win32',
        arch: 'x64',
        readEnvironment: () => ({}),
        readUserOverride: () => undefined,
        findSystemCandidates: () => [],
        managedRuntimeStore: lazyStore,
        probe: { probe: async () => ({ version: '0.144.0' }) }
    });
    try {
        assert.equal(managedReads, 0);
        await assert.rejects(stat(emptyRoot), /ENOENT/);
        await assert.rejects(emptyResolver.resolve(), /No compatible native Codex runtime/i);
        assert.equal(managedReads, 1);
        await assert.rejects(stat(emptyRoot), /ENOENT/);
    } finally {
        await rm(emptyBase, { recursive: true, force: true });
    }

    const host = hostRuntime();
    if (!host) {
        return;
    }
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-resolver-valid-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const consent = new RideCodexInstallConsent();
    const runtime = runtimeManifestEntryForTarget(host.target);
    const presentation = presentationFor(runtime.version, runtimeRoot, runtime.target);
    const installer = new RideCodexManagedInstaller({
        consent,
        store,
        validatePresentation: () => true,
        stager: { stage: async (_authorization, _target, installPresentation) => createStagedRuntime(runtimeRoot, installPresentation) },
        handshake: async () => undefined
    });
    try {
        await installer.install(consent.issue(presentation));
        await rewriteActiveRuntimeMetadata(store, runtimeRoot, runtime);
        const active = await store.readActiveRuntime();
        assert.ok(active);
        assert.equal(active.version, runtime.version);
        assert.equal(active.target, runtime.target);
        assert.equal(active.manifestDigest, runtimeManifestEntryDigest(runtime));
        assert.equal(Object.isFrozen(active), true);
        assert.equal(Object.isFrozen(active.pointer), true);
        assert.equal(Object.isFrozen(active.pointer.rootIdentity), true);
        let validatedActiveReads = 0;
        const resolver = new RideCodexRuntimeResolver({
            platform: host.platform,
            arch: host.arch,
            readEnvironment: () => ({}),
            readUserOverride: () => undefined,
            findSystemCandidates: () => [],
            managedRuntimeStore: {
                readActiveRuntime: async () => {
                    validatedActiveReads += 1;
                    return store.readActiveRuntime();
                }
            },
            probe: { probe: async () => ({ version: '0.144.0' }) }
        });
        const launch = await resolver.resolve();
        assert.equal(launch.source, 'managed');
        assert.equal(launch.executable, active.executable);
        assert.equal(launch.version, active.version);
        assert.equal(launch.target, active.target);
        assert.equal(validatedActiveReads, 1);
        await writeFile(active.executable, 'MUTATED-AFTER-FIRST-MANAGED-RESOLVE');
        await assert.rejects(resolver.resolve(), /No compatible native Codex runtime/i);
        assert.equal(validatedActiveReads, 2);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('pending activation exposes only the committed runtime to store and resolver', async () => {
    const host = hostRuntime();
    if (!host) {
        return;
    }
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-pending-view-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const consent = new RideCodexInstallConsent();
    const reviewed = runtimeManifestEntryForTarget(host.target);
    const previousPresentation = presentationFor(reviewed.version, runtimeRoot, reviewed.target);
    try {
        await new RideCodexManagedInstaller({
            consent,
            store,
            validatePresentation: () => true,
            stager: { stage: async (_authorization, _target, presentation) => createStagedRuntime(runtimeRoot, presentation) },
            handshake: async () => undefined
        }).install(consent.issue(previousPresentation));
        await rewriteActiveRuntimeMetadata(store, runtimeRoot, reviewed);
        const previous = await store.readActiveRuntime();
        assert.ok(previous);

        const candidatePresentation = presentationFor('0.145.0', runtimeRoot, host.target);
        await withAuthorizedStoreTransaction(store, candidatePresentation, async transaction => {
            const published = await store.publish(
                transaction,
                await createStagedRuntime(runtimeRoot, candidatePresentation),
                candidatePresentation
            );
            await store.activate(transaction, published, previous);
        });

        assert.equal((await store.readActiveRuntime())?.relativePath, previous.relativePath);
        const resolver = new RideCodexRuntimeResolver({
            platform: host.platform,
            arch: host.arch,
            readEnvironment: () => ({}),
            readUserOverride: () => undefined,
            findSystemCandidates: () => [],
            managedRuntimeStore: store,
            probe: { probe: async () => ({ version: reviewed.version }) }
        });
        assert.equal((await resolver.resolve()).executable, previous.executable);

        const firstBase = await mkdtemp(join(tmpdir(), 'ride-codex-pending-first-view-'));
        try {
            const firstRoot = join(firstBase, 'managed');
            const firstStore = new RideCodexRuntimeStore({ trustedRuntimeBase: firstBase, runtimeRoot: firstRoot });
            const firstPresentation = presentationFor(reviewed.version, firstRoot, reviewed.target);
            await withAuthorizedStoreTransaction(firstStore, firstPresentation, async transaction => {
                const firstPublished = await firstStore.publish(
                    transaction,
                    await createStagedRuntime(firstRoot, firstPresentation),
                    firstPresentation
                );
                await firstStore.activate(transaction, firstPublished, undefined);
            });
            assert.equal(await firstStore.readActiveRuntime(), undefined);
            const firstResolver = new RideCodexRuntimeResolver({
                platform: host.platform,
                arch: host.arch,
                readEnvironment: () => ({}),
                readUserOverride: () => undefined,
                findSystemCandidates: () => [],
                managedRuntimeStore: firstStore,
                probe: { probe: async () => ({ version: reviewed.version }) }
            });
            await assert.rejects(firstResolver.resolve(), /No compatible native Codex runtime/i);
        } finally {
            await rm(firstBase, { recursive: true, force: true });
        }
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('recovery quarantines a version renamed before its publishing journal phase update and permits retry', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-publish-phase-crash-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let crashAfterRename = false;
    const hooks = {
        afterPublishRename: () => {
            if (crashAfterRename) {
                crashAfterRename = false;
                throw new Error('simulated crash after publish rename');
            }
        }
    } as RideCodexRuntimeStoreTestHooks;
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot, testHooks: hooks });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        const candidatePresentation = presentationFor('0.144.0', runtimeRoot);
        crashAfterRename = true;
        await assert.rejects(
            withAuthorizedStoreTransaction(store, candidatePresentation, async transaction => store.publish(
                transaction,
                await createStagedRuntime(runtimeRoot, candidatePresentation),
                candidatePresentation
            )),
            /simulated crash/i
        );
        assert.equal(await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false), true);

        const restarted = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
        await restarted.recover();
        assert.equal(await restarted.activeVersion(), '0.143.0');
        assert.deepEqual(await restarted.versions(), ['0.143.0']);

        const retryConsent = new RideCodexInstallConsent();
        await createInstaller(runtimeRoot, retryConsent, restarted).install(
            retryConsent.issue(candidatePresentation)
        );
        assert.equal(await restarted.activeVersion(), '0.144.0');
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('publish does not adopt an active runtime when the caller explicitly expected no previous runtime', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-publish-previous-race-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        const presentation = presentationFor('0.144.0', runtimeRoot);
        await assert.rejects(
            withAuthorizedStoreTransaction(store, presentation, async transaction => store.publish(
                transaction,
                await createStagedRuntime(runtimeRoot, presentation),
                presentation,
                undefined
            )),
            /active runtime changed|previous/i
        );
        assert.equal(await store.activeVersion(), '0.143.0');
        assert.deepEqual(await store.versions(), ['0.143.0']);
        assert.equal(await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false), false);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('recovery quarantines staging after a publishing journal commit before the version rename', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-publish-intent-crash-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let crashBeforeRename = false;
    const hooks = {
        afterPublishingJournalWrite: () => {
            if (crashBeforeRename) {
                crashBeforeRename = false;
                throw new Error('simulated crash before publish rename');
            }
        }
    } as RideCodexRuntimeStoreTestHooks;
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot, testHooks: hooks });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        const candidatePresentation = presentationFor('0.144.0', runtimeRoot);
        crashBeforeRename = true;
        await assert.rejects(
            withAuthorizedStoreTransaction(store, candidatePresentation, async transaction => store.publish(
                transaction,
                await createStagedRuntime(runtimeRoot, candidatePresentation),
                candidatePresentation
            )),
            /simulated crash/i
        );
        assert.equal(await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false), true);

        const restarted = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
        await restarted.recover();
        assert.equal(await restarted.activeVersion(), '0.143.0');
        assert.deepEqual(await restarted.versions(), ['0.143.0']);
        assert.equal((await readdir(runtimeRoot)).some(entry => entry.startsWith('.staging-')), false);

        const retryConsent = new RideCodexInstallConsent();
        await createInstaller(runtimeRoot, retryConsent, restarted).install(
            retryConsent.issue(candidatePresentation)
        );
        assert.equal(await restarted.activeVersion(), '0.144.0');
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('crash recovery removes an unhandshaken candidate and permits the same version to retry', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-retry-after-recovery-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        const previous = await store.readActiveRuntime();
        assert.ok(previous);
        const candidatePresentation = presentationFor('0.144.0', runtimeRoot);
        await withAuthorizedStoreTransaction(store, candidatePresentation, async transaction => {
            const published = await store.publish(
                transaction,
                await createStagedRuntime(runtimeRoot, candidatePresentation),
                candidatePresentation
            );
            await store.activate(transaction, published, previous);
        });

        const restarted = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
        await restarted.recover();
        assert.equal(await restarted.activeVersion(), '0.143.0');
        assert.deepEqual(await restarted.versions(), ['0.143.0']);

        const retryConsent = new RideCodexInstallConsent();
        await createInstaller(runtimeRoot, retryConsent, restarted).install(
            retryConsent.issue(candidatePresentation)
        );
        assert.equal(await restarted.activeVersion(), '0.144.0');
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('finalization reattests after its last hook and rolls back a changed candidate', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-finalize-attest-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let mutateCandidate = false;
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            beforePendingFinalize: async () => {
                if (!mutateCandidate) {
                    return;
                }
                mutateCandidate = false;
                const active = JSON.parse(await readFile(join(runtimeRoot, 'active.json'), 'utf8')) as {
                    relativePath: string;
                    executableRelativePath: string;
                };
                await writeFile(
                    join(runtimeRoot, ...active.relativePath.split('/'), ...active.executableRelativePath.split('/')),
                    'MUTATED-AFTER-HANDSHAKE'
                );
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    const progress: InstallProgress[] = [];
    const installer = new RideCodexManagedInstaller({
        consent,
        store,
        validatePresentation: () => true,
        stager: { stage: async (_authorization, _target, presentation) => createStagedRuntime(runtimeRoot, presentation) },
        handshake: async () => undefined,
        onProgress: update => progress.push(update)
    });
    try {
        await installer.install(consent.issue(presentationFor('0.143.0', runtimeRoot)));
        progress.length = 0;
        mutateCandidate = true;
        await assert.rejects(
            installer.install(consent.issue(presentationFor('0.144.0', runtimeRoot))),
            /finalize|activation/i
        );
        assert.equal(progress.some(update => update.state === 'ready'), false);
        assert.equal(await store.activeVersion(), '0.143.0');
        assert.deepEqual(await store.versions(), ['0.143.0']);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('recovery completes a finalizing activation and reconciles exactly candidate plus previous', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-finalizing-crash-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let crashAfterFinalizing = false;
    const hooks = {
        afterFinalizingJournalWrite: () => {
            if (crashAfterFinalizing) {
                crashAfterFinalizing = false;
                throw new Error('simulated crash after finalizing journal');
            }
        }
    } as RideCodexRuntimeStoreTestHooks;
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot, testHooks: hooks });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.142.0', runtimeRoot))
        );
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        crashAfterFinalizing = true;
        await assert.rejects(
            createInstaller(runtimeRoot, consent, store).install(
                consent.issue(presentationFor('0.144.0', runtimeRoot))
            ),
            /finalize|activation|rollback/i
        );
        assert.equal((await store.readActiveRuntime())?.version, '0.143.0');
        assert.equal(await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false), true);

        const restarted = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
        await restarted.recover();
        assert.equal(await restarted.activeVersion(), '0.144.0');
        assert.deepEqual(await restarted.versions(), ['0.143.0', '0.144.0']);
        assert.equal(await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false), false);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('recovery resumes finalizing after obsolete quarantine interruption without deleting retained runtimes', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-finalizing-cleanup-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const outside = await mkdtemp(join(tmpdir(), 'ride-codex-finalizing-outside-'));
    const sentinel = join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'preserve');
    let interruptCleanup = false;
    const hooks = {
        afterObsoleteQuarantine: () => {
            if (interruptCleanup) {
                interruptCleanup = false;
                throw new Error('simulated crash during obsolete reconciliation');
            }
        }
    } as RideCodexRuntimeStoreTestHooks;
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot, testHooks: hooks });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.142.0', runtimeRoot))
        );
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        interruptCleanup = true;
        await assert.rejects(
            createInstaller(runtimeRoot, consent, store).install(
                consent.issue(presentationFor('0.144.0', runtimeRoot))
            ),
            /finalize|activation|rollback/i
        );

        const restarted = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
        await restarted.recover();
        assert.equal(await restarted.activeVersion(), '0.144.0');
        assert.deepEqual(await restarted.versions(), ['0.143.0', '0.144.0']);
        assert.equal(await readFile(sentinel, 'utf8'), 'preserve');
    } finally {
        await Promise.all([
            rm(trustedRuntimeBase, { recursive: true, force: true }),
            rm(outside, { recursive: true, force: true })
        ]);
    }
});

test('journal delete failure after finalize rename is deferred without rolling back ready state', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-finalize-delete-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let injectDeleteFailure = false;
    let deleteHooks = 0;
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            beforePendingQuarantineDelete: kind => {
                if (kind === 'finalize' && injectDeleteFailure) {
                    injectDeleteFailure = false;
                    deleteHooks += 1;
                    const error = new Error('simulated journal quarantine delete failure') as NodeJS.ErrnoException;
                    error.code = 'EBUSY';
                    throw error;
                }
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        injectDeleteFailure = true;
        const result = await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.144.0', runtimeRoot))
        );
        assert.equal(result.state, 'ready');
        assert.equal(deleteHooks, 1);
        assert.equal(await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false), false);
        assert.equal((await readdir(runtimeRoot)).some(name => name.startsWith('.install-quarantine-')), true);
        await new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot }).recover();
        assert.equal((await readdir(runtimeRoot)).some(name => name.startsWith('.install-quarantine-')), false);
        assert.equal(await store.activeVersion(), '0.144.0');
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('recovery consumes a retained finalizing journal before trusting a changed candidate', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-finalize-quarantine-recovery-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let retainJournal = false;
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            beforePendingQuarantineDelete: kind => {
                if (kind === 'finalize' && retainJournal) {
                    retainJournal = false;
                    const error = new Error('simulated process loss before journal cleanup') as NodeJS.ErrnoException;
                    error.code = 'EBUSY';
                    throw error;
                }
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        retainJournal = true;
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.144.0', runtimeRoot))
        );
        const candidate = await store.readActiveRuntime();
        assert.ok(candidate);
        await writeFile(candidate.executable, 'MUTATED-BEFORE-RECOVERY-VALIDATION');

        const restarted = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
        await restarted.recover();
        assert.equal(await restarted.activeVersion(), '0.143.0');
        assert.deepEqual(await restarted.versions(), ['0.143.0']);
        assert.equal(
            (await readdir(runtimeRoot)).some(name => name.startsWith('.install-quarantine-pending-')),
            false
        );
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('recovery recognizes a finalizing journal left after a completed rollback cleanup failure', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-finalize-rollback-quarantine-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let retainFinalizeJournal = false;
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            beforePendingQuarantineDelete: kind => {
                if (kind === 'finalize' && retainFinalizeJournal) {
                    retainFinalizeJournal = false;
                    const error = new Error('simulated retained finalizing journal') as NodeJS.ErrnoException;
                    error.code = 'EBUSY';
                    throw error;
                }
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        retainFinalizeJournal = true;
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.144.0', runtimeRoot))
        );
        const candidate = await store.readActiveRuntime();
        assert.ok(candidate);
        await writeFile(candidate.executable, 'MUTATED-BEFORE-ROLLBACK-WITH-RETAINED-JOURNAL');

        let retainRollbackJournal = true;
        const firstRestart = new RideCodexRuntimeStore({
            trustedRuntimeBase,
            runtimeRoot,
            testHooks: {
                beforePendingQuarantineDelete: kind => {
                    if (kind === 'rollback' && retainRollbackJournal) {
                        retainRollbackJournal = false;
                        const error = new Error('simulated rollback journal cleanup failure') as NodeJS.ErrnoException;
                        error.code = 'EBUSY';
                        throw error;
                    }
                }
            }
        });
        await assert.rejects(firstRestart.recover(), /finalization|proof|rollback|recovery/i);
        assert.equal(await firstRestart.activeVersion(), '0.143.0');
        assert.equal(
            (await readdir(runtimeRoot)).some(name => name.startsWith('.install-quarantine-pending-')),
            true
        );

        const secondRestart = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
        await secondRestart.recover();
        assert.equal(await secondRestart.activeVersion(), '0.143.0');
        assert.deepEqual(await secondRestart.versions(), ['0.143.0']);
        assert.equal(
            (await readdir(runtimeRoot)).some(name => name.startsWith('.install-quarantine-pending-')),
            false
        );
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('journal delete failure after rollback rename preserves the previous committed runtime', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-rollback-delete-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let injectDeleteFailure = false;
    let deleteHooks = 0;
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            beforePendingQuarantineDelete: kind => {
                if (kind === 'rollback' && injectDeleteFailure) {
                    injectDeleteFailure = false;
                    deleteHooks += 1;
                    const error = new Error('simulated rollback quarantine delete failure') as NodeJS.ErrnoException;
                    error.code = 'EBUSY';
                    throw error;
                }
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        injectDeleteFailure = true;
        await assert.rejects(
            createInstaller(runtimeRoot, consent, store).install(
                consent.issue(presentationFor('0.144.0', runtimeRoot)),
                { failHandshake: true }
            ),
            error => {
                assert.ok(error instanceof RideCodexManagedInstallError);
                assert.deepEqual(error.diagnostics.map(diagnostic => diagnostic.code), ['handshake-failed']);
                return true;
            }
        );
        assert.equal(deleteHooks, 1);
        assert.equal(await store.activeVersion(), '0.143.0');
        assert.deepEqual(await store.versions(), ['0.143.0']);
        assert.equal(await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false), false);
        assert.equal((await readdir(runtimeRoot)).some(name => name.startsWith('.install-quarantine-')), true);
        await new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot }).recover();
        assert.equal((await readdir(runtimeRoot)).some(name => name.startsWith('.install-quarantine-')), false);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('rollback quarantine recovery revalidates previous before discarding its journal', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-rollback-quarantine-proof-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let retainJournal = false;
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            beforePendingQuarantineDelete: kind => {
                if (kind === 'rollback' && retainJournal) {
                    retainJournal = false;
                    const error = new Error('simulated rollback journal retention') as NodeJS.ErrnoException;
                    error.code = 'EBUSY';
                    throw error;
                }
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        const previous = await store.readActiveRuntime();
        assert.ok(previous);
        retainJournal = true;
        await assert.rejects(
            createInstaller(runtimeRoot, consent, store).install(
                consent.issue(presentationFor('0.144.0', runtimeRoot)),
                { failHandshake: true }
            ),
            /handshake|activation/i
        );
        await writeFile(previous.executable, 'MUTATED-AFTER-ROLLBACK-COMMIT');

        const restarted = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
        await assert.rejects(restarted.recover(), /attestation|previous|runtime|recovery/i);
        assert.equal(
            (await readdir(runtimeRoot)).some(name => name.startsWith('.install-quarantine-pending-')),
            true
        );
        assert.equal(
            await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false),
            false
        );
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('publishing quarantine recovery revalidates previous before discarding its journal', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-publishing-quarantine-proof-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let crashPublishing = false;
    const initial = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            afterPublishingJournalWrite: () => {
                if (crashPublishing) {
                    crashPublishing = false;
                    throw new Error('simulated publishing interruption');
                }
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, initial).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        const previous = await initial.readActiveRuntime();
        assert.ok(previous);
        const presentation = presentationFor('0.144.0', runtimeRoot);
        crashPublishing = true;
        await assert.rejects(
            withAuthorizedStoreTransaction(initial, presentation, async transaction => initial.publish(
                transaction,
                await createStagedRuntime(runtimeRoot, presentation),
                presentation,
                previous
            )),
            /publishing interruption/i
        );

        let retainJournal = true;
        const firstRestart = new RideCodexRuntimeStore({
            trustedRuntimeBase,
            runtimeRoot,
            testHooks: {
                beforePendingQuarantineDelete: kind => {
                    if (kind === 'publishing-recovery' && retainJournal) {
                        retainJournal = false;
                        const error = new Error('simulated publishing journal retention') as NodeJS.ErrnoException;
                        error.code = 'EBUSY';
                        throw error;
                    }
                }
            }
        });
        await firstRestart.recover();
        await writeFile(previous.executable, 'MUTATED-AFTER-PUBLISHING-RECOVERY-COMMIT');

        const secondRestart = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
        await assert.rejects(secondRestart.recover(), /attestation|previous|runtime|recovery/i);
        assert.equal(
            (await readdir(runtimeRoot)).some(name => name.startsWith('.install-quarantine-pending-')),
            true
        );
        assert.equal(
            await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false),
            false
        );
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('pending journal rename failure leaves finalizing recovery authority intact', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-pending-rename-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let failRename = false;
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            beforePendingCommitRename: kind => {
                if (kind === 'finalize' && failRename) {
                    failRename = false;
                    throw new Error('simulated pending journal rename failure');
                }
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        const previous = await store.readActiveRuntime();
        assert.ok(previous);
        const presentation = presentationFor('0.144.0', runtimeRoot);
        await withAuthorizedStoreTransaction(store, presentation, async transaction => {
            const published = await store.publish(
                transaction,
                await createStagedRuntime(runtimeRoot, presentation),
                presentation
            );
            const activated = await store.activate(transaction, published, previous);
            const handshake = await store.completeHandshake(transaction, activated, async () => undefined);
            failRename = true;
            await assert.rejects(
                store.finalizeActivation(transaction, handshake),
                /pending|final|rename|activation/i
            );
        });
        assert.equal(await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false), true);
        await new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot }).recover();
        assert.equal(await store.activeVersion(), '0.144.0');
        assert.deepEqual(await store.versions(), ['0.143.0', '0.144.0']);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('pending journal replacement at the commit hook is rejected before rename', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-pending-replace-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let replaceJournal = false;
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            beforePendingCommitRename: async (kind, pendingPath) => {
                if (kind === 'finalize' && replaceJournal) {
                    replaceJournal = false;
                    await writeFile(pendingPath, '{}\n');
                }
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        const previous = await store.readActiveRuntime();
        assert.ok(previous);
        const presentation = presentationFor('0.144.0', runtimeRoot);
        await withAuthorizedStoreTransaction(store, presentation, async transaction => {
            const published = await store.publish(
                transaction,
                await createStagedRuntime(runtimeRoot, presentation),
                presentation
            );
            const activated = await store.activate(transaction, published, previous);
            const handshake = await store.completeHandshake(transaction, activated, async () => undefined);
            replaceJournal = true;
            await assert.rejects(store.finalizeActivation(transaction, handshake), /pending|journal|final/i);
        });
        assert.equal(await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false), true);
        assert.equal((await readdir(runtimeRoot)).some(name => name.startsWith('.install-quarantine-pending-')), false);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('discard refuses a candidate that is still protected by pending recovery authority', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-pending-discard-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let failActivation = false;
    let failRollbackCommit = false;
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            beforePointerRename: kind => {
                if (kind === 'activate' && failActivation) {
                    failActivation = false;
                    throw new Error('simulated activation pointer failure');
                }
            },
            beforePendingCommitRename: kind => {
                if (kind === 'rollback' && failRollbackCommit) {
                    failRollbackCommit = false;
                    throw new Error('simulated rollback journal failure');
                }
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        const previous = await store.readActiveRuntime();
        assert.ok(previous);
        const presentation = presentationFor('0.144.0', runtimeRoot);
        await withAuthorizedStoreTransaction(store, presentation, async transaction => {
            const published = await store.publish(
                transaction,
                await createStagedRuntime(runtimeRoot, presentation),
                presentation
            );
            failActivation = true;
            failRollbackCommit = true;
            await assert.rejects(
                store.activate(transaction, published, previous),
                /activation|rollback|recovery/i
            );
            await assert.rejects(store.discard(transaction, published), /pending|recovery|active/i);
            assert.equal(await stat(published.directory).then(() => true, () => false), false);
            assert.equal(
                (await readdir(runtimeRoot)).some(name => name.startsWith('.install-quarantine-candidate-')),
                true
            );
        });
        assert.equal(await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false), true);

        const restarted = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
        await restarted.recover();
        assert.equal(await restarted.activeVersion(), '0.143.0');
        assert.deepEqual(await restarted.versions(), ['0.143.0']);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('real Task 6 tree attestation protects staging and activation post-conditions', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-real-attestation-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const presentation = presentationFor('0.144.0', runtimeRoot);
    try {
        const staged = await createStagedRuntime(runtimeRoot, presentation);
        const baseline = await attestPublishedRuntime(staged.stagingDirectory, staged.unpackedBytes);
        const attested = Object.freeze({
            ...staged,
            revalidate: async () => {
                const current = await attestPublishedRuntime(staged.stagingDirectory, staged.unpackedBytes);
                if (current.treeDigest !== baseline.treeDigest
                    || current.entries !== baseline.entries
                    || current.totalReadBytes !== baseline.totalReadBytes
                    || current.totalPathBytes !== baseline.totalPathBytes) {
                    throw new Error('staged runtime attestation changed');
                }
            }
        });
        await writeFile(join(attested.resourcesDirectory, 'helper.bin'), 'MUTATED-STAGED-RESOURCE');
        await assert.rejects(
            withAuthorizedStoreTransaction(store, presentation, transaction => store.publish(
                transaction,
                attested,
                presentation
            )),
            /attestation|staged|provenance|activation/i
        );

        const clean = await createStagedRuntime(runtimeRoot, presentation);
        await withAuthorizedStoreTransaction(store, presentation, async transaction => {
            const published = await store.publish(transaction, clean, presentation);
            await writeFile(published.executable, 'MUTATED-PUBLISHED-EXECUTABLE');
            await assert.rejects(
                store.activate(transaction, published, undefined),
                /attestation|activation|runtime/i
            );
        });
        assert.equal(await store.readActiveRuntime(), undefined);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('finalize rejects a candidate changed by the last commit hook and restores the previous runtime', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-finalize-last-proof-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let mutateCandidate = false;
    let candidateExecutable = '';
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            beforePendingCommitRename: async kind => {
                if (kind === 'finalize' && mutateCandidate) {
                    mutateCandidate = false;
                    await writeFile(candidateExecutable, 'MUTATED-AFTER-FINAL-PROOF');
                }
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        const previous = await store.readActiveRuntime();
        assert.ok(previous);
        const presentation = presentationFor('0.144.0', runtimeRoot);
        await withAuthorizedStoreTransaction(store, presentation, async transaction => {
            const published = await store.publish(
                transaction,
                await createStagedRuntime(runtimeRoot, presentation),
                presentation,
                previous
            );
            const activated = await store.activate(transaction, published, previous);
            const handshake = await store.completeHandshake(transaction, activated, async () => undefined);
            candidateExecutable = activated.executable;
            mutateCandidate = true;
            await assert.rejects(
                store.finalizeActivation(transaction, handshake),
                /final|attestation|rollback|activation/i
            );
        });
        assert.equal(await store.activeVersion(), '0.143.0');
        assert.deepEqual(await store.versions(), ['0.143.0']);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('finalize restores its journal and rolls back when postcommit candidate validation fails', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-finalize-postcommit-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let mutateCandidate = false;
    let candidateExecutable = '';
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            beforePendingCommitSync: async kind => {
                if (kind === 'finalize' && mutateCandidate) {
                    mutateCandidate = false;
                    await writeFile(candidateExecutable, 'MUTATED-AFTER-JOURNAL-RENAME');
                }
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        const previous = await store.readActiveRuntime();
        assert.ok(previous);
        const presentation = presentationFor('0.144.0', runtimeRoot);
        await withAuthorizedStoreTransaction(store, presentation, async transaction => {
            const published = await store.publish(
                transaction,
                await createStagedRuntime(runtimeRoot, presentation),
                presentation,
                previous
            );
            const activated = await store.activate(transaction, published, previous);
            const handshake = await store.completeHandshake(transaction, activated, async () => undefined);
            candidateExecutable = activated.executable;
            mutateCandidate = true;
            await assert.rejects(
                store.finalizeActivation(transaction, handshake),
                /final|post-condition|rollback|activation/i
            );
        });
        assert.equal(
            await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false),
            false
        );
        assert.equal(await store.activeVersion(), '0.143.0');
        assert.deepEqual(await store.versions(), ['0.143.0']);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('rollback revalidates previous after the candidate enters quarantine and preserves recovery authority', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-rollback-last-proof-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let mutatePrevious = false;
    let previousExecutable = '';
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            afterRollbackCandidateQuarantine: async () => {
                if (mutatePrevious) {
                    mutatePrevious = false;
                    await writeFile(previousExecutable, 'MUTATED-WHILE-CANDIDATE-QUARANTINED');
                }
            }
        } as RideCodexRuntimeStoreTestHooks
    });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        const previous = await store.readActiveRuntime();
        assert.ok(previous);
        previousExecutable = previous.executable;
        const presentation = presentationFor('0.144.0', runtimeRoot);
        await withAuthorizedStoreTransaction(store, presentation, async transaction => {
            const published = await store.publish(
                transaction,
                await createStagedRuntime(runtimeRoot, presentation),
                presentation,
                previous
            );
            await store.activate(transaction, published, previous);
            mutatePrevious = true;
            await assert.rejects(
                store.restore(transaction, previous, published),
                /rollback|attestation|recovery|runtime/i
            );
        });
        assert.equal(
            await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false),
            true
        );
        await assert.rejects(store.readActiveRuntime(), /attestation|runtime|pending/i);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('publishing recovery revalidates previous after candidate quarantine before committing its journal', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-publishing-last-proof-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let crashPublishing = false;
    const initial = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            afterPublishingJournalWrite: () => {
                if (crashPublishing) {
                    crashPublishing = false;
                    throw new Error('simulated publishing crash');
                }
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, initial).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        const previous = await initial.readActiveRuntime();
        assert.ok(previous);
        const presentation = presentationFor('0.144.0', runtimeRoot);
        crashPublishing = true;
        await assert.rejects(
            withAuthorizedStoreTransaction(initial, presentation, async transaction => initial.publish(
                transaction,
                await createStagedRuntime(runtimeRoot, presentation),
                presentation,
                previous
            )),
            /publishing crash/i
        );

        let mutated = false;
        const restarted = new RideCodexRuntimeStore({
            trustedRuntimeBase,
            runtimeRoot,
            testHooks: {
                afterPublishingCandidateQuarantine: async () => {
                    mutated = true;
                    await writeFile(previous.executable, 'MUTATED-DURING-PUBLISHING-RECOVERY');
                }
            }
        });
        await assert.rejects(restarted.recover(), /attestation|previous|recovery|runtime/i);
        assert.equal(mutated, true);
        assert.equal(await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false), true);
        await assert.rejects(restarted.readActiveRuntime(), /attestation|runtime|publishing/i);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('pending journal parent fsync EIO propagates and leaves finalizing recovery authority intact', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-pending-fsync-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let injectSyncFailure = false;
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            beforePendingCommitSync: kind => {
                if (kind === 'finalize' && injectSyncFailure) {
                    injectSyncFailure = false;
                    const error = new Error('simulated pending parent fsync EIO') as NodeJS.ErrnoException;
                    error.code = 'EIO';
                    throw error;
                }
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        const previous = await store.readActiveRuntime();
        assert.ok(previous);
        const presentation = presentationFor('0.144.0', runtimeRoot);
        await withAuthorizedStoreTransaction(store, presentation, async transaction => {
            const published = await store.publish(
                transaction,
                await createStagedRuntime(runtimeRoot, presentation),
                presentation,
                previous
            );
            const activated = await store.activate(transaction, published, previous);
            const handshake = await store.completeHandshake(transaction, activated, async () => undefined);
            injectSyncFailure = true;
            await assert.rejects(
                store.finalizeActivation(transaction, handshake),
                /fsync|final|pending|activation/i
            );
        });
        assert.equal(await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false), true);
        const restarted = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
        await restarted.recover();
        assert.equal(await restarted.activeVersion(), '0.144.0');
        assert.deepEqual(await restarted.versions(), ['0.143.0', '0.144.0']);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('directory fsync propagates permission errors instead of treating them as unsupported', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-directory-fsync-permission-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const presentation = presentationFor('0.144.0', runtimeRoot);
    const staged = await createStagedRuntime(runtimeRoot, presentation);
    const originalOpen = fsPromises.open;
    let injected = false;
    const replacement = (async (...args: readonly unknown[]) => {
        const [path, flags] = args;
        if (!injected && path === runtimeRoot && flags === fsConstants.O_RDONLY) {
            injected = true;
            const error = new Error('simulated directory fsync EACCES') as NodeJS.ErrnoException;
            error.code = 'EACCES';
            throw error;
        }
        return Reflect.apply(originalOpen, fsPromises, args);
    }) as typeof fsPromises.open;
    try {
        Object.defineProperty(fsPromises, 'open', { ...Object.getOwnPropertyDescriptor(fsPromises, 'open'), value: replacement });
        await assert.rejects(
            withAuthorizedStoreTransaction(store, presentation, transaction => store.publish(
                transaction,
                staged,
                presentation
            )),
            /fsync|EACCES|permission/i
        );
        assert.equal(injected, true);
    } finally {
        Object.defineProperty(fsPromises, 'open', { ...Object.getOwnPropertyDescriptor(fsPromises, 'open'), value: originalOpen });
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('store rejects a structurally fake staged runtime before publishing any version', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-fake-staged-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const presentation = presentationFor('0.144.0', runtimeRoot);
    try {
        const real = await createStagedRuntime(runtimeRoot, presentation);
        const fake = Object.freeze({ ...real, revalidate: async () => undefined });
        await assert.rejects(
            withAuthorizedStoreTransaction(store, presentation, transaction => store.publish(
                transaction,
                fake,
                presentation
            )),
            /transaction|provenance|staged/i
        );
        assert.deepEqual(await store.versions(), []);
        assert.equal(await store.activeVersion(), undefined);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('store rejects fake and cross-store transaction capabilities', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-transaction-brand-'));
    const firstRoot = join(trustedRuntimeBase, 'first');
    const secondRoot = join(trustedRuntimeBase, 'second');
    const first = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot: firstRoot });
    const second = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot: secondRoot });
    const consent = new RideCodexInstallConsent();
    const presentation = presentationFor('0.144.0', firstRoot);
    const consumed = consent.consume(consent.issue(presentation));
    const transactionAuthorization = (consumed as unknown as { transactionAuthorization: object }).transactionAuthorization;
    try {
        await assert.rejects(
            (first.publish as unknown as (...args: readonly unknown[]) => Promise<unknown>)(
                Object.freeze({}),
                await createStagedRuntime(firstRoot, presentation),
                presentation
            ),
            /transaction/i
        );
        await (first as unknown as {
            withAuthorizedTransaction<T>(authorization: object, presentation: InstallPresentation, operation: (transaction: object) => Promise<T>): Promise<T>;
        }).withAuthorizedTransaction(transactionAuthorization, presentation, async transaction => {
            await assert.rejects(
                (second.publish as unknown as (...args: readonly unknown[]) => Promise<unknown>)(
                    transaction,
                    await createStagedRuntime(secondRoot, presentationFor('0.144.0', secondRoot)),
                    presentationFor('0.144.0', secondRoot)
                ),
                /transaction|store|root/i
            );
        });
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('transaction authorization is one-shot and its capability expires outside the callback', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-transaction-replay-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const consent = new RideCodexInstallConsent();
    const presentation = presentationFor('0.144.0', runtimeRoot);
    const consumed = consent.consume(consent.issue(presentation));
    const transactionAuthorization = (consumed as unknown as { transactionAuthorization: object }).transactionAuthorization;
    let captured: object | undefined;
    try {
        await (store as unknown as {
            withAuthorizedTransaction<T>(authorization: object, presentation: InstallPresentation, operation: (transaction: object) => Promise<T>): Promise<T>;
        }).withAuthorizedTransaction(transactionAuthorization, presentation, async transaction => {
            captured = transaction;
        });
        await assert.rejects(
            (store as unknown as {
                withAuthorizedTransaction<T>(authorization: object, presentation: InstallPresentation, operation: (transaction: object) => Promise<T>): Promise<T>;
            }).withAuthorizedTransaction(transactionAuthorization, presentation, async () => undefined),
            /authorization|transaction|used/i
        );
        await assert.rejects(
            (store.publish as unknown as (...args: readonly unknown[]) => Promise<unknown>)(
                captured,
                await createStagedRuntime(runtimeRoot, presentation),
                presentation
            ),
            /transaction|ended|active/i
        );
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('transaction authorization binds every consented presentation field and is consumed on mismatch', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-transaction-presentation-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const consent = new RideCodexInstallConsent();
    const approved = presentationFor('0.144.0', runtimeRoot);
    const substituted = presentationFor('0.145.0', runtimeRoot);
    const consumed = consent.consume(consent.issue(approved));
    try {
        await assert.rejects(
            store.withAuthorizedTransaction(
                consumed.transactionAuthorization,
                substituted,
                async () => undefined
            ),
            /consent|authorization|transaction/i
        );
        await assert.rejects(
            store.withAuthorizedTransaction(
                consumed.transactionAuthorization,
                approved,
                async () => undefined
            ),
            /used|authorization|transaction/i
        );
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('authorized transaction retains the consent snapshot when the caller mutates its presentation', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-transaction-snapshot-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const consent = new RideCodexInstallConsent();
    const approved = presentationFor('0.144.0', runtimeRoot);
    const replacement = presentationFor('0.145.0', runtimeRoot);
    const mutablePresentation = { ...approved } as InstallPresentation;
    const consumed = consent.consume(consent.issue(approved));
    try {
        await store.withAuthorizedTransaction(
            consumed.transactionAuthorization,
            mutablePresentation,
            async transaction => {
                Object.assign(mutablePresentation, replacement);
                await assert.rejects(
                    store.publish(
                        transaction,
                        await createStagedRuntime(runtimeRoot, replacement),
                        mutablePresentation
                    ),
                    /consent|presentation|transaction/i
                );
            }
        );
        assert.deepEqual(await store.versions(), []);
        assert.equal(await store.activeVersion(), undefined);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('authorized transaction preserves an undefined callback rejection', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-transaction-undefined-rejection-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const consent = new RideCodexInstallConsent();
    const presentation = presentationFor('0.144.0', runtimeRoot);
    const consumed = consent.consume(consent.issue(presentation));
    let rejected = false;
    try {
        try {
            await store.withAuthorizedTransaction(
                consumed.transactionAuthorization,
                consumed.presentation,
                async () => { throw undefined; }
            );
        } catch (error) {
            rejected = true;
            assert.equal(error, undefined);
        }
        assert.equal(rejected, true);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('an unawaited mutation started inside the callback cannot escape the transaction lock lifetime', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-transaction-unawaited-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    let releasePublish!: () => void;
    let markPublishEntered!: () => void;
    const publishEntered = new Promise<void>(resolveEntered => { markPublishEntered = resolveEntered; });
    const publishRelease = new Promise<void>(resolveRelease => { releasePublish = resolveRelease; });
    const store = new RideCodexRuntimeStore({
        trustedRuntimeBase,
        runtimeRoot,
        testHooks: {
            afterPublishingJournalWrite: async () => {
                markPublishEntered();
                await publishRelease;
            }
        }
    });
    const consent = new RideCodexInstallConsent();
    const presentation = presentationFor('0.144.0', runtimeRoot);
    const staged = await createStagedRuntime(runtimeRoot, presentation);
    const consumed = consent.consume(consent.issue(presentation));
    let escaped: Promise<unknown> | undefined;
    let transactionSettled = false;
    try {
        const transactionPromise = store.withAuthorizedTransaction(
            consumed.transactionAuthorization,
            consumed.presentation,
            async transaction => {
                escaped = store.publish(transaction, staged, presentation);
            }
        );
        void transactionPromise.finally(() => { transactionSettled = true; });
        await publishEntered;
        await delay(10);
        assert.equal(transactionSettled, false);
        releasePublish();
        await transactionPromise;
        assert.ok(escaped);
        await escaped;
        assert.equal(await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false), true);
    } finally {
        releasePublish();
        await escaped?.catch(() => undefined);
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('direct activation rejects a structurally forged published runtime capability', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-published-capability-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const presentation = presentationFor('0.144.0', runtimeRoot);
    try {
        await withAuthorizedStoreTransaction(store, presentation, async transaction => {
            const fake = Object.freeze({
                version: presentation.version,
                target: presentation.target,
                manifestDigest: presentation.manifestDigest,
                relativePath: 'versions/forged',
                directory: join(runtimeRoot, 'versions', 'forged'),
                executable: join(runtimeRoot, 'versions', 'forged', 'codex.exe'),
                pointer: Object.freeze({})
            });
            await assert.rejects(
                (store.activate as unknown as (...args: readonly unknown[]) => Promise<unknown>)(
                    transaction,
                    fake
                ),
                /published|capability|transaction/i
            );
        });
        assert.equal(await store.activeVersion(), undefined);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('activation rejects a published capability created by another transaction', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-published-cross-transaction-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const presentation = presentationFor('0.144.0', runtimeRoot);
    let published: Awaited<ReturnType<RideCodexRuntimeStore['publish']>> | undefined;
    try {
        await withAuthorizedStoreTransaction(store, presentation, async transaction => {
            published = await store.publish(
                transaction,
                await createStagedRuntime(runtimeRoot, presentation),
                presentation
            );
        });
        assert.ok(published);
        await withAuthorizedStoreTransaction(store, presentation, async transaction => {
            await assert.rejects(
                store.activate(transaction, published!),
                /published|capability|transaction/i
            );
        });
        await store.recover();
        assert.equal(await store.activeVersion(), undefined);
        assert.deepEqual(await store.versions(), []);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('direct finalize without a same-transaction handshake completion is rejected', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-handshake-capability-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.143.0', runtimeRoot))
        );
        const previous = await store.readActiveRuntime();
        assert.ok(previous);
        const presentation = presentationFor('0.144.0', runtimeRoot);
        await withAuthorizedStoreTransaction(store, presentation, async transaction => {
            const published = await store.publish(
                transaction,
                await createStagedRuntime(runtimeRoot, presentation),
                presentation,
                previous
            );
            const activated = await store.activate(transaction, published, previous);
            await assert.rejects(
                store.finalizeActivation(transaction, activated as never),
                /handshake|transaction|capability/i
            );
        });
        assert.equal(
            await stat(join(runtimeRoot, 'pending-activation.json')).then(() => true, () => false),
            true
        );
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('obsolete cleanup is private and an empty retain set cannot delete the active runtime', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-cleanup-sealed-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const store = new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot });
    const consent = new RideCodexInstallConsent();
    try {
        await createInstaller(runtimeRoot, consent, store).install(
            consent.issue(presentationFor('0.144.0', runtimeRoot))
        );
        assert.equal(
            (store as unknown as { cleanupObsolete?: unknown }).cleanupObsolete,
            undefined
        );
        assert.equal(await store.activeVersion(), '0.144.0');
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

test('progress is frozen, ordered, redacted, and observer failures cannot break transactions', async () => {
    const trustedRuntimeBase = await mkdtemp(join(tmpdir(), 'ride-codex-progress-'));
    const runtimeRoot = join(trustedRuntimeBase, 'managed');
    const consent = new RideCodexInstallConsent();
    const observed: InstallProgress[] = [];
    let throwFromObserver = false;
    const installer = new RideCodexManagedInstaller({
        consent,
        store: new RideCodexRuntimeStore({ trustedRuntimeBase, runtimeRoot }),
        validatePresentation: () => true,
        stager: { stage: async (_authorization, _target, presentation) => createStagedRuntime(runtimeRoot, presentation) },
        handshake: async () => undefined,
        onProgress: progress => {
            observed.push(progress);
            assert.equal(Object.isFrozen(progress), true);
            if (throwFromObserver) {
                throw new Error('UI observer secret=C:\\Users\\private');
            }
            throwFromObserver = true;
        }
    });
    try {
        await installer.install(consent.issue(presentationFor('0.144.0', runtimeRoot)));
        assert.deepEqual(observed.map(progress => progress.state), [
            'downloading', 'verifying', 'activating', 'ready'
        ]);
        assert.deepEqual(observed.map(progress => progress.sequence), [0, 1, 2, 3]);
        assert.doesNotMatch(JSON.stringify(observed), /archive|secret|Users|private|runtime\.tgz/i);
    } finally {
        await rm(trustedRuntimeBase, { recursive: true, force: true });
    }
});

function presentationFor(version: string, installRoot: string, target: RuntimeTarget = TARGET): InstallPresentation {
    const runtime = fixtureRuntimeEntry(version, target);
    return createRideCodexInstallPresentation({
        source: 'official-npm-registry',
        version,
        target,
        urlOrigin: 'https://registry.npmjs.org',
        installRoot,
        requiredSpaceBytes: 1024,
        rollbackPolicy: 'retain-new-and-previous-valid',
        manifestDigest: runtimeManifestEntryDigest(runtime)
    });
}

async function createStagedRuntime(
    runtimeRoot: string,
    presentation: InstallPresentation,
    delegatedAuthorization?: InstallAuthorization,
    delegatedValidator?: InstallAuthorizationValidator
): Promise<StagedRuntime> {
    await mkdir(runtimeRoot, { recursive: true });
    const target = presentation.target as RuntimeTarget;
    const runtime = fixtureRuntimeEntry(presentation.version, target);
    const archive = fixtureRuntimeArchive(presentation.version, target);
    const localAuthorization = Object.freeze({ fixture: randomUUID() });
    const authorization = delegatedAuthorization ?? localAuthorization;
    const validator = delegatedValidator ?? ((candidate: InstallAuthorization) => candidate === localAuthorization);
    const capabilities = new WeakSet<object>();
    const stager = new RideCodexRuntimeStager({
        trustedRuntimeBase: runtimeRoot,
        runtimeRoot,
        authorizationValidator: validator,
        statfs: async () => ({ bsize: 1, bavail: Number.MAX_SAFE_INTEGER }),
        fetcher: {
            authorize: async (candidate, context) => {
                if (!await validator(candidate, context)) {
                    throw new Error('fixture authorization rejected');
                }
                const capability = Object.freeze({}) as RideCodexRuntimeFetchCapability;
                capabilities.add(capability);
                return capability;
            },
            fetchAuthorized: async (capability, _runtime, destination) => {
                if (!capabilities.delete(capability)) {
                    throw new Error('fixture capability rejected');
                }
                const output = typeof destination === 'string'
                    ? destination
                    : (destination as RideCodexRuntimeFetchDestination).path;
                await writeFile(output, archive, { flag: 'wx' });
                const outputStat = await lstat(output, { bigint: true });
                return Object.freeze({
                    bytes: archive.length,
                    integrity: runtime.integrity,
                    identity: Object.freeze({
                        type: 'file' as const,
                        dev: outputStat.dev,
                        ino: outputStat.ino,
                        size: outputStat.size,
                        birthtimeNs: outputStat.birthtimeNs,
                        ctimeNs: outputStat.ctimeNs,
                        nlink: outputStat.nlink,
                        mode: outputStat.mode
                    })
                });
            }
        },
        probe: { probe: async () => Object.freeze({ version: presentation.version }) },
        runtimeEntryForTarget: () => runtime
    });
    return stager.stage(authorization, target);
}

function fixtureRuntimeEntry(version: string, target: RuntimeTarget): RideCodexRuntimeManifestEntry {
    const archive = fixtureRuntimeArchive(version, target);
    const suffix = target === 'x86_64-pc-windows-msvc' ? 'win32-x64'
        : target === 'aarch64-pc-windows-msvc' ? 'win32-arm64'
            : target === 'x86_64-apple-darwin' ? 'darwin-x64'
                : target === 'aarch64-apple-darwin' ? 'darwin-arm64'
                    : target === 'x86_64-unknown-linux-musl' ? 'linux-x64' : 'linux-arm64';
    return Object.freeze({
        package: '@openai/codex' as const,
        version: version as RideCodexRuntimeManifestEntry['version'],
        npmVersion: `${version}-${suffix}`,
        target,
        url: `https://registry.npmjs.org/@openai/codex/-/codex-${version}-${suffix}.tgz`,
        integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
        compressedBytes: archive.length,
        unpackedBytes: 64 * 1024,
        layoutVersion: 1 as const,
        entrypoint: target.includes('windows') ? 'bin/codex.exe' : 'bin/codex'
    });
}

function fixtureRuntimeArchive(version: string, target: RuntimeTarget): Buffer {
    const vendor = `package/vendor/${target}`;
    const entrypoint = target.includes('windows') ? 'bin/codex.exe' : 'bin/codex';
    const manifest = JSON.stringify({
        layoutVersion: 1,
        version,
        target,
        variant: 'codex',
        entrypoint,
        resourcesDir: 'codex-resources',
        pathDir: 'codex-path'
    });
    const entries: readonly TestTarEntry[] = [
        { name: 'package/', type: '5' },
        { name: 'package/vendor/', type: '5' },
        { name: `${vendor}/`, type: '5' },
        { name: `${vendor}/bin/`, type: '5' },
        { name: `${vendor}/codex-resources/`, type: '5' },
        { name: `${vendor}/codex-path/`, type: '5' },
        { name: `${vendor}/codex-package.json`, body: Buffer.from(manifest) },
        { name: `${vendor}/${entrypoint}`, body: nativeHeader(target), mode: 0o700 },
        { name: `${vendor}/codex-resources/helper.bin`, body: nativeHeader(target) }
    ];
    return gzipSync(Buffer.concat([
        ...entries.map(testTarEntry),
        Buffer.alloc(1024)
    ]), { level: 9 });
}

interface TestTarEntry {
    readonly name: string;
    readonly type?: '0' | '5';
    readonly body?: Buffer;
    readonly mode?: number;
}

function testTarEntry(entry: TestTarEntry): Buffer {
    const body = entry.body ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    writeTestTarOctal(header, 100, 8, entry.mode ?? (entry.type === '5' ? 0o700 : 0o600));
    writeTestTarOctal(header, 108, 8, 0);
    writeTestTarOctal(header, 116, 8, 0);
    writeTestTarOctal(header, 124, 12, body.length);
    writeTestTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? '0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'binary');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    const checksumText = checksum.toString(8).padStart(6, '0');
    header.write(`${checksumText}\0 `, 148, 8, 'ascii');
    const padding = (512 - (body.length % 512)) % 512;
    return Buffer.concat([header, body, Buffer.alloc(padding)]);
}

function writeTestTarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
    buffer.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

function createInstaller(
    runtimeRoot: string,
    consent: RideCodexInstallConsent,
    store: RideCodexRuntimeStore
): RideCodexManagedInstaller {
    return new RideCodexManagedInstaller({
        consent,
        store,
        validatePresentation: () => true,
        stager: {
            stage: async (authorization, _target, presentation) => createStagedRuntime(
                runtimeRoot,
                presentation,
                authorization,
                consent.authorizationValidator
            )
        },
        handshake: async (_runtime, options) => {
            if (options.failHandshake) {
                throw new Error('simulated handshake failure');
            }
        }
    });
}

async function withAuthorizedStoreTransaction<T>(
    store: RideCodexRuntimeStore,
    presentation: InstallPresentation,
    operation: (transaction: RideCodexRuntimeStoreTransaction) => Promise<T>,
    consent = new RideCodexInstallConsent()
): Promise<T> {
    const consumed = consent.consume(consent.issue(presentation));
    return store.withAuthorizedTransaction(
        consumed.transactionAuthorization,
        consumed.presentation,
        operation
    );
}

async function rewriteActiveRuntimeMetadata(
    store: RideCodexRuntimeStore,
    runtimeRoot: string,
    runtime: RideCodexRuntimeManifestEntry
): Promise<void> {
    const current = await store.readActiveRuntime();
    assert.ok(current);
    const manifestDigest = runtimeManifestEntryDigest(runtime);
    const relativePath = `versions/v-${runtime.version}--${runtime.target}--${manifestDigest.slice('sha256-'.length, 'sha256-'.length + 16)}`;
    const directory = join(runtimeRoot, ...relativePath.split('/'));
    await rename(current.directory, directory);
    const attestation = await attestPublishedRuntime(directory, 64 * 1024);
    const executableRelativePath = `package/vendor/${runtime.target}/${runtime.entrypoint}`;
    await writeFile(join(runtimeRoot, 'active.json'), `${JSON.stringify({
        schemaVersion: 1,
        version: runtime.version,
        target: runtime.target,
        manifestDigest,
        relativePath,
        executableRelativePath,
        treeDigest: attestation.treeDigest,
        treeEntries: attestation.entries,
        treeReadBytes: attestation.totalReadBytes.toString(),
        treePathBytes: attestation.totalPathBytes,
        rootIdentity: {
            dev: attestation.rootIdentity.dev.toString(),
            ino: attestation.rootIdentity.ino.toString(),
            size: attestation.rootIdentity.size.toString(),
            birthtimeNs: attestation.rootIdentity.birthtimeNs.toString(),
            ctimeNs: attestation.rootIdentity.ctimeNs.toString()
        }
    })}\n`);
}

function nativeHeader(target: RuntimeTarget): Buffer {
    if (target.includes('windows')) {
        const header = Buffer.alloc(512);
        header.write('MZ', 0, 'ascii');
        header.writeUInt32LE(0x80, 0x3c);
        header.write('PE\0\0', 0x80, 'binary');
        header.writeUInt16LE(target.startsWith('x86_64') ? 0x8664 : 0xaa64, 0x84);
        return header;
    }
    if (target.includes('linux')) {
        const header = Buffer.alloc(64);
        header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
        header.writeUInt16LE(target.startsWith('x86_64') ? 62 : 183, 18);
        return header;
    }
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(target.startsWith('x86_64') ? 0x01000007 : 0x0100000c, 4);
    return header;
}

function hostRuntime(): { platform: NodeJS.Platform; arch: string; target: RuntimeTarget } | undefined {
    if (process.platform === 'win32' && process.arch === 'x64') {
        return { platform: 'win32', arch: 'x64', target: 'x86_64-pc-windows-msvc' };
    }
    if (process.platform === 'win32' && process.arch === 'arm64') {
        return { platform: 'win32', arch: 'arm64', target: 'aarch64-pc-windows-msvc' };
    }
    if (process.platform === 'linux' && process.arch === 'x64') {
        return { platform: 'linux', arch: 'x64', target: 'x86_64-unknown-linux-musl' };
    }
    if (process.platform === 'linux' && process.arch === 'arm64') {
        return { platform: 'linux', arch: 'arm64', target: 'aarch64-unknown-linux-musl' };
    }
    if (process.platform === 'darwin' && process.arch === 'x64') {
        return { platform: 'darwin', arch: 'x64', target: 'x86_64-apple-darwin' };
    }
    if (process.platform === 'darwin' && process.arch === 'arm64') {
        return { platform: 'darwin', arch: 'arm64', target: 'aarch64-apple-darwin' };
    }
    return undefined;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}
