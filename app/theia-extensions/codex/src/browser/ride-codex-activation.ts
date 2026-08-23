/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export type RideCodexActivationState = 'inactive' | 'activating' | 'ready' | 'error';

export interface RideCodexFeature {
    activate(): Promise<void>;
    dispose?(): void;
}

export class RideCodexActivation {
    protected stateValue: RideCodexActivationState = 'inactive';
    protected activation: Promise<void> | undefined;
    protected error: unknown;
    protected feature: RideCodexFeature | undefined;
    protected disposed = false;

    constructor(protected readonly loadFeature: () => Promise<RideCodexFeature>) { }

    get state(): RideCodexActivationState {
        return this.stateValue;
    }

    activate(): Promise<void> {
        if (this.disposed) {
            return Promise.reject(new Error('Codex activation has been disposed.'));
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
        this.activation = this.loadFeature()
            .then(feature => {
                this.feature = feature;
                return feature.activate();
            })
            .then(() => {
                this.stateValue = 'ready';
            })
            .catch(error => {
                this.error = error;
                this.stateValue = 'error';
                throw error;
            });
        return this.activation;
    }

    retry(): Promise<void> {
        if (this.disposed) {
            return Promise.reject(new Error('Codex activation has been disposed.'));
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
        this.feature?.dispose?.();
    }
}
