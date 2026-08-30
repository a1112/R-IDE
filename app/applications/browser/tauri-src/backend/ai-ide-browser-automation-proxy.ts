// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import type {
    BrowserAutomation,
    BrowserAutomationClient,
    LaunchResult
} from '@theia/ai-ide/lib/common/browser-automation-protocol';
import { RootContainer } from '@theia/core/lib/node/backend-application';
import type { Container } from '@theia/core/shared/inversify';
import { inject, injectable, preDestroy } from '@theia/core/shared/inversify';

interface BrowserAutomationDelegate extends BrowserAutomation {
    setClient(client: BrowserAutomationClient | undefined): void;
    getClient?(): BrowserAutomationClient | undefined;
    dispose(): void;
}

interface BrowserAutomationFeature {
    createBrowserAutomation(rootContainer: Container, ensureActive: () => void): BrowserAutomationDelegate;
}

const browserAutomationFeatureModule = './ai-ide-browser-automation-feature.cjs';

async function loadBrowserAutomationFeature(): Promise<BrowserAutomationFeature> {
    const featureRequest = browserAutomationFeatureModule;
    return import(featureRequest) as Promise<BrowserAutomationFeature>;
}

export class BrowserAutomationImpl implements BrowserAutomation {
    protected readonly loadFeature = loadBrowserAutomationFeature;
    protected readonly rootContainer!: Container;
    protected delegate: BrowserAutomationDelegate | undefined;
    protected activation: Promise<BrowserAutomationDelegate> | undefined;
    protected client: BrowserAutomationClient | undefined;
    protected disposed = false;

    async isRunning(): Promise<boolean> {
        return this.delegate?.isRunning() ?? false;
    }

    async launch(remoteDebuggingPort: number): Promise<LaunchResult | undefined> {
        return (await this.activate()).launch(remoteDebuggingPort);
    }

    async close(): Promise<void> {
        const delegate = this.delegate;
        if (delegate) {
            await delegate.close();
            return;
        }
        const activation = this.activation;
        if (!activation) {
            return;
        }
        let activatingDelegate: BrowserAutomationDelegate;
        try {
            activatingDelegate = await activation;
        } catch {
            return;
        }
        await activatingDelegate.close();
    }

    async queryDom(selector?: string): Promise<string> {
        return (await this.activate()).queryDom(selector);
    }

    setClient(client: BrowserAutomationClient | undefined): void {
        this.client = client;
        this.delegate?.setClient(client);
    }

    getClient(): BrowserAutomationClient | undefined {
        return this.delegate?.getClient?.() ?? this.client;
    }

    protected activate(): Promise<BrowserAutomationDelegate> {
        if (this.disposed) {
            return Promise.reject(new Error('Browser automation proxy is disposed.'));
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

    protected async createDelegate(): Promise<BrowserAutomationDelegate> {
        this.ensureNotDisposed();
        const feature = await this.loadFeature();
        this.ensureNotDisposed();
        let candidate: BrowserAutomationDelegate | undefined;
        try {
            candidate = feature.createBrowserAutomation(
                this.rootContainer,
                () => this.ensureNotDisposed()
            );
            this.ensureNotDisposed();
            candidate.setClient(this.client);
            this.ensureNotDisposed();
            this.delegate = candidate;
            return candidate;
        } catch (error) {
            try {
                candidate?.dispose();
            } catch {
                // Preserve the activation failure while still making a best-effort cleanup attempt.
            }
            throw error;
        }
    }

    protected clearActivation(activation: Promise<BrowserAutomationDelegate>): void {
        if (this.activation === activation) {
            this.activation = undefined;
        }
    }

    protected ensureNotDisposed(): void {
        if (this.disposed) {
            throw new Error('Browser automation proxy is disposed.');
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        const delegate = this.delegate;
        this.delegate = undefined;
        this.activation = undefined;
        delegate?.dispose();
    }
}

injectable()(BrowserAutomationImpl);
inject(RootContainer)(BrowserAutomationImpl.prototype, 'rootContainer');
preDestroy()(BrowserAutomationImpl.prototype, 'dispose');
