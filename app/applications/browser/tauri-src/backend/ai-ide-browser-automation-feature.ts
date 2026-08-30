// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import type { BrowserAutomationClient } from '@theia/ai-ide/lib/common/browser-automation-protocol';
import { BrowserAutomationImpl } from '@theia/ai-ide/lib/node/app-tester-agent/browser-automation-impl';
import type { Container } from '@theia/core/shared/inversify';

interface BrowserAutomationDelegate extends BrowserAutomationImpl {
    setClient(client: BrowserAutomationClient | undefined): void;
    dispose(): void;
}

export function createBrowserAutomation(
    rootContainer: Container,
    ensureActive: () => void
): BrowserAutomationDelegate {
    ensureActive();
    const child = rootContainer.createChild();
    ensureActive();
    child.bind(BrowserAutomationImpl).toSelf().inSingletonScope();
    ensureActive();
    return child.get(BrowserAutomationImpl);
}
