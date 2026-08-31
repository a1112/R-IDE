/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export const RIDE_CODEX_APPROVAL_DECISIONS = Object.freeze([
    'accept', 'acceptForSession', 'decline', 'cancel'
] as const);

export type RideCodexApprovalDecision = typeof RIDE_CODEX_APPROVAL_DECISIONS[number];
export type RideCodexApprovalKind = 'command' | 'file-change';

export interface RideCodexApprovalContext {
    readonly generation: number;
    readonly threadId: string;
    readonly turnId: string;
}

export interface RideCodexApprovalCardBase {
    readonly kind: RideCodexApprovalKind;
    readonly token: string;
    readonly fingerprint: string;
    readonly expiresAt: number;
    readonly reason?: string;
    readonly allowedDecisions: readonly RideCodexApprovalDecision[];
}

export interface RideCodexCommandApprovalCard extends RideCodexApprovalCardBase {
    readonly kind: 'command';
    readonly command?: string;
    readonly cwd?: string;
    readonly network?: Readonly<{
        readonly host: string;
        readonly protocol: 'http' | 'https' | 'socks5Tcp' | 'socks5Udp';
    }>;
}

export interface RideCodexFileApprovalChange {
    readonly path: string;
    readonly kind: 'add' | 'delete' | 'update';
    readonly movePath?: string;
}

export interface RideCodexFileApprovalCard extends RideCodexApprovalCardBase {
    readonly kind: 'file-change';
    readonly changes: readonly RideCodexFileApprovalChange[];
}

export type RideCodexApprovalCard = RideCodexCommandApprovalCard | RideCodexFileApprovalCard;

export interface RideCodexApprovalDecisionRequest {
    readonly token: string;
    readonly fingerprint: string;
    readonly decision: RideCodexApprovalDecision;
}

export type RideCodexApprovalDecisionResult =
    | Readonly<{ status: 'responded' }>
    | Readonly<{
        status: 'rejected';
        code: 'invalid-decision' | 'ownership-mismatch' | 'response-failed' | 'stale-approval';
    }>;

export interface RideCodexApprovalClient {
    approvalsChanged(approvals: readonly RideCodexApprovalCard[]): void | Promise<void>;
}

export interface RideCodexApprovalSession {
    setContext(context: RideCodexApprovalContext): Promise<void>;
    disposeContext(): Promise<void>;
    approvals(): Promise<readonly RideCodexApprovalCard[]>;
    decide(request: RideCodexApprovalDecisionRequest): Promise<RideCodexApprovalDecisionResult>;
    dispose(): void;
}
