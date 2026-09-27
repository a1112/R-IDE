/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export const ReviewService = Symbol('ReviewService');
export const ReviewServicePath = '/services/ride-review';

export type ReviewTarget = { kind: 'working' } | { kind: 'commit'; commit: string } | { kind: 'branch'; base: string; head: string };
export interface ReviewFile {
    path: string;
    before: string;
    after: string;
    status: string;
    beforeMode?: string;
    afterMode?: string;
    skipped?: string;
    read: boolean;
    bookmarked: boolean;
}
export interface ReviewComment {
    id: string;
    path: string;
    side: 'before' | 'after';
    start: number;
    end: number;
    body: string;
    severity?: 'info' | 'warning' | 'error';
    source: 'human' | 'ai';
    resolved: boolean;
}
export interface Review {
    id: string;
    repositoryId: string;
    title: string;
    createdAt: number;
    base: string;
    head: string;
    target: ReviewTarget;
    previousReviewId?: string;
    files: ReviewFile[];
    comments: ReviewComment[];
    ai: { state: 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; covered: string[]; message?: string; summary?: string };
}
export interface ReviewSummary extends Pick<Review, 'id' | 'repositoryId' | 'title' | 'createdAt' | 'base' | 'head' | 'previousReviewId' | 'ai'> {
    fileCount: number;
}
export interface ReviewService {
    list(repositoryId?: string): Promise<ReviewSummary[]>;
    create(repositoryId: string, target: ReviewTarget, previousReviewId?: string): Promise<Review>;
    read(id: string): Promise<Review>;
    markFile(id: string, path: string, flags: { read?: boolean; bookmarked?: boolean }): Promise<Review>;
    comment(id: string, comment: Omit<ReviewComment, 'id' | 'source' | 'resolved'>): Promise<Review>;
    resolveComment(id: string, commentId: string, resolved: boolean): Promise<Review>;
    delete(id: string): Promise<void>;
    exportMarkdown(id: string): Promise<string>;
    history(repositoryId: string): Promise<{ oid: string; subject: string; author: string; date: string }[]>;
    blame(id: string, path: string): Promise<string>;
    startAi(id: string, model?: string): Promise<Review>;
    cancelAi(id: string): Promise<Review>;
}
