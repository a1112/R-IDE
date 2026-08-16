/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as nativeChrome from '../src/browser/ride-native-chrome';

type WindowControlLayout = {
    placement: 'left' | 'right';
    actions: string[];
};

const nativeChromeWithLayout = nativeChrome as typeof nativeChrome & {
    getRideWindowControls?: (platform: 'macos' | 'windows' | 'linux' | 'unknown') => WindowControlLayout;
};

test('uses platform-native window control placement and order', () => {
    const getRideWindowControls = nativeChromeWithLayout.getRideWindowControls;
    assert.equal(typeof getRideWindowControls, 'function');

    assert.deepEqual(getRideWindowControls?.('macos'), {
        placement: 'left',
        actions: ['close', 'minimize', 'toggleMaximize']
    });
    assert.deepEqual(getRideWindowControls?.('windows'), {
        placement: 'right',
        actions: ['minimize', 'toggleMaximize', 'close']
    });
    assert.deepEqual(getRideWindowControls?.('linux'), {
        placement: 'right',
        actions: ['minimize', 'toggleMaximize', 'close']
    });
    assert.deepEqual(getRideWindowControls?.('unknown'), {
        placement: 'right',
        actions: ['minimize', 'toggleMaximize', 'close']
    });
});
