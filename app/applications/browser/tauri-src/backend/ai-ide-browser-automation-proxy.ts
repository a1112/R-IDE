// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import type { BrowserAutomation, BrowserAutomationClient, LaunchResult } from '@theia/ai-ide/lib/common/browser-automation-protocol';
import { Container, injectable } from '@theia/core/shared/inversify';

interface BrowserAutomationDelegate extends BrowserAutomation {
    dispose(): void;
    setClient(client: BrowserAutomationClient | undefined): void;
    getClient?(): BrowserAutomationClient | undefined;
}

interface BrowserAutomationFeature {
    createBrowserAutomation(parentContainer: Container): BrowserAutomationDelegate;
}

const browserAutomationFeatureModule = './ai-ide-browser-automation-feature.cjs';

@injectable()
export class BrowserAutomationImpl implements BrowserAutomationDelegate {
    protected readonly parentContainer = new Container();
    protected delegate: BrowserAutomationDelegate | undefined;
    protected client: BrowserAutomationClient | undefined;

    protected async activate(): Promise<BrowserAutomationDelegate> {
        if (this.delegate) {
            return this.delegate;
        }
        const featureRequest = browserAutomationFeatureModule;
        const feature = await import(featureRequest) as BrowserAutomationFeature;
        const delegate = feature.createBrowserAutomation(this.parentContainer);
        delegate.setClient(this.client);
        this.delegate = delegate;
        return delegate;
    }

    async launch(remoteDebuggingPort: number): Promise<LaunchResult | undefined> {
        return (await this.activate()).launch(remoteDebuggingPort);
    }

    async isRunning(): Promise<boolean> {
        return this.delegate ? this.delegate.isRunning() : false;
    }

    async queryDom(selector?: string): Promise<string> {
        return (await this.activate()).queryDom(selector);
    }

    async close(): Promise<void> {
        await this.delegate?.close();
    }

    dispose(): void {
        this.delegate?.dispose();
        this.delegate = undefined;
    }

    setClient(client: BrowserAutomationClient | undefined): void {
        this.client = client;
        this.delegate?.setClient(client);
    }

    getClient(): BrowserAutomationClient | undefined {
        return this.client;
    }
}
