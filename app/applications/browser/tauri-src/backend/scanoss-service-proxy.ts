// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import type { ScanOSSResult, ScanOSSService } from '@theia/scanoss/lib/common';
import { injectable } from '@theia/core/shared/inversify';

interface ScanOSSFeature {
    createScanOSSService(): ScanOSSService;
}

async function loadScanOSSFeature(): Promise<ScanOSSFeature> {
    const featureRequest = './scanoss-service-feature.cjs';
    return import(featureRequest);
}

export class ScanOSSServiceImpl implements ScanOSSService {
    async scanContent(content: string, apiKey?: string): Promise<ScanOSSResult> {
        const feature = await loadScanOSSFeature();
        return feature.createScanOSSService().scanContent(content, apiKey);
    }
}

injectable()(ScanOSSServiceImpl);
