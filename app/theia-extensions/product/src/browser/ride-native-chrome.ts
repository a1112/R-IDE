/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { invoke as tauriInvoke, isTauri as isTauriRuntime } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { injectable, unmanaged } from '@theia/core/shared/inversify';
import type { RideOpenRequest } from './ride-open-request';
import type { RidePerformanceSnapshot, RideUsageGroup } from './ride-performance';

export interface RideMenuAction {
    label: string;
    command: string;
}

export interface RideMenuGroup {
    label: string;
    actions: RideMenuAction[];
}

export type RideLanguage = 'en' | 'zh-cn';

interface NativeMenuPayload {
    command: string;
}

export type RidePlatform = 'macos' | 'windows' | 'linux' | 'unknown';
export type RideWindowControlAction = 'close' | 'minimize' | 'toggleMaximize';

export interface RideWindowControlLayout {
    placement: 'left' | 'right';
    actions: RideWindowControlAction[];
}

export function getRideWindowControls(platform: RidePlatform): RideWindowControlLayout {
    if (platform === 'macos') {
        return {
            placement: 'left',
            actions: ['close', 'minimize', 'toggleMaximize']
        };
    }
    return {
        placement: 'right',
        actions: ['minimize', 'toggleMaximize', 'close']
    };
}
type RideOpenRequestListener = (
    event: string,
    handler: (event: { payload: RideOpenRequest }) => void
) => Promise<() => void>;

let resolveFrontendReadyNotification!: () => void;
const frontendReadyNotification = new Promise<void>(resolve => {
    resolveFrontendReadyNotification = resolve;
});

export interface RideNativeChromeOptions {
    isTauri?: boolean;
    platform?: RidePlatform;
    listen?: RideOpenRequestListener;
    invoke?: RideNativeInvoke;
}

export type RideNativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export const RIDE_LANGUAGE_STORAGE_KEY = 'localeId';

export const RIDE_LANGUAGE_COMMANDS = {
    SET_ENGLISH: 'ride.language.en',
    SET_CHINESE: 'ride.language.zh-cn',
    TOGGLE: 'ride.language.toggle'
};

export const RIDE_TEXT = {
    en: {
        aiAssistant: 'AI Assistant',
        aiPrompt: 'How can I optimize this logic?',
        aiSuggestionIntro: 'You can consider these improvements:',
        askAssistant: 'Ask R-IDE Assistant...',
        bottomPanel: 'Bottom Panel',
        cacheSuggestion: 'Use caching to reduce database queries',
        close: 'Close',
        closeAllEditors: 'Close All Editors',
        closeEditor: 'Close Editor',
        commandPalette: 'Command Palette...',
        configureDisplayLanguage: 'Configure Display Language...',
        copy: 'Copy',
        cut: 'Cut',
        debugConsole: 'Debug Console',
        documentation: 'Documentation',
        edit: 'Edit',
        explorer: 'Explorer',
        extensions: 'Extensions',
        file: 'File',
        find: 'Find',
        go: 'Go',
        help: 'Help',
        inspectDetails: 'View Details',
        language: 'Language',
        languageEnglish: 'English',
        languageChinese: 'Chinese (Simplified)',
        leftSidebar: 'Left Sidebar',
        memoryInspector: 'Memory Inspector',
        minimize: 'Minimize',
        newFile: 'New File',
        newTerminal: 'New Terminal',
        newWorkspaceTerminal: 'New Terminal in Workspace',
        openCommandPalette: 'Open command palette',
        openEditors: '',
        openFile: 'Open File...',
        openFolder: 'Open Folder...',
        openRecent: 'Open Recent',
        openRideMenu: 'Open R-IDE menu',
        outline: 'Outline',
        output: 'Output',
        paste: 'Paste',
        problems: 'Problems',
        quickOpen: 'Quick Open...',
        redo: 'Redo',
        reportIssue: 'Report Issue',
        rightSidebar: 'Right Sidebar',
        run: 'Run',
        runAndDebug: 'Run and Debug',
        save: 'Save',
        saveAll: 'Save All',
        search: 'Search',
        securitySuggestion: 'Avoid unnecessary object creation',
        selectLeftSidebarMenu: 'Toggle left sidebar menu',
        selectBottomPanelMenu: 'Toggle bottom panel menu',
        selectRightSidebarMenu: 'Toggle right sidebar menu',
        settings: 'Settings',
        sourceControl: 'Source Control',
        startDebugging: 'Start Debugging',
        testExplorer: 'Test Explorer',
        terminal: 'Terminal',
        timeline: 'Timeline',
        toggleBottomPanel: 'Toggle Bottom Panel',
        toggleLeftSidebar: 'Toggle Left Sidebar',
        toggleMaximize: 'Maximize/Restore',
        toggleRightSidebar: 'Toggle Right Sidebar',
        undo: 'Undo',
        useIndexSuggestion: 'Use indexes appropriately',
        usePoolSuggestion: 'Reuse connections with a pool',
        view: 'View',
        window: 'Window'
    },
    'zh-cn': {
        aiAssistant: 'AI 助手',
        aiPrompt: '如何优化这段处理逻辑的性能?',
        aiSuggestionIntro: '可以考虑以下优化方向:',
        askAssistant: '询问 R-IDE Assistant...',
        bottomPanel: '底部栏',
        cacheSuggestion: '使用缓存减少数据库查询',
        close: '关闭',
        closeAllEditors: '关闭所有编辑器',
        closeEditor: '关闭编辑器',
        commandPalette: '命令面板...',
        configureDisplayLanguage: '更多显示语言...',
        copy: '复制',
        cut: '剪切',
        debugConsole: '调试控制台',
        documentation: '文档',
        edit: '编辑',
        explorer: '资源管理器',
        extensions: '扩展',
        file: '文件',
        find: '查找',
        go: '跳转',
        help: '帮助',
        inspectDetails: '查看详细建议',
        language: '语言',
        languageEnglish: 'English',
        languageChinese: '简体中文',
        leftSidebar: '左侧栏',
        memoryInspector: '内存检查器',
        minimize: '最小化',
        newFile: '新建文件',
        newTerminal: '新建终端',
        newWorkspaceTerminal: '在工作区中新建终端',
        openCommandPalette: '打开命令面板',
        openEditors: '',
        openFile: '打开文件...',
        openFolder: '打开文件夹...',
        openRecent: '打开最近',
        openRideMenu: '打开 R-IDE 菜单',
        outline: '大纲',
        output: '输出',
        paste: '粘贴',
        problems: '问题',
        quickOpen: '快速打开...',
        redo: '重做',
        reportIssue: '报告问题',
        rightSidebar: '右侧栏',
        run: '运行',
        runAndDebug: '运行和调试',
        save: '保存',
        saveAll: '全部保存',
        search: '搜索',
        securitySuggestion: '避免不必要的对象创建',
        selectLeftSidebarMenu: '左侧栏功能菜单',
        selectBottomPanelMenu: '底部栏功能菜单',
        selectRightSidebarMenu: '右侧栏功能菜单',
        settings: '设置',
        sourceControl: '源代码管理',
        startDebugging: '开始调试',
        testExplorer: '测试',
        terminal: '终端',
        timeline: '时间线',
        toggleBottomPanel: '切换底部面板',
        toggleLeftSidebar: '切换左侧栏',
        toggleMaximize: '最大化/还原',
        toggleRightSidebar: '切换右侧栏',
        undo: '撤销',
        useIndexSuggestion: '合理使用索引',
        usePoolSuggestion: '使用连接池复用连接',
        view: '视图',
        window: '窗口'
    }
} as const;

export type RideTextKey = keyof typeof RIDE_TEXT.en;

function parseRideLanguage(language?: string | null): RideLanguage | undefined {
    const normalized = language?.toLowerCase().replace('_', '-');
    if (!normalized) {
        return undefined;
    }
    if (normalized?.startsWith('en')) {
        return 'en';
    }
    if (normalized?.startsWith('zh')) {
        return 'zh-cn';
    }
    return undefined;
}

export function normalizeRideLanguage(language?: string | null): RideLanguage {
    return parseRideLanguage(language) ?? 'en';
}

export function getSystemRideLanguage(): RideLanguage {
    if (typeof navigator === 'undefined') {
        return 'en';
    }

    const languages = [
        new URLSearchParams(window.location.search).get('ride_locale'),
        ...(Array.isArray(navigator.languages) ? navigator.languages : []),
        navigator.language
    ];
    for (const language of languages) {
        const rideLanguage = parseRideLanguage(language);
        if (rideLanguage) {
            return rideLanguage;
        }
    }
    return 'en';
}

export function getStoredRideLanguage(): RideLanguage {
    const locale = typeof window === 'object' ? window.localStorage.getItem(RIDE_LANGUAGE_STORAGE_KEY) : undefined;
    return parseRideLanguage(locale) ?? getSystemRideLanguage();
}

export function rideText(language: RideLanguage, key: RideTextKey): string {
    return RIDE_TEXT[language][key];
}

export function getRideMainMenu(language: RideLanguage = getStoredRideLanguage()): RideMenuGroup[] {
    const selected = (target: RideLanguage, label: string): string => language === target ? `✓ ${label}` : label;
    const t = (key: RideTextKey): string => rideText(language, key);
    return [
        {
            label: t('file'),
            actions: [
                { label: t('newFile'), command: 'workbench.action.files.newUntitledFile' },
                { label: t('openFile'), command: 'workspace:openFile' },
                { label: t('openFolder'), command: 'workspace:openFolder' },
                { label: t('openRecent'), command: 'workspace:openRecent' },
                { label: t('save'), command: 'core.save' },
                { label: t('saveAll'), command: 'core.saveAll' }
            ]
        },
        {
            label: t('edit'),
            actions: [
                { label: t('undo'), command: 'core.undo' },
                { label: t('redo'), command: 'core.redo' },
                { label: t('cut'), command: 'core.cut' },
                { label: t('copy'), command: 'core.copy' },
                { label: t('paste'), command: 'core.paste' },
                { label: t('find'), command: 'core.find' }
            ]
        },
        {
            label: t('view'),
            actions: [
                { label: t('commandPalette'), command: 'workbench.action.showCommands' },
                { label: t('quickOpen'), command: 'workbench.action.quickOpen' },
                { label: t('explorer'), command: 'fileNavigator:toggle' },
                { label: t('toggleLeftSidebar'), command: 'core.toggle.left.panel' },
                { label: t('toggleBottomPanel'), command: 'core.toggle.bottom.panel' },
                { label: t('toggleRightSidebar'), command: 'core.toggle.right.panel' }
            ]
        },
        {
            label: t('run'),
            actions: [
                { label: t('run'), command: 'workbench.action.debug.run' },
                { label: t('startDebugging'), command: 'workbench.action.debug.start' },
                { label: t('newTerminal'), command: 'terminal:new' },
                { label: t('newWorkspaceTerminal'), command: 'terminal:new:active:workspace' }
            ]
        },
        {
            label: t('window'),
            actions: [
                { label: t('minimize'), command: 'ride.window.minimize' },
                { label: t('toggleMaximize'), command: 'ride.window.toggleMaximize' },
                { label: t('closeEditor'), command: 'workbench.action.closeActiveEditor' },
                { label: t('closeAllEditors'), command: 'workbench.action.closeAllEditors' }
            ]
        },
        {
            label: t('language'),
            actions: [
                { label: selected('zh-cn', t('languageChinese')), command: RIDE_LANGUAGE_COMMANDS.SET_CHINESE },
                { label: selected('en', t('languageEnglish')), command: RIDE_LANGUAGE_COMMANDS.SET_ENGLISH },
                { label: t('configureDisplayLanguage'), command: 'workbench.action.configureLanguage' }
            ]
        },
        {
            label: t('help'),
            actions: [
                { label: t('settings'), command: 'workbench.action.openGlobalSettings' },
                { label: t('documentation'), command: 'theia-ide:documentation' },
                { label: t('reportIssue'), command: 'theia-ide:report-issue' }
            ]
        }
    ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && Object(value) === value && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isUsageGroup(value: unknown): value is RideUsageGroup {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.cpuPercent === 'number'
        && Number.isFinite(value.cpuPercent)
        && value.cpuPercent >= 0
        && value.cpuPercent <= 100
        && isNonNegativeSafeInteger(value.memoryBytes)
        && isNonNegativeSafeInteger(value.processCount);
}

function isPerformanceSnapshot(value: unknown): value is RidePerformanceSnapshot {
    if (!isRecord(value) || !isNonNegativeSafeInteger(value.sampledAtMs)) {
        return false;
    }
    return isUsageGroup(value.total)
        && isUsageGroup(value.main)
        && isUsageGroup(value.backend)
        && isUsageGroup(value.pluginHost)
        && isUsageGroup(value.other);
}

@injectable()
export class RideNativeChrome {
    readonly isTauri: boolean;
    readonly platform: RidePlatform;

    protected readonly openRequestListener: RideOpenRequestListener;
    protected readonly invoke: RideNativeInvoke;

    constructor(@unmanaged() options: RideNativeChromeOptions = {}) {
        this.isTauri = options.isTauri ?? (typeof window === 'object' && isTauriRuntime());
        this.platform = options.platform ?? this.resolvePlatform();
        this.openRequestListener = options.listen ?? ((event, handler) => listen<RideOpenRequest>(event, handler));
        this.invoke = options.invoke ?? ((command, args) => tauriInvoke<unknown>(command, args));
    }

    async showNativeMenu(anchor: HTMLElement, language: RideLanguage = getStoredRideLanguage()): Promise<boolean> {
        if (!this.isTauri) {
            return false;
        }

        const rect = anchor.getBoundingClientRect();
        try {
            await this.invoke('ride_show_main_menu', {
                request: {
                    x: Math.round(rect.left),
                    y: Math.round(rect.bottom + 2),
                    language
                }
            });
            return true;
        } catch (error) {
            console.warn('[R-IDE] Native menu failed, falling back to web menu.', error);
            return false;
        }
    }

    async startWindowDrag(event: MouseEvent): Promise<void> {
        if (!this.isTauri || event.button !== 0 || event.detail > 1) {
            return;
        }

        const target = event.target instanceof HTMLElement ? event.target : undefined;
        if (target?.closest('button, input, label, a, textarea, select, [data-no-drag], .lm-MenuBar, .lm-Menu')) {
            return;
        }

        try {
            await this.invoke('ride_start_window_drag');
        } catch {
            // Browser preview and non-Tauri shells do not expose native dragging.
        }
    }

    async runWindowAction(action: 'close' | 'minimize' | 'toggleMaximize'): Promise<void> {
        if (!this.isTauri) {
            return;
        }

        await this.invoke('ride_window_control', { action }).catch(error => {
            console.warn(`[R-IDE] Window action failed: ${action}`, error);
        });
    }

    async notifyFrontendReady(locale: RideLanguage): Promise<void> {
        try {
            if (!this.isTauri) {
                return;
            }

            await this.invoke('ride_frontend_ready', { locale }).catch(error => {
                console.warn('[R-IDE] Failed to report frontend readiness.', error);
            });
        } finally {
            // RideWorkbenchContribution and RideOpenRequestContribution use
            // separate instances. This module-scoped latch closes the native
            // initial-intent delivery window for both of them.
            resolveFrontendReadyNotification();
        }
    }

    waitForFrontendReadyNotification(): Promise<void> {
        return frontendReadyNotification;
    }

    async getPluginDirectories(): Promise<string[]> {
        if (!this.isTauri) {
            return [];
        }
        const directories = await this.invoke('ride_plugin_directories');
        if (!Array.isArray(directories) || directories.some(directory => typeof directory !== 'string')) {
            throw new Error('R-IDE received invalid native plugin directories.');
        }
        return directories;
    }

    async getPerformanceSnapshot(): Promise<RidePerformanceSnapshot | undefined> {
        if (!this.isTauri) {
            return undefined;
        }
        const snapshot = await this.invoke('ride_performance_snapshot');
        if (!isPerformanceSnapshot(snapshot)) {
            throw new Error('R-IDE received an invalid native performance snapshot.');
        }
        return snapshot;
    }

    async listenForNativeMenuCommands(handler: (command: string) => void): Promise<() => void> {
        if (!this.isTauri) {
            return () => undefined;
        }

        return listen<NativeMenuPayload>('ride-native-menu-command', event => {
            const command = event.payload?.command;
            if (command) {
                handler(command);
            }
        });
    }

    async listenForOpenRequests(handler: (request: RideOpenRequest) => void): Promise<() => void> {
        if (!this.isTauri) {
            return () => undefined;
        }

        return this.openRequestListener('ride-open-request', event => handler(event.payload));
    }

    protected resolvePlatform(): RidePlatform {
        if (typeof navigator === 'undefined') {
            return 'unknown';
        }
        const navigatorWithData = navigator as Navigator & {
            userAgentData?: {
                platform?: string;
            };
        };
        const value = `${navigatorWithData.userAgentData?.platform ?? ''} ${navigator.userAgent}`.toLowerCase();
        if (value.includes('mac')) {
            return 'macos';
        }
        if (value.includes('win')) {
            return 'windows';
        }
        if (value.includes('linux') || value.includes('x11')) {
            return 'linux';
        }
        return 'unknown';
    }
}
