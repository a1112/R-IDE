// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import type { ScanOSSService } from '@theia/scanoss/lib/common';
import { ScanOSSServiceImpl } from '@theia/scanoss/lib/node/scanoss-service-impl';
import type { Container } from '@theia/core/shared/inversify';

export function createScanOSSService(rootContainer: Container, ensureActive: () => void): ScanOSSService {
    ensureActive();
    const child = rootContainer.createChild();
    ensureActive();
    child.bind(ScanOSSServiceImpl).toSelf().inSingletonScope();
    ensureActive();
    return child.get(ScanOSSServiceImpl);
}
