/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { RpcServer } from '@theia/core/lib/common/messaging/proxy-factory';
import type {
    RideCodexAuthClient as RideCodexAuthClientModel,
    RideCodexAuthSnapshot,
    RideCodexLoginRequest,
    RideCodexLoginResult
} from './ride-codex-auth';
import type {
    RideCodexConversationsClient as RideCodexConversationsClientModel,
    RideCodexConversationsSnapshot,
    RideCodexModelListRequest,
    RideCodexModelPage,
    RideCodexThreadListRequest,
    RideCodexThreadPage,
    RideCodexThreadResumeRequest,
    RideCodexThreadStartRequest,
    RideCodexThreadSummary
} from './ride-codex-conversations';
import type {
    RideCodexTurnClient as RideCodexTurnClientModel,
    RideCodexTurnInterruptRequest,
    RideCodexTurnResult,
    RideCodexTurnStartRequest,
    RideCodexTurnSteerRequest
} from './ride-codex-events';
import type {
    RideCodexApprovalClient as RideCodexApprovalClientModel,
    RideCodexApprovalContext,
    RideCodexApprovalDecisionRequest,
    RideCodexApprovalDecisionResult,
    RideCodexApprovalCard
} from './ride-codex-approvals';

export const RideCodexServicePath = '/services/ride-codex';
export const RideCodexService = Symbol('RideCodexService');

export interface RideCodexService {
    status(): Promise<{ state: 'inactive' | 'activating' | 'ready' | 'error' }>;
    activate(): Promise<void>;
}

export const RideCodexAuthServicePath = '/services/ride-codex-auth';
export const RideCodexAuthService = Symbol('RideCodexAuthService');
export const RideCodexAuthClient = Symbol('RideCodexAuthClient');

export interface RideCodexAuthClient extends RideCodexAuthClientModel { }

export interface RideCodexAuthService extends RpcServer<RideCodexAuthClient> {
    status(): Promise<RideCodexAuthSnapshot>;
    activate(): Promise<RideCodexAuthSnapshot>;
    login(request: RideCodexLoginRequest): Promise<RideCodexLoginResult>;
    cancelLogin(loginId: string): Promise<void>;
    readAccount(options?: Readonly<{ refreshToken?: boolean }>): Promise<RideCodexAuthSnapshot>;
    logout(): Promise<RideCodexAuthSnapshot>;
    readRateLimits(): Promise<RideCodexAuthSnapshot>;
    disconnectClient(client: RideCodexAuthClient): void;
}

export const RideCodexConversationsServicePath = '/services/ride-codex-conversations';
export const RideCodexConversationsService = Symbol('RideCodexConversationsService');
export const RideCodexConversationsClient = Symbol('RideCodexConversationsClient');

export interface RideCodexConversationsClient extends RideCodexConversationsClientModel { }

export interface RideCodexConversationsService extends RpcServer<RideCodexConversationsClient> {
    status(): Promise<RideCodexConversationsSnapshot>;
    listModels(options?: RideCodexModelListRequest): Promise<RideCodexModelPage>;
    listThreads(options?: RideCodexThreadListRequest): Promise<RideCodexThreadPage>;
    startThread(request: RideCodexThreadStartRequest): Promise<RideCodexThreadSummary>;
    resumeThread(request: RideCodexThreadResumeRequest): Promise<RideCodexThreadSummary>;
    readThread(threadId: string): Promise<RideCodexThreadSummary>;
    archiveThread(threadId: string): Promise<void>;
    selectThread(threadId: string | null): Promise<void>;
    disconnectClient(client: RideCodexConversationsClient): void;
}

export const RideCodexTurnsServicePath = '/services/ride-codex-turns';
export const RideCodexTurnsService = Symbol('RideCodexTurnsService');
export const RideCodexTurnClient = Symbol('RideCodexTurnClient');

export interface RideCodexTurnClient extends RideCodexTurnClientModel { }

export interface RideCodexTurnsService extends RpcServer<RideCodexTurnClient> {
    startTurn(request: RideCodexTurnStartRequest): Promise<RideCodexTurnResult>;
    steerTurn(request: RideCodexTurnSteerRequest): Promise<RideCodexTurnResult>;
    interruptTurn(request: RideCodexTurnInterruptRequest): Promise<RideCodexTurnResult>;
    disconnectClient(): void;
}

export const RideCodexApprovalsServicePath = '/services/ride-codex-approvals';
export const RideCodexApprovalsService = Symbol('RideCodexApprovalsService');
export const RideCodexApprovalClient = Symbol('RideCodexApprovalClient');

export interface RideCodexApprovalClient extends RideCodexApprovalClientModel { }

export interface RideCodexApprovalsService extends RpcServer<RideCodexApprovalClient> {
    setContext(context: RideCodexApprovalContext): Promise<void>;
    disposeContext(): Promise<void>;
    approvals(): Promise<readonly RideCodexApprovalCard[]>;
    decide(request: RideCodexApprovalDecisionRequest): Promise<RideCodexApprovalDecisionResult>;
}
