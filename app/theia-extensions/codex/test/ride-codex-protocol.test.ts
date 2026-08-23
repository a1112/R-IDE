/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RideCodexService, RideCodexServicePath } from '../src/common/ride-codex-protocol';

test('publishes the R-IDE Codex service identity at its RPC path', () => {
    assert.equal(RideCodexServicePath, '/services/ride-codex');
    assert.equal(RideCodexService.toString(), 'Symbol(RideCodexService)');
});
