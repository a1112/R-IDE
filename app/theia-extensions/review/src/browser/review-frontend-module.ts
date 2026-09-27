/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { MenuContribution, MenuModelRegistry } from '@theia/core/lib/common/menu';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { ResourceResolver } from '@theia/core/lib/common/resource';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { WidgetFactory, WidgetManager } from '@theia/core/lib/browser/widget-manager';
import { CommonMenus } from '@theia/core/lib/browser/common-menus';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import { RepositoryService, REPOSITORY_SERVICE_PATH } from '../common/repository-protocol';
import { ReviewService, ReviewServicePath } from '../common/review-protocol';
import { ReviewWidget, REVIEW_WIDGET_ID } from './review-widget';
import { ReviewSnapshotResolver } from './review-snapshot-resource';
import { RepositorySession } from './review-session';
import { ReviewModelCatalog } from './review-models';
import { RideCodexConversationsService, RideCodexConversationsServicePath } from 'theia-ide-codex-ext/lib/common/ride-codex-protocol';
import '../../src/browser/style/review.css';

@injectable()
export class ReviewFrontendContribution implements CommandContribution, MenuContribution, FrontendApplicationContribution {
    @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
    @inject(WidgetManager) protected readonly widgets!: WidgetManager;
    @inject(RepositoryService) protected readonly repositories!: RepositoryService;
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(FrontendApplicationStateService) protected readonly state!: FrontendApplicationStateService;
    protected readonly subscriptions = new DisposableCollection();
    // Stable across socket reconnects; each frontend page owns a distinct dirty-buffer guard.
    protected readonly sessionId = crypto.randomUUID();
    protected stopped = false;
    protected session?: RepositorySession;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand({ id: 'ride.review.open', label: 'R-IDE: 仓库与代码审查' }, { execute: () => this.open() });
    }

    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(CommonMenus.VIEW_VIEWS, { commandId: 'ride.review.open', label: '仓库与代码审查', order: '45' });
    }

    protected async open(): Promise<void> {
        const widget = await this.widgets.getOrCreateWidget<ReviewWidget>(REVIEW_WIDGET_ID);
        if (!widget.isAttached) {
            await this.shell.addWidget(widget, { area: 'main' });
        }
        await this.shell.activateWidget(widget.id);
    }

    onStart(): void {
        this.state
            .reachedState('ready')
            .then(() => {
                if (this.stopped) {
                    return;
                }
                this.session = new RepositorySession(this.repositories, () => this.editors.all
                    .filter(editor => !editor.isDisposed && editor.saveable.dirty && editor.editor.uri.scheme === 'file')
                    .map(editor => FileUri.fsPath(editor.editor.uri)), this.sessionId);
                for (const editor of this.editors.all) {
                    this.watchEditor(editor);
                }
                this.subscriptions.push(
                    this.editors.onCreated(editor => {
                        this.watchEditor(editor);
                        this.publishDirty().catch(() => undefined);
                    })
                );
                const connect = (): void => {
                    this.session?.reconnect().catch(() => undefined);
                };
                const heartbeat = window.setInterval(connect, 5000);
                this.subscriptions.push({ dispose: () => window.clearInterval(heartbeat) });
                const resume = (): void => {
                    if (document.visibilityState === 'visible') {
                        this.publishDirty()
                            .then(() => this.repositories.refresh())
                            .catch(() => undefined);
                    }
                };
                document.addEventListener('visibilitychange', resume);
                this.subscriptions.push({ dispose: () => document.removeEventListener('visibilitychange', resume) });
                connect();
            })
            .catch(() => undefined);
    }

    protected watchEditor(editor: EditorWidget): void {
        const listener = editor.saveable.onDirtyChanged(() => {
            this.publishDirty().catch(() => undefined);
        });
        this.subscriptions.push(listener);
        editor.disposed.connect(() => {
            listener.dispose();
            this.publishDirty().catch(() => undefined);
        });
    }

    protected publishDirty(): Promise<void> {
        return this.session?.publishDirty() || Promise.resolve();
    }

    onStop(): void {
        this.stopped = true;
        this.session?.stop();
        this.subscriptions.dispose();
    }
}

export default new ContainerModule(bind => {
    bind(RepositoryService)
        .toDynamicValue(context => ServiceConnectionProvider.createProxy<RepositoryService>(context.container, REPOSITORY_SERVICE_PATH))
        .inSingletonScope();
    bind(ReviewService)
        .toDynamicValue(context => ServiceConnectionProvider.createProxy<ReviewService>(context.container, ReviewServicePath))
        .inSingletonScope();
    bind(ReviewWidget).toSelf();
    bind(ReviewModelCatalog).toDynamicValue(context => new ReviewModelCatalog(() =>
        ServiceConnectionProvider.createProxy<RideCodexConversationsService>(context.container, RideCodexConversationsServicePath, {
            conversationsChanged: () => undefined
        })
    )).inSingletonScope();
    bind(WidgetFactory).toDynamicValue(context => ({ id: REVIEW_WIDGET_ID, createWidget: () => context.container.get(ReviewWidget) }));
    bind(ReviewSnapshotResolver).toSelf().inSingletonScope();
    bind(ResourceResolver).toService(ReviewSnapshotResolver);
    bind(ReviewFrontendContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(ReviewFrontendContribution);
    bind(MenuContribution).toService(ReviewFrontendContribution);
    bind(FrontendApplicationContribution).toService(ReviewFrontendContribution);
});
