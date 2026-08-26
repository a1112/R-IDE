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
    consumeInstallTransactionAuthorization,
    InstallTransactionAuthorization
} from './ride-codex-install-consent';
import {
    attestPublishedRuntime,
    consumeStagedRuntimeForPublication,
    PublishedRuntimeAttestation,
    RuntimeFilesystemIdentity,
    runtimeFilesystemIdentitiesEqual,
    StagedRuntime
} from './ride-codex-runtime-stager';

export type PointerWriteKind = 'activate' | 'rollback';
export type PendingActivationCommitKind = 'finalize' | 'rollback' | 'publishing-recovery';

export interface RideCodexRuntimeStoreTestHooks {
    beforePointerSync?(kind: PointerWriteKind, temporaryPath: string): void | Promise<void>;
    beforePointerRename?(kind: PointerWriteKind, temporaryPath: string): void | Promise<void>;
    afterPointerRename?(kind: PointerWriteKind, activePath: string): void | Promise<void>;
    beforePendingFinalize?(pendingPath: string): void | Promise<void>;
    beforePendingCommitRename?(
        kind: PendingActivationCommitKind,
        pendingPath: string,
        quarantinePath: string
    ): void | Promise<void>;
    beforePendingQuarantineDelete?(
        kind: PendingActivationCommitKind,
        quarantinePath: string
    ): void | Promise<void>;
    afterPublishingJournalWrite?(pendingPath: string): void | Promise<void>;
    afterPublishRename?(publishedPath: string): void | Promise<void>;
    afterFinalizingJournalWrite?(pendingPath: string): void | Promise<void>;
    afterObsoleteQuarantine?(relativePath: string, quarantinePath: string): void | Promise<void>;
    afterRollbackCandidateQuarantine?(quarantinePath: string): void | Promise<void>;
    afterPublishingCandidateQuarantine?(quarantinePath: string): void | Promise<void>;
    beforePendingCommitSync?(kind: PendingActivationCommitKind, root: string): void | Promise<void>;
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

const RUNTIME_STORE_TRANSACTION_BRAND: unique symbol = Symbol('ride-codex-runtime-store-transaction');
const RUNTIME_HANDSHAKE_COMPLETION_BRAND: unique symbol = Symbol('ride-codex-runtime-handshake-completion');

export type RideCodexRuntimeStoreTransaction = Readonly<{
    readonly [RUNTIME_STORE_TRANSACTION_BRAND]: true;
}>;

export type RideCodexHandshakeCompletion = Readonly<{
    readonly [RUNTIME_HANDSHAKE_COMPLETION_BRAND]: true;
}>;

interface StoreTransactionRecord {
    active: boolean;
    accepting: boolean;
    mutationInProgress: boolean;
    readonly presentation: InstallPresentation;
    readonly operations: Set<Promise<unknown>>;
    published?: PublishedManagedRuntime;
    activated?: ValidatedManagedRuntime;
}

interface PublishedRuntimeRecord {
    readonly transaction: StoreTransactionRecord;
    activated: boolean;
}

interface HandshakeCompletionRecord {
    readonly transaction: StoreTransactionRecord;
    readonly runtime: ValidatedManagedRuntime;
    consumed: boolean;
}

interface CommittedPendingQuarantine {
    readonly path: string;
    readonly identity: RuntimeFilesystemIdentity;
    readonly pending: PendingActivationTransaction;
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

interface PendingActivationTransaction {
    readonly schemaVersion: 1;
    readonly transactionId: string;
    readonly phase: 'publishing' | 'awaiting-handshake' | 'finalizing';
    readonly candidate: ActiveRuntimePointer;
    readonly previous: ActiveRuntimePointer | 'none';
    readonly retention: readonly string[];
    readonly stagingRelativePath: string;
    readonly stagingIdentity: SerializedRuntimeIdentity;
}

const ACTIVE_POINTER = 'active.json';
const PENDING_ACTIVATION = 'pending-activation.json';
const VERSIONS_DIRECTORY = 'versions';
const MAX_POINTER_BYTES = 16 * 1024;
const MAX_PENDING_BYTES = 32 * 1024;
const MAX_DIRECTORY_ENTRIES = 4096;
const MAX_DELETE_TREE_ENTRIES = 262_144;
const MAX_RUNTIME_BYTES = 2 * 1024 * 1024 * 1024;
const POINTER_KEYS = Object.freeze([
    'executableRelativePath', 'manifestDigest', 'relativePath', 'rootIdentity',
    'schemaVersion', 'target', 'treeDigest', 'treeEntries', 'treePathBytes',
    'treeReadBytes', 'version'
].sort());
const IDENTITY_KEYS = Object.freeze(['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'size'].sort());
const PENDING_KEYS = Object.freeze([
    'candidate', 'phase', 'previous', 'retention', 'schemaVersion', 'stagingIdentity',
    'stagingRelativePath', 'transactionId'
].sort());
const ROOT_LOCKS = new Map<string, RootLock>();
const MAX_TRANSACTION_OPERATIONS = 16;

export class RideCodexRuntimeStoreError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RideCodexRuntimeStoreError';
    }
}

export class RideCodexRuntimeStore {
    readonly installRoot: string;
    readonly #trustedRuntimeBase: string;
    readonly #testHooks: RideCodexRuntimeStoreTestHooks;
    readonly #transactions = new WeakMap<object, StoreTransactionRecord>();
    readonly #publishedRuntimes = new WeakMap<object, PublishedRuntimeRecord>();
    readonly #handshakeCompletions = new WeakMap<object, HandshakeCompletionRecord>();

    constructor(options: RideCodexRuntimeStoreOptions) {
        if (!isAbsolute(options.trustedRuntimeBase) || !isAbsolute(options.runtimeRoot)
            || isNetworkPath(options.trustedRuntimeBase) || isNetworkPath(options.runtimeRoot)) {
            throw new RideCodexRuntimeStoreError('Codex runtime store paths must be absolute local paths.');
        }
        this.#trustedRuntimeBase = resolve(options.trustedRuntimeBase);
        this.installRoot = resolve(options.runtimeRoot);
        requireSameOrChild(this.#trustedRuntimeBase, this.installRoot);
        this.#testHooks = options.testHooks ?? Object.freeze({});
    }

    async withAuthorizedTransaction<T>(
        authorization: InstallTransactionAuthorization,
        presentation: InstallPresentation,
        operation: (transaction: RideCodexRuntimeStoreTransaction) => Promise<T>
    ): Promise<T> {
        if (typeof operation !== 'function') {
            throw new RideCodexRuntimeStoreError('Codex install transaction operation is invalid.');
        }
        return this.#withRootLock(async () => {
            const authorized = consumeInstallTransactionAuthorization(authorization, presentation);
            if (!authorized || !samePath(authorized.canonicalRoot, this.installRoot)) {
                throw new RideCodexRuntimeStoreError(
                    'Codex install consent transaction authorization is invalid, expired, or already used.'
                );
            }
            const transaction = Object.freeze({}) as RideCodexRuntimeStoreTransaction;
            const record: StoreTransactionRecord = {
                active: true,
                accepting: true,
                mutationInProgress: false,
                presentation: authorized.presentation,
                operations: new Set()
            };
            this.#transactions.set(transaction, record);
            let result: T | undefined;
            let callbackFailure: unknown;
            let callbackRejected = false;
            try {
                result = await operation(transaction);
            } catch (error) {
                callbackRejected = true;
                callbackFailure = error;
            }
            record.accepting = false;
            const settlements = await Promise.allSettled([...record.operations]);
            record.active = false;
            if (callbackRejected) {
                throw callbackFailure;
            }
            const operationFailure = settlements.find(
                (settlement): settlement is PromiseRejectedResult => settlement.status === 'rejected'
            );
            if (operationFailure) {
                throw operationFailure.reason;
            }
            return result as T;
        });
    }

    async #withRootLock<T>(operation: () => Promise<T>): Promise<T> {
        const key = pathKey(this.installRoot);
        let lock = ROOT_LOCKS.get(key);
        if (!lock) {
            lock = new RootLock(key);
            ROOT_LOCKS.set(key, lock);
        }
        return lock.run(operation);
    }

    async recover(transaction?: RideCodexRuntimeStoreTransaction): Promise<void> {
        if (transaction) {
            return this.#trackTransactionOperation(transaction, () => this.#recoverUnlocked());
        }
        return this.#withRootLock(() => this.#recoverUnlocked());
    }

    async #recoverUnlocked(): Promise<void> {
        const boundary = await this.#ensureWritableBoundary();
        let pending = await this.#readPendingActivation(boundary);
        const committedPending = await this.#readCommittedPendingQuarantine(boundary);
        if (pending && committedPending) {
            throw new RideCodexRuntimeStoreError(
                'Codex runtime store contains both active and quarantined recovery journals.'
            );
        }
        if (!pending && committedPending) {
            await this.#recoverCommittedPendingQuarantine(committedPending, boundary);
            pending = await this.#readPendingActivation(boundary);
        }
        if (pending) {
            if (pending.phase === 'publishing') {
                await this.#recoverPublishing(pending, boundary);
            } else if (pending.phase === 'finalizing') {
                await this.#finishFinalizing(pending, boundary);
            } else {
                await this.#rollbackPendingActivation(pending, boundary, 'recover');
            }
        }
        const entries = await boundedDirectoryEntries(boundary.root);
        for (const entry of entries) {
            if (entry.startsWith('.install-quarantine-pending-')) {
                // Pending journals are recovery authority, not generic cleanup. A
                // best-effort deletion failure is retried through the validated
                // committed-journal path on the next recovery pass.
                continue;
            }
            if (!entry.startsWith('.staging-')
                && !entry.startsWith('active.json.tmp-')
                && !entry.startsWith('pending-activation.json.tmp-')
                && !entry.startsWith('.install-quarantine-')) {
                continue;
            }
            const candidate = join(boundary.root, entry);
            requireStrictChild(boundary.root, candidate);
            if (entry.startsWith('.install-quarantine-')) {
                await deleteExistingQuarantine(candidate, boundary.root, boundary);
            } else {
                await quarantineAndDelete(candidate, boundary.root, boundary);
            }
        }
    }

    async activeVersion(): Promise<string | undefined> {
        return (await this.readActiveRuntime())?.version;
    }

    async versions(): Promise<readonly string[]> {
        const boundary = await this.#openReadOnlyBoundary();
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
        const boundary = await this.#openReadOnlyBoundary();
        if (!boundary) {
            return undefined;
        }
        const pointer = await this.#readActivePointer(boundary);
        const pending = await this.#readPendingActivation(boundary);
        if (!pending) {
            return pointer ? this.#validatePointer(pointer, boundary) : undefined;
        }
        if (pending.phase === 'publishing') {
            const committedPrevious = pending.previous === 'none' ? undefined : pending.previous;
            if (pointer && committedPrevious && activePointersEqual(pointer, committedPrevious)) {
                return this.#validatePointer(committedPrevious, boundary);
            }
            if (!pointer && !committedPrevious) {
                return undefined;
            }
            throw new RideCodexRuntimeStoreError(
                'Codex publishing transaction does not have a valid committed runtime view.'
            );
        }
        await this.#validatePointer(pending.candidate, boundary);
        const previous = pending.previous === 'none' ? undefined : pending.previous;
        if (pointer && activePointersEqual(pointer, pending.candidate)) {
            return previous ? this.#validatePointer(previous, boundary) : undefined;
        }
        if (pointer && previous && activePointersEqual(pointer, previous)) {
            return this.#validatePointer(previous, boundary);
        }
        if (!pointer && !previous) {
            return undefined;
        }
        throw new RideCodexRuntimeStoreError(
            'Codex pending activation does not have a valid committed runtime view.'
        );
    }

    async revalidate(runtime: ValidatedManagedRuntime): Promise<ValidatedManagedRuntime> {
        const boundary = await this.#openReadOnlyBoundary();
        if (!boundary) {
            throw new RideCodexRuntimeStoreError('Codex managed runtime store is missing.');
        }
        const validated = await this.#validatePointer(runtime.pointer, boundary);
        if (validated.relativePath !== runtime.relativePath
            || validated.version !== runtime.version
            || validated.target !== runtime.target
            || validated.manifestDigest !== runtime.manifestDigest) {
            throw new RideCodexRuntimeStoreError('Codex managed runtime changed before revalidation.');
        }
        return validated;
    }

    async #validatePointer(
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

    async publish(
        transaction: RideCodexRuntimeStoreTransaction,
        staged: StagedRuntime,
        presentation: InstallPresentation,
        expectedPrevious?: ValidatedManagedRuntime
    ): Promise<PublishedManagedRuntime> {
        return this.#trackTransactionOperation(transaction, async transactionRecord => {
            const expectedPreviousWasSpecified = arguments.length >= 4;
            if (!installPresentationsEqual(transactionRecord.presentation, presentation)) {
                throw new RideCodexRuntimeStoreError('Codex install transaction presentation changed before publishing.');
            }
            const boundary = await this.#ensureWritableBoundary();
            if (await this.#readPendingActivation(boundary)) {
                throw new RideCodexRuntimeStoreError('Codex managed runtime transaction already requires recovery.');
            }
            const activePointer = await this.#readActivePointer(boundary);
            const previous = activePointer ? await this.#validatePointer(activePointer, boundary) : undefined;
            if (expectedPreviousWasSpecified
                && !optionalPointersEqual(previous?.pointer, expectedPrevious?.pointer)) {
                throw new RideCodexRuntimeStoreError('Codex active runtime changed before publishing.');
            }
            if (!samePath(presentation.installRoot, boundary.root)
                || staged.version !== presentation.version
                || staged.target !== presentation.target
                || staged.authorizationContext.target !== presentation.target
                || staged.authorizationContext.manifestDigest !== presentation.manifestDigest
                || !samePath(staged.authorizationContext.canonicalRoot, boundary.root)) {
                throw new RideCodexRuntimeStoreError('Codex staged runtime does not match its consented presentation.');
            }
            await consumeStagedRuntimeForPublication(staged, {
                target: presentation.target as StagedRuntime['target'],
                manifestDigest: presentation.manifestDigest,
                canonicalRoot: boundary.root
            }).catch(() => {
                throw new RideCodexRuntimeStoreError('Codex staged runtime provenance is invalid or already used.');
            });
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
            const stagingAttestation = await attestPublishedRuntime(staging, staged.unpackedBytes);
            if (!stableDirectoryIdentityEqual(stagingAttestation.rootIdentity, staged.stagingIdentity)) {
                throw new RideCodexRuntimeStoreError('Codex staged runtime identity changed before publishing.');
            }
            const intentPointer = createActivePointer(
                presentation,
                relativePath,
                executableRelativePath,
                stagingAttestation
            );
            const stagingRelativePath = relative(boundary.root, staging).split(/[/\\]/).join('/');
            if (!/^\.staging-[0-9a-f-]+$/i.test(stagingRelativePath)) {
                throw new RideCodexRuntimeStoreError('Codex staged runtime has a non-canonical journal path.');
            }
            let pending = createPendingActivation(
                'publishing',
                intentPointer,
                previous?.pointer,
                stagingRelativePath,
                staged.stagingIdentity
            );
            await this.#writePendingActivation(pending, boundary);
            await this.#testHooks.afterPublishingJournalWrite?.(join(boundary.root, PENDING_ACTIVATION));
            await boundary.verify();
            await fs.rename(staging, directory);
            await syncDirectory(versionsRoot!);
            await boundary.verify();
            await this.#testHooks.afterPublishRename?.(directory);
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
            const awaitingHandshake = transitionPendingActivation(pending, 'awaiting-handshake', pointer);
            await this.#replacePendingActivation(pending, awaitingHandshake, boundary);
            pending = awaitingHandshake;
            await boundary.verify();
            const published = Object.freeze({
                version: presentation.version,
                target: presentation.target,
                manifestDigest: presentation.manifestDigest,
                relativePath,
                directory,
                executable,
                pointer: pending.candidate
            });
            transactionRecord.published = published;
            this.#publishedRuntimes.set(published, { transaction: transactionRecord, activated: false });
            return published;
        });
    }

    async activate(
        transaction: RideCodexRuntimeStoreTransaction,
        published: PublishedManagedRuntime,
        expectedPrevious?: ValidatedManagedRuntime
    ): Promise<ValidatedManagedRuntime> {
        return this.#trackTransactionOperation(transaction, async transactionRecord => {
            const publishedRecord = this.#requirePublishedRuntime(published, transactionRecord);
            if (publishedRecord.activated || transactionRecord.published !== published) {
                throw new RideCodexRuntimeStoreError('Codex published runtime capability is invalid or already used.');
            }
            const boundary = await this.#ensureWritableBoundary();
            const pending = await this.#readPendingActivation(boundary);
            if (!pending || pending.phase !== 'awaiting-handshake'
                || !activePointersEqual(pending.candidate, published.pointer)
                || !optionalPointersEqual(pending.previous === 'none' ? undefined : pending.previous, expectedPrevious?.pointer)) {
                throw new RideCodexRuntimeStoreError('Codex publishing journal changed before activation.');
            }
            const previousPointer = pending.previous === 'none' ? undefined : pending.previous;
            const activePointer = await this.#readActivePointer(boundary);
            if (!optionalPointersEqual(activePointer, previousPointer)) {
                throw new RideCodexRuntimeStoreError('Codex active runtime changed before activation.');
            }
            if (previousPointer) {
                await this.#validatePointer(previousPointer, boundary);
            }
            let candidate: ValidatedManagedRuntime;
            try {
                candidate = await this.#validatePointer(published.pointer, boundary);
                if (!activePointersEqual(candidate.pointer, published.pointer)) {
                    throw new RideCodexRuntimeStoreError('Codex published runtime changed before activation.');
                }
            } catch {
                await this.#rollbackPendingActivation(pending, boundary, 'activation-failure');
                throw new RideCodexRuntimeStoreError(
                    'Codex published runtime failed activation validation and was removed safely.'
                );
            }
            let primaryFailure: unknown;
            try {
                await this.#writeActivePointer(published.pointer, 'activate');
            } catch (error) {
                primaryFailure = error;
            }
            try {
                const activated = await this.#readHandshakeCandidate(pending, boundary);
                publishedRecord.activated = true;
                transactionRecord.activated = activated;
                return activated;
            } catch (postConditionError) {
                const primary = primaryFailure ?? postConditionError;
                try {
                    await this.#rollbackPendingActivation(pending, boundary, 'activation-failure');
                } catch {
                    throw new RideCodexRuntimeStoreError(
                        'Codex runtime activation failed and rollback also failed; safe recovery is required.'
                    );
                }
                throw new RideCodexRuntimeStoreError(
                    primary
                        ? 'Codex runtime activation post-condition failed and was rolled back safely.'
                        : 'Codex runtime activation failed and was rolled back safely.'
                );
            }
        });
    }

    async restore(
        transaction: RideCodexRuntimeStoreTransaction,
        previous: ValidatedManagedRuntime | undefined,
        failed: PublishedManagedRuntime
    ): Promise<void> {
        return this.#trackTransactionOperation(transaction, async transactionRecord => {
            this.#requirePublishedRuntime(failed, transactionRecord);
            const boundary = await this.#ensureWritableBoundary();
            const pending = await this.#readPendingActivation(boundary);
            if (!pending) {
                const active = await this.#readActivePointer(boundary);
                const expected = previous?.pointer;
                if (optionalPointersEqual(active, expected) && !await pathExists(failed.directory)) {
                    if (expected) {
                        await this.#validatePointer(expected, boundary);
                    } else {
                        await boundary.verify();
                    }
                    return;
                }
            }
            if (!pending || pending.phase !== 'awaiting-handshake'
                || !activePointersEqual(pending.candidate, failed.pointer)
                || !optionalPointersEqual(
                    pending.previous === 'none' ? undefined : pending.previous,
                    previous?.pointer
                )) {
                throw new RideCodexRuntimeStoreError('Codex pending activation changed before rollback.');
            }
            await this.#rollbackPendingActivation(pending, boundary, 'rollback');
        });
    }

    async completeHandshake(
        transaction: RideCodexRuntimeStoreTransaction,
        runtime: ValidatedManagedRuntime,
        operation: (runtime: ValidatedManagedRuntime) => Promise<void>
    ): Promise<RideCodexHandshakeCompletion> {
        return this.#trackTransactionOperation(transaction, async transactionRecord => {
            if (transactionRecord.activated !== runtime || typeof operation !== 'function') {
                throw new RideCodexRuntimeStoreError('Codex handshake transaction capability is invalid.');
            }
            await operation(runtime);
            this.#requireTransaction(transaction, true);
            if (transactionRecord.activated !== runtime) {
                throw new RideCodexRuntimeStoreError('Codex activated runtime changed during handshake.');
            }
            const completion = Object.freeze({}) as RideCodexHandshakeCompletion;
            this.#handshakeCompletions.set(completion, {
                transaction: transactionRecord,
                runtime,
                consumed: false
            });
            return completion;
        });
    }

    async finalizeActivation(
        transaction: RideCodexRuntimeStoreTransaction,
        completion: RideCodexHandshakeCompletion
    ): Promise<ValidatedManagedRuntime> {
        return this.#trackTransactionOperation(transaction, async transactionRecord => {
            const handshake = typeof completion === 'object' && completion
                ? this.#handshakeCompletions.get(completion)
                : undefined;
            if (!handshake || handshake.consumed || handshake.transaction !== transactionRecord) {
                throw new RideCodexRuntimeStoreError('Codex handshake completion capability is invalid or already used.');
            }
            handshake.consumed = true;
            const runtime = handshake.runtime;
            const boundary = await this.#ensureWritableBoundary();
            const initialPending = await this.#readPendingActivation(boundary);
            if (!initialPending || initialPending.phase !== 'awaiting-handshake'
                || !activePointersEqual(initialPending.candidate, runtime.pointer)) {
                throw new RideCodexRuntimeStoreError('Codex pending activation is unavailable for finalization.');
            }
            await this.#testHooks.beforePendingFinalize?.(join(boundary.root, PENDING_ACTIVATION));
            const pending = await this.#readPendingActivation(boundary);
            if (!pending || !pendingActivationsEqual(pending, initialPending)) {
                throw new RideCodexRuntimeStoreError('Codex pending activation changed before finalization.');
            }
            const active = await this.#readHandshakeCandidate(pending, boundary);
            if (!activePointersEqual(active.pointer, runtime.pointer)) {
                throw new RideCodexRuntimeStoreError('Codex active runtime changed before finalization.');
            }
            const retainPrevious = pending.previous !== 'none'
                && await this.#validatePointer(pending.previous, boundary).then(() => true, () => false);
            const finalizing = transitionPendingActivation(
                pending,
                'finalizing',
                pending.candidate,
                retainPrevious
            );
            await this.#replacePendingActivation(pending, finalizing, boundary);
            await this.#testHooks.afterFinalizingJournalWrite?.(join(boundary.root, PENDING_ACTIVATION));
            return this.#finishFinalizing(finalizing, boundary);
        });
    }

    async #finishFinalizing(
        expected: PendingActivationTransaction,
        boundary: StoreBoundary
    ): Promise<ValidatedManagedRuntime> {
        if (expected.phase !== 'finalizing') {
            throw new RideCodexRuntimeStoreError('Codex activation is not in its finalizing phase.');
        }
        try {
            await this.#readHandshakeCandidate(expected, boundary);
        } catch {
            try {
                await this.#rollbackPendingActivation(expected, boundary, 'rollback');
            } catch {
                throw new RideCodexRuntimeStoreError(
                    'Codex finalization proof failed and rollback also failed; safe recovery is required.'
                );
            }
            throw new RideCodexRuntimeStoreError(
                'Codex finalization proof failed and the previous runtime was restored safely.'
            );
        }
        await this.#reconcileRetainedVersions(expected, boundary);
        const pending = await this.#readPendingActivation(boundary);
        if (!pending || !pendingActivationsEqual(pending, expected)) {
            throw new RideCodexRuntimeStoreError(
                'Codex finalizing journal changed during version reconciliation.'
            );
        }
        await this.#testHooks.beforePendingCommitRename?.(
            'finalize',
            join(boundary.root, PENDING_ACTIVATION),
            pendingQuarantinePath(boundary.root, pending)
        );
        try {
            await this.#validateFinalizingCommitState(pending, boundary);
        } catch {
            try {
                await this.#rollbackPendingActivation(pending, boundary, 'rollback');
            } catch {
                throw new RideCodexRuntimeStoreError(
                    'Codex finalization proof failed and rollback also failed; safe recovery is required.'
                );
            }
            throw new RideCodexRuntimeStoreError(
                'Codex finalization proof failed and the previous runtime was restored safely.'
            );
        }
        const committed = await this.#commitPendingActivationRemoval(
            boundary,
            'finalize',
            pending,
            () => this.#validateFinalizingCommitState(pending, boundary)
        );
        let active: ValidatedManagedRuntime;
        try {
            active = await this.#validateFinalizingCommitState(pending, boundary);
        } catch {
            const pendingPath = join(boundary.root, PENDING_ACTIVATION);
            try {
                await this.#restorePendingQuarantine(pendingPath, committed.path, committed.identity, boundary);
                await this.#rollbackPendingActivation(pending, boundary, 'rollback');
            } catch {
                throw new RideCodexRuntimeStoreError(
                    'Codex finalization post-condition failed and rollback also failed; safe recovery is required.'
                );
            }
            throw new RideCodexRuntimeStoreError(
                'Codex finalization post-condition failed and the previous runtime was restored safely.'
            );
        }
        await this.#deleteCommittedQuarantine(committed, boundary, 'finalize');
        return active;
    }

    async #validateFinalizingCommitState(
        pending: PendingActivationTransaction,
        boundary: StoreBoundary
    ): Promise<ValidatedManagedRuntime> {
        const pointer = await this.#readActivePointer(boundary);
        if (!pointer || !activePointersEqual(pointer, pending.candidate)) {
            throw new RideCodexRuntimeStoreError('Codex finalizing active pointer changed before commit.');
        }
        const active = await this.#validatePointer(pending.candidate, boundary);
        if (pending.previous !== 'none' && pending.retention.includes(pending.previous.relativePath)) {
            await this.#validatePointer(pending.previous, boundary);
        }
        return active;
    }

    async #reconcileRetainedVersions(
        pending: PendingActivationTransaction,
        boundary: StoreBoundary
    ): Promise<void> {
        if (pending.phase !== 'finalizing') {
            throw new RideCodexRuntimeStoreError('Codex version reconciliation requires a finalizing journal.');
        }
        const keep = new Set(pending.retention);
        const versionsRoot = await boundary.requireVersions(true);
        for (const entry of await boundedDirectoryEntries(versionsRoot!)) {
            if (!parseVersionDirectoryName(entry)) {
                continue;
            }
            const relativePath = `${VERSIONS_DIRECTORY}/${entry}`;
            if (keep.has(relativePath)) {
                continue;
            }
            await this.#quarantineObsoleteVersion(join(versionsRoot!, entry), relativePath, versionsRoot!, boundary);
        }
        await this.#validatePointer(pending.candidate, boundary);
        if (pending.previous !== 'none' && pending.retention.includes(pending.previous.relativePath)) {
            await this.#validatePointer(pending.previous, boundary);
        }
    }

    async #quarantineObsoleteVersion(
        candidate: string,
        relativePath: string,
        versionsRoot: string,
        boundary: StoreBoundary
    ): Promise<void> {
        requireStrictChild(versionsRoot, candidate);
        const before = await safeLstat(candidate, 'Codex obsolete runtime entry is missing.');
        requireRegularDirectory(before, 'Codex obsolete runtime entry is unsafe.');
        if (!samePath(await safeRealpath(candidate, 'Codex obsolete runtime entry is unsafe.'), candidate)) {
            throw new RideCodexRuntimeStoreError('Codex obsolete runtime cleanup refused an unsafe entry.');
        }
        await verifySafeDeletionTree(candidate, boundary.root);
        const quarantine = join(boundary.root, `.install-quarantine-obsolete-${randomUUID()}`);
        requireStrictChild(boundary.root, quarantine);
        await boundary.verify();
        await fs.rename(candidate, quarantine);
        const moved = await safeLstat(quarantine, 'Codex obsolete runtime quarantine is missing.');
        if (!stableDirectoryIdentityEqual(filesystemIdentity(before), filesystemIdentity(moved))
            || !samePath(await safeRealpath(quarantine, 'Codex obsolete runtime quarantine is unsafe.'), quarantine)) {
            throw new RideCodexRuntimeStoreError('Codex obsolete runtime changed while entering quarantine.');
        }
        await syncDirectory(versionsRoot);
        await syncDirectory(boundary.root);
        await boundary.verify();
        await this.#testHooks.afterObsoleteQuarantine?.(relativePath, quarantine);
        await deleteQuarantineWhileAuthorityIsRetained(quarantine, boundary.root, boundary);
    }

    async #recoverPublishing(
        pending: PendingActivationTransaction,
        boundary: StoreBoundary
    ): Promise<void> {
        if (pending.phase !== 'publishing') {
            throw new RideCodexRuntimeStoreError('Codex publishing recovery received an invalid phase.');
        }
        const activePointer = await this.#readActivePointer(boundary);
        const previous = pending.previous === 'none' ? undefined : pending.previous;
        if (previous) {
            if (!activePointer || !activePointersEqual(activePointer, previous)) {
                throw new RideCodexRuntimeStoreError('Codex active runtime changed during publishing recovery.');
            }
            await this.#validatePointer(previous, boundary);
        } else if (activePointer) {
            throw new RideCodexRuntimeStoreError('Codex first-install active state changed during publishing recovery.');
        }

        const staging = resolve(boundary.root, ...pending.stagingRelativePath.split('/'));
        requireStrictChild(boundary.root, staging);
        const versionsRoot = await boundary.requireVersions(false);
        if (!versionsRoot) {
            throw new RideCodexRuntimeStoreError('Codex publishing versions directory is missing.');
        }
        const candidate = resolve(boundary.root, ...pending.candidate.relativePath.split('/'));
        requireStrictChild(versionsRoot, candidate);
        const quarantine = join(boundary.root, `.install-quarantine-publishing-${pending.transactionId}`);
        requireStrictChild(boundary.root, quarantine);
        const states = await Promise.all([staging, candidate, quarantine].map(pathExists));
        if (states.filter(Boolean).length !== 1) {
            throw new RideCodexRuntimeStoreError('Codex publishing recovery state is inconsistent.');
        }
        const source = states[0] ? staging : states[1] ? candidate : quarantine;
        const before = await this.#validatePublishingRecoveryObject(source, pending, boundary);
        if (source !== quarantine) {
            await boundary.verify();
            await fs.rename(source, quarantine);
            const moved = await this.#validatePublishingRecoveryObject(quarantine, pending, boundary);
            if (!stableDirectoryIdentityEqual(filesystemIdentity(before), filesystemIdentity(moved))) {
                throw new RideCodexRuntimeStoreError('Codex publishing candidate changed while entering quarantine.');
            }
            await syncDirectory(source === candidate ? versionsRoot : boundary.root);
            await syncDirectory(boundary.root);
        }
        await this.#testHooks.afterPublishingCandidateQuarantine?.(quarantine);
        const finalPending = await this.#readPendingActivation(boundary);
        if (!finalPending || !pendingActivationsEqual(finalPending, pending)) {
            throw new RideCodexRuntimeStoreError('Codex publishing journal changed before recovery commit.');
        }
        await this.#testHooks.beforePendingCommitRename?.(
            'publishing-recovery',
            join(boundary.root, PENDING_ACTIVATION),
            pendingQuarantinePath(boundary.root, pending)
        );
        const committed = await this.#commitPendingActivationRemoval(
            boundary,
            'publishing-recovery',
            pending,
            () => this.#validateCommittedPrevious(pending, boundary)
        );
        try {
            await this.#validateCommittedPrevious(pending, boundary);
        } catch {
            try {
                await this.#restorePendingQuarantine(
                    join(boundary.root, PENDING_ACTIVATION),
                    committed.path,
                    committed.identity,
                    boundary
                );
            } catch {
                throw new RideCodexRuntimeStoreError(
                    'Codex publishing recovery post-condition failed and journal restoration also failed.'
                );
            }
            throw new RideCodexRuntimeStoreError(
                'Codex publishing recovery post-condition failed; recovery authority was preserved.'
            );
        }
        await deleteQuarantineWhileAuthorityIsRetained(quarantine, boundary.root, boundary);
        await this.#deleteCommittedQuarantine(committed, boundary, 'publishing-recovery');
    }

    async #validateCommittedPrevious(
        pending: PendingActivationTransaction,
        boundary: StoreBoundary
    ): Promise<void> {
        const pointer = await this.#readActivePointer(boundary);
        if (pending.previous === 'none') {
            if (pointer) {
                throw new RideCodexRuntimeStoreError('Codex first-install committed state changed before recovery commit.');
            }
            await boundary.verify();
            return;
        }
        if (!pointer || !activePointersEqual(pointer, pending.previous)) {
            throw new RideCodexRuntimeStoreError('Codex previous active pointer changed before recovery commit.');
        }
        await this.#validatePointer(pending.previous, boundary);
    }

    async #validatePublishingRecoveryObject(
        candidate: string,
        pending: PendingActivationTransaction,
        boundary: StoreBoundary
    ): Promise<BigIntStats> {
        const before = await safeLstat(candidate, 'Codex publishing recovery object is missing.');
        requireRegularDirectory(before, 'Codex publishing recovery object is unsafe.');
        if (!samePath(await safeRealpath(candidate, 'Codex publishing recovery object is unsafe.'), candidate)
            || !stableDirectoryIdentityEqual(
                filesystemIdentity(before),
                deserializeIdentity(pending.stagingIdentity)
            )) {
            throw new RideCodexRuntimeStoreError('Codex publishing recovery object identity is invalid.');
        }
        await verifySafeDeletionTree(candidate, boundary.root);
        const after = await safeLstat(candidate, 'Codex publishing recovery object changed during validation.');
        if (!stableDirectoryIdentityEqual(filesystemIdentity(before), filesystemIdentity(after))) {
            throw new RideCodexRuntimeStoreError('Codex publishing recovery object identity changed.');
        }
        await boundary.verify();
        return after;
    }

    async #readHandshakeCandidate(
        expected: PendingActivationTransaction,
        boundary: StoreBoundary
    ): Promise<ValidatedManagedRuntime> {
        const pending = await this.#readPendingActivation(boundary);
        if (!pending || !pendingActivationsEqual(pending, expected)) {
            throw new RideCodexRuntimeStoreError('Codex pending activation changed before candidate validation.');
        }
        const pointer = await this.#readActivePointer(boundary);
        if (!pointer || !activePointersEqual(pointer, pending.candidate)) {
            throw new RideCodexRuntimeStoreError('Codex activation pointer post-condition did not match the candidate.');
        }
        return this.#validatePointer(pointer, boundary);
    }

    async discard(
        transaction: RideCodexRuntimeStoreTransaction,
        published: PublishedManagedRuntime
    ): Promise<void> {
        return this.#trackTransactionOperation(transaction, async transactionRecord => {
            this.#requirePublishedRuntime(published, transactionRecord);
            const boundary = await this.#ensureWritableBoundary();
            const pending = await this.#readPendingActivation(boundary);
            if (pending) {
                throw new RideCodexRuntimeStoreError(
                    activePointersEqual(pending.candidate, published.pointer)
                        ? 'Codex pending candidate cannot be discarded before recovery commits.'
                        : 'Codex runtime cannot be discarded while another activation is pending.'
                );
            }
            const current = await this.readActiveRuntime();
            if (current?.relativePath === published.relativePath) {
                throw new RideCodexRuntimeStoreError('Codex active runtime cannot be discarded.');
            }
            const stat = await safeLstat(published.directory, 'Codex failed runtime directory is missing.');
            if (!stableDirectoryIdentityEqual(filesystemIdentity(stat), deserializeIdentity(published.pointer.rootIdentity))) {
                throw new RideCodexRuntimeStoreError('Codex failed runtime identity changed before cleanup.');
            }
            await quarantineAndDelete(published.directory, boundary.root, boundary);
        });
    }

    async #readActivePointer(boundary: StoreBoundary): Promise<ActiveRuntimePointer | undefined> {
        const bytes = await readBoundedRegularFile(join(boundary.root, ACTIVE_POINTER), MAX_POINTER_BYTES, true);
        if (!bytes) {
            return undefined;
        }
        const pointer = parseActivePointer(bytes);
        await boundary.verify();
        return pointer;
    }

    async #readPendingActivation(
        boundary: StoreBoundary
    ): Promise<PendingActivationTransaction | undefined> {
        const bytes = await readBoundedRegularFile(join(boundary.root, PENDING_ACTIVATION), MAX_PENDING_BYTES, true);
        if (!bytes) {
            return undefined;
        }
        const pending = parsePendingActivation(bytes);
        await boundary.verify();
        return pending;
    }

    async #readCommittedPendingQuarantine(
        boundary: StoreBoundary
    ): Promise<CommittedPendingQuarantine | undefined> {
        const entries = (await boundedDirectoryEntries(boundary.root)).filter(
            candidateEntry => /^\.install-quarantine-pending-[0-9a-f-]{36}$/.test(candidateEntry)
        );
        if (entries.length > 1) {
            throw new RideCodexRuntimeStoreError('Codex runtime store contains multiple quarantined recovery journals.');
        }
        const entry = entries[0];
        if (!entry) {
            return undefined;
        }
        const quarantine = join(boundary.root, entry);
        requireStrictChild(boundary.root, quarantine);
        const before = await safeLstat(quarantine, 'Codex quarantined recovery journal is missing.');
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== BigInt(1)
            || !samePath(
                await safeRealpath(quarantine, 'Codex quarantined recovery journal is unsafe.'),
                quarantine
            )) {
            throw new RideCodexRuntimeStoreError('Codex quarantined recovery journal is unsafe.');
        }
        const bytes = await readBoundedRegularFile(quarantine, MAX_PENDING_BYTES, false);
        if (!bytes) {
            throw new RideCodexRuntimeStoreError('Codex quarantined recovery journal is unavailable.');
        }
        const pending = parsePendingActivation(bytes);
        if (!samePath(quarantine, pendingQuarantinePath(boundary.root, pending))) {
            throw new RideCodexRuntimeStoreError('Codex quarantined recovery journal name is inconsistent.');
        }
        const after = await safeLstat(quarantine, 'Codex quarantined recovery journal changed while reading.');
        if (!stableObjectIdentityEqual(filesystemIdentity(before), filesystemIdentity(after))) {
            throw new RideCodexRuntimeStoreError('Codex quarantined recovery journal identity changed while reading.');
        }
        await boundary.verify();
        return Object.freeze({
            path: quarantine,
            identity: filesystemIdentity(after),
            pending
        });
    }

    async #recoverCommittedPendingQuarantine(
        committed: CommittedPendingQuarantine,
        boundary: StoreBoundary
    ): Promise<void> {
        const pendingPath = join(boundary.root, PENDING_ACTIVATION);
        const restore = async (): Promise<void> => {
            await this.#restorePendingQuarantine(
                pendingPath,
                committed.path,
                committed.identity,
                boundary
            );
            const restored = await this.#readPendingActivation(boundary);
            if (!restored || !pendingActivationsEqual(restored, committed.pending)) {
                throw new RideCodexRuntimeStoreError('Codex quarantined recovery journal was not restored safely.');
            }
        };

        if (committed.pending.phase === 'finalizing') {
            const active = await this.#readActivePointer(boundary);
            const previous = committed.pending.previous === 'none'
                ? undefined
                : committed.pending.previous;
            if (optionalPointersEqual(active, previous)) {
                await this.#recoverCommittedRollback(committed, boundary, restore);
                return;
            }
            await restore();
            try {
                await this.#finishFinalizing(committed.pending, boundary);
            } catch (error) {
                const pending = await this.#readPendingActivation(boundary);
                const quarantined = await this.#readCommittedPendingQuarantine(boundary);
                if (pending || quarantined) {
                    throw error;
                }
                await this.#validateCommittedPrevious(committed.pending, boundary);
            }
            return;
        }

        if (committed.pending.phase === 'awaiting-handshake') {
            await this.#recoverCommittedRollback(committed, boundary, restore);
            return;
        }

        const staging = resolve(boundary.root, ...committed.pending.stagingRelativePath.split('/'));
        requireStrictChild(boundary.root, staging);
        const versionsRoot = join(boundary.root, VERSIONS_DIRECTORY);
        const candidate = resolve(boundary.root, ...committed.pending.candidate.relativePath.split('/'));
        requireStrictChild(versionsRoot, candidate);
        const publishingQuarantine = join(
            boundary.root,
            `.install-quarantine-publishing-${committed.pending.transactionId}`
        );
        requireStrictChild(boundary.root, publishingQuarantine);
        const states = await Promise.all([staging, candidate, publishingQuarantine].map(pathExists));
        if (states.filter(Boolean).length > 1) {
            throw new RideCodexRuntimeStoreError('Codex committed publishing recovery state is inconsistent.');
        }
        if (!states.some(Boolean)) {
            await this.#validateCommittedPrevious(committed.pending, boundary);
            await this.#deleteCommittedQuarantine(committed, boundary, 'publishing-recovery');
            return;
        }
        await restore();
        await this.#recoverPublishing(committed.pending, boundary);
    }

    async #recoverCommittedRollback(
        committed: CommittedPendingQuarantine,
        boundary: StoreBoundary,
        restore: () => Promise<void>
    ): Promise<void> {
        const versionsRoot = join(boundary.root, VERSIONS_DIRECTORY);
        const candidate = resolve(boundary.root, ...committed.pending.candidate.relativePath.split('/'));
        requireStrictChild(versionsRoot, candidate);
        const candidateQuarantine = join(
            boundary.root,
            `.install-quarantine-candidate-${committed.pending.transactionId}`
        );
        requireStrictChild(boundary.root, candidateQuarantine);
        const states = await Promise.all([candidate, candidateQuarantine].map(pathExists));
        if (states.filter(Boolean).length > 1) {
            throw new RideCodexRuntimeStoreError('Codex committed rollback candidate state is inconsistent.');
        }
        if (!states.some(Boolean)) {
            await this.#validateCommittedPrevious(committed.pending, boundary);
            await this.#deleteCommittedQuarantine(committed, boundary, 'rollback');
            return;
        }
        await restore();
        await this.#rollbackPendingActivation(committed.pending, boundary, 'recover');
    }

    async #writePendingActivation(
        pending: PendingActivationTransaction,
        boundary: StoreBoundary
    ): Promise<void> {
        const pendingPath = join(boundary.root, PENDING_ACTIVATION);
        if (await pathExists(pendingPath)) {
            throw new RideCodexRuntimeStoreError('Codex pending activation already exists and requires recovery.');
        }
        const temporaryPath = join(boundary.root, `pending-activation.json.tmp-${randomUUID()}`);
        requireStrictChild(boundary.root, temporaryPath);
        const bytes = Buffer.from(`${JSON.stringify(pending)}\n`, 'utf8');
        if (bytes.length > MAX_PENDING_BYTES) {
            throw new RideCodexRuntimeStoreError('Codex pending activation journal exceeded its size limit.');
        }
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
        try {
            handle = await fs.open(
                temporaryPath,
                fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
                0o600
            );
            await handle.writeFile(bytes);
            await handle.sync();
        } finally {
            await handle?.close().catch(() => undefined);
        }
        const tempStat = await safeLstat(temporaryPath, 'Codex pending activation temporary journal is missing.');
        if (!tempStat.isFile() || tempStat.isSymbolicLink() || tempStat.nlink !== BigInt(1)) {
            throw new RideCodexRuntimeStoreError('Codex pending activation temporary journal is unsafe.');
        }
        await syncDirectory(boundary.root);
        await boundary.verify();
        await fs.rename(temporaryPath, pendingPath);
        await syncDirectory(boundary.root);
        await boundary.verify();
    }

    async #replacePendingActivation(
        expected: PendingActivationTransaction,
        replacement: PendingActivationTransaction,
        boundary: StoreBoundary
    ): Promise<void> {
        const pendingPath = join(boundary.root, PENDING_ACTIVATION);
        const before = await safeLstat(pendingPath, 'Codex pending activation journal is missing.');
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== BigInt(1)) {
            throw new RideCodexRuntimeStoreError('Codex pending activation journal is unsafe.');
        }
        const current = await this.#readPendingActivation(boundary);
        if (!current || !pendingActivationsEqual(current, expected)) {
            throw new RideCodexRuntimeStoreError('Codex pending activation changed before its phase update.');
        }
        const temporaryPath = join(boundary.root, `pending-activation.json.tmp-${randomUUID()}`);
        requireStrictChild(boundary.root, temporaryPath);
        const bytes = Buffer.from(`${JSON.stringify(replacement)}\n`, 'utf8');
        if (bytes.length > MAX_PENDING_BYTES) {
            throw new RideCodexRuntimeStoreError('Codex pending activation journal exceeded its size limit.');
        }
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
        try {
            handle = await fs.open(
                temporaryPath,
                fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
                0o600
            );
            await handle.writeFile(bytes);
            await handle.sync();
        } finally {
            await handle?.close().catch(() => undefined);
        }
        const temporaryStat = await safeLstat(
            temporaryPath,
            'Codex pending activation phase journal is missing.'
        );
        if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink() || temporaryStat.nlink !== BigInt(1)) {
            throw new RideCodexRuntimeStoreError('Codex pending activation phase journal is unsafe.');
        }
        await syncDirectory(boundary.root);
        const finalCurrent = await this.#readPendingActivation(boundary);
        const finalStat = await safeLstat(pendingPath, 'Codex pending activation changed before its phase update.');
        if (!finalCurrent || !pendingActivationsEqual(finalCurrent, expected)
            || !runtimeFilesystemIdentitiesEqual(filesystemIdentity(before), filesystemIdentity(finalStat))) {
            throw new RideCodexRuntimeStoreError('Codex pending activation changed before its phase update.');
        }
        await boundary.verify();
        await fs.rename(temporaryPath, pendingPath);
        await syncDirectory(boundary.root);
        const committed = await this.#readPendingActivation(boundary);
        if (!committed || !pendingActivationsEqual(committed, replacement)) {
            throw new RideCodexRuntimeStoreError('Codex pending activation phase update did not commit safely.');
        }
        await boundary.verify();
    }

    async #commitPendingActivationRemoval(
        boundary: StoreBoundary,
        kind: PendingActivationCommitKind,
        expected: PendingActivationTransaction,
        finalStateProof: () => Promise<unknown>
    ): Promise<CommittedPendingQuarantine> {
        const pendingPath = join(boundary.root, PENDING_ACTIVATION);
        const before = await safeLstat(pendingPath, 'Codex pending activation journal is missing.');
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== BigInt(1)
            || !samePath(await safeRealpath(pendingPath, 'Codex pending activation journal is unsafe.'), pendingPath)) {
            throw new RideCodexRuntimeStoreError('Codex pending activation journal is unsafe.');
        }
        const pending = await this.#readPendingActivation(boundary);
        if (!pending || !pendingActivationsEqual(pending, expected)) {
            throw new RideCodexRuntimeStoreError('Codex pending activation journal changed before commit.');
        }
        const quarantine = pendingQuarantinePath(boundary.root, pending);
        requireStrictChild(boundary.root, quarantine);
        if (await pathExists(quarantine)) {
            throw new RideCodexRuntimeStoreError('Codex pending activation quarantine already exists.');
        }
        await boundary.verify();
        const finalPending = await this.#readPendingActivation(boundary);
        const finalStat = await safeLstat(pendingPath, 'Codex pending activation journal changed before commit.');
        if (!finalPending || !pendingActivationsEqual(finalPending, expected)
            || !runtimeFilesystemIdentitiesEqual(filesystemIdentity(before), filesystemIdentity(finalStat))) {
            throw new RideCodexRuntimeStoreError('Codex pending activation journal changed before commit.');
        }
        await finalStateProof();
        await fs.rename(pendingPath, quarantine);
        try {
            const moved = await safeLstat(quarantine, 'Codex pending activation quarantine is missing.');
            if (!moved.isFile() || moved.isSymbolicLink() || moved.nlink !== BigInt(1)
                || !stableObjectIdentityEqual(filesystemIdentity(before), filesystemIdentity(moved))
                || !samePath(await safeRealpath(quarantine, 'Codex pending activation quarantine is unsafe.'), quarantine)) {
                throw new RideCodexRuntimeStoreError('Codex pending activation quarantine identity changed.');
            }
            await this.#testHooks.beforePendingCommitSync?.(kind, boundary.root);
            await syncDirectory(boundary.root);
            await boundary.verify();
            return Object.freeze({
                path: quarantine,
                identity: filesystemIdentity(before),
                pending: expected
            });
        } catch (error) {
            await this.#restorePendingQuarantine(pendingPath, quarantine, filesystemIdentity(before), boundary)
                .catch(() => undefined);
            throw error;
        }
    }

    async #restorePendingQuarantine(
        pendingPath: string,
        quarantine: string,
        expectedIdentity: RuntimeFilesystemIdentity,
        boundary: StoreBoundary
    ): Promise<void> {
        if (await pathExists(pendingPath)) {
            throw new RideCodexRuntimeStoreError('Codex pending activation journal was replaced during recovery.');
        }
        const quarantined = await safeLstat(quarantine, 'Codex pending activation quarantine is missing.');
        if (!quarantined.isFile() || quarantined.isSymbolicLink()
            || !stableObjectIdentityEqual(filesystemIdentity(quarantined), expectedIdentity)) {
            throw new RideCodexRuntimeStoreError('Codex pending activation quarantine changed before recovery.');
        }
        await fs.rename(quarantine, pendingPath);
        const restored = await safeLstat(pendingPath, 'Codex pending activation journal was not restored.');
        if (!stableObjectIdentityEqual(filesystemIdentity(restored), expectedIdentity)) {
            throw new RideCodexRuntimeStoreError('Codex pending activation journal identity changed during recovery.');
        }
        await syncDirectory(boundary.root);
        await boundary.verify();
    }

    async #deleteCommittedQuarantine(
        committed: CommittedPendingQuarantine,
        boundary: StoreBoundary,
        kind: PendingActivationCommitKind
    ): Promise<void> {
        try {
            await this.#testHooks.beforePendingQuarantineDelete?.(kind, committed.path);
            await deleteExistingQuarantine(committed.path, boundary.root, boundary);
        } catch (error) {
            if (await pathExists(committed.path)) {
                // The committed journal remains authoritative, so cleanup can be
                // retried safely after a sharing violation or other pre-delete error.
                return;
            }
            const pendingPath = join(boundary.root, PENDING_ACTIVATION);
            try {
                if (!await pathExists(pendingPath)) {
                    await this.#writePendingActivation(committed.pending, boundary);
                }
            } catch {
                throw new RideCodexRuntimeStoreError(
                    'Codex committed journal cleanup failed after deletion and recovery authority could not be restored.'
                );
            }
            throw error;
        }
    }

    async #rollbackPendingActivation(
        pending: PendingActivationTransaction,
        boundary: StoreBoundary,
        reason: 'recover' | 'rollback' | 'activation-failure'
    ): Promise<void> {
        if (pending.phase !== 'awaiting-handshake' && pending.phase !== 'finalizing') {
            throw new RideCodexRuntimeStoreError('Codex activation cannot roll back after entering another phase.');
        }
        const activePointer = await this.#readActivePointer(boundary);
        const previousPointer = pending.previous === 'none' ? undefined : pending.previous;
        const activeIsCandidate = activePointer !== undefined
            && activePointersEqual(activePointer, pending.candidate);
        const activeIsPrevious = previousPointer !== undefined
            && activePointer !== undefined
            && activePointersEqual(activePointer, previousPointer);
        const activeIsOriginalEmpty = previousPointer === undefined && activePointer === undefined;

        if (activeIsCandidate) {
            if (previousPointer) {
                await this.#validatePointer(previousPointer, boundary);
                try {
                    await this.#writeActivePointer(previousPointer, 'rollback');
                } catch {
                    // A rename can commit before a later durability signal fails. The
                    // post-condition below decides whether rollback actually completed.
                }
                const restoredPointer = await this.#readActivePointer(boundary);
                if (!restoredPointer || !activePointersEqual(restoredPointer, previousPointer)) {
                    throw new RideCodexRuntimeStoreError('Codex rollback pointer post-condition failed.');
                }
                await this.#validatePointer(previousPointer, boundary);
            } else {
                const activePath = join(boundary.root, ACTIVE_POINTER);
                await quarantineAndDelete(activePath, boundary.root, boundary);
                await syncDirectory(boundary.root);
                if (await this.#readActivePointer(boundary)) {
                    throw new RideCodexRuntimeStoreError('Codex first-install rollback post-condition failed.');
                }
            }
        }
        if (activeIsPrevious) {
            if (!previousPointer) {
                throw new RideCodexRuntimeStoreError('Codex previous runtime is invalid during pending recovery.');
            }
            await this.#validatePointer(previousPointer, boundary);
        }
        if (!activeIsCandidate && !activeIsPrevious && !activeIsOriginalEmpty) {
            throw new RideCodexRuntimeStoreError(
                `Codex pending activation state is inconsistent during ${reason}; recovery stopped safely.`
            );
        }

        const candidateQuarantine = await this.#quarantineRollbackCandidate(pending, boundary);
        await this.#testHooks.afterRollbackCandidateQuarantine?.(candidateQuarantine);
        await this.#testHooks.beforePendingCommitRename?.(
            'rollback',
            join(boundary.root, PENDING_ACTIVATION),
            pendingQuarantinePath(boundary.root, pending)
        );
        const finalPending = await this.#readPendingActivation(boundary);
        if (!finalPending || !pendingActivationsEqual(finalPending, pending)) {
            throw new RideCodexRuntimeStoreError('Codex pending activation changed before rollback commit.');
        }
        const committed = await this.#commitPendingActivationRemoval(
            boundary,
            'rollback',
            pending,
            () => this.#validateCommittedPrevious(pending, boundary)
        );
        try {
            await this.#validateCommittedPrevious(pending, boundary);
        } catch {
            try {
                await this.#restorePendingQuarantine(
                    join(boundary.root, PENDING_ACTIVATION),
                    committed.path,
                    committed.identity,
                    boundary
                );
            } catch {
                throw new RideCodexRuntimeStoreError(
                    'Codex rollback post-condition failed and journal restoration also failed.'
                );
            }
            throw new RideCodexRuntimeStoreError(
                'Codex rollback post-condition failed; recovery authority was preserved.'
            );
        }
        await deleteQuarantineWhileAuthorityIsRetained(candidateQuarantine, boundary.root, boundary);
        await this.#deleteCommittedQuarantine(committed, boundary, 'rollback');
    }

    async #quarantineRollbackCandidate(
        pending: PendingActivationTransaction,
        boundary: StoreBoundary
    ): Promise<string> {
        const pointer = pending.candidate;
        const versionsRoot = await boundary.requireVersions(false);
        if (!versionsRoot) {
            throw new RideCodexRuntimeStoreError('Codex pending candidate versions directory is missing.');
        }
        const candidate = resolve(boundary.root, ...pointer.relativePath.split('/'));
        requireStrictChild(versionsRoot, candidate);
        const quarantine = join(boundary.root, `.install-quarantine-candidate-${pending.transactionId}`);
        requireStrictChild(boundary.root, quarantine);
        const candidateExists = await pathExists(candidate);
        const quarantineExists = await pathExists(quarantine);
        if (!candidateExists && quarantineExists) {
            await validateRollbackQuarantine(quarantine, pointer, boundary);
            return quarantine;
        }
        if (!candidateExists || quarantineExists) {
            throw new RideCodexRuntimeStoreError('Codex pending candidate quarantine state is inconsistent.');
        }
        const before = await validateRollbackCandidate(candidate, pointer, boundary);
        await boundary.verify();
        await fs.rename(candidate, quarantine);
        const moved = await validateRollbackQuarantine(quarantine, pointer, boundary);
        if (!stableDirectoryIdentityEqual(filesystemIdentity(before), filesystemIdentity(moved))) {
            throw new RideCodexRuntimeStoreError('Codex pending candidate changed while entering quarantine.');
        }
        await syncDirectory(boundary.root);
        await boundary.verify();
        return quarantine;
    }

    async #writeActivePointer(pointer: ActiveRuntimePointer, kind: PointerWriteKind): Promise<void> {
        const boundary = await this.#ensureWritableBoundary();
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
            await this.#testHooks.beforePointerSync?.(kind, temporaryPath);
            await handle.sync();
        } finally {
            await handle?.close().catch(() => undefined);
        }
        const tempStat = await safeLstat(temporaryPath, 'Codex active runtime temporary pointer is missing.');
        if (!tempStat.isFile() || tempStat.isSymbolicLink() || tempStat.nlink !== BigInt(1)) {
            throw new RideCodexRuntimeStoreError('Codex active runtime temporary pointer is unsafe.');
        }
        await syncDirectory(boundary.root);
        await this.#testHooks.beforePointerRename?.(kind, temporaryPath);
        const activePath = join(boundary.root, ACTIVE_POINTER);
        await fs.rename(temporaryPath, activePath);
        await this.#testHooks.afterPointerRename?.(kind, activePath);
        await syncDirectory(boundary.root);
        await boundary.verify();
    }

    #requireTransaction(
        transaction: RideCodexRuntimeStoreTransaction,
        allowSettling = false
    ): StoreTransactionRecord {
        if (typeof transaction !== 'object' || !transaction) {
            throw new RideCodexRuntimeStoreError('Codex install transaction capability is invalid.');
        }
        const record = this.#transactions.get(transaction);
        if (!record || !record.active || (!allowSettling && !record.accepting)) {
            throw new RideCodexRuntimeStoreError('Codex install transaction capability is invalid, ended, or belongs to another store.');
        }
        return record;
    }

    #trackTransactionOperation<T>(
        transaction: RideCodexRuntimeStoreTransaction,
        operation: (record: StoreTransactionRecord) => Promise<T>
    ): Promise<T> {
        const record = this.#requireTransaction(transaction);
        if (record.operations.size >= MAX_TRANSACTION_OPERATIONS) {
            throw new RideCodexRuntimeStoreError('Codex install transaction exceeded its operation limit.');
        }
        if (record.mutationInProgress) {
            throw new RideCodexRuntimeStoreError(
                'Codex install transaction already has a mutation in progress.'
            );
        }
        record.mutationInProgress = true;
        const pending = Promise.resolve().then(() => operation(record));
        record.operations.add(pending);
        pending.then(
            () => {
                record.operations.delete(pending);
                record.mutationInProgress = false;
            },
            () => {
                record.operations.delete(pending);
                record.mutationInProgress = false;
            }
        );
        return pending;
    }

    #requirePublishedRuntime(
        published: PublishedManagedRuntime,
        transaction: StoreTransactionRecord
    ): PublishedRuntimeRecord {
        if (typeof published !== 'object' || !published) {
            throw new RideCodexRuntimeStoreError('Codex published runtime capability is invalid.');
        }
        const record = this.#publishedRuntimes.get(published);
        if (!record || record.transaction !== transaction) {
            throw new RideCodexRuntimeStoreError('Codex published runtime capability is invalid or belongs to another transaction.');
        }
        return record;
    }

    async #ensureWritableBoundary(): Promise<StoreBoundary> {
        const base = await validateExistingDirectory(this.#trustedRuntimeBase, 'Codex trusted runtime base is unavailable.');
        let current = base.path;
        const child = relative(this.#trustedRuntimeBase, this.installRoot);
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

    async #openReadOnlyBoundary(): Promise<StoreBoundary | undefined> {
        try {
            await validateExistingDirectory(this.#trustedRuntimeBase, 'Codex trusted runtime base is unsafe.');
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

function createPendingActivation(
    phase: PendingActivationTransaction['phase'],
    candidate: ActiveRuntimePointer,
    previous: ActiveRuntimePointer | undefined,
    stagingRelativePath: string,
    stagingIdentity: RuntimeFilesystemIdentity
): PendingActivationTransaction {
    const retained = Object.freeze([
        candidate.relativePath,
        ...(previous ? [previous.relativePath] : [])
    ]);
    return Object.freeze({
        schemaVersion: 1,
        transactionId: randomUUID(),
        phase,
        candidate,
        previous: previous ?? 'none',
        retention: retained,
        stagingRelativePath,
        stagingIdentity: serializeIdentity(stagingIdentity)
    });
}

function transitionPendingActivation(
    pending: PendingActivationTransaction,
    phase: PendingActivationTransaction['phase'],
    candidate: ActiveRuntimePointer,
    retainPrevious = true
): PendingActivationTransaction {
    return Object.freeze({
        schemaVersion: 1,
        transactionId: pending.transactionId,
        phase,
        candidate,
        previous: pending.previous,
        retention: Object.freeze([
            candidate.relativePath,
            ...(pending.previous === 'none' || !retainPrevious ? [] : [pending.previous.relativePath])
        ]),
        stagingRelativePath: pending.stagingRelativePath,
        stagingIdentity: pending.stagingIdentity
    });
}

function pendingQuarantinePath(root: string, pending: PendingActivationTransaction): string {
    const quarantine = join(root, `.install-quarantine-pending-${pending.transactionId}`);
    requireStrictChild(root, quarantine);
    return quarantine;
}

function parsePendingActivation(bytes: Buffer): PendingActivationTransaction {
    const source = bytes.toString('utf8');
    let candidate: unknown;
    try {
        candidate = JSON.parse(source) as unknown;
    } catch {
        throw new RideCodexRuntimeStoreError('Codex pending activation journal is invalid JSON.');
    }
    const record = requireExactRecord(
        candidate,
        PENDING_KEYS,
        'Codex pending activation journal has an invalid shape.'
    );
    if (record.schemaVersion !== 1
        || (record.phase !== 'publishing'
            && record.phase !== 'awaiting-handshake'
            && record.phase !== 'finalizing')
        || typeof record.transactionId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.transactionId)
        || (record.previous !== 'none' && (typeof record.previous !== 'object' || !record.previous))
        || typeof record.stagingRelativePath !== 'string'
        || !/^\.staging-[0-9a-f-]+$/i.test(record.stagingRelativePath)
        || !Array.isArray(record.retention)
        || record.retention.length < 1 || record.retention.length > 2
        || record.retention.some(path => typeof path !== 'string' || !isSafeRelativePath(path as string))) {
        throw new RideCodexRuntimeStoreError('Codex pending activation journal values are invalid.');
    }
    const stagingIdentityRecord = requireExactRecord(
        record.stagingIdentity,
        IDENTITY_KEYS,
        'Codex pending activation staging identity has an invalid shape.'
    );
    const stagingIdentity = Object.freeze({
        dev: stagingIdentityRecord.dev as string,
        ino: stagingIdentityRecord.ino as string,
        size: stagingIdentityRecord.size as string,
        birthtimeNs: stagingIdentityRecord.birthtimeNs as string,
        ctimeNs: stagingIdentityRecord.ctimeNs as string
    });
    const parsedStagingIdentity = deserializeIdentity(stagingIdentity);
    if (parsedStagingIdentity.dev < BigInt(0) || parsedStagingIdentity.ino < BigInt(0)
        || parsedStagingIdentity.size < BigInt(0)) {
        throw new RideCodexRuntimeStoreError('Codex pending activation staging identity is invalid.');
    }
    const pending: PendingActivationTransaction = Object.freeze({
        schemaVersion: 1,
        transactionId: record.transactionId,
        phase: record.phase,
        candidate: parsePointerValue(record.candidate),
        previous: record.previous === 'none' ? 'none' : parsePointerValue(record.previous),
        retention: Object.freeze((record.retention as string[]).slice()),
        stagingRelativePath: record.stagingRelativePath,
        stagingIdentity
    });
    if (pending.previous !== 'none' && activePointersEqual(pending.candidate, pending.previous)) {
        throw new RideCodexRuntimeStoreError('Codex pending activation journal does not change the active runtime.');
    }
    const completeRetention = [
        pending.candidate.relativePath,
        ...(pending.previous === 'none' ? [] : [pending.previous.relativePath])
    ];
    const candidateOnlyRetention = [pending.candidate.relativePath];
    const retentionMatches = (expected: readonly string[]): boolean => pending.retention.length === expected.length
        && pending.retention.every((path, index) => path === expected[index]);
    if (!retentionMatches(completeRetention)
        && !(pending.phase === 'finalizing' && retentionMatches(candidateOnlyRetention))) {
        throw new RideCodexRuntimeStoreError('Codex pending activation retention policy is inconsistent.');
    }
    if (source !== `${JSON.stringify(pending)}\n`) {
        throw new RideCodexRuntimeStoreError('Codex pending activation journal is not canonical JSON.');
    }
    return pending;
}

function parsePointerValue(value: unknown): ActiveRuntimePointer {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    const pointer = parseActivePointer(bytes);
    if (pointer.relativePath !== versionRelativePath(pointer.version, pointer.target, pointer.manifestDigest)
        || pointer.executableRelativePath !== expectedExecutableRelativePath(pointer.target)) {
        throw new RideCodexRuntimeStoreError('Codex pending activation pointer metadata is inconsistent.');
    }
    return pointer;
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

async function deleteExistingQuarantine(candidate: string, root: string, boundary: StoreBoundary): Promise<void> {
    requireStrictChild(root, candidate);
    const entry = relative(root, candidate);
    if (!/^\.install-quarantine-[0-9A-Za-z-]{1,160}$/.test(entry)) {
        throw new RideCodexRuntimeStoreError('Codex runtime quarantine name is invalid.');
    }
    const before = await safeLstat(candidate, 'Codex runtime quarantine is missing.');
    if ((!before.isDirectory() && !before.isFile()) || before.isSymbolicLink()) {
        throw new RideCodexRuntimeStoreError('Codex runtime quarantine contains an unsafe entry.');
    }
    if (!samePath(await safeRealpath(candidate, 'Codex runtime quarantine is unsafe.'), candidate)) {
        throw new RideCodexRuntimeStoreError('Codex runtime quarantine escaped its verified root.');
    }
    await boundary.verify();
    await verifySafeDeletionTree(candidate, root);
    const after = await safeLstat(candidate, 'Codex runtime quarantine changed before deletion.');
    if (!stableObjectIdentityEqual(filesystemIdentity(before), filesystemIdentity(after))) {
        throw new RideCodexRuntimeStoreError('Codex runtime quarantine identity changed before deletion.');
    }
    await fs.rm(candidate, { recursive: before.isDirectory(), force: true });
    await syncDirectory(root);
    await boundary.verify();
}

async function deleteQuarantineWhileAuthorityIsRetained(
    candidate: string,
    root: string,
    boundary: StoreBoundary
): Promise<void> {
    try {
        await deleteExistingQuarantine(candidate, root, boundary);
    } catch (error) {
        if (await pathExists(candidate)) {
            return;
        }
        throw error;
    }
}

async function validateRollbackCandidate(
    candidate: string,
    pointer: ActiveRuntimePointer,
    boundary: StoreBoundary
): Promise<BigIntStats> {
    const stat = await safeLstat(candidate, 'Codex pending candidate runtime is missing.');
    requireRegularDirectory(stat, 'Codex pending candidate runtime is unsafe.');
    if (!samePath(await safeRealpath(candidate, 'Codex pending candidate runtime is unsafe.'), candidate)
        || !stableDirectoryIdentityEqual(filesystemIdentity(stat), deserializeIdentity(pointer.rootIdentity))) {
        throw new RideCodexRuntimeStoreError('Codex pending candidate runtime identity is invalid.');
    }
    await attestRollbackTree(candidate, pointer, boundary);
    const after = await safeLstat(candidate, 'Codex pending candidate runtime changed during validation.');
    if (!stableDirectoryIdentityEqual(filesystemIdentity(stat), filesystemIdentity(after))) {
        throw new RideCodexRuntimeStoreError('Codex pending candidate runtime identity changed during validation.');
    }
    return after;
}

async function validateRollbackQuarantine(
    quarantine: string,
    pointer: ActiveRuntimePointer,
    boundary: StoreBoundary
): Promise<BigIntStats> {
    requireStrictChild(boundary.root, quarantine);
    const entry = relative(boundary.root, quarantine);
    if (!/^\.install-quarantine-candidate-[0-9a-f-]{36}$/.test(entry)) {
        throw new RideCodexRuntimeStoreError('Codex pending candidate quarantine name is invalid.');
    }
    const stat = await safeLstat(quarantine, 'Codex pending candidate quarantine is missing.');
    requireRegularDirectory(stat, 'Codex pending candidate quarantine is unsafe.');
    if (!samePath(await safeRealpath(quarantine, 'Codex pending candidate quarantine is unsafe.'), quarantine)
        || !stableDirectoryIdentityEqual(filesystemIdentity(stat), deserializeIdentity(pointer.rootIdentity))) {
        throw new RideCodexRuntimeStoreError('Codex pending candidate quarantine identity is invalid.');
    }
    await attestRollbackTree(quarantine, pointer, boundary);
    const after = await safeLstat(quarantine, 'Codex pending candidate quarantine changed during validation.');
    if (!stableDirectoryIdentityEqual(filesystemIdentity(stat), filesystemIdentity(after))) {
        throw new RideCodexRuntimeStoreError('Codex pending candidate quarantine changed during validation.');
    }
    return after;
}

async function attestRollbackTree(
    candidate: string,
    pointer: ActiveRuntimePointer,
    boundary: StoreBoundary
): Promise<void> {
    const maximum = Number(parseBoundedBigInt(pointer.treeReadBytes, MAX_RUNTIME_BYTES, 'tree byte count'));
    try {
        await attestPublishedRuntime(candidate, maximum, pointer.treeEntries);
    } catch {
        await verifySafeDeletionTree(candidate, boundary.root);
    }
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

async function validateExistingDirectory(path: string, message: string): Promise<{ path: string; identity: RuntimeFilesystemIdentity; }> {
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

function parseVersionDirectoryName(name: string): { version: string; } | undefined {
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

function optionalPointersEqual(
    left: ActiveRuntimePointer | undefined,
    right: ActiveRuntimePointer | undefined
): boolean {
    return left === undefined || right === undefined
        ? left === right
        : activePointersEqual(left, right);
}

function pendingActivationsEqual(
    left: PendingActivationTransaction,
    right: PendingActivationTransaction
): boolean {
    return left.schemaVersion === right.schemaVersion
        && left.transactionId === right.transactionId
        && left.phase === right.phase
        && activePointersEqual(left.candidate, right.candidate)
        && left.stagingRelativePath === right.stagingRelativePath
        && serializedIdentitiesEqual(left.stagingIdentity, right.stagingIdentity)
        && left.retention.length === right.retention.length
        && left.retention.every((path, index) => path === right.retention[index])
        && (left.previous === 'none' || right.previous === 'none'
            ? left.previous === right.previous
            : activePointersEqual(left.previous, right.previous));
}

function activePointersEqual(left: ActiveRuntimePointer, right: ActiveRuntimePointer): boolean {
    return left.schemaVersion === right.schemaVersion
        && left.version === right.version
        && left.target === right.target
        && left.manifestDigest === right.manifestDigest
        && left.relativePath === right.relativePath
        && left.executableRelativePath === right.executableRelativePath
        && left.treeDigest === right.treeDigest
        && left.treeEntries === right.treeEntries
        && left.treeReadBytes === right.treeReadBytes
        && left.treePathBytes === right.treePathBytes
        && left.rootIdentity.dev === right.rootIdentity.dev
        && left.rootIdentity.ino === right.rootIdentity.ino
        && left.rootIdentity.size === right.rootIdentity.size
        && left.rootIdentity.birthtimeNs === right.rootIdentity.birthtimeNs
        && left.rootIdentity.ctimeNs === right.rootIdentity.ctimeNs;
}

function serializedIdentitiesEqual(left: SerializedRuntimeIdentity, right: SerializedRuntimeIdentity): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.birthtimeNs === right.birthtimeNs
        && left.ctimeNs === right.ctimeNs;
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
        if (!isUnsupportedDirectorySyncError(code)) {
            throw error;
        }
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

function isUnsupportedDirectorySyncError(code: string | undefined): boolean {
    return ['EINVAL', 'EISDIR', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '')
        || (process.platform === 'win32' && code === 'EPERM');
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

function installPresentationsEqual(left: InstallPresentation, right: InstallPresentation): boolean {
    return left.source === right.source
        && left.version === right.version
        && left.target === right.target
        && left.urlOrigin === right.urlOrigin
        && samePath(left.installRoot, right.installRoot)
        && left.requiredSpaceBytes === right.requiredSpaceBytes
        && left.rollbackPolicy === right.rollbackPolicy
        && left.manifestDigest === right.manifestDigest;
}

function pathKey(path: string): string {
    return process.platform === 'win32' ? path.toLowerCase() : path;
}

function isNetworkPath(path: string): boolean {
    return path.startsWith('\\\\') || path.startsWith('//');
}
