// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import type { ScanOSSResult, ScanOSSService } from '@theia/scanoss/lib/common';
import { RootContainer } from '@theia/core/lib/node/backend-application';
import type { Container } from '@theia/core/shared/inversify';
import { inject, injectable, preDestroy } from '@theia/core/shared/inversify';

interface ScanOSSFeature {
    createScanOSSService(rootContainer: Container, ensureActive: () => void): ScanOSSService;
}

const scanOSSFeatureModule = './scanoss-service-feature.cjs';
const scanOSSUnavailableResult: ScanOSSResult = Object.freeze({
    type: 'error',
    message: 'ScanOSS runtime is unavailable.'
});

async function loadScanOSSFeature(): Promise<ScanOSSFeature> {
    const featureRequest = scanOSSFeatureModule;
    return import(featureRequest) as Promise<ScanOSSFeature>;
}

export class ScanOSSServiceImpl implements ScanOSSService {
    protected readonly loadFeature = loadScanOSSFeature;
    protected readonly rootContainer!: Container;
    protected delegate: ScanOSSService | undefined;
    protected activation: Promise<ScanOSSService> | undefined;
    protected disposed = false;

    async scanContent(content: string, apiKey?: string): Promise<ScanOSSResult> {
        const activeDelegate = this.delegate;
        if (activeDelegate) {
            return activeDelegate.scanContent(content, apiKey);
        }
        let delegate: ScanOSSService;
        try {
            delegate = await this.activate();
        } catch {
            return scanOSSUnavailableResult;
        }
        return delegate.scanContent(content, apiKey);
    }

    protected activate(): Promise<ScanOSSService> {
        if (this.disposed) {
            return Promise.reject(new Error('ScanOSS service proxy is disposed.'));
        }
        if (this.delegate) {
            return Promise.resolve(this.delegate);
        }
        if (this.activation) {
            return this.activation;
        }
        const activation = this.createDelegate();
        this.activation = activation;
        void activation.then(
            () => this.clearActivation(activation),
            () => this.clearActivation(activation)
        );
        return activation;
    }

    protected async createDelegate(): Promise<ScanOSSService> {
        this.ensureNotDisposed();
        const feature = await this.loadFeature();
        this.ensureNotDisposed();
        const candidate = feature.createScanOSSService(
            this.rootContainer,
            () => this.ensureNotDisposed()
        );
        this.ensureNotDisposed();
        this.delegate = candidate;
        return candidate;
    }

    protected clearActivation(activation: Promise<ScanOSSService>): void {
        if (this.activation === activation) {
            this.activation = undefined;
        }
    }

    protected ensureNotDisposed(): void {
        if (this.disposed) {
            throw new Error('ScanOSS service proxy is disposed.');
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.delegate = undefined;
        this.activation = undefined;
    }
}

injectable()(ScanOSSServiceImpl);
inject(RootContainer)(ScanOSSServiceImpl.prototype, 'rootContainer');
preDestroy()(ScanOSSServiceImpl.prototype, 'dispose');
