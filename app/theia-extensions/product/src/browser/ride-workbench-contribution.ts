/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ApplicationShell, open, OpenerService, WidgetManager } from '@theia/core/lib/browser';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { CommandContribution, CommandRegistry, CommandService, nls } from '@theia/core/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import {
    getRideMainMenu,
    getStoredRideLanguage,
    normalizeRideLanguage,
    RideLanguage,
    RIDE_LANGUAGE_COMMANDS,
    RIDE_LANGUAGE_STORAGE_KEY,
    RideNativeChrome,
    RideWindowControlAction,
    rideText,
    RideTextKey,
    getRideWindowControls
} from './ride-native-chrome';

const GETTING_STARTED_WIDGET_ID = 'getting.started.widget';

type RideChromeSwitchKind = 'left' | 'right' | 'bottom';

interface RideChromeSwitchAction {
    label: string;
    command?: string;
    icon: string;
    panel?: 'left' | 'right' | 'bottom';
    widgetId?: string;
    rank?: number;
}

@injectable()
export class RideWorkbenchContribution implements FrontendApplicationContribution, CommandContribution {

    protected readonly nativeChrome = new RideNativeChrome();

    protected fallbackMenu?: HTMLElement;

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

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(WindowService)
    protected readonly windowService: WindowService;

    onStart(): void {
        document.body.dataset.productShell = 'r-ide';
        document.body.dataset.rideRuntime = this.nativeChrome.isTauri ? 'tauri' : 'browser';
        document.body.dataset.ridePlatform = this.nativeChrome.platform;
        this.applyRideLanguage();
        this.nativeChrome.listenForNativeMenuCommands(command => this.handleMenuCommand(command)).catch(console.warn);
        this.installTopChromeWhenReady();
        this.applicationState.onStateChanged(state => {
            if (state === 'attached_shell' || state === 'initialized_layout') {
                this.releaseStartupOverlay();
                this.installTopChrome();
                this.applyRideLanguage();
            }
        });
        this.applicationState.reachedState('initialized_layout').then(() => this.installTopChromeWhenReady());
        this.applicationState.reachedState('ready').then(() => {
            this.releaseStartupOverlay();
            this.installTopChromeWhenReady();
            this.nativeChrome.notifyFrontendReady(this.getRideLanguage()).catch(console.warn);
            if (this.shouldRestoreDemoWorkbench()) {
                this.restoreDemoWorkbench().catch(console.warn);
                window.setTimeout(() => this.restoreDemoWorkbench().catch(console.warn), 1500);
            } else {
                this.configureLeanStartup().catch(console.warn);
            }
        });
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand({
            id: RIDE_LANGUAGE_COMMANDS.SET_CHINESE,
            label: rideText('zh-cn', 'languageChinese')
        }, {
            execute: () => this.setRideLanguage('zh-cn')
        });
        commands.registerCommand({
            id: RIDE_LANGUAGE_COMMANDS.SET_ENGLISH,
            label: rideText('en', 'languageEnglish')
        }, {
            execute: () => this.setRideLanguage('en')
        });
        commands.registerCommand({
            id: RIDE_LANGUAGE_COMMANDS.TOGGLE,
            label: 'Toggle R-IDE Language'
        }, {
            execute: () => this.setRideLanguage(this.getRideLanguage() === 'en' ? 'zh-cn' : 'en')
        });
    }

    protected installTopChromeWhenReady(attempts = 40): void {
        this.installTopChrome();
        this.applyRideLanguage();
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

        this.releaseStartupOverlay();
        topPanel.classList.add('ride-window-drag-surface');
        topPanel.setAttribute('data-tauri-drag-region', '');
        topPanel.addEventListener('mousedown', event => this.nativeChrome.startWindowDrag(event));
        topPanel.addEventListener('dblclick', event => this.toggleWindowFromChrome(event));

        const brand = document.createElement('button');
        brand.type = 'button';
        brand.className = 'ride-brand ride-menu-button';
        brand.setAttribute('aria-label', this.t('openRideMenu'));
        brand.setAttribute('aria-haspopup', 'menu');
        brand.setAttribute('data-no-drag', 'true');
        brand.appendChild(this.createIcon('codicon-menu'));
        brand.addEventListener('click', event => this.openMainMenu(event, brand));

        const leftSidebarControl = this.createPanelSplitButton({
            containerClass: 'ride-left-sidebar-control',
            iconClass: 'codicon-layout-sidebar-left',
            label: this.t('toggleLeftSidebar'),
            menuLabel: this.t('selectLeftSidebarMenu'),
            toggleCommand: 'core.toggle.left.panel',
            switchKind: 'left'
        });

        const commandCenter = document.createElement('button');
        commandCenter.type = 'button';
        commandCenter.className = 'ride-command-center';
        commandCenter.setAttribute('data-no-drag', 'true');
        commandCenter.setAttribute('aria-label', this.t('openCommandPalette'));
        commandCenter.appendChild(this.createIcon('codicon-search'));
        commandCenter.addEventListener('click', () => this.execute('workbench.action.showCommands'));

        const runButton = document.createElement('button');
        runButton.type = 'button';
        runButton.className = 'ride-run-button';
        runButton.setAttribute('data-no-drag', 'true');
        const runLabel = document.createElement('span');
        runLabel.className = 'ride-run-label';
        runLabel.textContent = this.t('run');
        runButton.append(this.createIcon('codicon-play'), runLabel, this.createIcon('codicon-chevron-down'));
        runButton.addEventListener('click', () => this.execute('workbench.action.debug.run'));

        const layoutActions = document.createElement('div');
        layoutActions.className = 'ride-layout-actions';
        layoutActions.setAttribute('data-no-drag', 'true');
        const bottomPanelControl = this.createPanelSplitButton({
            containerClass: 'ride-bottom-panel-control',
            iconClass: 'codicon-layout-panel',
            label: this.t('toggleBottomPanel'),
            menuLabel: this.t('selectBottomPanelMenu'),
            toggleCommand: 'core.toggle.bottom.panel',
            switchKind: 'bottom'
        });
        const rightSidebarControl = this.createPanelSplitButton({
            containerClass: 'ride-right-sidebar-control',
            iconClass: 'codicon-layout-sidebar-right',
            label: this.t('toggleRightSidebar'),
            menuLabel: this.t('selectRightSidebarMenu'),
            toggleCommand: 'core.toggle.right.panel',
            switchKind: 'right'
        });

        layoutActions.append(
            bottomPanelControl,
            rightSidebarControl
        );

        const windowControls = this.createWindowControls();
        if (windowControls.dataset.placement === 'left') {
            topPanel.prepend(windowControls, brand, leftSidebarControl);
            topPanel.append(commandCenter, runButton, layoutActions);
        } else {
            topPanel.prepend(brand, leftSidebarControl);
            topPanel.append(commandCenter, runButton, layoutActions, windowControls);
        }
    }

    protected releaseStartupOverlay(): void {
        document.body.classList.add('ride-shell-interactive');
        for (const overlay of Array.from(document.querySelectorAll<HTMLElement>('.theia-preload, .spinner-container'))) {
            overlay.setAttribute('aria-hidden', 'true');
        }
    }

    protected createIconButton(iconClass: string, label: string, command?: string): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ride-icon-button';
        button.title = label;
        button.setAttribute('aria-label', label);
        button.setAttribute('data-no-drag', 'true');
        button.appendChild(this.createIcon(iconClass));
        if (command) {
            button.addEventListener('click', () => this.execute(command));
        }
        return button;
    }

    protected createWindowControls(): HTMLElement {
        const layout = getRideWindowControls(this.nativeChrome.platform);
        const controls = document.createElement('div');
        controls.className = 'ride-window-controls';
        controls.dataset.placement = layout.placement;
        controls.setAttribute('role', 'group');
        controls.setAttribute('aria-label', this.t('window'));
        controls.setAttribute('data-no-drag', 'true');

        const icons: Record<RideWindowControlAction, string> = {
            close: 'codicon-chrome-close',
            minimize: 'codicon-chrome-minimize',
            toggleMaximize: 'codicon-chrome-maximize'
        };
        for (const action of layout.actions) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `ride-window-control ${action}`;
            button.title = this.t(action);
            button.setAttribute('aria-label', this.t(action));
            button.setAttribute('data-no-drag', 'true');
            button.appendChild(this.createIcon(icons[action]));
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                this.nativeChrome.runWindowAction(action).catch(error => {
                    console.warn(`[R-IDE] Window action failed: ${action}`, error);
                });
            });
            controls.appendChild(button);
        }
        return controls;
    }

    protected createIcon(iconClass: string): HTMLSpanElement {
        const icon = document.createElement('span');
        icon.classList.add('codicon', iconClass);
        return icon;
    }

    protected createPanelSplitButton(options: {
        containerClass: string;
        iconClass: string;
        label: string;
        menuLabel: string;
        toggleCommand: string;
        switchKind: RideChromeSwitchKind;
    }): HTMLElement {
        const group = document.createElement('div');
        group.className = `ride-split-control ${options.containerClass}`;
        group.setAttribute('data-no-drag', 'true');

        const toggle = this.createIconButton(options.iconClass, options.label, options.toggleCommand);
        toggle.classList.add('ride-split-main');

        const menu = this.createIconButton('codicon-chevron-down', options.menuLabel);
        menu.classList.add('ride-split-menu');
        menu.setAttribute('aria-haspopup', 'menu');
        menu.addEventListener('click', event => this.openChromeSwitchMenu(event, menu, options.switchKind));

        group.append(toggle, menu);
        return group;
    }

    protected async openMainMenu(event: MouseEvent, anchor: HTMLElement): Promise<void> {
        event.preventDefault();
        event.stopPropagation();
        this.closeFallbackMenu();

        if (await this.nativeChrome.showNativeMenu(anchor, this.getRideLanguage())) {
            return;
        }

        this.openFallbackMenu(anchor);
    }

    protected openFallbackMenu(anchor: HTMLElement): void {
        const menu = document.createElement('div');
        menu.className = 'ride-fallback-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('data-no-drag', 'true');

        for (const group of getRideMainMenu(this.getRideLanguage())) {
            const section = document.createElement('section');
            section.className = 'ride-fallback-menu-section';
            const header = document.createElement('div');
            header.className = 'ride-fallback-menu-heading';
            header.textContent = group.label;
            section.appendChild(header);

            for (const action of group.actions) {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'ride-fallback-menu-item';
                item.setAttribute('role', 'menuitem');
                const label = document.createElement('span');
                label.textContent = action.label;
                item.appendChild(label);
                item.addEventListener('click', () => {
                    this.closeFallbackMenu();
                    this.handleMenuCommand(action.command);
                });
                section.appendChild(item);
            }

            menu.appendChild(section);
        }

        document.body.appendChild(menu);
        this.positionChromePopup(menu, anchor);
        this.fallbackMenu = menu;

        window.setTimeout(() => {
            document.addEventListener('mousedown', this.closeFallbackMenuOnOutsideClick, { capture: true });
            document.addEventListener('keydown', this.closeFallbackMenuOnEscape, { capture: true });
        }, 0);
    }

    protected openChromeSwitchMenu(event: MouseEvent, anchor: HTMLElement, kind: RideChromeSwitchKind): void {
        event.preventDefault();
        event.stopPropagation();
        this.closeFallbackMenu();

        const menu = document.createElement('div');
        menu.className = 'ride-fallback-menu ride-switch-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('data-no-drag', 'true');
        menu.dataset.switchKind = kind;

        const section = document.createElement('section');
        section.className = 'ride-fallback-menu-section';
        const header = document.createElement('div');
        header.className = 'ride-fallback-menu-heading';
        header.textContent = kind === 'left' ? this.t('leftSidebar') : kind === 'right' ? this.t('rightSidebar') : this.t('bottomPanel');
        section.appendChild(header);

        for (const action of this.getChromeSwitchActions(kind)) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'ride-fallback-menu-item ride-switch-menu-item';
            item.setAttribute('role', 'menuitem');
            const label = document.createElement('span');
            label.textContent = action.label;
            item.append(this.createIcon(action.icon), label);
            item.addEventListener('click', () => {
                this.closeFallbackMenu();
                this.activateChromeSwitchAction(action).catch(console.warn);
            });
            section.appendChild(item);
        }

        menu.appendChild(section);
        document.body.appendChild(menu);
        this.positionChromePopup(menu, anchor);
        this.fallbackMenu = menu;

        window.setTimeout(() => {
            document.addEventListener('mousedown', this.closeFallbackMenuOnOutsideClick, { capture: true });
            document.addEventListener('keydown', this.closeFallbackMenuOnEscape, { capture: true });
        }, 0);
    }

    protected getChromeSwitchActions(kind: RideChromeSwitchKind): RideChromeSwitchAction[] {
        if (kind === 'left') {
            return [
                { label: this.t('explorer'), command: 'fileNavigator:toggle', icon: 'codicon-files', panel: 'left', rank: 100 },
                { label: this.t('search'), command: 'search-in-workspace.toggle', icon: 'codicon-search', panel: 'left', rank: 200 },
                { label: this.t('sourceControl'), command: 'scmView:toggle', icon: 'codicon-source-control', panel: 'left', rank: 300 },
                { label: this.t('runAndDebug'), command: 'debug:toggle', icon: 'codicon-debug-alt', panel: 'left', rank: 400 },
                { label: this.t('extensions'), command: 'vsxExtensions.toggle', icon: 'codicon-extensions', panel: 'left', rank: 500 },
                { label: this.t('testExplorer'), icon: 'codicon-beaker', panel: 'left', widgetId: 'test-view-container', rank: 600 }
            ];
        }

        if (kind === 'right') {
            return [
                { label: this.t('aiAssistant'), command: 'aiChat:toggle', icon: 'codicon-comment-discussion', panel: 'right' },
                { label: this.t('outline'), command: 'outlineView:toggle', icon: 'codicon-list-tree', panel: 'right' },
                { label: this.t('memoryInspector'), command: 'memory-inspector-command', icon: 'codicon-symbol-number', panel: 'right' },
                { label: this.t('toggleRightSidebar'), command: 'core.toggle.right.panel', icon: 'codicon-layout-sidebar-right' }
            ];
        }

        return [
            { label: this.t('terminal'), command: 'workbench.action.terminal.toggleTerminal', icon: 'codicon-terminal', panel: 'bottom' },
            { label: this.t('problems'), command: 'problemsView:toggle', icon: 'codicon-warning', panel: 'bottom' },
            { label: this.t('output'), command: 'output:toggle', icon: 'codicon-output', panel: 'bottom' },
            { label: this.t('debugConsole'), command: 'debug:console:toggle', icon: 'codicon-debug-console', panel: 'bottom' },
            { label: this.t('toggleBottomPanel'), command: 'core.toggle.bottom.panel', icon: 'codicon-layout-panel' }
        ];
    }

    protected async activateChromeSwitchAction(action: RideChromeSwitchAction): Promise<void> {
        if (action.command) {
            await this.execute(action.command, true);
        }
        if (action.widgetId && action.panel) {
            await this.openChromeSwitchWidget(action);
        }
        if (action.panel) {
            this.shell.expandPanel(action.panel);
            this.shell.resize(this.getPanelSize(action.panel), action.panel);
            this.applySidePanelTitles();
        }
    }

    protected async openChromeSwitchWidget(action: RideChromeSwitchAction): Promise<void> {
        if (!action.widgetId || !action.panel) {
            return;
        }
        const widget = await this.widgetManager.getOrCreateWidget(action.widgetId);
        if (!widget.isAttached) {
            await this.shell.addWidget(widget, { area: action.panel, rank: action.rank });
        }
        await this.shell.activateWidget(widget.id);
    }

    protected getPanelSize(panel: 'left' | 'right' | 'bottom'): number {
        if (panel === 'left') {
            return 292;
        }
        if (panel === 'right') {
            return 330;
        }
        return 220;
    }

    protected positionChromePopup(menu: HTMLElement, anchor: HTMLElement): void {
        const rect = anchor.getBoundingClientRect();
        const margin = 8;
        const top = Math.min(rect.bottom + 7, window.innerHeight - menu.offsetHeight - margin);
        const preferredLeft = rect.left > window.innerWidth / 2 ? rect.right - menu.offsetWidth : rect.left;
        const left = Math.max(margin, Math.min(preferredLeft, window.innerWidth - menu.offsetWidth - margin));
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(Math.max(margin, top))}px`;
    }

    protected closeFallbackMenuOnOutsideClick = (event: MouseEvent): void => {
        if (event.target instanceof Node && this.fallbackMenu?.contains(event.target)) {
            return;
        }
        this.closeFallbackMenu();
    };

    protected closeFallbackMenuOnEscape = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
            this.closeFallbackMenu();
        }
    };

    protected closeFallbackMenu(): void {
        this.fallbackMenu?.remove();
        this.fallbackMenu = undefined;
        document.removeEventListener('mousedown', this.closeFallbackMenuOnOutsideClick, { capture: true });
        document.removeEventListener('keydown', this.closeFallbackMenuOnEscape, { capture: true });
    }

    protected handleMenuCommand(command: string): void {
        if (command === 'ride.window.minimize') {
            this.nativeChrome.runWindowAction('minimize').catch(console.warn);
            return;
        }
        if (command === 'ride.window.toggleMaximize') {
            this.nativeChrome.runWindowAction('toggleMaximize').catch(console.warn);
            return;
        }
        if (command === RIDE_LANGUAGE_COMMANDS.SET_ENGLISH) {
            this.setRideLanguage('en');
            return;
        }
        if (command === RIDE_LANGUAGE_COMMANDS.SET_CHINESE) {
            this.setRideLanguage('zh-cn');
            return;
        }
        if (command === RIDE_LANGUAGE_COMMANDS.TOGGLE) {
            this.setRideLanguage(this.getRideLanguage() === 'en' ? 'zh-cn' : 'en');
            return;
        }
        this.execute(command, true);
    }

    protected toggleWindowFromChrome(event: MouseEvent): void {
        const target = event.target instanceof HTMLElement ? event.target : undefined;
        if (target?.closest('button, input, label, a, textarea, select, [data-no-drag], .lm-MenuBar, .lm-Menu')) {
            return;
        }
        this.nativeChrome.runWindowAction('toggleMaximize').catch(console.warn);
    }

    protected getRideLanguage(): RideLanguage {
        return getStoredRideLanguage();
    }

    protected t(key: RideTextKey): string {
        return rideText(this.getRideLanguage(), key);
    }

    protected setRideLanguage(language: RideLanguage): void {
        const target = normalizeRideLanguage(language);
        const previous = window.localStorage.getItem(RIDE_LANGUAGE_STORAGE_KEY);
        const alreadyStored = previous ? normalizeRideLanguage(previous) === target : false;
        window.localStorage.setItem(RIDE_LANGUAGE_STORAGE_KEY, target);
        nls.setLocale(target);
        document.documentElement.setAttribute('lang', target === 'zh-cn' ? 'zh-CN' : 'en');
        this.applyRideLanguage();
        if (!alreadyStored) {
            this.windowService.setSafeToShutDown();
            this.windowService.reload();
        }
    }

    protected applyRideLanguage(): void {
        const language = this.getRideLanguage();
        document.body.dataset.rideLanguage = language;
        document.documentElement.setAttribute('lang', language === 'zh-cn' ? 'zh-CN' : 'en');
        this.updateButtonLabel('.ride-brand.ride-menu-button', this.t('openRideMenu'));
        this.updateButtonLabel('.ride-command-center', this.t('openCommandPalette'));
        this.updateButtonLabel('.ride-left-sidebar-control .ride-split-main', this.t('toggleLeftSidebar'));
        this.updateButtonLabel('.ride-left-sidebar-control .ride-split-menu', this.t('selectLeftSidebarMenu'));
        this.updateButtonLabel('.ride-bottom-panel-control .ride-split-main', this.t('toggleBottomPanel'));
        this.updateButtonLabel('.ride-bottom-panel-control .ride-split-menu', this.t('selectBottomPanelMenu'));
        this.updateButtonLabel('.ride-right-sidebar-control .ride-split-main', this.t('toggleRightSidebar'));
        this.updateButtonLabel('.ride-right-sidebar-control .ride-split-menu', this.t('selectRightSidebarMenu'));
        const runLabel = document.querySelector<HTMLElement>('.ride-run-label');
        if (runLabel) {
            runLabel.textContent = this.t('run');
        }
        this.applyMenuLabels();
        this.applySidePanelTitles();
    }

    protected updateButtonLabel(selector: string, label: string): void {
        const button = document.querySelector<HTMLElement>(selector);
        if (button) {
            button.title = label;
            button.setAttribute('aria-label', label);
        }
    }

    protected menuBarLabel(key: RideTextKey, mnemonic: string): string {
        return this.getRideLanguage() === 'zh-cn' ? `${this.t(key)}(${mnemonic})` : this.t(key);
    }

    protected applyMenuLabels(): void {
        const labels = new Map<string, string>([
            ['File', this.menuBarLabel('file', 'F')],
            ['文件(F)', this.menuBarLabel('file', 'F')],
            ['Edit', this.menuBarLabel('edit', 'E')],
            ['编辑(E)', this.menuBarLabel('edit', 'E')],
            ['Selection', this.getRideLanguage() === 'zh-cn' ? '选择(S)' : 'Selection'],
            ['选择(S)', this.getRideLanguage() === 'zh-cn' ? '选择(S)' : 'Selection'],
            ['View', this.menuBarLabel('view', 'V')],
            ['查看(V)', this.menuBarLabel('view', 'V')],
            ['Go', this.menuBarLabel('go', 'G')],
            ['跳转(G)', this.menuBarLabel('go', 'G')],
            ['Run', this.menuBarLabel('run', 'R')],
            ['运行(R)', this.menuBarLabel('run', 'R')],
            ['Terminal', this.menuBarLabel('terminal', 'T')],
            ['终端(T)', this.menuBarLabel('terminal', 'T')],
            ['Help', this.menuBarLabel('help', 'H')],
            ['帮助(H)', this.menuBarLabel('help', 'H')]
        ]);
        const relabel = () => {
            for (const label of Array.from(document.querySelectorAll<HTMLElement>('.lm-MenuBar-itemLabel'))) {
                const text = label.textContent?.trim();
                const translated = text ? labels.get(text) : undefined;
                if (translated && label.textContent !== translated) {
                    label.textContent = translated;
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
        this.applySidePanelTitles();
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
        await this.shell.closeWidget(GETTING_STARTED_WIDGET_ID, { save: false }).catch(() => undefined);
        await this.shell.collapsePanel('bottom').catch(() => undefined);
        await this.shell.collapsePanel('right').catch(() => undefined);
        this.applySidePanelTitles();
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

    protected applySidePanelTitles(): void {
        const labels = new Map<string, string>([
            ['EXPLORER', this.t('explorer')],
            ['Explorer', this.t('explorer')],
            ['资源管理器', this.t('explorer')],
            ['Open Editors', this.t('openEditors')],
            ['SOURCE CONTROL', this.t('sourceControl')],
            ['Source Control', this.t('sourceControl')],
            ['源代码管理', this.t('sourceControl')],
            ['AI CHAT', this.t('aiAssistant')],
            ['AI Chat', this.t('aiAssistant')],
            ['AI 助手', this.t('aiAssistant')],
            ['OUTLINE', this.t('outline')],
            ['Outline', this.t('outline')],
            ['大纲', this.t('outline')],
            ['PROBLEMS', this.t('problems')],
            ['Problems', this.t('problems')],
            ['问题', this.t('problems')],
            ['EXTENSIONS', this.t('extensions')],
            ['Extensions', this.t('extensions')],
            ['扩展', this.t('extensions')],
            ['SETTINGS', this.t('settings')],
            ['Settings', this.t('settings')],
            ['设置', this.t('settings')],
            ['TIMELINE', this.t('timeline')],
            ['Timeline', this.t('timeline')],
            ['时间线', this.t('timeline')]
        ]);
        for (const label of Array.from(document.querySelectorAll<HTMLElement>('.theia-sidepanel-title'))) {
            const text = label.textContent?.trim();
            const localized = text ? labels.get(text) : undefined;
            if (localized) {
                label.textContent = localized;
            }
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
