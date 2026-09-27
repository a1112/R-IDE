/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { ContainerModule, interfaces } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { ConnectionHandler } from '@theia/core/lib/common/messaging/handler';
import { RpcConnectionHandler } from '@theia/core/lib/common/messaging/proxy-factory';
import { RepositoryService, REPOSITORY_SERVICE_PATH } from '../common/repository-protocol';
import { ReviewService, ReviewServicePath } from '../common/review-protocol';
import { RepositoryManager } from './repository-manager';
import { ReviewStore } from './review-store';

/** Services are initialized after the frontend is ready, outside the first-paint path. */
class ReviewRuntime implements BackendApplicationContribution {
    private services?: Promise<{ repositories: RepositoryManager; reviews: ReviewStore }>;
    private stopped = false;
    private readonly dirtySessions = new Map<string, string>();
    constructor(private readonly container: interfaces.Container) { }
    claimDirtySession(session: string, connection: string): void {
        if (!/^[a-f0-9-]{36}$/.test(session)) { throw new Error('Invalid editor session'); }
        this.dirtySessions.set(session, connection);
    }
    ownsDirtySession(session: string, connection: string): boolean { return this.dirtySessions.get(session) === connection; }
    get(): Promise<{ repositories: RepositoryManager; reviews: ReviewStore }> {
        if (this.stopped) { return Promise.reject(new Error('Application is stopping')); }
        if (!this.services) {
            this.services = (async () => {
                const config = await this.container.get<EnvVariablesServer>(EnvVariablesServer).getConfigDirUri();
                const directory = path.join(FileUri.fsPath(config), 'repository-review');
                const repositories = new RepositoryManager({ dataDir: directory });
                await repositories.initialize();
                const reviews = new ReviewStore(directory, id => repositories.getRepository(id),
                    (id, action) => repositories.withRepositoryLock(id, action), {
                        run: async input => {
                            // Import and resolve the AI services only for an explicit review request.
                            const [{ CodexReviewAiRunner }, { RideCodexAppServerHost }, { RideCodexTurnCoordinator }, { RideCodexThreadCoordinator }] = await Promise.all([
                                import('./review-ai'),
                                import('theia-ide-codex-ext/lib/node/ride-codex-app-server-host'),
                                import('theia-ide-codex-ext/lib/node/ride-codex-turn-coordinator'),
                                import('theia-ide-codex-ext/lib/node/ride-codex-thread-coordinator')
                            ]);
                            const runner = new CodexReviewAiRunner(this.container.get(RideCodexAppServerHost),
                                this.container.get(RideCodexTurnCoordinator), this.container.get(RideCodexThreadCoordinator));
                            return runner.run(input);
                        }
                    });
                return { repositories, reviews };
            })();
        }
        return this.services;
    }
    async onStop(): Promise<void> {
        this.stopped = true;
        if (this.services) {
            const services = await this.services;
            await Promise.all([services.repositories.stop(), services.reviews.stop()]);
        }
    }
}

export default new ContainerModule(bind => {
    bind(ReviewRuntime).toDynamicValue(context => new ReviewRuntime(context.container)).inSingletonScope();
    bind(BackendApplicationContribution).toService(ReviewRuntime);
    bind(ConnectionHandler).toDynamicValue(context => new RpcConnectionHandler<object>(REPOSITORY_SERVICE_PATH, client => {
        const runtime = context.container.get(ReviewRuntime);
        const id = randomUUID();
        let editorSession: string | undefined;
        let connected = true;
        client.onDidCloseConnection(() => {
            connected = false;
            runtime.get().then(s => s.repositories.disconnectClient(editorSession ?? id)).catch(() => undefined);
        });
        const manager = async (): Promise<RepositoryManager> => {
            if (!connected) { throw new Error('Client disconnected'); }
            return (await runtime.get()).repositories;
        };
        const service: RepositoryService = {
            ready: async () => { (await manager()).start(); },
            addRoot: async root => (await manager()).addRoot(root),
            removeRoot: async root => (await manager()).removeRoot(root),
            roots: async () => (await manager()).roots(),
            list: async () => (await manager()).list(),
            getRepository: async repoId => (await manager()).getRepository(repoId),
            refresh: async repoId => (await manager()).refresh(repoId, true),
            configure: async (repoId, config) => (await manager()).configure(repoId, config),
            sync: async repoId => (await manager()).sync(repoId),
            recover: async (repoId, action, confirmRestored) => (await manager()).recover(repoId, action, confirmRestored),
            setDirtyPaths: async (paths, sessionId) => {
                if (!connected) { throw new Error('Client disconnected'); }
                const session = sessionId ?? id;
                if (!editorSession) { runtime.claimDirtySession(session, id); editorSession = session; }
                if (editorSession !== session || !runtime.ownsDirtySession(session, id)) { throw new Error('Editor session was superseded'); }
                const repositories = await manager();
                if (!connected || !runtime.ownsDirtySession(session, id)) { throw new Error('Editor session was superseded'); }
                await repositories.setDirtyPaths(session, paths);
            },
            events: async cursor => (await manager()).events(cursor)
        };
        return service;
    })).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(context => new RpcConnectionHandler<object>(ReviewServicePath, () => {
        const runtime = context.container.get(ReviewRuntime);
        const store = async (): Promise<ReviewStore> => (await runtime.get()).reviews;
        const service: ReviewService = {
            list: async repoId => (await store()).list(repoId),
            read: async id => (await store()).read(id),
            create: async (repoId, target, previous) => (await store()).create(repoId, target, previous),
            markFile: async (id, file, flags) => (await store()).markFile(id, file, flags),
            comment: async (id, comment) => (await store()).comment(id, comment),
            resolveComment: async (id, commentId, resolved) => (await store()).resolveComment(id, commentId, resolved),
            delete: async id => (await store()).delete(id),
            exportMarkdown: async id => (await store()).exportMarkdown(id),
            history: async repoId => (await store()).history(repoId),
            blame: async (id, file) => (await store()).blame(id, file),
            startAi: async (id, model) => (await store()).startAi(id, model),
            cancelAi: async id => (await store()).cancelAi(id)
        };
        return service;
    })).inSingletonScope();
});
