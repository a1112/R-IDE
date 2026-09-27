/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

interface RepositoryConnection {
    setDirtyPaths(paths: string[], sessionId?: string): Promise<void>;
    ready(): Promise<void>;
}

/** Serializes editor guards across RPC reconnects before backend synchronization is enabled. */
export class RepositorySession {
    protected stopped = false;
    protected publishing: Promise<void> = Promise.resolve();

    constructor(
        protected readonly connection: RepositoryConnection,
        protected readonly dirtyPaths: () => string[],
        protected readonly sessionId?: string
    ) { }

    publishDirty(): Promise<void> {
        this.publishing = this.publishing.catch(() => undefined).then(async () => {
            if (!this.stopped) {
                await this.connection.setDirtyPaths(this.dirtyPaths(), this.sessionId);
            }
        });
        return this.publishing;
    }

    async reconnect(): Promise<void> {
        await this.publishDirty();
        if (!this.stopped) {
            await this.connection.ready();
        }
    }

    stop(): void {
        this.stopped = true;
    }
}
