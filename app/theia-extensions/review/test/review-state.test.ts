/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeEvents, validateCommentRange, snapshotAddress, parseSnapshotAddress } from '../src/browser/review-state';
import URI from '@theia/core/lib/common/uri';

test('reconnected event batches are deduplicated, ordered and bounded', () => {
    assert.deepEqual(mergeEvents([{ id: 3 }, { id: 1 }], [{ id: 3 }, { id: 2 }, { id: 4 }], 3).map(e => e.id), [2, 3, 4]);
});
test('line comments reject absent, fractional and inverted ranges', () => {
    assert.equal(validateCommentRange('a\nb\n', 1, 2), undefined);
    for (const [start, end] of [[0, 1], [2, 1], [1.5, 2], [1, 5], [NaN, 1]]) {
        assert.equal(typeof validateCommentRange('a\nb\n', start, end), 'string');
    }
});
test('snapshot addresses preserve Unicode, spaces and delimiters without path traversal', () => {
    const address = snapshotAddress('revision-1', 'src/中文 name#?.ts', 'after');
    assert.deepEqual(parseSnapshotAddress(address), { reviewId: 'revision-1', path: 'src/中文 name#?.ts', side: 'after' });
    assert.deepEqual(parseSnapshotAddress(new URI(address).toString()), { reviewId: 'revision-1', path: 'src/中文 name#?.ts', side: 'after' });
    assert.throws(() => parseSnapshotAddress('ride-review:/bad'));
});
