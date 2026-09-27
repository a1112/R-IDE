/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export const RepositoryService = Symbol('RepositoryService');
export const REPOSITORY_SERVICE_PATH = '/services/ride-review/repositories';

export type RepositoryState = 'idle' | 'syncing' | 'paused' | 'error';
export interface Repository {
    id: string;
    path: string;
    gitDir: string;
    commonDir: string;
    name: string;
    branch?: string;
    head?: string;
    upstream?: string;
    ahead: number;
    behind: number;
    dirty: boolean;
    enabled: boolean;
    intervalMs: number;
    state: RepositoryState;
    reason?: string;
    lastSync?: number;
    submodule?: boolean;
    recoveryNeedsConfirmation?: boolean;
    recoveryStash?: string;
    retainedStash?: string;
}
export interface RepositoryEvent {
    id: number;
    repositoryId: string;
    type: 'discovered' | 'observed' | 'worktree-changed' | 'head-changed' | 'branch-changed' | 'commits-discovered'
        | 'sync-start' | 'sync-success' | 'sync-failed' | 'sync-conflict' | 'recovery';
    observedAt: number;
    before?: string;
    after?: string;
    operationId?: string;
    message?: string;
}
export interface RepositorySyncConfiguration { enabled: boolean; intervalMs?: number; }
export interface RepositoryService {
    ready(): Promise<void>;
    addRoot(path: string): Promise<Repository[]>;
    removeRoot(path: string): Promise<void>;
    roots(): Promise<string[]>;
    list(): Promise<Repository[]>;
    getRepository(id: string): Promise<Repository>;
    refresh(id?: string): Promise<Repository[]>;
    configure(id: string, configuration: RepositorySyncConfiguration): Promise<Repository>;
    sync(id: string): Promise<Repository>;
    recover(id: string, action: 'continue' | 'abort', confirmRestored?: boolean): Promise<Repository>;
    setDirtyPaths(paths: string[], sessionId?: string): Promise<void>;
    events(after?: number): Promise<RepositoryEvent[]>;
}
