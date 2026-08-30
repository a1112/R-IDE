/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, test } from 'node:test';
import ts from 'typescript';
import type { FrontendApplication } from '@theia/core/lib/browser';
import type { KeybindingRegistry } from '@theia/core/lib/browser/keybinding';
import type { TabBarToolbarRegistry } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { bindRootContributionProvider, ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import type { CommandRegistry } from '@theia/core/lib/common/command';
import type { Command, CommandHandler } from '@theia/core/lib/common/command';
import type { Disposable } from '@theia/core/lib/common/disposable';
import type { MenuModelRegistry } from '@theia/core/lib/common/menu';
import type { MessageService } from '@theia/core/lib/common/message-service';
import { RootContainer } from '@theia/core/lib/node/backend-application';
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

type ScanOSSTestResult =
    | { readonly type: 'clean' }
    | { readonly type: 'error'; readonly message: string }
    | { readonly type: 'match'; readonly matched: string; readonly url: string; readonly raw: unknown };

interface ScanOSSTestDelegate {
    scanContent(content: string, apiKey?: string): Promise<ScanOSSTestResult>;
}

interface ScanOSSTestFeature {
    createScanOSSService(rootContainer: Container, ensureActive: () => void): ScanOSSTestDelegate;
}

interface ScanOSSTestProxy extends ScanOSSTestDelegate {
    dispose(): void;
}

interface ScanOSSUpstreamTestDelegate extends ScanOSSTestDelegate {
    doScanContent(content: string, apiKey?: string): Promise<ScanOSSTestResult>;
}

type ScanOSSTestProxyConstructor = new () => ScanOSSTestProxy;
type ScanOSSUpstreamTestConstructor = new () => ScanOSSUpstreamTestDelegate;

interface CompiledScanOSSModules {
    readonly Proxy: ScanOSSTestProxyConstructor;
    readonly initialRequests: readonly string[];
    readonly proxyOutputText: string;
    readonly loadFeatureModule: () => ScanOSSTestFeature;
    readonly loadUpstreamLoggerIdentifier: () => symbol;
    readonly loadUpstreamConstructor: () => ScanOSSUpstreamTestConstructor;
}

type CommonJSLoad = (request: string, parent: unknown, isMain: boolean) => unknown;

const commonJSModule = createRequire(__filename)('node:module') as { _load: CommonJSLoad };
const scanOSSUnavailableResult: ScanOSSTestResult = {
    type: 'error',
    message: 'ScanOSS runtime is unavailable.'
};
let compiledScanOSSDirectory: string | undefined;
let compiledScanOSSModules: CompiledScanOSSModules | undefined;

function observeCommonJSLoads<T>(action: () => T): { readonly value: T; readonly requests: readonly string[] } {
    const requests: string[] = [];
    const originalLoad = commonJSModule._load;
    commonJSModule._load = function (this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
        requests.push(request);
        return Reflect.apply(originalLoad, this, [request, parent, isMain]);
    };
    try {
        return { value: action(), requests };
    } finally {
        commonJSModule._load = originalLoad;
    }
}

function compileScanOSSModules(): CompiledScanOSSModules {
    if (compiledScanOSSModules) {
        return compiledScanOSSModules;
    }
    const appDirectory = path.resolve(__dirname, '..', '..', '..', '..', '..');
    const sourceDirectory = path.join(appDirectory, 'applications', 'browser', 'tauri-src', 'backend');
    const outputRoot = path.resolve(__dirname, '..');
    compiledScanOSSDirectory = fs.mkdtempSync(path.join(outputRoot, 'scanoss-lifecycle-'));
    const transpile = (sourceName: string, outputName: string): string => {
        const sourceFile = path.join(sourceDirectory, sourceName);
        const result = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
            fileName: sourceFile,
            reportDiagnostics: true,
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                experimentalDecorators: true,
                emitDecoratorMetadata: true,
                esModuleInterop: true
            }
        });
        const errors = (result.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
        if (errors.length > 0) {
            throw new Error(`Unable to compile ${sourceName}: ${errors.map(error => error.messageText).join(', ')}`);
        }
        const output = path.join(compiledScanOSSDirectory!, outputName);
        fs.writeFileSync(output, result.outputText);
        return output;
    };
    const proxyOutput = transpile('scanoss-service-proxy.ts', 'proxy.cjs');
    const featureOutput = transpile('scanoss-service-feature.ts', 'feature.cjs');
    const runtimeRequire = createRequire(path.join(compiledScanOSSDirectory, 'runtime.cjs'));
    const loaded = observeCommonJSLoads(() => runtimeRequire(proxyOutput) as {
        ScanOSSServiceImpl: ScanOSSTestProxyConstructor;
    });
    compiledScanOSSModules = {
        Proxy: loaded.value.ScanOSSServiceImpl,
        initialRequests: loaded.requests,
        proxyOutputText: fs.readFileSync(proxyOutput, 'utf8'),
        loadFeatureModule: () => runtimeRequire(featureOutput) as ScanOSSTestFeature,
        loadUpstreamLoggerIdentifier: () => {
            const implementation = runtimeRequire.resolve('@theia/scanoss/lib/node/scanoss-service-impl');
            return (createRequire(implementation)('@theia/core') as { ILogger: symbol }).ILogger;
        },
        loadUpstreamConstructor: () => (runtimeRequire('@theia/scanoss/lib/node/scanoss-service-impl') as {
            ScanOSSServiceImpl: ScanOSSUpstreamTestConstructor;
        }).ScanOSSServiceImpl
    };
    return compiledScanOSSModules;
}

after(() => {
    if (compiledScanOSSDirectory) {
        fs.rmSync(compiledScanOSSDirectory, { recursive: true, force: true });
    }
});

function assertNoScanOSSRuntimeLoads(requests: readonly string[]): void {
    const forbidden = requests.filter(request => {
        const normalized = request.replace(/\\/g, '/');
        return normalized === 'scanoss'
            || normalized.startsWith('scanoss/')
            || normalized === '@grpc/grpc-js'
            || normalized.startsWith('@grpc/grpc-js/')
            || normalized === 'protobufjs'
            || normalized.startsWith('protobufjs/')
            || normalized.includes('/node_modules/scanoss/')
            || normalized.includes('/node_modules/@grpc/grpc-js/')
            || normalized.includes('/node_modules/protobufjs/')
            || normalized.includes('@theia/scanoss/lib/node/scanoss-service-impl');
    });
    assert.deepEqual(forbidden, []);
}

function createScanOSSProxy(
    Proxy: ScanOSSTestProxyConstructor,
    loadFeature: () => Promise<ScanOSSTestFeature>,
    rootContainer: Container = new Container()
): { readonly proxy: ScanOSSTestProxy; readonly connectionContainer: Container; readonly rootContainer: Container } {
    rootContainer.bind(RootContainer).toConstantValue(rootContainer);
    const connectionContainer = rootContainer.createChild();
    connectionContainer.bind(Proxy).toSelf().inSingletonScope();
    const proxy = connectionContainer.get(Proxy);
    (proxy as unknown as { loadFeature: () => Promise<ScanOSSTestFeature> }).loadFeature = loadFeature;
    return { proxy, connectionContainer, rootContainer };
}

function scanOSSDelegate(
    scanContent: (content: string, apiKey?: string) => Promise<ScanOSSTestResult> = async () => ({ type: 'clean' })
): ScanOSSTestDelegate {
    return { scanContent };
}

function bindScanOSSLogger(rootContainer: Container, loggerIdentifier: symbol, onResolve: () => void = () => undefined): void {
    rootContainer.bind<unknown>(loggerIdentifier).toDynamicValue(() => {
        onResolve();
        return { debug: () => undefined };
    }).whenTargetNamed('scanoss:ScanOSSServiceImpl');
}

test('compiled ScanOSS proxy construction does not load the deferred runtime', () => {
    const compiled = compileScanOSSModules();
    assertNoScanOSSRuntimeLoads(compiled.initialRequests);
    const constructed = observeCommonJSLoads(() => createScanOSSProxy(
        compiled.Proxy,
        async () => ({ createScanOSSService: () => scanOSSDelegate() })
    ));
    assert.ok(constructed.value.proxy);
    assertNoScanOSSRuntimeLoads(constructed.requests);
});

test('compiled ScanOSS proxy receives RootContainer through function-form Inversify metadata', () => {
    const { Proxy } = compileScanOSSModules();
    const rootContainer = new Container();
    const { proxy } = createScanOSSProxy(
        Proxy,
        async () => ({ createScanOSSService: () => scanOSSDelegate() }),
        rootContainer
    );
    assert.strictEqual(
        (proxy as unknown as { rootContainer: Container }).rootContainer,
        rootContainer
    );
});

test('compiled ScanOSS feature creates one child and one real singleton delegate', () => {
    const compiled = compileScanOSSModules();
    const feature = compiled.loadFeatureModule();
    const Upstream = compiled.loadUpstreamConstructor();
    const rootContainer = new Container();
    let loggerResolutions = 0;
    bindScanOSSLogger(rootContainer, compiled.loadUpstreamLoggerIdentifier(), () => loggerResolutions++);
    const originalCreateChild = rootContainer.createChild.bind(rootContainer);
    let childCreations = 0;
    let createdChild: Container | undefined;
    (rootContainer as unknown as { createChild(): Container }).createChild = () => {
        childCreations++;
        const child = originalCreateChild();
        createdChild = child;
        return child;
    };

    const delegate = feature.createScanOSSService(rootContainer, () => undefined);

    assert.equal(childCreations, 1);
    assert.ok(createdChild);
    assert.ok(delegate instanceof Upstream);
    assert.strictEqual(createdChild.get(Upstream), delegate);
    assert.equal(loggerResolutions, 1);
});

test('compiled ScanOSS proxy shares one concurrent first-use activation and delegate', async () => {
    const { Proxy } = compileScanOSSModules();
    const calls: Array<[string, string | undefined]> = [];
    const delegate = scanOSSDelegate(async (content, apiKey) => {
        calls.push([content, apiKey]);
        return { type: 'clean' };
    });
    let loads = 0;
    let factories = 0;
    const { proxy } = createScanOSSProxy(Proxy, async () => {
        loads++;
        await Promise.resolve();
        return {
            createScanOSSService: () => {
                factories++;
                return delegate;
            }
        };
    });

    const results = await Promise.all([
        proxy.scanContent('first-content', 'first-key'),
        proxy.scanContent('second-content', undefined)
    ]);

    assert.deepEqual(results, [{ type: 'clean' }, { type: 'clean' }]);
    assert.equal(loads, 1);
    assert.equal(factories, 1);
    assert.deepEqual(calls, [
        ['first-content', 'first-key'],
        ['second-content', undefined]
    ]);
});

test('compiled ScanOSS proxy preserves real upstream sequencing, arguments, results, and errors', async () => {
    const compiled = compileScanOSSModules();
    const feature = compiled.loadFeatureModule();
    const Upstream = compiled.loadUpstreamConstructor();
    const prototype = Upstream.prototype;
    const originalDoScanContent = prototype.doScanContent;
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const calls: Array<{ phase: 'start' | 'end'; content: string; apiKey: string | undefined }> = [];
    const firstResult: ScanOSSTestResult = { type: 'clean' };
    const upstreamError = new Error('untouched upstream failure');
    const rootContainer = new Container();
    let loggerResolutions = 0;
    bindScanOSSLogger(rootContainer, compiled.loadUpstreamLoggerIdentifier(), () => loggerResolutions++);
    const { proxy } = createScanOSSProxy(compiled.Proxy, async () => feature, rootContainer);
    const originalCreateChild = rootContainer.createChild.bind(rootContainer);
    let childCreations = 0;
    (rootContainer as unknown as { createChild(): Container }).createChild = () => {
        childCreations++;
        return originalCreateChild();
    };
    const operations: Promise<ScanOSSTestResult>[] = [];

    prototype.doScanContent = async (content: string, apiKey?: string) => {
        calls.push({ phase: 'start', content, apiKey });
        if (content === 'first-source') {
            firstEntered.resolve(undefined);
            await releaseFirst.promise;
        }
        calls.push({ phase: 'end', content, apiKey });
        if (content === 'second-source') {
            throw upstreamError;
        }
        return firstResult;
    };
    try {
        const first = proxy.scanContent('first-source', 'first-api-key');
        const second = proxy.scanContent('second-source', undefined);
        operations.push(first, second);
        const both = Promise.allSettled(operations);
        await Promise.race([
            firstEntered.promise,
            both.then(() => {
                throw new Error('The real upstream delegate was not reached.');
            })
        ]);
        assert.deepEqual(calls, [{
            phase: 'start',
            content: 'first-source',
            apiKey: 'first-api-key'
        }]);
        releaseFirst.resolve(undefined);
        assert.strictEqual(await first, firstResult);
        await assert.rejects(second, error => error === upstreamError);
        assert.deepEqual(calls, [
            { phase: 'start', content: 'first-source', apiKey: 'first-api-key' },
            { phase: 'end', content: 'first-source', apiKey: 'first-api-key' },
            { phase: 'start', content: 'second-source', apiKey: undefined },
            { phase: 'end', content: 'second-source', apiKey: undefined }
        ]);
        assert.equal(childCreations, 1);
        assert.equal(loggerResolutions, 1);
    } finally {
        releaseFirst.resolve(undefined);
        await Promise.allSettled(operations);
        prototype.doScanContent = originalDoScanContent;
    }
});

test('compiled ScanOSS proxy converts a load failure to the fixed result and retries later', async () => {
    const { Proxy } = compileScanOSSModules();
    const success: ScanOSSTestResult = { type: 'clean' };
    let attempts = 0;
    const { proxy } = createScanOSSProxy(Proxy, async () => {
        attempts++;
        if (attempts === 1) {
            throw new Error('Cannot load D:\\private-build\\scanoss-service-feature.cjs');
        }
        return { createScanOSSService: () => scanOSSDelegate(async () => success) };
    });

    assert.deepEqual(await proxy.scanContent('private source', 'private key'), scanOSSUnavailableResult);
    assert.strictEqual(await proxy.scanContent('retry source', 'retry key'), success);
    assert.equal(attempts, 2);
});

test('compiled ScanOSS proxy converts child construction failure to the fixed result and retries later', async () => {
    const compiled = compileScanOSSModules();
    const feature = compiled.loadFeatureModule();
    const rootContainer = new Container();
    const delegate = scanOSSDelegate();
    const { proxy } = createScanOSSProxy(compiled.Proxy, async () => feature, rootContainer);
    let childAttempts = 0;
    let singletonScope = false;
    let bound: unknown;
    (rootContainer as unknown as { createChild(): Container }).createChild = () => {
        childAttempts++;
        if (childAttempts === 1) {
            return {
                bind: () => {
                    throw new Error('D:\\private-build\\child-binding-failure');
                }
            } as unknown as Container;
        }
        return {
            bind: (identifier: unknown) => {
                bound = identifier;
                return {
                    toSelf: () => ({
                        inSingletonScope: () => {
                            singletonScope = true;
                        }
                    })
                };
            },
            get: (identifier: unknown) => {
                assert.strictEqual(identifier, bound);
                return delegate;
            }
        } as unknown as Container;
    };

    assert.deepEqual(await proxy.scanContent('first source'), scanOSSUnavailableResult);
    assert.deepEqual(await proxy.scanContent('second source'), { type: 'clean' });
    assert.equal(childAttempts, 2);
    assert.equal(singletonScope, true);
});

test('compiled ScanOSS proxy shares a private failed activation and exposes no diagnostics', async () => {
    const { Proxy } = compileScanOSSModules();
    const sourceSecret = 'PRIVATE_SOURCE_5f7f6f';
    const apiKeySecret = 'PRIVATE_API_KEY_6e8e7e';
    const environmentSecret = 'PRIVATE_ENV_7d9d8d';
    const pathSecret = 'D:\\private-build\\scanoss-runtime.cjs';
    const previousEnvironment = process.env.R_IDE_SCANOSS_PRIVATE_TEST;
    process.env.R_IDE_SCANOSS_PRIVATE_TEST = environmentSecret;
    const consoleMethods = ['error', 'warn', 'log', 'debug'] as const;
    type ConsoleMethod = typeof consoleMethods[number];
    const mutableConsole = console as unknown as Record<ConsoleMethod, (...args: unknown[]) => void>;
    const originals = {} as Record<ConsoleMethod, (...args: unknown[]) => void>;
    const logs: string[] = [];
    for (const method of consoleMethods) {
        originals[method] = mutableConsole[method];
        mutableConsole[method] = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    }
    let attempts = 0;
    const { proxy } = createScanOSSProxy(Proxy, async () => {
        attempts++;
        await Promise.resolve();
        if (attempts === 1) {
            const error = new Error(`${sourceSecret} ${apiKeySecret} ${environmentSecret} ${pathSecret}`);
            error.stack = `Error: private activation failure\n    at ${pathSecret}:42:7`;
            throw error;
        }
        return { createScanOSSService: () => scanOSSDelegate() };
    });

    try {
        const [first, concurrent] = await Promise.all([
            proxy.scanContent(sourceSecret, apiKeySecret),
            proxy.scanContent(sourceSecret, apiKeySecret)
        ]);
        assert.strictEqual(first, concurrent);
        assert.deepEqual(first, scanOSSUnavailableResult);
        assert.equal(attempts, 1);
        assert.deepEqual(logs, []);
        const publicOutput = JSON.stringify(first) + logs.join('\n');
        for (const secret of [sourceSecret, apiKeySecret, environmentSecret, pathSecret]) {
            assert.equal(publicOutput.includes(secret), false);
        }
        assert.deepEqual(await proxy.scanContent('later source', 'later key'), { type: 'clean' });
        assert.equal(attempts, 2);
    } finally {
        for (const method of consoleMethods) {
            mutableConsole[method] = originals[method];
        }
        if (previousEnvironment === undefined) {
            delete process.env.R_IDE_SCANOSS_PRIVATE_TEST;
        } else {
            process.env.R_IDE_SCANOSS_PRIVATE_TEST = previousEnvironment;
        }
    }
});

test('compiled ScanOSS proxy preDestroy blocks a late feature from constructing or resurrecting', async () => {
    const { Proxy } = compileScanOSSModules();
    const loaded = deferred<ScanOSSTestFeature>();
    let loads = 0;
    let factories = 0;
    const created = createScanOSSProxy(Proxy, () => {
        loads++;
        return loaded.promise;
    });
    const activation = created.proxy.scanContent('pending source', 'pending key');
    try {
        await Promise.resolve();
        await created.connectionContainer.unbindAllAsync();
        loaded.resolve({
            createScanOSSService: () => {
                factories++;
                return scanOSSDelegate();
            }
        });
        assert.deepEqual(await activation, scanOSSUnavailableResult);
        assert.deepEqual(await created.proxy.scanContent('after disposal'), scanOSSUnavailableResult);
        assert.equal(loads, 1);
        assert.equal(factories, 0);
    } finally {
        loaded.resolve({ createScanOSSService: () => scanOSSDelegate() });
        await Promise.allSettled([activation]);
    }
});

test('compiled ScanOSS proxy checks disposal before child creation and delegate construction', async () => {
    const compiled = compileScanOSSModules();
    const feature = compiled.loadFeatureModule();
    const beforeChildRoot = new Container();
    let childCreations = 0;
    let beforeChild!: ReturnType<typeof createScanOSSProxy>;
    beforeChild = createScanOSSProxy(compiled.Proxy, async () => ({
        createScanOSSService: (rootContainer, ensureActive) => {
            beforeChild.proxy.dispose();
            return feature.createScanOSSService(rootContainer, ensureActive);
        }
    }), beforeChildRoot);
    (beforeChildRoot as unknown as { createChild(): Container }).createChild = () => {
        childCreations++;
        return {
            bind: () => ({
                toSelf: () => ({ inSingletonScope: () => undefined })
            }),
            get: () => scanOSSDelegate()
        } as unknown as Container;
    };

    assert.deepEqual(await beforeChild.proxy.scanContent('dispose before child'), scanOSSUnavailableResult);
    assert.equal(childCreations, 0);

    const beforeConstructionRoot = new Container();
    let delegateConstructions = 0;
    let beforeConstruction!: ReturnType<typeof createScanOSSProxy>;
    beforeConstruction = createScanOSSProxy(compiled.Proxy, async () => feature, beforeConstructionRoot);
    (beforeConstructionRoot as unknown as { createChild(): Container }).createChild = () => {
        beforeConstruction.proxy.dispose();
        return {
            bind: () => ({
                toSelf: () => ({ inSingletonScope: () => undefined })
            }),
            get: () => {
                delegateConstructions++;
                return scanOSSDelegate();
            }
        } as unknown as Container;
    };

    assert.deepEqual(await beforeConstruction.proxy.scanContent('dispose before construction'), scanOSSUnavailableResult);
    assert.equal(delegateConstructions, 0);
});

test('compiled ScanOSS proxy disposal is idempotent, drops its delegate, and calls no invented disposal hook', async () => {
    const { Proxy } = compileScanOSSModules();
    let loads = 0;
    let delegateDisposals = 0;
    const delegate = {
        scanContent: async (): Promise<ScanOSSTestResult> => ({ type: 'clean' }),
        dispose: () => delegateDisposals++
    };
    const { proxy } = createScanOSSProxy(Proxy, async () => {
        loads++;
        return { createScanOSSService: () => delegate };
    });

    assert.deepEqual(await proxy.scanContent('activate once'), { type: 'clean' });
    proxy.dispose();
    proxy.dispose();

    assert.equal(delegateDisposals, 0);
    assert.equal((proxy as unknown as { delegate: unknown }).delegate, undefined);
    assert.deepEqual(await proxy.scanContent('must not resurrect'), scanOSSUnavailableResult);
    assert.equal(loads, 1);
});

test('compiled ScanOSS proxy keeps the sibling feature request nonliteral', () => {
    const { proxyOutputText } = compileScanOSSModules();
    assert.match(proxyOutputText, /featureRequest/);
    assert.doesNotMatch(
        proxyOutputText,
        /require\(\s*['"]\.\/scanoss-service-feature\.cjs['"]\s*\)/
    );
});

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

test('concurrent callers share one failed load and the next activation retries once', async () => {
    const { loader } = harness();
    const firstLoad = deferred<RideDeferredFeatureModule>();
    let loadCalls = 0;
    const descriptor = feature('shared-retryable', loader, () => {
        loadCalls++;
        return loadCalls === 1
            ? firstLoad.promise
            : Promise.resolve({ contributionTypes: [] });
    });

    const first = loader.activate(descriptor);
    const concurrent = loader.activate(descriptor);
    assert.strictEqual(concurrent, first);
    firstLoad.reject(new Error('shared chunk failure'));
    await assert.rejects(first, /shared chunk failure/);
    await assert.rejects(concurrent, /shared chunk failure/);

    await loader.activate(descriptor);
    assert.equal(loadCalls, 2);
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
