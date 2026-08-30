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

let compiledDirectory: string | undefined;
let compiledProxy: BrowserAutomationProxyConstructor | undefined;

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
    compiledProxy = (createRequire(path.join(compiledDirectory, 'runtime.cjs'))(output) as {
        BrowserAutomationImpl: BrowserAutomationProxyConstructor;
    }).BrowserAutomationImpl;
    return compiledProxy;
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
