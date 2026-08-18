/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRestoreDemoWorkbench } from '../src/browser/ride-workbench-startup';

test('legacy local storage cannot enable the production demo workbench', () => {
    const host = {
        location: { search: '' },
        localStorage: { getItem: () => '1' }
    };

    assert.equal(shouldRestoreDemoWorkbench(host), false);
});

test('the demo workbench remains available through explicit one-shot switches', () => {
    assert.equal(shouldRestoreDemoWorkbench({
        location: { search: '?rideDemoWorkbench=1' }
    }), true);
    assert.equal(shouldRestoreDemoWorkbench({
        RIDE_RESTORE_DEMO_WORKBENCH: true,
        location: { search: '' }
    }), true);
});
