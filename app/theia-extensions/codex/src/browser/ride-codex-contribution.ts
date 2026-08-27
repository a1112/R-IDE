/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ApplicationShell } from '@theia/core/lib/browser';
import { RideCodexApprovalDecision, RideCodexApprovalCard } from '../common/ride-codex-approvals';
import { RideCodexLoginRequest, RideCodexLoginResult } from '../common/ride-codex-auth';
import { RideCodexControlModel } from './ride-codex-control-model';
import {
    RideCodexControlHandlers,
    RideCodexControlWidget,
    RIDE_CODEX_CONTROL_WIDGET_ID
} from './ride-codex-control-widget';

/** Owns the one Codex control widget for the activated feature. */
export class RideCodexContribution {
    #widget: RideCodexControlWidget | undefined;
    #disposed = false;

    constructor(
        protected readonly shell: ApplicationShell,
        protected readonly model: RideCodexControlModel,
        protected readonly locale?: string
    ) { }

    async open(): Promise<void> {
        if (this.#disposed) {
            throw new Error('Codex contribution is disposed.');
        }
        const widget = this.#widget ?? this.createWidget();
        if (!widget.parent) {
            await this.shell.addWidget(widget, { area: 'right', rank: 500 });
        }
        await this.shell.activateWidget(RIDE_CODEX_CONTROL_WIDGET_ID);
    }

    dispose(): void {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        this.#widget?.dispose();
        this.#widget = undefined;
        this.model.dispose().catch(() => undefined);
    }

    protected createWidget(): RideCodexControlWidget {
        const handlers: RideCodexControlHandlers = {
            onLogin: (request: RideCodexLoginRequest): Promise<RideCodexLoginResult> => this.model.login(request),
            onCancelLogin: () => this.model.cancelLogin(),
            onLogout: () => this.model.logout(),
            onSelectModel: modelId => this.model.selectModel(modelId),
            onSelectThread: threadId => this.model.selectThread(threadId),
            onStartThread: async () => { await this.model.startThread(); },
            onResumeThread: async threadId => { await this.model.resumeThread(threadId); },
            onArchiveThread: threadId => this.model.archiveThread(threadId),
            onDecideApproval: (card: RideCodexApprovalCard, decision: RideCodexApprovalDecision) =>
                this.model.decideApproval(card, decision).then(() => undefined),
            onInterrupt: async () => { await this.model.interruptTurn(); },
            onRetry: () => this.model.retry()
        };
        const widget = new RideCodexControlWidget(this.model, handlers, this.locale);
        this.#widget = widget;
        return widget;
    }
}
