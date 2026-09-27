/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewModelCatalog, selectDefaultModel } from '../src/browser/review-models';

test('model catalogue connects only on an explicit request and reuses existing Codex RPC', async () => {
    let connections = 0;
    const requests: unknown[] = [];
    const catalog = new ReviewModelCatalog(() => {
        connections++;
        return { listModels: async request => { requests.push(request); return { data: [], nextCursor: null }; } };
    });
    assert.equal(connections, 0);
    assert.deepEqual(await catalog.list(), []);
    await catalog.list();
    assert.equal(connections, 1);
    assert.deepEqual(requests, [{ limit: 100, includeHidden: false }, { limit: 100, includeHidden: false }]);
});

test('model dialog selects server default and safely handles an empty catalogue', () => {
    assert.equal(selectDefaultModel([{ id: 'a', isDefault: false }, { id: 'b', isDefault: true }]), 'b');
    assert.equal(selectDefaultModel([{ id: 'a', isDefault: false }]), 'a');
    assert.equal(selectDefaultModel([]), '');
});
