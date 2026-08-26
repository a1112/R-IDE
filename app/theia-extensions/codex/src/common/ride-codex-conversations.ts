/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export interface RideCodexModelListRequest {
    readonly cursor?: string;
    readonly limit?: number;
    readonly includeHidden?: boolean;
}

export interface RideCodexReasoningEffort {
    readonly effort: string;
    readonly description: string;
}

export interface RideCodexServiceTier {
    readonly id: string;
    readonly name: string;
    readonly description: string;
}

export interface RideCodexModel {
    readonly id: string;
    readonly model: string;
    readonly displayName: string;
    readonly description: string;
    readonly isDefault: boolean;
    readonly hidden: boolean;
    readonly inputModalities: readonly ('text' | 'image')[];
    readonly supportedReasoningEfforts: readonly RideCodexReasoningEffort[];
    readonly defaultReasoningEffort: string;
    readonly supportsPersonality: boolean;
    readonly serviceTiers: readonly RideCodexServiceTier[];
    readonly defaultServiceTier: string | null;
}

export interface RideCodexModelPage {
    readonly data: readonly RideCodexModel[];
    readonly nextCursor: string | null;
}

export type RideCodexThreadStatusKind = 'not-loaded' | 'idle' | 'system-error' | 'active';
export type RideCodexThreadActiveFlag = 'waiting-on-approval' | 'waiting-on-user-input';

export interface RideCodexThreadStatus {
    readonly kind: RideCodexThreadStatusKind;
    readonly activeFlags: readonly RideCodexThreadActiveFlag[];
}

export interface RideCodexThreadSummary {
    readonly id: string;
    readonly preview: string;
    readonly name: string | null;
    readonly modelProvider: string;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly recencyAt: number | null;
    readonly cwd: string;
    readonly status: RideCodexThreadStatus;
}

export interface RideCodexThreadListRequest {
    readonly cursor?: string;
    readonly limit?: number;
    readonly archived?: boolean;
}

export interface RideCodexThreadPage {
    readonly data: readonly RideCodexThreadSummary[];
    readonly nextCursor: string | null;
    readonly backwardsCursor: string | null;
}

export interface RideCodexThreadStartRequest {
    readonly workspaceRoot: string;
    readonly cwd?: string;
    readonly model?: string;
    readonly serviceTier?: string;
}

export interface RideCodexThreadResumeRequest extends RideCodexThreadStartRequest {
    readonly threadId: string;
}

export interface RideCodexConversationsSnapshot {
    readonly generation: number;
    readonly threads: readonly RideCodexThreadSummary[];
    readonly selectedThreadId?: string;
    readonly persistedTranscriptCount: 0;
}

export interface RideCodexConversationsClient {
    conversationsChanged(snapshot: RideCodexConversationsSnapshot): void;
}
