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
import { RootContainer } from '@theia/core/lib/node/backend-application';
import { Container } from '@theia/core/shared/inversify';

interface ProviderManagerTest {
    readonly apiKey: string | undefined;
    setApiKey(apiKey: string | undefined): void;
    setProxyUrl?(proxyUrl: string | undefined): void;
    setMaxRetriesOnErrors?(value: number): void;
    setRetryDelayOnRateLimitError?(value: number): void;
    setRetryDelayOnOtherErrors?(value: number): void;
    createOrUpdateLanguageModels(...models: Array<{ readonly id: string; readonly model: string }>): Promise<void>;
    removeLanguageModels(...modelIds: string[]): void;
    dispose(): void;
}

interface ProviderFeatureTest {
    [factory: string]: unknown;
}

type ProviderProxyConstructor = new () => ProviderManagerTest;
type ProviderUpstreamConstructor = new () => ProviderManagerTest;

interface ProviderDescriptor {
    readonly name: string;
    readonly proxySource: string;
    readonly featureSource: string;
    readonly proxyExport: string;
    readonly featureExport: string;
    readonly upstreamRequest: string;
    readonly upstreamExport: string;
    readonly forbiddenRuntime: RegExp;
    readonly applyConfiguration: (manager: ProviderManagerTest, events?: string[]) => void;
    readonly expectedConfiguration: readonly string[];
}

const providers: readonly ProviderDescriptor[] = [
    {
        name: 'Google',
        proxySource: 'google-language-models-manager-proxy.ts',
        featureSource: 'google-language-models-manager-feature.ts',
        proxyExport: 'GoogleLanguageModelsManagerImpl',
        featureExport: 'createGoogleLanguageModelsManager',
        upstreamRequest: '@theia/ai-google/lib/node/google-language-models-manager-impl',
        upstreamExport: 'GoogleLanguageModelsManagerImpl',
        forbiddenRuntime: /(?:^|[/\\])(?:@google[/\\]genai|google-auth-library|gaxios|node-fetch)(?:$|[/\\])/,
        applyConfiguration: (manager, events) => {
            manager.setApiKey('google-key');
            events?.push('proxy:set-api-key');
            manager.setMaxRetriesOnErrors?.(7);
            events?.push('proxy:set-max-retries');
            manager.setRetryDelayOnRateLimitError?.(17);
            events?.push('proxy:set-rate-limit-delay');
            manager.setRetryDelayOnOtherErrors?.(27);
            events?.push('proxy:set-other-delay');
        },
        expectedConfiguration: [
            'delegate:set-api-key:google-key',
            'delegate:set-max-retries:7',
            'delegate:set-rate-limit-delay:17',
            'delegate:set-other-delay:27',
        ],
    },
    {
        name: 'Hugging Face',
        proxySource: 'huggingface-language-models-manager-proxy.ts',
        featureSource: 'huggingface-language-models-manager-feature.ts',
        proxyExport: 'HuggingFaceLanguageModelsManagerImpl',
        featureExport: 'createHuggingFaceLanguageModelsManager',
        upstreamRequest: '@theia/ai-huggingface/lib/node/huggingface-language-models-manager-impl',
        upstreamExport: 'HuggingFaceLanguageModelsManagerImpl',
        forbiddenRuntime: /(?:^|[/\\])(?:@huggingface[/\\](?:inference|jinja|tasks))(?:$|[/\\])/,
        applyConfiguration: (manager, events) => {
            manager.setApiKey('huggingface-key');
            events?.push('proxy:set-api-key');
            manager.setProxyUrl?.('http://127.0.0.1:8080');
            events?.push('proxy:set-proxy-url');
        },
        expectedConfiguration: [
            'delegate:set-api-key:huggingface-key',
            'delegate:set-proxy-url:http://127.0.0.1:8080',
        ],
    },
];

type CommonJSLoad = (request: string, parent: unknown, isMain: boolean) => unknown;
const commonJSModule = createRequire(__filename)('node:module') as { _load: CommonJSLoad };
const compiledDirectories: string[] = [];

function observeLoads<T>(action: () => T): { readonly value: T; readonly requests: readonly string[] } {
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

function transpile(sourceFile: string, outputFile: string): void {
    const result = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
        fileName: sourceFile,
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
            sourceMap: false,
        },
        reportDiagnostics: true,
    });
    const errors = (result.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
    if (errors.length > 0) {
        throw new Error(`Unable to compile ${path.basename(sourceFile)}: ${errors.map(error => error.messageText).join(', ')}`);
    }
    fs.writeFileSync(outputFile, result.outputText);
}

function compileProxy(descriptor: ProviderDescriptor): {
    readonly Proxy: ProviderProxyConstructor;
    readonly directory: string;
    readonly initialRequests: readonly string[];
} {
    const appDirectory = path.resolve(__dirname, '..', '..', '..', '..', '..');
    const sourceDirectory = path.join(appDirectory, 'applications', 'browser', 'tauri-src', 'backend');
    const directory = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), 'ai-provider-lifecycle-'));
    compiledDirectories.push(directory);
    const output = path.join(directory, 'proxy.cjs');
    transpile(path.join(sourceDirectory, descriptor.proxySource), output);
    const loaded = observeLoads(() => createRequire(path.join(directory, 'runtime.cjs'))(output) as Record<string, unknown>);
    return {
        Proxy: loaded.value[descriptor.proxyExport] as ProviderProxyConstructor,
        directory,
        initialRequests: loaded.requests,
    };
}

function createProxy(
    Proxy: ProviderProxyConstructor,
    loadFeature: () => Promise<ProviderFeatureTest>,
): ProviderManagerTest {
    const rootContainer = new Container();
    rootContainer.bind(RootContainer).toConstantValue(rootContainer);
    const connectionContainer = rootContainer.createChild();
    connectionContainer.bind(Proxy).toSelf().inSingletonScope();
    const proxy = connectionContainer.get(Proxy);
    (proxy as unknown as { loadFeature: () => Promise<ProviderFeatureTest> }).loadFeature = loadFeature;
    return proxy;
}

function fakeDelegate(events: string[]): ProviderManagerTest {
    let apiKey: string | undefined;
    return {
        get apiKey() { return apiKey; },
        setApiKey: value => { apiKey = value; events.push(`delegate:set-api-key:${value}`); },
        setProxyUrl: value => events.push(`delegate:set-proxy-url:${value}`),
        setMaxRetriesOnErrors: value => events.push(`delegate:set-max-retries:${value}`),
        setRetryDelayOnRateLimitError: value => events.push(`delegate:set-rate-limit-delay:${value}`),
        setRetryDelayOnOtherErrors: value => events.push(`delegate:set-other-delay:${value}`),
        createOrUpdateLanguageModels: async (...models) => { events.push(`delegate:create:${models.map(model => model.id).join(',')}`); },
        removeLanguageModels: (...ids) => events.push(`delegate:remove:${ids.join(',')}`),
        dispose: () => events.push('delegate:dispose'),
    };
}

after(() => {
    for (const directory of compiledDirectories) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

for (const descriptor of providers) {
    test(`${descriptor.name} provider stays cold for empty startup configuration`, async () => {
        const compiled = compileProxy(descriptor);
        let loads = 0;
        const proxy = createProxy(compiled.Proxy, async () => {
            loads++;
            throw new Error('cold provider feature must not load');
        });

        descriptor.applyConfiguration(proxy);
        await proxy.createOrUpdateLanguageModels();
        proxy.removeLanguageModels();
        proxy.removeLanguageModels('provider/missing-before-activation');

        assert.equal(loads, 0);
        assert.equal(compiled.initialRequests.some(request => descriptor.forbiddenRuntime.test(request)), false);
    });

    test(`${descriptor.name} provider shares activation and applies cached configuration first`, async () => {
        const compiled = compileProxy(descriptor);
        const events: string[] = [];
        const delegate = fakeDelegate(events);
        let loads = 0;
        let factories = 0;
        const proxy = createProxy(compiled.Proxy, async () => {
            loads++;
            await Promise.resolve();
            return {
                [descriptor.featureExport]: () => {
                    factories++;
                    return delegate;
                },
            };
        });
        descriptor.applyConfiguration(proxy);

        await Promise.all([
            proxy.createOrUpdateLanguageModels({ id: 'provider/one', model: 'one' }),
            proxy.createOrUpdateLanguageModels({ id: 'provider/two', model: 'two' }),
        ]);

        assert.equal(loads, 1);
        assert.equal(factories, 1);
        assert.deepEqual(events.slice(0, descriptor.expectedConfiguration.length), descriptor.expectedConfiguration);
        assert.deepEqual(events.slice(descriptor.expectedConfiguration.length).sort(), [
            'delegate:create:provider/one',
            'delegate:create:provider/two',
        ]);
    });

    test(`${descriptor.name} provider feature constructs the real singleton in one child`, () => {
        const compiled = compileProxy(descriptor);
        const appDirectory = path.resolve(__dirname, '..', '..', '..', '..', '..');
        const sourceDirectory = path.join(appDirectory, 'applications', 'browser', 'tauri-src', 'backend');
        const featureOutput = path.join(compiled.directory, path.basename(descriptor.featureSource, '.ts') + '.cjs');
        transpile(path.join(sourceDirectory, descriptor.featureSource), featureOutput);
        const runtimeRequire = createRequire(path.join(compiled.directory, 'runtime.cjs'));
        const feature = runtimeRequire(featureOutput) as Record<string, unknown>;
        const upstreamFile = runtimeRequire.resolve(descriptor.upstreamRequest);
        const upstreamRequire = createRequire(upstreamFile);
        const Upstream = (runtimeRequire(descriptor.upstreamRequest) as Record<string, unknown>)[descriptor.upstreamExport] as ProviderUpstreamConstructor;
        const registryIdentifier = (upstreamRequire('@theia/ai-core') as { LanguageModelRegistry: symbol }).LanguageModelRegistry;
        const rootContainer = new Container();
        rootContainer.bind(registryIdentifier).toConstantValue({});
        const originalCreateChild = rootContainer.createChild.bind(rootContainer);
        let childCreations = 0;
        let child: Container | undefined;
        (rootContainer as unknown as { createChild(): Container }).createChild = () => {
            childCreations++;
            const created = originalCreateChild();
            child = created;
            return created;
        };
        let activeChecks = 0;
        const factory = feature[descriptor.featureExport] as (container: Container, ensureActive: () => void) => ProviderManagerTest;

        const delegate = factory(rootContainer, () => { activeChecks++; });

        assert.equal(childCreations, 1);
        assert.equal(activeChecks, 3);
        assert.ok(child);
        assert.ok(delegate instanceof Upstream);
        assert.strictEqual(child.get(Upstream), delegate);
    });
}
