// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import type { HuggingFaceLanguageModelsManager } from '@theia/ai-huggingface/lib/common/huggingface-language-models-manager';
import { HuggingFaceLanguageModelsManagerImpl } from '@theia/ai-huggingface/lib/node/huggingface-language-models-manager-impl';
import type { Container } from '@theia/core/shared/inversify';

export function createHuggingFaceLanguageModelsManager(
    rootContainer: Container,
    ensureActive: () => void
): HuggingFaceLanguageModelsManager {
    ensureActive();
    const child = rootContainer.createChild();
    ensureActive();
    child.bind(HuggingFaceLanguageModelsManagerImpl).toSelf().inSingletonScope();
    ensureActive();
    return child.get(HuggingFaceLanguageModelsManagerImpl);
}
