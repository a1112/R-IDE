/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ApplicationShell, FrontendApplicationContribution, open, OpenerService } from '@theia/core/lib/browser';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { CommandService } from '@theia/core/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';
import { GettingStartedWidget } from '@theia/getting-started/lib/browser/getting-started-widget';
import { WorkspaceService } from '@theia/workspace/lib/browser';

@injectable()
export class RideWorkbenchContribution implements FrontendApplicationContribution {

    @inject(CommandService)
    protected readonly commandService: CommandService;

    @inject(OpenerService)
    protected readonly openerService: OpenerService;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(FrontendApplicationStateService)
    protected readonly applicationState: FrontendApplicationStateService;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    onStart(): void {
        document.body.dataset.productShell = 'r-ide';
        this.installTopChromeWhenReady();
        this.applicationState.reachedState('ready').then(() => {
            this.installTopChromeWhenReady();
            if (this.shouldRestoreDemoWorkbench()) {
                this.restoreDemoWorkbench().catch(console.warn);
                window.setTimeout(() => this.restoreDemoWorkbench().catch(console.warn), 1500);
            } else {
                this.configureLeanStartup().catch(console.warn);
            }
        });
    }

    protected installTopChromeWhenReady(attempts = 40): void {
        this.installTopChrome();
        this.localizeMenuLabels();
        this.localizeSidePanelTitles();
        const chromeReady = !!document.querySelector('.ride-brand') && !!document.getElementById('theia:menubar');
        if (!chromeReady && attempts > 0) {
            window.setTimeout(() => this.installTopChromeWhenReady(attempts - 1), 250);
        }
    }

    protected installTopChrome(): void {
        const topPanel = document.getElementById('theia-top-panel');
        if (!topPanel || topPanel.querySelector('.ride-brand')) {
            return;
        }

        const brand = document.createElement('div');
        brand.className = 'ride-brand';
        brand.innerHTML = '<span class="codicon codicon-menu"></span><strong>R-IDE</strong>';

        const commandCenter = document.createElement('button');
        commandCenter.type = 'button';
        commandCenter.className = 'ride-command-center';
        commandCenter.setAttribute('aria-label', 'Open command palette');
        commandCenter.innerHTML = '<span class="codicon codicon-search"></span><span>搜索文件 / 命令 (Ctrl+K)</span>';
        commandCenter.addEventListener('click', () => this.execute('workbench.action.showCommands'));

        const runButton = document.createElement('button');
        runButton.type = 'button';
        runButton.className = 'ride-run-button';
        runButton.innerHTML = '<span class="codicon codicon-play"></span><span>运行</span><span class="codicon codicon-chevron-down"></span>';
        runButton.addEventListener('click', () => this.execute('workbench.action.debug.run'));

        const layoutActions = document.createElement('div');
        layoutActions.className = 'ride-layout-actions';
        layoutActions.append(
            this.createIconButton('codicon-layout-sidebar-left', 'Toggle left sidebar', 'core.toggle.left.panel'),
            this.createIconButton('codicon-layout-panel', 'Toggle bottom panel', 'core.toggle.bottom.panel'),
            this.createIconButton('codicon-layout-sidebar-right', 'Toggle right sidebar', 'core.toggle.right.panel'),
            this.createIconButton('codicon-settings-gear', 'Settings', 'workbench.action.openGlobalSettings')
        );

        topPanel.prepend(brand);
        topPanel.append(commandCenter, runButton, layoutActions);
    }

    protected createIconButton(iconClass: string, label: string, command: string): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ride-icon-button';
        button.title = label;
        button.setAttribute('aria-label', label);
        button.innerHTML = `<span class="codicon ${iconClass}"></span>`;
        button.addEventListener('click', () => this.execute(command));
        return button;
    }

    protected localizeMenuLabels(): void {
        const labels = new Map<string, string>([
            ['File', '文件(F)'],
            ['Edit', '编辑(E)'],
            ['Selection', '选择(S)'],
            ['View', '查看(V)'],
            ['Go', '跳转(G)'],
            ['Run', '运行(R)'],
            ['Terminal', '终端(T)'],
            ['Help', '帮助(H)']
        ]);
        const relabel = () => {
            for (const label of Array.from(document.querySelectorAll<HTMLElement>('.lm-MenuBar-itemLabel'))) {
                const text = label.textContent?.trim();
                const localized = text ? labels.get(text) : undefined;
                if (localized) {
                    label.textContent = localized;
                }
            }
        };
        relabel();
        const menuBar = document.getElementById('theia:menubar');
        if (menuBar && !menuBar.dataset.rideMenuLocalized) {
            menuBar.dataset.rideMenuLocalized = 'true';
            new MutationObserver(relabel).observe(menuBar, { childList: true, subtree: true, characterData: true });
        }
    }

    protected async restoreDemoWorkbench(): Promise<void> {
        await this.ensureNavigatorVisible();
        await this.openDemoEditors();
        await this.execute('terminal:new', true);
        this.shell.expandPanel('bottom');
        this.shell.resize(220, 'bottom');
        await this.ensurePanelVisible('theia-right-side-panel', 'aiChat:toggle');
        this.shell.expandPanel('right');
        this.shell.resize(330, 'right');
        this.installRightStack();
        this.localizeSidePanelTitles();
    }

    protected shouldRestoreDemoWorkbench(): boolean {
        const flags = window as Window & { RIDE_RESTORE_DEMO_WORKBENCH?: boolean };
        if (flags.RIDE_RESTORE_DEMO_WORKBENCH) {
            return true;
        }

        const searchParams = new URLSearchParams(window.location.search);
        return searchParams.get('rideDemoWorkbench') === '1'
            || window.localStorage?.getItem('ride.restoreDemoWorkbench') === '1';
    }

    protected async configureLeanStartup(): Promise<void> {
        await this.ensureNavigatorVisible();
        await this.shell.closeWidget(GettingStartedWidget.ID, { save: false }).catch(() => undefined);
        await this.shell.collapsePanel('bottom').catch(() => undefined);
        await this.shell.collapsePanel('right').catch(() => undefined);
        this.localizeSidePanelTitles();
    }

    protected async ensurePanelVisible(panelId: string, command: string): Promise<void> {
        const panel = document.getElementById(panelId);
        if (!panel || panel.classList.contains('lm-mod-hidden')) {
            await this.execute(command, true);
        }
    }

    protected async ensureNavigatorVisible(): Promise<void> {
        this.shell.expandPanel('left');
        this.shell.resize(292, 'left');

        const leftPanel = document.getElementById('theia-left-side-panel');
        const title = document.querySelector('.theia-sidepanel-toolbar.theia-left-side-panel .theia-sidepanel-title')?.textContent?.trim() ?? '';
        if (!leftPanel || leftPanel.classList.contains('lm-mod-hidden') || !/EXPLORER|Explorer|资源管理器/i.test(title)) {
            await this.execute('fileNavigator:toggle', true);
            this.shell.expandPanel('left');
            this.shell.resize(292, 'left');
        }
    }

    protected localizeSidePanelTitles(): void {
        const labels = new Map<string, string>([
            ['EXPLORER', '资源管理器'],
            ['Explorer', '资源管理器'],
            ['Open Editors', ''],
            ['SOURCE CONTROL', '源代码管理'],
            ['Source Control', '源代码管理'],
            ['AI CHAT', 'AI 助手'],
            ['AI Chat', 'AI 助手'],
            ['OUTLINE', '大纲'],
            ['Outline', '大纲'],
            ['PROBLEMS', '问题'],
            ['Problems', '问题'],
            ['EXTENSIONS', '扩展'],
            ['Extensions', '扩展'],
            ['SETTINGS', '设置'],
            ['Settings', '设置'],
            ['TIMELINE', '时间线'],
            ['Timeline', '时间线']
        ]);
        for (const label of Array.from(document.querySelectorAll<HTMLElement>('.theia-sidepanel-title'))) {
            const text = label.textContent?.trim();
            const localized = text ? labels.get(text) : undefined;
            if (localized) {
                label.textContent = localized;
            }
        }
    }

    protected installRightStack(): void {
        const rightContentPanel = document.getElementById('theia-right-content-panel');
        if (!rightContentPanel) {
            return;
        }

        rightContentPanel.classList.add('ride-stack-installed');
        let stack = rightContentPanel.querySelector<HTMLElement>('.ride-right-stack');
        if (!stack) {
            stack = document.createElement('aside');
            stack.className = 'ride-right-stack';
            stack.setAttribute('aria-label', 'R-IDE assistant and diagnostics');
            stack.innerHTML = this.renderRightStack();
            rightContentPanel.appendChild(stack);
            this.bindRightStackInteractions(stack);
        }
    }

    protected renderRightStack(): string {
        return `
            <section class="ride-stack-section ride-ai-section" data-section="ai">
                <header class="ride-stack-header">
                    <button class="ride-stack-title" type="button" data-action="toggle">
                        <span class="codicon codicon-sparkle"></span>
                        <span>AI 助手</span>
                        <i class="ride-live-dot"></i>
                    </button>
                    <button class="ride-stack-action codicon codicon-close" type="button" title="Close"></button>
                </header>
                <div class="ride-stack-body">
                    <div class="ride-assistant-id">
                        <span class="codicon codicon-account"></span>
                        <span>R-IDE Assistant</span>
                    </div>
                    <div class="ride-ai-prompt">如何优化这段处理逻辑的性能?</div>
                    <div class="ride-ai-answer">
                        <p>可以考虑以下优化方向:</p>
                        <ol>
                            <li>使用缓存减少数据库查询</li>
                            <li>合理使用索引</li>
                            <li>避免不必要的对象创建</li>
                            <li>使用连接池复用连接</li>
                        </ol>
                        <button type="button">查看详细建议</button>
                    </div>
                    <div class="ride-chat-input">
                        <span>询问 R-IDE Assistant...</span>
                        <div>
                            <span class="codicon codicon-mention"></span>
                            <span class="codicon codicon-symbol-number"></span>
                            <span class="codicon codicon-send"></span>
                        </div>
                    </div>
                </div>
            </section>
            <section class="ride-stack-section" data-section="outline">
                <header class="ride-stack-header">
                    <button class="ride-stack-title" type="button" data-action="toggle">
                        <span class="codicon codicon-list-tree"></span>
                        <span>大纲</span>
                    </button>
                    <button class="ride-stack-action codicon codicon-close" type="button" title="Close"></button>
                </header>
                <div class="ride-stack-body ride-outline-tree">
                    <div><span class="codicon codicon-symbol-class"></span><span>UserHandler</span></div>
                    <div class="depth-1"><span class="codicon codicon-symbol-field"></span><span>userService</span></div>
                    <div class="depth-1"><span class="codicon codicon-symbol-method"></span><span>NewUserHandler(s *service.UserService)</span></div>
                    <div class="depth-1 active"><span class="codicon codicon-symbol-method"></span><span>GetUser(c *gin.Context)</span></div>
                </div>
            </section>
            <section class="ride-stack-section" data-section="problems">
                <header class="ride-stack-header">
                    <button class="ride-stack-title" type="button" data-action="toggle">
                        <span class="codicon codicon-warning"></span>
                        <span>问题</span>
                        <strong>2</strong>
                    </button>
                    <button class="ride-stack-action codicon codicon-close" type="button" title="Close"></button>
                </header>
                <div class="ride-stack-body ride-problem-list">
                    <div class="ride-problem-file">user_handler.go <span>internal/handler</span></div>
                    <div><span class="codicon codicon-warning"></span><span>err 未使用的变量 "err"</span><em>22:9</em></div>
                    <div><span class="codicon codicon-error"></span><span>可能的空指针引用 user</span><em>28:15</em></div>
                </div>
            </section>
            <section class="ride-stack-section ride-extension-section" data-section="extensions">
                <header class="ride-stack-header">
                    <button class="ride-stack-title" type="button" data-action="toggle">
                        <span class="codicon codicon-extensions"></span>
                        <span>扩展</span>
                    </button>
                    <button class="ride-stack-action codicon codicon-close" type="button" title="Close"></button>
                </header>
                <div class="ride-stack-body ride-extension-list">
                    <span class="ride-section-note">已启用</span>
                    <div><b class="go">GO</b><span><strong>Go</strong><small>Rich Go language support</small></span><i class="codicon codicon-settings-gear"></i></div>
                    <div><b class="lens"></b><span><strong>GitLens</strong><small>Supercharge Git</small></span><i class="codicon codicon-settings-gear"></i></div>
                    <div><b class="err"></b><span><strong>Error Lens</strong><small>Improve highlighting of errors</small></span><i class="codicon codicon-settings-gear"></i></div>
                    <div><b class="yaml">Y</b><span><strong>YAML</strong><small>YAML Language Support</small></span><i class="codicon codicon-settings-gear"></i></div>
                    <button type="button">推荐扩展</button>
                </div>
            </section>
            <section class="ride-stack-section collapsed" data-section="settings">
                <header class="ride-stack-header">
                    <button class="ride-stack-title" type="button" data-action="toggle">
                        <span class="codicon codicon-settings-gear"></span>
                        <span>设置</span>
                    </button>
                    <button class="ride-stack-action codicon codicon-close" type="button" title="Close"></button>
                </header>
                <div class="ride-stack-body"></div>
            </section>
        `;
    }

    protected bindRightStackInteractions(stack: HTMLElement): void {
        for (const toggle of Array.from(stack.querySelectorAll<HTMLButtonElement>('[data-action="toggle"]'))) {
            toggle.addEventListener('click', () => {
                toggle.closest('.ride-stack-section')?.classList.toggle('collapsed');
            });
        }
    }

    protected async openDemoEditors(): Promise<void> {
        const roots = await this.workspaceService.roots;
        const root = roots.find(candidate => candidate.resource.toString().toLowerCase().includes('r-project')) ?? roots[0];
        if (!root) {
            return;
        }

        const files = [
            'main.go',
            'internal/api/router.go',
            'internal/handler/user_handler.go',
            'internal/config/config.yaml',
            'internal/db/db.go'
        ];
        for (const [index, file] of files.entries()) {
            await open(this.openerService, root.resource.resolve(file), {
                activate: index === files.length - 1,
                preview: false,
                reveal: true
            } as never);
        }
    }

    protected async execute(command: string, silent = false): Promise<void> {
        try {
            await this.commandService.executeCommand(command);
        } catch (error) {
            if (!silent) {
                console.warn(`R-IDE command failed: ${command}`, error);
            }
        }
    }
}
