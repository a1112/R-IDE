/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { FrontendApplication } from '@theia/core/lib/browser';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import type { KeybindingRegistry } from '@theia/core/lib/browser/keybinding';
import type { TabBarToolbarRegistry } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import type { RenderedToolbarAction } from '@theia/core/lib/browser/shell/tab-bar-toolbar/tab-bar-toolbar-types';
import type { Command, CommandHandler, CommandRegistry } from '@theia/core/lib/common/command';
import type { Disposable } from '@theia/core/lib/common/disposable';
import type { MenuModelRegistry } from '@theia/core/lib/common/menu';
import type { MessageService } from '@theia/core/lib/common/message-service';
import type { MaybePromise } from '@theia/core/lib/common/types';
import type { interfaces } from '@theia/core/shared/inversify';

export enum RideDeferredContributionType {
    Commands = 'CommandContribution',
    Menus = 'MenuContribution',
    Keybindings = 'KeybindingContribution',
    TabBarToolbar = 'TabBarToolbarContribution',
    FrontendApplication = 'FrontendApplicationContribution'
}

export type RideDeferredRegistrationResult = void | Disposable | readonly Disposable[];

export interface RideDeferredFeatureModule {
    readonly contributionTypes: readonly RideDeferredContributionType[];
    readonly registerCommands?: (commands: CommandRegistry) => MaybePromise<RideDeferredRegistrationResult>;
    readonly registerMenus?: (menus: MenuModelRegistry) => MaybePromise<RideDeferredRegistrationResult>;
    readonly registerKeybindings?: (keybindings: KeybindingRegistry) => MaybePromise<RideDeferredRegistrationResult>;
    readonly registerToolbarItems?: (toolbar: TabBarToolbarRegistry) => MaybePromise<RideDeferredRegistrationResult>;
    readonly initialize?: () => MaybePromise<void>;
    readonly configure?: (application: FrontendApplication) => MaybePromise<void>;
    readonly onStart?: (application: FrontendApplication) => MaybePromise<void>;
    readonly onStop?: (application: FrontendApplication) => void;
    readonly dispose?: () => void;
}

export interface RideDeferredFeature {
    readonly id: string;
    readonly load: () => Promise<RideDeferredFeatureModule>;
    readonly activate: (module: RideDeferredFeatureModule) => Promise<void>;
}

export interface RideDeferredCommandProxyOptions {
    readonly id: string;
    readonly command: Command;
    readonly toolbarItem: RenderedToolbarAction;
    readonly load: () => Promise<RideDeferredFeatureModule>;
    readonly isEnabled?: (...args: unknown[]) => boolean;
    readonly isVisible?: (...args: unknown[]) => boolean;
}

export class RideDeferredCommandProxy implements FrontendApplicationContribution, Disposable {
    protected commands: CommandRegistry | undefined;
    protected toolbar: TabBarToolbarRegistry | undefined;
    protected commandRegistration: Disposable | undefined;
    protected toolbarRegistration: Disposable | undefined;
    protected disposed = false;
    protected readonly feature: RideDeferredFeature;

    constructor(
        protected readonly loader: RideDeferredFeatureLoader,
        protected readonly options: RideDeferredCommandProxyOptions
    ) {
        this.feature = {
            id: options.id,
            load: options.load,
            activate: module => this.activateModule(module)
        };
    }

    registerCommands(commands: CommandRegistry): void {
        if (this.disposed) {
            return;
        }
        this.commands = commands;
        this.registerCommandProxy();
    }

    registerToolbarItems(toolbar: TabBarToolbarRegistry): void {
        if (this.disposed) {
            return;
        }
        this.toolbar = toolbar;
        this.registerToolbarProxy();
    }

    protected registerCommandProxy(): void {
        if (!this.commands || this.commandRegistration) {
            return;
        }
        const handler: CommandHandler = {
            execute: (...args: unknown[]) => this.execute(...args)
        };
        if (this.options.isEnabled) {
            handler.isEnabled = (...args: unknown[]) => this.options.isEnabled!(...args);
        }
        if (this.options.isVisible) {
            handler.isVisible = (...args: unknown[]) => this.options.isVisible!(...args);
        }
        this.commandRegistration = this.commands.registerCommand(this.options.command, handler);
    }

    protected registerToolbarProxy(): void {
        if (!this.toolbar || this.toolbarRegistration) {
            return;
        }
        this.toolbarRegistration = this.toolbar.registerItem(this.options.toolbarItem);
    }

    protected async execute(...args: unknown[]): Promise<unknown> {
        await this.loader.activate(this.feature);
        return this.commands?.executeCommand(this.options.command.id, ...args);
    }

    protected async activateModule(module: RideDeferredFeatureModule): Promise<void> {
        this.releaseProxyRegistrations();
        try {
            await this.loader.activateModule(module);
        } catch (error) {
            if (!this.disposed && !this.loader.isDisposed) {
                this.registerCommandProxy();
                this.registerToolbarProxy();
            }
            throw error;
        }
    }

    protected releaseProxyRegistrations(): void {
        this.toolbarRegistration?.dispose();
        this.toolbarRegistration = undefined;
        this.commandRegistration?.dispose();
        this.commandRegistration = undefined;
    }

    dispose(): void {
        this.disposed = true;
        this.releaseProxyRegistrations();
    }

    onStop(): void {
        this.dispose();
    }
}

export interface RideDeferredFeatureLoaderBindingIdentifiers {
    readonly commands: interfaces.ServiceIdentifier<CommandRegistry>;
    readonly menus: interfaces.ServiceIdentifier<MenuModelRegistry>;
    readonly keybindings: interfaces.ServiceIdentifier<KeybindingRegistry>;
    readonly toolbar: interfaces.ServiceIdentifier<TabBarToolbarRegistry>;
    readonly application: interfaces.ServiceIdentifier<FrontendApplication>;
    readonly messages: interfaces.ServiceIdentifier<MessageService>;
    readonly frontendContribution: interfaces.ServiceIdentifier<FrontendApplicationContribution>;
}

export function bindRideDeferredFeatureLoader(
    bind: interfaces.Bind,
    identifiers: RideDeferredFeatureLoaderBindingIdentifiers
): void {
    bind(RideDeferredFeatureLoader).toDynamicValue(context => new RideDeferredFeatureLoader(
        context.container.get(identifiers.commands),
        context.container.get(identifiers.menus),
        context.container.get(identifiers.keybindings),
        context.container.get(identifiers.toolbar),
        context.container.get(identifiers.application),
        context.container.get(identifiers.messages)
    )).inSingletonScope();
    bind(identifiers.frontendContribution).toService(RideDeferredFeatureLoader);
}

interface ActivatedModule {
    readonly module: RideDeferredFeatureModule;
    readonly registrations: Disposable[];
}

export class RideDeferredFeatureLoader implements FrontendApplicationContribution, Disposable {
    protected readonly activations = new Map<string, Promise<void>>();
    protected readonly activatedModules: ActivatedModule[] = [];
    protected readonly disposedModules = new WeakSet<RideDeferredFeatureModule>();
    protected readonly stoppedModules = new WeakSet<RideDeferredFeatureModule>();
    protected disposed = false;

    get isDisposed(): boolean {
        return this.disposed;
    }

    constructor(
        protected readonly commands: CommandRegistry,
        protected readonly menus: MenuModelRegistry,
        protected readonly keybindings: KeybindingRegistry,
        protected readonly toolbar: TabBarToolbarRegistry,
        protected readonly application: FrontendApplication,
        protected readonly messages: MessageService
    ) { }

    activate(feature: RideDeferredFeature): Promise<void> {
        if (this.disposed) {
            return Promise.reject(new Error(`Deferred feature loader is disposed; cannot activate "${feature.id}".`));
        }
        const current = this.activations.get(feature.id);
        if (current) {
            return current;
        }
        const activation = this.doActivate(feature);
        this.activations.set(feature.id, activation);
        return activation;
    }

    protected async doActivate(feature: RideDeferredFeature): Promise<void> {
        try {
            const module = await feature.load();
            if (this.disposed) {
                this.disposeModule(module);
                throw new Error(`Deferred feature loader was disposed while activating "${feature.id}".`);
            }
            await feature.activate(module);
        } catch (error) {
            await this.reportActivationError(feature.id, error);
            this.activations.delete(feature.id);
            throw error;
        }
    }

    async activateModule(module: RideDeferredFeatureModule): Promise<void> {
        try {
            this.validateModule(module);
        } catch (error) {
            this.disposeModule(module);
            throw error;
        }
        if (this.disposed) {
            this.disposeModule(module);
            throw new Error('Deferred feature loader is disposed.');
        }

        const registrations: Disposable[] = [];
        let started = false;
        try {
            await this.runRegistration(module.registerCommands, this.commands, registrations);
            this.throwIfDisposedDuringActivation();
            await this.runRegistration(module.registerMenus, this.menus, registrations);
            this.throwIfDisposedDuringActivation();
            await this.runRegistration(module.registerKeybindings, this.keybindings, registrations);
            this.throwIfDisposedDuringActivation();
            await this.runRegistration(module.registerToolbarItems, this.toolbar, registrations);
            this.throwIfDisposedDuringActivation();
            await module.initialize?.();
            this.throwIfDisposedDuringActivation();
            await module.configure?.(this.application);
            this.throwIfDisposedDuringActivation();
            await module.onStart?.(this.application);
            started = true;
            this.throwIfDisposedDuringActivation();
            this.activatedModules.push({ module, registrations });
        } catch (error) {
            if (started) {
                this.stopModule(module, this.application);
            }
            this.disposeRegistrations(registrations);
            this.disposeModule(module);
            throw error;
        }
    }

    protected validateModule(module: RideDeferredFeatureModule): void {
        if (!module || typeof module !== 'object' || !Array.isArray(module.contributionTypes)) {
            throw new Error('Deferred feature module must declare contributionTypes.');
        }
        for (const hook of ['initializeLayout', 'onDidInitializeLayout', 'onWillStop']) {
            if (hook in module) {
                throw new Error(`Unsupported lifecycle hook "${hook}" in deferred feature module.`);
            }
        }
        const supportedHooks = new Set([
            'contributionTypes',
            'registerCommands',
            'registerMenus',
            'registerKeybindings',
            'registerToolbarItems',
            'initialize',
            'configure',
            'onStart',
            'onStop',
            'dispose'
        ]);
        for (const hook of Object.keys(module)) {
            if (!supportedHooks.has(hook)) {
                throw new Error(`Unsupported deferred feature module hook "${hook}".`);
            }
        }
        const supported = new Set<string>(Object.values(RideDeferredContributionType));
        for (const contributionType of module.contributionTypes) {
            if (!supported.has(contributionType)) {
                throw new Error(`Unsupported contribution type "${contributionType}" in deferred feature module.`);
            }
        }
        const declaredTypes = new Set(module.contributionTypes);
        const adapterContracts: Array<{
            readonly type: RideDeferredContributionType;
            readonly hooks: readonly (keyof RideDeferredFeatureModule)[];
        }> = [
            { type: RideDeferredContributionType.Commands, hooks: ['registerCommands'] },
            { type: RideDeferredContributionType.Menus, hooks: ['registerMenus'] },
            { type: RideDeferredContributionType.Keybindings, hooks: ['registerKeybindings'] },
            { type: RideDeferredContributionType.TabBarToolbar, hooks: ['registerToolbarItems'] },
            {
                type: RideDeferredContributionType.FrontendApplication,
                hooks: ['initialize', 'configure', 'onStart', 'onStop']
            }
        ];
        for (const contract of adapterContracts) {
            const presentHooks = contract.hooks.filter(hook => typeof module[hook] === 'function');
            if (presentHooks.length > 0 && !declaredTypes.has(contract.type)) {
                throw new Error(`${String(presentHooks[0])} requires ${contract.type} in contributionTypes.`);
            }
        }
        for (const contract of adapterContracts) {
            const presentHooks = contract.hooks.filter(hook => typeof module[hook] === 'function');
            if (declaredTypes.has(contract.type) && presentHooks.length === 0) {
                throw new Error(`${contract.type} requires ${String(contract.hooks[0])} in the deferred feature module.`);
            }
        }
    }

    protected throwIfDisposedDuringActivation(): void {
        if (this.disposed) {
            throw new Error('Deferred feature loader was disposed during module activation.');
        }
    }

    protected async runRegistration<T>(
        registration: ((service: T) => MaybePromise<RideDeferredRegistrationResult>) | undefined,
        service: T,
        registrations: Disposable[]
    ): Promise<void> {
        if (!registration) {
            return;
        }
        if (this.disposed) {
            throw new Error('Deferred feature loader was disposed during module activation.');
        }
        const result = await registration(service);
        if (Array.isArray(result)) {
            registrations.push(...result);
        } else if (this.isDisposable(result)) {
            registrations.push(result);
        }
    }

    protected isDisposable(candidate: unknown): candidate is Disposable {
        if (!candidate || typeof candidate !== 'object') {
            return false;
        }
        return typeof (candidate as Disposable).dispose === 'function';
    }

    protected async reportActivationError(featureId: string, error: unknown): Promise<void> {
        const detail = error instanceof Error ? error.message : String(error);
        try {
            await this.messages.error(`Failed to activate deferred feature "${featureId}": ${detail}`);
        } catch (notificationError) {
            console.error(`[R-IDE] Failed to report deferred feature activation error for ${featureId}.`, notificationError);
        }
    }

    onStop(application: FrontendApplication): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        for (const activated of [...this.activatedModules].reverse()) {
            this.stopModule(activated.module, application);
            this.disposeRegistrations(activated.registrations);
            this.disposeModule(activated.module);
        }
        this.activatedModules.length = 0;
    }

    dispose(): void {
        this.onStop(this.application);
    }

    protected disposeRegistrations(registrations: readonly Disposable[]): void {
        for (const registration of [...registrations].reverse()) {
            try {
                registration.dispose();
            } catch (error) {
                console.error('[R-IDE] Failed to dispose deferred feature registration.', error);
            }
        }
    }

    protected disposeModule(module: RideDeferredFeatureModule): void {
        if (this.disposedModules.has(module)) {
            return;
        }
        this.disposedModules.add(module);
        try {
            module.dispose?.();
        } catch (error) {
            console.error('[R-IDE] Failed to dispose deferred feature module.', error);
        }
    }

    protected stopModule(module: RideDeferredFeatureModule, application: FrontendApplication): void {
        if (this.stoppedModules.has(module)) {
            return;
        }
        this.stoppedModules.add(module);
        try {
            module.onStop?.(application);
        } catch (error) {
            console.error('[R-IDE] Failed to stop deferred feature module.', error);
        }
    }
}
