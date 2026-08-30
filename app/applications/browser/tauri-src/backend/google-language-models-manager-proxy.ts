// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import type {
    GoogleLanguageModelsManager,
    GoogleModelDescription
} from '@theia/ai-google/lib/common/google-language-models-manager';
import { RootContainer } from '@theia/core/lib/node/backend-application';
import type { Container } from '@theia/core/shared/inversify';
import { inject, injectable, preDestroy } from '@theia/core/shared/inversify';

interface GoogleFeature {
    createGoogleLanguageModelsManager(rootContainer: Container, ensureActive: () => void): GoogleLanguageModelsManager;
}

const googleFeatureModule = './google-language-models-manager-feature.cjs';

async function loadGoogleFeature(): Promise<GoogleFeature> {
    const featureRequest = googleFeatureModule;
    return import(featureRequest) as Promise<GoogleFeature>;
}

export class GoogleLanguageModelsManagerImpl implements GoogleLanguageModelsManager {
    protected readonly loadFeature = loadGoogleFeature;
    protected readonly rootContainer!: Container;
    protected delegate: GoogleLanguageModelsManager | undefined;
    protected activation: Promise<GoogleLanguageModelsManager> | undefined;
    protected apiKeyValue: string | undefined;
    protected maxRetriesOnErrors = 3;
    protected retryDelayOnRateLimitError = 60;
    protected retryDelayOnOtherErrors = -1;
    protected disposed = false;

    get apiKey(): string | undefined {
        return this.apiKeyValue ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
    }

    setApiKey(apiKey: string | undefined): void {
        this.apiKeyValue = apiKey || undefined;
        this.delegate?.setApiKey(apiKey);
    }

    setMaxRetriesOnErrors(maxRetries: number): void {
        this.maxRetriesOnErrors = maxRetries;
        this.delegate?.setMaxRetriesOnErrors(maxRetries);
    }

    setRetryDelayOnRateLimitError(retryDelay: number): void {
        this.retryDelayOnRateLimitError = retryDelay;
        this.delegate?.setRetryDelayOnRateLimitError(retryDelay);
    }

    setRetryDelayOnOtherErrors(retryDelay: number): void {
        this.retryDelayOnOtherErrors = retryDelay;
        this.delegate?.setRetryDelayOnOtherErrors(retryDelay);
    }

    async createOrUpdateLanguageModels(...modelDescriptions: GoogleModelDescription[]): Promise<void> {
        if (modelDescriptions.length === 0) {
            return;
        }
        const delegate = await this.activate();
        await delegate.createOrUpdateLanguageModels(...modelDescriptions);
    }

    removeLanguageModels(...modelIds: string[]): void {
        if (modelIds.length === 0) {
            return;
        }
        this.delegate?.removeLanguageModels(...modelIds);
    }

    protected activate(): Promise<GoogleLanguageModelsManager> {
        if (this.disposed) {
            return Promise.reject(new Error('Google language models manager proxy is disposed.'));
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

    protected async createDelegate(): Promise<GoogleLanguageModelsManager> {
        this.ensureNotDisposed();
        const feature = await this.loadFeature();
        this.ensureNotDisposed();
        const candidate = feature.createGoogleLanguageModelsManager(
            this.rootContainer,
            () => this.ensureNotDisposed()
        );
        this.ensureNotDisposed();
        candidate.setApiKey(this.apiKeyValue);
        candidate.setMaxRetriesOnErrors(this.maxRetriesOnErrors);
        candidate.setRetryDelayOnRateLimitError(this.retryDelayOnRateLimitError);
        candidate.setRetryDelayOnOtherErrors(this.retryDelayOnOtherErrors);
        this.ensureNotDisposed();
        this.delegate = candidate;
        return candidate;
    }

    protected clearActivation(activation: Promise<GoogleLanguageModelsManager>): void {
        if (this.activation === activation) {
            this.activation = undefined;
        }
    }

    protected ensureNotDisposed(): void {
        if (this.disposed) {
            throw new Error('Google language models manager proxy is disposed.');
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

injectable()(GoogleLanguageModelsManagerImpl);
inject(RootContainer)(GoogleLanguageModelsManagerImpl.prototype, 'rootContainer');
preDestroy()(GoogleLanguageModelsManagerImpl.prototype, 'dispose');
