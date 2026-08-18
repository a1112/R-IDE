/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FrontendApplication } from '@theia/core/lib/browser';
import type { KeybindingRegistry } from '@theia/core/lib/browser/keybinding';
import type { TabBarToolbarRegistry } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { bindRootContributionProvider, ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import type { CommandRegistry } from '@theia/core/lib/common/command';
import type { Command, CommandHandler } from '@theia/core/lib/common/command';
import type { Disposable } from '@theia/core/lib/common/disposable';
import type { MenuModelRegistry } from '@theia/core/lib/common/menu';
import type { MessageService } from '@theia/core/lib/common/message-service';
import { Container, ContainerModule } from '@theia/core/shared/inversify';
import {
    bindRideDeferredFeatureLoader,
    RideDeferredCommandProxy,
    RideDeferredContributionType,
    RideDeferredFeature,
    RideDeferredFeatureLoaderBindingIdentifiers,
    RideDeferredFeatureLoader,
    RideDeferredFeatureModule
} from '../src/browser/ride-deferred-feature-loader';

class FakeCommandRegistry {
    readonly handlers = new Map<string, CommandHandler>();
    readonly events: string[];

    constructor(events: string[]) {
        this.events = events;
    }

    registerCommand(command: Command, handler: CommandHandler): Disposable {
        if (this.handlers.has(command.id)) {
            throw new Error(`duplicate command ${command.id}`);
        }
        this.events.push(`register-command:${command.id}`);
        this.handlers.set(command.id, handler);
        return {
            dispose: () => {
                this.events.push(`dispose-command:${command.id}`);
                this.handlers.delete(command.id);
            }
        };
    }

    async executeCommand<T>(id: string, ...args: unknown[]): Promise<T | undefined> {
        return this.handlers.get(id)?.execute(...args) as T | undefined;
    }
}

class FakeToolbarRegistry {
    readonly items = new Set<string>();
    readonly events: string[];

    constructor(events: string[]) {
        this.events = events;
    }

    registerItem(item: { id: string }): Disposable {
        if (this.items.has(item.id)) {
            throw new Error(`duplicate toolbar item ${item.id}`);
        }
        this.events.push(`register-toolbar:${item.id}`);
        this.items.add(item.id);
        return {
            dispose: () => {
                this.events.push(`dispose-toolbar:${item.id}`);
                this.items.delete(item.id);
            }
        };
    }
}

interface Harness {
    readonly loader: RideDeferredFeatureLoader;
    readonly commands: CommandRegistry;
    readonly menus: MenuModelRegistry;
    readonly keybindings: KeybindingRegistry;
    readonly toolbar: TabBarToolbarRegistry;
    readonly application: FrontendApplication;
    readonly errors: string[];
}

function harness(): Harness {
    const errors: string[] = [];
    const commands = { kind: 'commands' } as unknown as CommandRegistry;
    const menus = { kind: 'menus' } as unknown as MenuModelRegistry;
    const keybindings = { kind: 'keybindings' } as unknown as KeybindingRegistry;
    const toolbar = { kind: 'toolbar' } as unknown as TabBarToolbarRegistry;
    const application = { kind: 'application' } as unknown as FrontendApplication;
    const messages = {
        error: async (message: string) => {
            errors.push(message);
            return undefined;
        }
    } as unknown as MessageService;
    return {
        loader: new RideDeferredFeatureLoader(commands, menus, keybindings, toolbar, application, messages),
        commands,
        menus,
        keybindings,
        toolbar,
        application,
        errors
    };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

function feature(
    id: string,
    loader: RideDeferredFeatureLoader,
    load: () => Promise<RideDeferredFeatureModule>
): RideDeferredFeature {
    return {
        id,
        load,
        activate: module => loader.activateModule(module)
    };
}

test('binding factory injects every explicit adapter service and one shutdown contribution', () => {
    const container = new Container();
    const identifiers: RideDeferredFeatureLoaderBindingIdentifiers = {
        commands: Symbol('CommandRegistry'),
        menus: Symbol('MenuModelRegistry'),
        keybindings: Symbol('KeybindingRegistry'),
        toolbar: Symbol('TabBarToolbarRegistry'),
        application: Symbol('FrontendApplication'),
        messages: Symbol('MessageService'),
        frontendContribution: Symbol('FrontendApplicationContribution')
    };
    const services = {
        commands: { kind: 'commands' },
        menus: { kind: 'menus' },
        keybindings: { kind: 'keybindings' },
        toolbar: { kind: 'toolbar' },
        application: { kind: 'application' },
        messages: { error: async () => undefined }
    };
    for (const key of ['commands', 'menus', 'keybindings', 'toolbar', 'application', 'messages'] as const) {
        container.bind(identifiers[key]).toConstantValue(services[key] as never);
    }
    container.load(new ContainerModule(bind => bindRideDeferredFeatureLoader(bind, identifiers)));

    const loader = container.get(RideDeferredFeatureLoader);
    assert.strictEqual(container.get(identifiers.frontendContribution), loader);
    for (const key of ['commands', 'menus', 'keybindings', 'toolbar', 'application', 'messages'] as const) {
        assert.strictEqual(
            (loader as unknown as Record<string, unknown>)[key],
            services[key]
        );
    }
});

test('command proxy removes same-ID registrations, activates the chunk, and executes the real action', async () => {
    const events: string[] = [];
    const commands = new FakeCommandRegistry(events);
    const toolbar = new FakeToolbarRegistry(events);
    const application = {} as FrontendApplication;
    const loader = new RideDeferredFeatureLoader(
        commands as unknown as CommandRegistry,
        {} as MenuModelRegistry,
        {} as KeybindingRegistry,
        toolbar as unknown as TabBarToolbarRegistry,
        application,
        { error: async () => undefined } as unknown as MessageService
    );
    const command: Command = { id: 'extract-widget', label: 'Move View to Secondary Window' };
    let loads = 0;
    const proxy = new RideDeferredCommandProxy(loader, {
        id: 'secondary-window',
        command,
        toolbarItem: { id: command.id, command: command.id, icon: 'codicon-window' },
        load: async () => {
            loads++;
            return {
                contributionTypes: [
                    RideDeferredContributionType.Commands,
                    RideDeferredContributionType.TabBarToolbar
                ],
                registerCommands: registry => registry.registerCommand(command, {
                    execute: widget => {
                        events.push(`real-execute:${widget}`);
                    }
                }),
                registerToolbarItems: registry => registry.registerItem({
                    id: command.id,
                    command: command.id,
                    icon: 'codicon-window'
                })
            };
        }
    });
    proxy.registerCommands(commands as unknown as CommandRegistry);
    proxy.registerToolbarItems(toolbar as unknown as TabBarToolbarRegistry);

    await commands.executeCommand(command.id, 'editor-widget');
    await commands.executeCommand(command.id, 'second-widget');

    assert.equal(loads, 1);
    assert.deepEqual(events, [
        'register-command:extract-widget',
        'register-toolbar:extract-widget',
        'dispose-toolbar:extract-widget',
        'dispose-command:extract-widget',
        'register-command:extract-widget',
        'register-toolbar:extract-widget',
        'real-execute:editor-widget',
        'real-execute:second-widget'
    ]);
});

test('command proxy restores its activation surface after module activation fails', async () => {
    const events: string[] = [];
    const commands = new FakeCommandRegistry(events);
    const toolbar = new FakeToolbarRegistry(events);
    const loader = new RideDeferredFeatureLoader(
        commands as unknown as CommandRegistry,
        {} as MenuModelRegistry,
        {} as KeybindingRegistry,
        toolbar as unknown as TabBarToolbarRegistry,
        {} as FrontendApplication,
        { error: async () => undefined } as unknown as MessageService
    );
    const command: Command = { id: 'extract-widget' };
    const proxy = new RideDeferredCommandProxy(loader, {
        id: 'secondary-window-failure',
        command,
        toolbarItem: { id: command.id, command: command.id },
        load: async () => ({
            contributionTypes: ['OpenHandler' as RideDeferredContributionType]
        })
    });
    proxy.registerCommands(commands as unknown as CommandRegistry);
    proxy.registerToolbarItems(toolbar as unknown as TabBarToolbarRegistry);

    await assert.rejects(commands.executeCommand(command.id), /unsupported contribution type/i);

    assert.ok(commands.handlers.has(command.id));
    assert.ok(toolbar.items.has(command.id));
    assert.deepEqual(events.slice(-2), [
        'register-command:extract-widget',
        'register-toolbar:extract-widget'
    ]);
});

test('command proxy does not resurrect registrations when disposed during a failed activation', async () => {
    const events: string[] = [];
    const commands = new FakeCommandRegistry(events);
    const toolbar = new FakeToolbarRegistry(events);
    const loaded = deferred<RideDeferredFeatureModule>();
    const loader = new RideDeferredFeatureLoader(
        commands as unknown as CommandRegistry,
        {} as MenuModelRegistry,
        {} as KeybindingRegistry,
        toolbar as unknown as TabBarToolbarRegistry,
        {} as FrontendApplication,
        { error: async () => undefined } as unknown as MessageService
    );
    const command: Command = { id: 'extract-widget' };
    const proxy = new RideDeferredCommandProxy(loader, {
        id: 'secondary-window-disposed',
        command,
        toolbarItem: { id: command.id, command: command.id },
        load: () => loaded.promise
    });
    proxy.registerCommands(commands as unknown as CommandRegistry);
    proxy.registerToolbarItems(toolbar as unknown as TabBarToolbarRegistry);

    const activation = commands.executeCommand(command.id);
    proxy.dispose();
    loaded.resolve({
        contributionTypes: ['OpenHandler' as RideDeferredContributionType]
    });

    await assert.rejects(activation, /unsupported contribution type/i);
    proxy.registerCommands(commands as unknown as CommandRegistry);
    proxy.registerToolbarItems(toolbar as unknown as TabBarToolbarRegistry);
    assert.equal(commands.handlers.has(command.id), false);
    assert.equal(toolbar.items.has(command.id), false);
});

test('command proxy does not resurrect registrations after loader shutdown', async () => {
    const events: string[] = [];
    const commands = new FakeCommandRegistry(events);
    const toolbar = new FakeToolbarRegistry(events);
    const loaded = deferred<RideDeferredFeatureModule>();
    const registrationEntered = deferred<void>();
    const releaseRegistration = deferred<void>();
    const loader = new RideDeferredFeatureLoader(
        commands as unknown as CommandRegistry,
        {} as MenuModelRegistry,
        {} as KeybindingRegistry,
        toolbar as unknown as TabBarToolbarRegistry,
        {} as FrontendApplication,
        { error: async () => undefined } as unknown as MessageService
    );
    const command: Command = { id: 'extract-widget' };
    const proxy = new RideDeferredCommandProxy(loader, {
        id: 'secondary-window-shutdown',
        command,
        toolbarItem: { id: command.id, command: command.id },
        load: () => loaded.promise
    });
    proxy.registerCommands(commands as unknown as CommandRegistry);
    proxy.registerToolbarItems(toolbar as unknown as TabBarToolbarRegistry);

    const activation = commands.executeCommand(command.id);
    loaded.resolve({
        contributionTypes: [RideDeferredContributionType.Commands],
        registerCommands: async registry => {
            registrationEntered.resolve(undefined);
            await releaseRegistration.promise;
            return registry.registerCommand(command, { execute: () => undefined });
        }
    });
    await registrationEntered.promise;
    loader.dispose();
    releaseRegistration.resolve(undefined);

    await assert.rejects(activation, /disposed/i);
    assert.equal(commands.handlers.has(command.id), false);
    assert.equal(toolbar.items.has(command.id), false);

    proxy.onStop();
    proxy.registerCommands(commands as unknown as CommandRegistry);
    proxy.registerToolbarItems(toolbar as unknown as TabBarToolbarRegistry);
    assert.equal(commands.handlers.has(command.id), false);
    assert.equal(toolbar.items.has(command.id), false);
});

test('concurrent executions of the same proxy command share activation and reach the real handler', async () => {
    const events: string[] = [];
    const commands = new FakeCommandRegistry(events);
    const toolbar = new FakeToolbarRegistry(events);
    const loaded = deferred<RideDeferredFeatureModule>();
    const loader = new RideDeferredFeatureLoader(
        commands as unknown as CommandRegistry,
        {} as MenuModelRegistry,
        {} as KeybindingRegistry,
        toolbar as unknown as TabBarToolbarRegistry,
        {} as FrontendApplication,
        { error: async () => undefined } as unknown as MessageService
    );
    const command: Command = { id: 'extract-widget' };
    let loads = 0;
    const proxy = new RideDeferredCommandProxy(loader, {
        id: 'secondary-window-concurrent',
        command,
        toolbarItem: { id: command.id, command: command.id },
        load: () => {
            loads++;
            return loaded.promise;
        }
    });
    proxy.registerCommands(commands as unknown as CommandRegistry);
    proxy.registerToolbarItems(toolbar as unknown as TabBarToolbarRegistry);

    const first = commands.executeCommand(command.id, 'first-widget');
    const second = commands.executeCommand(command.id, 'second-widget');
    loaded.resolve({
        contributionTypes: [RideDeferredContributionType.Commands],
        registerCommands: registry => registry.registerCommand(command, {
            execute: widget => events.push(`real-execute:${widget}`)
        })
    });

    await Promise.all([first, second]);
    assert.equal(loads, 1);
    assert.deepEqual(events.slice(-2), [
        'real-execute:first-widget',
        'real-execute:second-widget'
    ]);
});

test('shares concurrent activation and caches one successful feature activation', async () => {
    const { loader } = harness();
    const loaded = deferred<RideDeferredFeatureModule>();
    let loadCalls = 0;
    let activateCalls = 0;
    const descriptor: RideDeferredFeature = {
        id: 'shared',
        load: () => {
            loadCalls++;
            return loaded.promise;
        },
        activate: async () => {
            activateCalls++;
        }
    };

    const first = loader.activate(descriptor);
    const second = loader.activate(descriptor);
    assert.strictEqual(second, first);
    loaded.resolve({ contributionTypes: [] });
    await first;
    await loader.activate(descriptor);

    assert.equal(loadCalls, 1);
    assert.equal(activateCalls, 1);
});

test('a failed activation reports the error and remains retryable', async () => {
    const { loader, errors } = harness();
    let attempts = 0;
    const descriptor = feature('retryable', loader, async () => {
        attempts++;
        if (attempts === 1) {
            throw new Error('chunk unavailable');
        }
        return { contributionTypes: [] };
    });

    await assert.rejects(loader.activate(descriptor), /chunk unavailable/);
    await loader.activate(descriptor);

    assert.equal(attempts, 2);
    assert.deepEqual(errors, ['Failed to activate deferred feature "retryable": chunk unavailable']);
});

test('a synchronously thrown load failure is removed from the activation cache', async () => {
    const { loader } = harness();
    let attempts = 0;
    const descriptor: RideDeferredFeature = {
        id: 'synchronous-load-failure',
        load: () => {
            attempts++;
            if (attempts === 1) {
                throw new Error('synchronous chunk failure');
            }
            return Promise.resolve({ contributionTypes: [] });
        },
        activate: module => loader.activateModule(module)
    };

    await assert.rejects(loader.activate(descriptor), /synchronous chunk failure/);
    await loader.activate(descriptor);
    assert.equal(attempts, 2);
});

test('registers supported adapters and lifecycle hooks exactly once in Theia startup order', async () => {
    const { loader, commands, menus, keybindings, toolbar, application } = harness();
    const events: string[] = [];
    const disposed: string[] = [];
    const registrationDisposable = (name: string): Disposable => ({
        dispose: () => disposed.push(name)
    });
    const module: RideDeferredFeatureModule = {
        contributionTypes: [
            RideDeferredContributionType.Commands,
            RideDeferredContributionType.Menus,
            RideDeferredContributionType.Keybindings,
            RideDeferredContributionType.TabBarToolbar,
            RideDeferredContributionType.FrontendApplication
        ],
        registerCommands: service => {
            assert.strictEqual(service, commands);
            events.push('commands');
            return registrationDisposable('commands');
        },
        registerMenus: service => {
            assert.strictEqual(service, menus);
            events.push('menus');
            return registrationDisposable('menus');
        },
        registerKeybindings: service => {
            assert.strictEqual(service, keybindings);
            events.push('keybindings');
            return registrationDisposable('keybindings');
        },
        registerToolbarItems: service => {
            assert.strictEqual(service, toolbar);
            events.push('toolbar');
            return registrationDisposable('toolbar');
        },
        initialize: () => {
            events.push('initialize');
        },
        configure: service => {
            assert.strictEqual(service, application);
            events.push('configure');
        },
        onStart: service => {
            assert.strictEqual(service, application);
            events.push('onStart');
        },
        onStop: service => {
            assert.strictEqual(service, application);
            events.push('onStop');
        },
        dispose: () => disposed.push('module')
    };
    const descriptor = feature('ordered', loader, async () => module);

    await Promise.all([loader.activate(descriptor), loader.activate(descriptor)]);
    await loader.activate(descriptor);
    loader.onStop(application);
    loader.onStop(application);
    loader.dispose();

    assert.deepEqual(events, [
        'commands',
        'menus',
        'keybindings',
        'toolbar',
        'initialize',
        'configure',
        'onStart',
        'onStop'
    ]);
    assert.deepEqual(disposed, ['toolbar', 'keybindings', 'menus', 'commands', 'module']);
});

test('dispose rejects new work and cleans a module that resolves after shutdown', async () => {
    const { loader } = harness();
    const loaded = deferred<RideDeferredFeatureModule>();
    let activated = 0;
    let disposed = 0;
    const descriptor = feature('late', loader, () => loaded.promise);
    const activation = loader.activate(descriptor);

    loader.dispose();
    loaded.resolve({
        contributionTypes: [],
        initialize: () => {
            activated++;
        },
        dispose: () => disposed++
    });

    await assert.rejects(activation, /disposed/i);
    await assert.rejects(loader.activate(descriptor), /disposed/i);
    assert.equal(activated, 0);
    assert.equal(disposed, 1);
});

test('dispose during initialize prevents later lifecycle hooks and cleans partial registrations once', async () => {
    const { loader } = harness();
    const initializeEntered = deferred<void>();
    const releaseInitialize = deferred<void>();
    const events: string[] = [];
    let registrationDisposals = 0;
    let moduleDisposals = 0;
    const activation = loader.activate(feature('dispose-initialize', loader, async () => ({
        contributionTypes: [
            RideDeferredContributionType.Commands,
            RideDeferredContributionType.FrontendApplication
        ],
        registerCommands: () => ({ dispose: () => registrationDisposals++ }),
        initialize: async () => {
            events.push('initialize');
            initializeEntered.resolve(undefined);
            await releaseInitialize.promise;
        },
        configure: () => {
            events.push('configure');
        },
        onStart: () => {
            events.push('onStart');
        },
        onStop: () => {
            events.push('onStop');
        },
        dispose: () => {
            moduleDisposals++;
        }
    })));

    await initializeEntered.promise;
    loader.dispose();
    releaseInitialize.resolve(undefined);

    await assert.rejects(activation, /disposed/i);
    loader.dispose();
    assert.deepEqual(events, ['initialize']);
    assert.equal(registrationDisposals, 1);
    assert.equal(moduleDisposals, 1);
});

test('dispose during onStart invokes onStop exactly once after startup settles', async () => {
    const { loader, application } = harness();
    const onStartEntered = deferred<void>();
    const releaseOnStart = deferred<void>();
    const events: string[] = [];
    let registrationDisposals = 0;
    let moduleDisposals = 0;
    const activation = loader.activate(feature('dispose-on-start', loader, async () => ({
        contributionTypes: [
            RideDeferredContributionType.Commands,
            RideDeferredContributionType.FrontendApplication
        ],
        registerCommands: () => ({ dispose: () => registrationDisposals++ }),
        onStart: async service => {
            assert.strictEqual(service, application);
            events.push('onStart');
            onStartEntered.resolve(undefined);
            await releaseOnStart.promise;
        },
        onStop: service => {
            assert.strictEqual(service, application);
            events.push('onStop');
        },
        dispose: () => moduleDisposals++
    })));

    await onStartEntered.promise;
    loader.dispose();
    releaseOnStart.resolve(undefined);

    await assert.rejects(activation, /disposed/i);
    loader.dispose();
    assert.deepEqual(events, ['onStart', 'onStop']);
    assert.equal(registrationDisposals, 1);
    assert.equal(moduleDisposals, 1);
});

test('rejects unsupported contribution types before any adapter runs', async () => {
    const { loader } = harness();
    let registered = 0;
    let disposed = 0;
    const descriptor = feature('unsupported', loader, async () => ({
        contributionTypes: ['OpenHandler' as RideDeferredContributionType],
        registerCommands: () => {
            registered++;
        },
        dispose: () => disposed++
    }));

    await assert.rejects(loader.activate(descriptor), /unsupported contribution type "OpenHandler"/i);
    assert.equal(registered, 0);
    assert.equal(disposed, 1);
});

test('rejects startup-layout lifecycle hooks before any adapter runs', async () => {
    const { loader } = harness();
    for (const unsupportedHook of ['initializeLayout', 'onDidInitializeLayout', 'onWillStop']) {
        let registered = 0;
        const module = {
            contributionTypes: [RideDeferredContributionType.FrontendApplication],
            registerCommands: () => {
                registered++;
            },
            [unsupportedHook]: () => undefined
        } as unknown as RideDeferredFeatureModule;

        await assert.rejects(
            loader.activate(feature(`unsupported-${unsupportedHook}`, loader, async () => module)),
            new RegExp(`unsupported lifecycle hook "${unsupportedHook}"`, 'i')
        );
        assert.equal(registered, 0);
    }
});

test('rejects undeclared adapter hooks before any supported adapter runs', async () => {
    const { loader } = harness();
    let registered = 0;
    const module = {
        contributionTypes: [RideDeferredContributionType.Commands],
        registerCommands: () => {
            registered++;
        },
        registerOpenHandlers: () => undefined
    } as unknown as RideDeferredFeatureModule;

    await assert.rejects(
        loader.activate(feature('unsupported-adapter', loader, async () => module)),
        /unsupported deferred feature module hook "registerOpenHandlers"/i
    );
    assert.equal(registered, 0);
});

test('rejects adapters that are not declared by contributionTypes', async () => {
    const { loader } = harness();
    let registered = 0;
    const module: RideDeferredFeatureModule = {
        contributionTypes: [RideDeferredContributionType.Commands],
        registerMenus: () => {
            registered++;
        }
    };

    await assert.rejects(
        loader.activate(feature('mismatched-adapter', loader, async () => module)),
        /registerMenus.*MenuContribution/i
    );
    assert.equal(registered, 0);

    await assert.rejects(
        loader.activate(feature('missing-adapter', loader, async () => ({
            contributionTypes: [RideDeferredContributionType.Menus]
        }))),
        /MenuContribution.*registerMenus/i
    );
    await assert.rejects(
        loader.activate(feature('undeclared-lifecycle', loader, async () => ({
            contributionTypes: [],
            initialize: () => undefined
        }))),
        /initialize.*FrontendApplicationContribution/i
    );
});

test('explicit activation works after a real ContributionProvider has cached its first read', async () => {
    const LateContribution = Symbol('LateContribution');
    const container = new Container();
    container.load(new ContainerModule(bind => bindRootContributionProvider(bind, LateContribution)));
    const provider = container.getNamed<ContributionProvider<object>>(ContributionProvider, LateContribution);
    assert.deepEqual(provider.getContributions(), []);

    const lateContribution = { source: 'late container.load' };
    container.load(new ContainerModule(bind => bind(LateContribution).toConstantValue(lateContribution)));
    assert.deepEqual(
        provider.getContributions(),
        [],
        'Theia caches the provider result, so late container bindings are intentionally invisible'
    );

    const { loader } = harness();
    let explicitActivations = 0;
    await loader.activate({
        id: 'cached-provider-regression',
        load: async () => ({ contributionTypes: [] }),
        activate: async () => {
            explicitActivations++;
        }
    });

    assert.equal(explicitActivations, 1);
    assert.deepEqual(provider.getContributions(), []);
});
