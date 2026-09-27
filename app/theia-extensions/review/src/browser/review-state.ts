/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** Pure UI helpers kept independent of Theia so reconnection and anchors can be tested. */
export function mergeEvents<T extends { id: number }>(current: T[], incoming: T[], limit = 300): T[] {
    const byCursor = new Map<number, T>();
    for (const event of [...current, ...incoming]) {
        byCursor.set(event.id, event);
    }
    return [...byCursor.values()].sort((a, b) => a.id - b.id).slice(-limit);
}

export function validateCommentRange(text: string, start: number, end: number): string | undefined {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > text.split('\n').length) {
        return '请输入此快照内有效的起止行号（从 1 开始）。';
    }
    return undefined;
}

export function snapshotAddress(reviewId: string, path: string, side: 'before' | 'after'): string {
    return `ride-review:/${encodeURIComponent(reviewId)}/${side}/${encodeURIComponent(path)}`;
}

export function parseSnapshotAddress(address: string): { reviewId: string; path: string; side: 'before' | 'after' } {
    const match = /^ride-review:\/([^/]+)\/(before|after)\/(.+)$/.exec(address);
    if (!match) {
        throw new Error('无效的审查快照地址。');
    }
    return { reviewId: decodeURIComponent(match[1]), side: match[2] as 'before' | 'after', path: decodeURIComponent(match[3]) };
}
