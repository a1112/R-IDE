/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { types as utilTypes } from 'node:util';
import { createRideCodexAuthNormalizers } from '../common/ride-codex-auth';

export const rideCodexNodeAuthNormalizers = createRideCodexAuthNormalizers({
    isProxy: value => utilTypes.isProxy(value)
});
