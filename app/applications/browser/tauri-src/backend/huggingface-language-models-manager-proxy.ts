// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import type {
    HuggingFaceLanguageModelsManager,
    HuggingFaceModelDescription
} from '@theia/ai-huggingface/lib/common/huggingface-language-models-manager';
import { RootContainer } from '@theia/core/lib/node/backend-application';
import type { Container } from '@theia/core/shared/inversify';
import { inject, injectable, preDestroy } from '@theia/core/shared/inversify';

interface HuggingFaceFeature {
    createHuggingFaceLanguageModelsManager(rootContainer: Container, ensureActive: () => void): HuggingFaceLanguageModelsManager;
}

const huggingFaceFeatureModule = './huggingface-language-models-manager-feature.cjs';

async function loadHuggingFaceFeature(): Promise<HuggingFaceFeature> {
    const featureRequest = huggingFaceFeatureModule;
    return import(featureRequest) as Promise<HuggingFaceFeature>;
}

export class HuggingFaceLanguageModelsManagerImpl implements HuggingFaceLanguageModelsManager {
    protected readonly loadFeature = loadHuggingFaceFeature;
    protected readonly rootContainer!: Container;
    protected delegate: HuggingFaceLanguageModelsManager | undefined;
    protected activation: Promise<HuggingFaceLanguageModelsManager> | undefined;
    protected apiKeyValue: string | undefined;
    protected proxyUrlValue: string | undefined;
    protected disposed = false;

    get apiKey(): string | undefined {
        return this.apiKeyValue ?? process.env.HUGGINGFACE_API_KEY;
    }

    setApiKey(apiKey: string | undefined): void {
        this.apiKeyValue = apiKey || undefined;
        this.delegate?.setApiKey(apiKey);
    }

    setProxyUrl(proxyUrl: string | undefined): void {
        this.proxyUrlValue = proxyUrl || undefined;
        this.delegate?.setProxyUrl(proxyUrl);
    }

    async createOrUpdateLanguageModels(...modelDescriptions: HuggingFaceModelDescription[]): Promise<void> {
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

    protected activate(): Promise<HuggingFaceLanguageModelsManager> {
        if (this.disposed) {
            return Promise.reject(new Error('Hugging Face language models manager proxy is disposed.'));
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

    protected async createDelegate(): Promise<HuggingFaceLanguageModelsManager> {
        this.ensureNotDisposed();
        const feature = await this.loadFeature();
        this.ensureNotDisposed();
        const candidate = feature.createHuggingFaceLanguageModelsManager(
            this.rootContainer,
            () => this.ensureNotDisposed()
        );
        this.ensureNotDisposed();
        candidate.setApiKey(this.apiKeyValue);
        candidate.setProxyUrl(this.proxyUrlValue);
        this.ensureNotDisposed();
        this.delegate = candidate;
        return candidate;
    }

    protected clearActivation(activation: Promise<HuggingFaceLanguageModelsManager>): void {
        if (this.activation === activation) {
            this.activation = undefined;
        }
    }

    protected ensureNotDisposed(): void {
        if (this.disposed) {
            throw new Error('Hugging Face language models manager proxy is disposed.');
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

injectable()(HuggingFaceLanguageModelsManagerImpl);
inject(RootContainer)(HuggingFaceLanguageModelsManagerImpl.prototype, 'rootContainer');
preDestroy()(HuggingFaceLanguageModelsManagerImpl.prototype, 'dispose');
