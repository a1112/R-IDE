// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import type { Container } from '@theia/core/shared/inversify';
import { BrowserAutomationImpl } from '@theia/ai-ide/lib/node/app-tester-agent/browser-automation-impl';

export function createBrowserAutomation(parentContainer: Container): BrowserAutomationImpl {
    const child = parentContainer.createChild();
    child.bind(BrowserAutomationImpl).toSelf().inSingletonScope();
    return child.get(BrowserAutomationImpl);
}
