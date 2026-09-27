/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { inject, injectable } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { Resource, ResourceResolver } from '@theia/core/lib/common/resource';
import { ReviewService } from '../common/review-protocol';
import { parseSnapshotAddress } from './review-state';

/** No saveContents implementation: Monaco treats these immutable resources as read-only. */
@injectable()
export class ReviewSnapshotResolver implements ResourceResolver {
    @inject(ReviewService) protected readonly reviews!: ReviewService;

    async resolve(uri: URI): Promise<Resource> {
        if (uri.scheme !== 'ride-review') {
            throw new Error('Unsupported resource.');
        }
        const address = parseSnapshotAddress(uri.toString());
        const review = await this.reviews.read(address.reviewId);
        const file = review.files.find(candidate => candidate.path === address.path);
        if (!file || file.skipped) {
            throw new Error(file?.skipped || '该审查快照中不存在此文件。');
        }
        const contents = file[address.side];
        return { uri, readOnly: true, autosaveable: false, readContents: async () => contents, dispose: () => undefined };
    }
}
