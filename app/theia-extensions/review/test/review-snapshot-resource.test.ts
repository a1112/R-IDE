/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import URI from '@theia/core/lib/common/uri';
import { ReviewSnapshotResolver } from '../src/browser/review-snapshot-resource';
import { Review, ReviewService } from '../src/common/review-protocol';
import { snapshotAddress } from '../src/browser/review-state';

function resolver(read: (id: string) => Promise<Review>): ReviewSnapshotResolver {
    const instance = new ReviewSnapshotResolver();
    Object.assign(instance, { reviews: { read } as Partial<ReviewService> });
    return instance;
}

test('Monaco resources retain captured content and cannot be saved or autosaved', async () => {
    let content = 'first snapshot\n';
    const resource = await resolver(async id => {
        assert.equal(id, 'snapshot-id');
        return { files: [{ path: 'src/a.ts', before: 'before\n', after: content }] } as Review;
    }).resolve(new URI(snapshotAddress('snapshot-id', 'src/a.ts', 'after')));
    content = 'later workspace changes\n';
    assert.equal(await resource.readContents(), 'first snapshot\n');
    assert.equal(resource.readOnly, true);
    assert.equal(resource.autosaveable, false);
    assert.equal(resource.saveContents, undefined);
});

test('missing, skipped, and foreign resources never open as editable blank documents', async () => {
    const instance = resolver(async () => ({ files: [{ path: 'image.png', skipped: 'binary file' }] }) as Review);
    await assert.rejects(() => instance.resolve(new URI('file:///source.ts')), /Unsupported/);
    await assert.rejects(() => instance.resolve(new URI(snapshotAddress('id', 'absent.ts', 'after'))), /不存在/);
    await assert.rejects(() => instance.resolve(new URI(snapshotAddress('id', 'image.png', 'after'))), /binary file/);
});
