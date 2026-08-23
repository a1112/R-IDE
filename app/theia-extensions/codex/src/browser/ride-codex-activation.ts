/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';

export type RideCodexActivationState = 'inactive' | 'activating' | 'ready' | 'error';

export interface RideCodexFeature {
    activate(): Promise<void>;
    dispose?(): void;
}

export class RideCodexActivation implements FrontendApplicationContribution {
    protected stateValue: RideCodexActivationState = 'inactive';
    protected activation: Promise<void> | undefined;
    protected error: unknown;
    protected feature: RideCodexFeature | undefined;
    protected disposed = false;
    protected readonly disposedFeatures = new WeakSet<RideCodexFeature>();
    protected readonly disposedError = new Error('Codex activation has been disposed.');

    constructor(protected readonly loadFeature: () => Promise<RideCodexFeature>) { }

    get state(): RideCodexActivationState {
        return this.stateValue;
    }

    activate(): Promise<void> {
        if (this.disposed) {
            return Promise.reject(this.disposedError);
        }
        if (this.stateValue === 'ready') {
            return Promise.resolve();
        }
        if (this.stateValue === 'error') {
            return Promise.reject(this.error);
        }
        if (this.activation) {
            return this.activation;
        }
        this.stateValue = 'activating';
        this.activation = this.doActivate();
        return this.activation;
    }

    protected async doActivate(): Promise<void> {
        let feature: RideCodexFeature | undefined;
        try {
            feature = await this.loadFeature();
            this.feature = feature;
            this.throwIfDisposed(feature);
            await feature.activate();
            this.throwIfDisposed(feature);
            this.stateValue = 'ready';
        } catch (error) {
            if (feature) {
                this.disposeFeature(feature);
            }
            const failure = this.disposed ? this.disposedError : error;
            this.error = failure;
            this.stateValue = 'error';
            throw failure;
        }
    }

    protected throwIfDisposed(feature: RideCodexFeature): void {
        if (this.disposed) {
            this.disposeFeature(feature);
            throw this.disposedError;
        }
    }

    retry(): Promise<void> {
        if (this.disposed) {
            return Promise.reject(this.disposedError);
        }
        if (this.stateValue !== 'error') {
            return this.activate();
        }
        this.activation = undefined;
        this.error = undefined;
        this.stateValue = 'inactive';
        return this.activate();
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (this.feature) {
            this.disposeFeature(this.feature);
        }
    }

    onStop(): void {
        this.dispose();
    }

    protected disposeFeature(feature: RideCodexFeature): void {
        if (this.feature === feature) {
            this.feature = undefined;
        }
        if (this.disposedFeatures.has(feature)) {
            return;
        }
        this.disposedFeatures.add(feature);
        try {
            feature.dispose?.();
        } catch (error) {
            console.error('[R-IDE] Failed to dispose Codex feature.', error);
        }
    }
}
