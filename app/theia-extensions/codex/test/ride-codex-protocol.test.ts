/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    RideCodexAuthClient,
    RideCodexAuthService,
    RideCodexAuthServicePath,
    RideCodexService,
    RideCodexServicePath
} from '../src/common/ride-codex-protocol';

test('publishes the R-IDE Codex service identity at its RPC path', () => {
    assert.equal(RideCodexServicePath, '/services/ride-codex');
    assert.equal(RideCodexService.toString(), 'Symbol(RideCodexService)');
});

test('publishes a separate stable local RPC identity for secret-free auth state', () => {
    assert.equal(RideCodexAuthServicePath, '/services/ride-codex-auth');
    assert.equal(RideCodexAuthService.toString(), 'Symbol(RideCodexAuthService)');
    assert.equal(RideCodexAuthClient.toString(), 'Symbol(RideCodexAuthClient)');
});
