// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import type { GoogleLanguageModelsManager } from '@theia/ai-google/lib/common/google-language-models-manager';
import { GoogleLanguageModelsManagerImpl } from '@theia/ai-google/lib/node/google-language-models-manager-impl';
import type { Container } from '@theia/core/shared/inversify';

export function createGoogleLanguageModelsManager(
    rootContainer: Container,
    ensureActive: () => void
): GoogleLanguageModelsManager {
    ensureActive();
    const child = rootContainer.createChild();
    ensureActive();
    child.bind(GoogleLanguageModelsManagerImpl).toSelf().inSingletonScope();
    ensureActive();
    return child.get(GoogleLanguageModelsManagerImpl);
}
