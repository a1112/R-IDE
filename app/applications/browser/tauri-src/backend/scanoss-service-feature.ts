// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import type { ScanOSSService } from '@theia/scanoss/lib/common';
import { ScanOSSServiceImpl } from '@theia/scanoss/lib/node/scanoss-service-impl';

export function createScanOSSService(): ScanOSSService {
    return new ScanOSSServiceImpl();
}
