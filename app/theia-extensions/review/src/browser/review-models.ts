/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { RideCodexConversationsService } from 'theia-ide-codex-ext/lib/common/ride-codex-protocol';
import type { RideCodexModel } from 'theia-ide-codex-ext/lib/common/ride-codex-conversations';

/** Share Codex's catalogue without connecting to AI during normal repository browsing. */
export class ReviewModelCatalog {
    protected service?: Pick<RideCodexConversationsService, 'listModels'>;

    constructor(protected readonly connect: () => Pick<RideCodexConversationsService, 'listModels'>) { }

    async list(): Promise<readonly RideCodexModel[]> {
        this.service = this.service || this.connect();
        const result = await this.service.listModels({ limit: 100, includeHidden: false });
        return result.data;
    }
}

export function selectDefaultModel(models: readonly Pick<RideCodexModel, 'id' | 'isDefault'>[]): string {
    return models.find(model => model.isDefault)?.id || models[0]?.id || '';
}
