/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { resolve } from 'node:path';
import {
    createRideCodexInstallDiagnostic,
    createRideCodexInstallProgress,
    InstallDiagnostic,
    InstallPresentation,
    InstallProgress,
    InstallResult
} from '../common/ride-codex-installation';
import {
    createRideCodexRuntimeInstallPresentation,
    InstallConsentToken,
    RideCodexInstallConsent,
    RideCodexInstallConsentError
} from './ride-codex-install-consent';
import { InstallAuthorization } from './ride-codex-runtime-fetcher';
import { RuntimeTarget, runtimeManifestEntryForTarget } from './ride-codex-runtime-manifest';
import {
    PublishedManagedRuntime,
    RideCodexRuntimeStore,
    ValidatedManagedRuntime
} from './ride-codex-runtime-store';
import { StagedRuntime } from './ride-codex-runtime-stager';

export interface RideCodexRuntimeStagerLike {
    stage(
        authorization: InstallAuthorization,
        target: RuntimeTarget,
        presentation: InstallPresentation
    ): Promise<StagedRuntime>;
}

export interface RideCodexManagedInstallOptions {
    readonly failHandshake?: boolean;
}

export interface RideCodexManagedHandshakeOptions {
    readonly failHandshake: boolean;
}

export type RideCodexManagedHandshake = (
    runtime: PublishedManagedRuntime,
    options: RideCodexManagedHandshakeOptions
) => Promise<void>;

export interface RideCodexRuntimeResolverInvalidator {
    invalidate(): void;
}

export interface RideCodexManagedInstallerOptions {
    readonly consent: RideCodexInstallConsent;
    readonly store: RideCodexRuntimeStore;
    readonly stager: RideCodexRuntimeStagerLike;
    readonly handshake: RideCodexManagedHandshake;
    readonly resolver?: RideCodexRuntimeResolverInvalidator;
    readonly onProgress?: (progress: InstallProgress) => void;
    readonly validatePresentation?: (presentation: InstallPresentation) => boolean;
}

export class RideCodexManagedInstallError extends Error {
    readonly diagnostics: readonly InstallDiagnostic[];

    constructor(diagnostics: readonly InstallDiagnostic[]) {
        const safeDiagnostics = Object.freeze(diagnostics.slice(0, 4).map(diagnostic => Object.freeze({ ...diagnostic })));
        super(safeDiagnostics.map(diagnostic => diagnostic.message).join(' ') || 'Codex managed runtime installation failed safely.');
        this.name = 'RideCodexManagedInstallError';
        this.diagnostics = safeDiagnostics;
    }
}

export class RideCodexManagedInstaller {
    private readonly consent: RideCodexInstallConsent;
    private readonly store: RideCodexRuntimeStore;
    private readonly stager: RideCodexRuntimeStagerLike;
    private readonly handshake: RideCodexManagedHandshake;
    private readonly resolver?: RideCodexRuntimeResolverInvalidator;
    private readonly onProgress?: (progress: InstallProgress) => void;
    private readonly validatePresentation: (presentation: InstallPresentation) => boolean;

    constructor(options: RideCodexManagedInstallerOptions) {
        this.consent = options.consent;
        this.store = options.store;
        this.stager = options.stager;
        this.handshake = options.handshake;
        this.resolver = options.resolver;
        this.onProgress = options.onProgress;
        this.validatePresentation = options.validatePresentation ?? (presentation => {
            const expected = createRideCodexRuntimeInstallPresentation(
                runtimeManifestEntryForTarget(presentation.target as RuntimeTarget),
                this.store.installRoot
            );
            return presentationsEqual(presentation, expected);
        });
    }

    async install(
        token: InstallConsentToken | undefined,
        options: RideCodexManagedInstallOptions = {}
    ): Promise<InstallResult> {
        // This synchronous consume is deliberately the first operation: no lock, statfs,
        // recovery, network access, or staging is reachable before the one-shot token is spent.
        const consumed = this.consent.consume(token);
        const presentation = consumed.presentation;
        if (!samePath(presentation.installRoot, this.store.installRoot)) {
            throw new RideCodexInstallConsentError('Codex install consent does not match this managed runtime root.');
        }
        try {
            if (!this.validatePresentation(presentation)) {
                throw new Error('mismatch');
            }
        } catch {
            throw new RideCodexInstallConsentError(
                'Codex install consent does not match the reviewed runtime manifest.'
            );
        }
        return this.store.withTransaction(async () => {
            let sequence = 0;
            let staged: StagedRuntime | undefined;
            let published: PublishedManagedRuntime | undefined;
            let previous: ValidatedManagedRuntime | undefined;
            let activated = false;
            const progress = (state: InstallProgress['state']): void => {
                const update = createRideCodexInstallProgress(state, presentation, sequence++);
                try {
                    this.onProgress?.(update);
                } catch {
                    // UI observers cannot influence the installation transaction.
                }
            };

            try {
                await this.store.recover();
                progress('downloading');
                staged = await this.stager.stage(
                    consumed.authorization,
                    presentation.target as RuntimeTarget,
                    presentation
                );
                progress('verifying');
                await staged.revalidate();
                previous = await this.store.readActiveRuntime();
                published = await this.store.publish(staged, presentation);
                progress('activating');
                try {
                    await this.store.activate(published, previous);
                    activated = true;
                } catch (error) {
                    const committed = await this.store.readActiveRuntime().catch(() => undefined);
                    if (committed?.relativePath !== published.relativePath) {
                        throw error;
                    }
                    activated = true;
                }
                this.safeInvalidateResolver();
            } catch {
                if (published && !activated) {
                    await this.store.discard(published).catch(() => undefined);
                } else if (staged && !published) {
                    await this.store.recover().catch(() => undefined);
                }
                progress('failed');
                throw new RideCodexManagedInstallError([
                    createRideCodexInstallDiagnostic('activation-failed', 'Codex runtime activation failed safely.')
                ]);
            }

            try {
                await this.handshake(published!, Object.freeze({ failHandshake: options.failHandshake === true }));
            } catch {
                const diagnostics: InstallDiagnostic[] = [
                    createRideCodexInstallDiagnostic('handshake-failed', 'Codex App Server handshake failed.')
                ];
                let restored = false;
                try {
                    await this.store.restore(previous, published!);
                    restored = true;
                    this.safeInvalidateResolver();
                    progress('rolled-back');
                } catch {
                    const current = await this.store.readActiveRuntime().catch(() => undefined);
                    restored = previous
                        ? current?.relativePath === previous.relativePath
                        : current === undefined;
                    if (restored) {
                        this.safeInvalidateResolver();
                        progress('rolled-back');
                    } else {
                        diagnostics.push(createRideCodexInstallDiagnostic(
                            'rollback-failed',
                            'Codex runtime rollback also failed; the active pointer requires safe recovery.'
                        ));
                    }
                }
                if (restored) {
                    await this.store.discard(published!).catch(() => {
                        diagnostics.push(createRideCodexInstallDiagnostic(
                            'cleanup-failed',
                            'The failed Codex runtime was isolated but could not be removed.'
                        ));
                    });
                }
                progress('failed');
                throw new RideCodexManagedInstallError(diagnostics);
            }

            const retainedPrevious = previous
                ? await this.store.revalidate(previous).catch(() => undefined)
                : undefined;
            const readyDiagnostics: InstallDiagnostic[] = [];
            await this.store.cleanupObsolete(new Set([
                published!.relativePath,
                ...(retainedPrevious ? [retainedPrevious.relativePath] : [])
            ])).catch(() => {
                readyDiagnostics.push(createRideCodexInstallDiagnostic(
                    'cleanup-deferred',
                    'Codex runtime is ready, but obsolete runtime cleanup was deferred safely.'
                ));
            });
            progress('ready');
            return Object.freeze({
                state: 'ready' as const,
                version: published!.version,
                target: presentation.target,
                executable: published!.executable,
                ...(retainedPrevious ? { previousVersion: retainedPrevious.version } : {}),
                diagnostics: Object.freeze(readyDiagnostics)
            });
        });
    }

    private safeInvalidateResolver(): void {
        try {
            this.resolver?.invalidate();
        } catch {
            // Cache invalidation is best-effort; active.json remains the source of truth.
        }
    }
}

function samePath(left: string, right: string): boolean {
    const normalizedLeft = resolve(left);
    const normalizedRight = resolve(right);
    return process.platform === 'win32'
        ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
        : normalizedLeft === normalizedRight;
}

function presentationsEqual(left: InstallPresentation, right: InstallPresentation): boolean {
    return left.source === right.source
        && left.version === right.version
        && left.target === right.target
        && left.urlOrigin === right.urlOrigin
        && samePath(left.installRoot, right.installRoot)
        && left.requiredSpaceBytes === right.requiredSpaceBytes
        && left.rollbackPolicy === right.rollbackPolicy
        && left.manifestDigest === right.manifestDigest;
}
