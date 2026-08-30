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

interface BrowserAutomationClientTest {
    readonly marker: string;
}

interface BrowserAutomationDelegateTest {
    isRunning(): Promise<boolean>;
    launch(remoteDebuggingPort: number): Promise<{ remoteDebuggingPort: number } | undefined>;
    close(): Promise<void>;
    queryDom(selector?: string): Promise<string>;
    setClient(client: BrowserAutomationClientTest | undefined): void;
    getClient?(): BrowserAutomationClientTest | undefined;
    dispose(): void;
}

interface BrowserAutomationFeatureTest {
    createBrowserAutomation(rootContainer: Container, ensureActive: () => void): BrowserAutomationDelegateTest;
}

interface BrowserAutomationProxyTest extends BrowserAutomationDelegateTest {
    dispose(): void;
}

type BrowserAutomationProxyConstructor = new () => BrowserAutomationProxyTest;
type BrowserAutomationUpstreamConstructor = new () => BrowserAutomationDelegateTest;
type CommonJSLoad = (request: string, parent: unknown, isMain: boolean) => unknown;

const commonJSModule = createRequire(__filename)('node:module') as { _load: CommonJSLoad };
let compiledDirectory: string | undefined;
let compiledProxy: BrowserAutomationProxyConstructor | undefined;
let initialProxyRequests: readonly string[] = [];
let compiledFeature: BrowserAutomationFeatureTest | undefined;

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

function assertNoBrowserAutomationRuntime(requests: readonly string[]): void {
    const forbidden = requests.filter(request => /(?:^|[/\\])(?:puppeteer-core|chromium-bidi|esprima|@tootallnate[/\\]quickjs-emscripten)(?:$|[/\\])/.test(request));
    assert.deepEqual(forbidden, []);
}

function compileProxy(): BrowserAutomationProxyConstructor {
    if (compiledProxy) {
        return compiledProxy;
    }
    const appDirectory = path.resolve(__dirname, '..', '..', '..', '..', '..');
    const sourceFile = path.join(
        appDirectory,
        'applications',
        'browser',
        'tauri-src',
        'backend',
        'ai-ide-browser-automation-proxy.ts'
    );
    compiledDirectory = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), 'browser-automation-lifecycle-'));
    const result = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
        fileName: sourceFile,
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
            experimentalDecorators: false,
            sourceMap: false
        },
        reportDiagnostics: true
    });
    const errors = (result.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
    if (errors.length > 0) {
        throw new Error(`Unable to compile browser automation proxy: ${errors.map(error => error.messageText).join(', ')}`);
    }
    const output = path.join(compiledDirectory, 'proxy.cjs');
    fs.writeFileSync(output, result.outputText);
    const loaded = observeCommonJSLoads(() => createRequire(path.join(compiledDirectory!, 'runtime.cjs'))(output) as {
        BrowserAutomationImpl: BrowserAutomationProxyConstructor;
    });
    initialProxyRequests = loaded.requests;
    compiledProxy = loaded.value.BrowserAutomationImpl;
    return compiledProxy;
}

function compileFeature(): {
    readonly feature: BrowserAutomationFeatureTest;
    readonly Upstream: BrowserAutomationUpstreamConstructor;
} {
    compileProxy();
    const runtimeRequire = createRequire(path.join(compiledDirectory!, 'runtime.cjs'));
    if (!compiledFeature) {
        const appDirectory = path.resolve(__dirname, '..', '..', '..', '..', '..');
        const sourceFile = path.join(
            appDirectory,
            'applications',
            'browser',
            'tauri-src',
            'backend',
            'ai-ide-browser-automation-feature.ts'
        );
        const result = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
            fileName: sourceFile,
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
                sourceMap: false
            },
            reportDiagnostics: true
        });
        const errors = (result.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
        if (errors.length > 0) {
            throw new Error(`Unable to compile browser automation feature: ${errors.map(error => error.messageText).join(', ')}`);
        }
        const output = path.join(compiledDirectory!, 'ai-ide-browser-automation-feature.cjs');
        fs.writeFileSync(output, result.outputText);
        compiledFeature = runtimeRequire(output) as BrowserAutomationFeatureTest;
    }
    const Upstream = (runtimeRequire('@theia/ai-ide/lib/node/app-tester-agent/browser-automation-impl') as {
        BrowserAutomationImpl: BrowserAutomationUpstreamConstructor;
    }).BrowserAutomationImpl;
    return { feature: compiledFeature, Upstream };
}

function createProxy(
    loadFeature: () => Promise<BrowserAutomationFeatureTest>
): { proxy: BrowserAutomationProxyTest; connectionContainer: Container } {
    const Proxy = compileProxy();
    const rootContainer = new Container();
    rootContainer.bind(RootContainer).toConstantValue(rootContainer);
    const connectionContainer = rootContainer.createChild();
    connectionContainer.bind(Proxy).toSelf().inSingletonScope();
    const proxy = connectionContainer.get(Proxy);
    (proxy as unknown as { loadFeature: () => Promise<BrowserAutomationFeatureTest> }).loadFeature = loadFeature;
    return { proxy, connectionContainer };
}

after(() => {
    if (compiledDirectory) {
        fs.rmSync(compiledDirectory, { recursive: true, force: true });
    }
});

test('cold browser automation operations do not load Puppeteer or activate the feature', async () => {
    let loads = 0;
    const client = { marker: 'cold-client' };
    const constructed = observeCommonJSLoads(() => createProxy(async () => {
        loads++;
        throw new Error('cold feature must not load');
    }));

    constructed.value.proxy.setClient(client);
    assert.strictEqual(constructed.value.proxy.getClient?.(), client);
    assert.equal(await constructed.value.proxy.isRunning(), false);
    await constructed.value.proxy.close();
    assert.equal(loads, 0);
    assertNoBrowserAutomationRuntime(initialProxyRequests);
    assertNoBrowserAutomationRuntime(constructed.requests);
});

test('browser automation proxy shares activation and applies a pre-activation client', async () => {
    let loads = 0;
    let factories = 0;
    let clientAtLaunch: BrowserAutomationClientTest | undefined;
    const client = { marker: 'connected-client' };
    const candidate: BrowserAutomationDelegateTest = {
        isRunning: async () => true,
        launch: async remoteDebuggingPort => {
            clientAtLaunch = candidate.getClient?.();
            return { remoteDebuggingPort };
        },
        close: async () => undefined,
        queryDom: async selector => `<body data-selector="${selector ?? ''}"></body>`,
        setClient: next => { clientAtLaunch = next; },
        getClient: () => clientAtLaunch,
        dispose: () => undefined
    };
    const created = createProxy(async () => {
        loads++;
        await Promise.resolve();
        return {
            createBrowserAutomation: () => {
                factories++;
                return candidate;
            }
        };
    });
    created.proxy.setClient(client);

    const [launched, dom] = await Promise.all([
        created.proxy.launch(9333),
        created.proxy.queryDom('#app')
    ]);

    assert.deepEqual(launched, { remoteDebuggingPort: 9333 });
    assert.equal(dom, '<body data-selector="#app"></body>');
    assert.strictEqual(clientAtLaunch, client);
    assert.equal(loads, 1);
    assert.equal(factories, 1);
});

test('browser automation proxy retries after a failed feature load', async () => {
    let attempts = 0;
    const candidate: BrowserAutomationDelegateTest = {
        isRunning: async () => false,
        launch: async remoteDebuggingPort => ({ remoteDebuggingPort }),
        close: async () => undefined,
        queryDom: async () => '<main></main>',
        setClient: () => undefined,
        dispose: () => undefined
    };
    const created = createProxy(async () => {
        attempts++;
        if (attempts === 1) {
            throw new Error('feature unavailable');
        }
        return { createBrowserAutomation: () => candidate };
    });

    await assert.rejects(created.proxy.queryDom(), /feature unavailable/);
    assert.deepEqual(await created.proxy.launch(9444), { remoteDebuggingPort: 9444 });
    assert.equal(attempts, 2);
});

test('browser automation feature creates the real implementation as one child singleton', () => {
    const { feature, Upstream } = compileFeature();
    const rootContainer = new Container();
    const originalCreateChild = rootContainer.createChild.bind(rootContainer);
    let childCreations = 0;
    let createdChild: Container | undefined;
    (rootContainer as unknown as { createChild(): Container }).createChild = () => {
        childCreations++;
        const child = originalCreateChild();
        createdChild = child;
        return child;
    };
    let activeChecks = 0;

    const delegate = feature.createBrowserAutomation(rootContainer, () => { activeChecks++; });

    assert.equal(childCreations, 1);
    assert.equal(activeChecks, 3);
    assert.ok(createdChild);
    assert.ok(delegate instanceof Upstream);
    assert.strictEqual(createdChild.get(Upstream), delegate);
    delegate.dispose();
});

test('close waits for an activation already in flight and closes its delegate', async () => {
    let resolveFeature!: (feature: BrowserAutomationFeatureTest) => void;
    const feature = new Promise<BrowserAutomationFeatureTest>(resolve => { resolveFeature = resolve; });
    let closes = 0;
    const candidate: BrowserAutomationDelegateTest = {
        isRunning: async () => true,
        launch: async remoteDebuggingPort => ({ remoteDebuggingPort }),
        close: async () => { closes++; },
        queryDom: async () => '<main></main>',
        setClient: () => undefined,
        dispose: () => undefined
    };
    const created = createProxy(() => feature);
    const launch = created.proxy.launch(9555);
    const close = created.proxy.close();
    resolveFeature({ createBrowserAutomation: () => candidate });

    assert.deepEqual(await launch, { remoteDebuggingPort: 9555 });
    await close;
    assert.equal(closes, 1);
});

test('browser automation proxy disposes a candidate canceled during client handoff', async () => {
    let disposals = 0;
    let created!: ReturnType<typeof createProxy>;
    const candidate: BrowserAutomationDelegateTest = {
        isRunning: async () => false,
        launch: async remoteDebuggingPort => ({ remoteDebuggingPort }),
        close: async () => undefined,
        queryDom: async () => '<html></html>',
        setClient: () => created.proxy.dispose(),
        dispose: () => disposals++
    };
    created = createProxy(async () => ({
        createBrowserAutomation: () => candidate
    }));

    await assert.rejects(created.proxy.launch(9222), /disposed/i);
    created.proxy.dispose();
    assert.equal(disposals, 1);
});

test('browser automation proxy disposes an active delegate once and cannot resurrect it', async () => {
    let loads = 0;
    let disposals = 0;
    const upstreamError = new Error('upstream query failed');
    const candidate: BrowserAutomationDelegateTest = {
        isRunning: async () => true,
        launch: async remoteDebuggingPort => ({ remoteDebuggingPort }),
        close: async () => undefined,
        queryDom: async () => { throw upstreamError; },
        setClient: () => undefined,
        dispose: () => { disposals++; }
    };
    const created = createProxy(async () => {
        loads++;
        return { createBrowserAutomation: () => candidate };
    });

    await assert.rejects(created.proxy.queryDom(), error => error === upstreamError);
    created.proxy.dispose();
    created.proxy.dispose();
    await assert.rejects(created.proxy.launch(9666), /disposed/i);
    assert.equal(loads, 1);
    assert.equal(disposals, 1);
});
