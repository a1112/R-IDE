// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import type { BrowserAutomation, BrowserAutomationClient, LaunchResult } from '@theia/ai-ide/lib/common/browser-automation-protocol';
import { Container, injectable, preDestroy } from '@theia/core/shared/inversify';

interface BrowserAutomationDelegate extends BrowserAutomation {
    dispose(): void;
    setClient(client: BrowserAutomationClient | undefined): void;
    getClient?(): BrowserAutomationClient | undefined;
}

interface BrowserAutomationFeature {
    createBrowserAutomation(parentContainer: Container): BrowserAutomationDelegate;
}

const browserAutomationFeatureModule = './ai-ide-browser-automation-feature.cjs';

async function loadBrowserAutomationFeature(): Promise<BrowserAutomationFeature> {
    const featureRequest = browserAutomationFeatureModule;
    return import(featureRequest) as Promise<BrowserAutomationFeature>;
}

class BrowserAutomationDisposedError extends Error {
    constructor() {
        super('Browser automation proxy is disposed.');
    }
}

function disposedError(): Error {
    return pathFreeError(new BrowserAutomationDisposedError());
}

function pathFreeError<T extends Error>(error: T): T {
    error.stack = `${error.name}: ${error.message}`;
    return error;
}

function activationError(): Error {
    // Build paths from dynamic import or construction failures are deliberately
    // omitted. Operation errors from the real upstream delegate are forwarded
    // unchanged after activation succeeds.
    return pathFreeError(new Error('Failed to activate browser automation runtime.'));
}

export class BrowserAutomationImpl implements BrowserAutomationDelegate {
    protected readonly loadFeature = loadBrowserAutomationFeature;
    protected readonly parentContainer = new Container();
    protected delegate: BrowserAutomationDelegate | undefined;
    protected activation: Promise<BrowserAutomationDelegate> | undefined;
    protected client: BrowserAutomationClient | undefined;
    protected disposed = false;

    protected activate(): Promise<BrowserAutomationDelegate> {
        if (this.disposed) {
            return Promise.reject(disposedError());
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
            () => {
                if (this.activation === activation) {
                    this.activation = undefined;
                }
            },
            () => {
                if (this.activation === activation) {
                    this.activation = undefined;
                }
            },
        );
        return activation;
    }

    protected async createDelegate(): Promise<BrowserAutomationDelegate> {
        let candidate: BrowserAutomationDelegate | undefined;
        try {
            const feature = await this.loadFeature();
            if (this.disposed) {
                throw disposedError();
            }
            candidate = feature.createBrowserAutomation(this.parentContainer);
            if (this.disposed) {
                const stale = candidate;
                candidate = undefined;
                stale.dispose();
                throw disposedError();
            }
            candidate.setClient(this.client);
            if (this.disposed) {
                const stale = candidate;
                candidate = undefined;
                stale.dispose();
                throw disposedError();
            }
            this.delegate = candidate;
            return candidate;
        } catch (error) {
            if (candidate && candidate !== this.delegate) {
                try {
                    candidate.dispose();
                } catch {
                    // Activation failed before ownership was published. Keep the
                    // public failure deterministic and free of local diagnostics.
                }
            }
            if (this.disposed || error instanceof BrowserAutomationDisposedError) {
                throw disposedError();
            }
            throw activationError();
        }
    }

    protected ensureActive(): void {
        if (this.disposed) {
            throw disposedError();
        }
    }

    async launch(remoteDebuggingPort: number): Promise<LaunchResult | undefined> {
        const delegate = await this.activate();
        this.ensureActive();
        return delegate.launch(remoteDebuggingPort);
    }

    async isRunning(): Promise<boolean> {
        return this.delegate ? this.delegate.isRunning() : false;
    }

    async queryDom(selector?: string): Promise<string> {
        const delegate = await this.activate();
        this.ensureActive();
        return delegate.queryDom(selector);
    }

    async close(): Promise<void> {
        await this.delegate?.close();
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        const delegate = this.delegate;
        this.delegate = undefined;
        delegate?.dispose();
    }

    setClient(client: BrowserAutomationClient | undefined): void {
        this.client = client;
        this.delegate?.setClient(client);
    }

    getClient(): BrowserAutomationClient | undefined {
        return this.client;
    }
}

// The generated backend build intentionally avoids decorator syntax entirely.
// Register metadata through Inversify's decorator functions so the emitted CJS
// stays executable and unbindAllAsync() cancels pending activation.
injectable()(BrowserAutomationImpl);
preDestroy()(BrowserAutomationImpl.prototype, 'dispose');
