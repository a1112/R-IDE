/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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
import { RuntimeTarget, runtimeManifestEntryForTarget } from '../src/node/ride-codex-runtime-manifest';
import { RideCodexRuntimeStore } from '../src/node/ride-codex-runtime-store';
import { RideCodexRuntimeResolver } from '../src/node/ride-codex-runtime-resolver';
import { RuntimeFilesystemIdentity, StagedRuntime } from '../src/node/ride-codex-runtime-stager';

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
    assert.equal(await consent.authorizationValidator(consumed.authorization, context), true);
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
        stager: { stage: async (_authorization, _target, presentation) => createStagedRuntime(runtimeRoot, presentation) },
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
        assert.equal(await store.activeVersion(), '0.144.0');
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
        await store.withTransaction(() => store.recover());
        assert.equal((await readdir(runtimeRoot)).some(name => name.startsWith('.staging-stale')), false);
        assert.equal((await readdir(runtimeRoot)).some(name => name.startsWith('active.json.tmp-stale')), false);

        const versionsRoot = join(runtimeRoot, 'versions');
        const nonCanonical = join(versionsRoot, 'do-not-delete');
        await mkdir(nonCanonical);
        await writeFile(join(nonCanonical, 'sentinel.txt'), 'local');
        await store.cleanupObsolete(new Set());
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
        await assert.rejects(store.cleanupObsolete(new Set()), /unsafe|link|cleanup/i);
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
    const presentation = presentationFor('0.144.0', runtimeRoot, host.target);
    const installer = createInstaller(runtimeRoot, consent, store);
    try {
        await installer.install(consent.issue(presentation));
        const resolver = new RideCodexRuntimeResolver({
            platform: host.platform,
            arch: host.arch,
            readEnvironment: () => ({}),
            readUserOverride: () => undefined,
            findSystemCandidates: () => [],
            managedRuntimeStore: store,
            probe: { probe: async () => ({ version: '0.144.0' }) }
        });
        const launch = await resolver.resolve();
        assert.equal(launch.source, 'managed');
        assert.equal(launch.executable, (await store.readActiveRuntime())?.executable);
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
    return createRideCodexInstallPresentation({
        source: 'official-npm-registry',
        version,
        target,
        urlOrigin: 'https://registry.npmjs.org',
        installRoot,
        requiredSpaceBytes: 1024,
        rollbackPolicy: 'retain-new-and-previous-valid',
        manifestDigest: `sha256-${version.replace(/\D/g, '').padEnd(64, '0').slice(0, 64)}`
    });
}

async function createStagedRuntime(runtimeRoot: string, presentation: InstallPresentation): Promise<StagedRuntime> {
    await mkdir(runtimeRoot, { recursive: true });
    const stagingDirectory = join(runtimeRoot, `.staging-${randomUUID()}`);
    const packageRoot = join(stagingDirectory, 'package');
    const vendorRoot = join(packageRoot, 'vendor', presentation.target);
    const executableName = presentation.target.includes('windows') ? 'codex.exe' : 'codex';
    const executable = join(vendorRoot, 'bin', executableName);
    const resourcesDirectory = join(vendorRoot, 'codex-resources');
    const pathDirectory = join(vendorRoot, 'codex-path');
    await mkdir(join(vendorRoot, 'bin'), { recursive: true });
    await mkdir(resourcesDirectory);
    await mkdir(pathDirectory);
    await writeFile(executable, nativeHeader(presentation.target as RuntimeTarget));
    await writeFile(join(resourcesDirectory, 'helper.bin'), nativeHeader(presentation.target as RuntimeTarget));
    if (!presentation.target.includes('windows')) {
        await chmod(executable, 0o700);
    }
    const stat = await lstat(stagingDirectory, { bigint: true });
    const stagingIdentity: RuntimeFilesystemIdentity = Object.freeze({
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        birthtimeNs: stat.birthtimeNs,
        ctimeNs: stat.ctimeNs
    });
    return Object.freeze({
        stagingDirectory,
        packageRoot,
        executable,
        resourcesDirectory,
        pathDirectory,
        package: '@openai/codex' as const,
        version: presentation.version as '0.144.0',
        npmVersion: `${presentation.version}-win32-x64`,
        target: presentation.target as RuntimeTarget,
        integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
        compressedBytes: 1,
        unpackedBytes: 1024,
        layoutVersion: 1 as const,
        entrypoint: (presentation.target.includes('windows') ? 'bin/codex.exe' : 'bin/codex') as StagedRuntime['entrypoint'],
        authorizationContext: Object.freeze({
            target: presentation.target as RuntimeTarget,
            manifestDigest: presentation.manifestDigest,
            canonicalRoot: runtimeRoot,
            destination: join(stagingDirectory, 'runtime.tgz')
        }),
        stagingIdentity,
        revalidate: async () => undefined
    });
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
        stager: { stage: async (_authorization, _target, presentation) => createStagedRuntime(runtimeRoot, presentation) },
        handshake: async (_runtime, options) => {
            if (options.failHandshake) {
                throw new Error('simulated handshake failure');
            }
        }
    });
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
