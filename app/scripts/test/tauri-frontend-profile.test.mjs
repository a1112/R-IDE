import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    acquirePublishLock,
    canonicalDigest,
    createDirectoryTransactionPlan,
    findPackageManifest,
    generateProfileTarget,
    publishProfileBuild,
    parseProfileCliArguments,
    recoverDirectoryTransactions,
    replaceDirectoryTransactional,
    resolveInstalledPackageGraph,
    resolveProfile,
    retryFilesystemOperation,
    resolveInstalledManifest,
    selectCanonicalPackageManifest,
} from '../tauri-frontend-profile.mjs';
import {
    auditTheiaMetafile,
    buildAllowedTheiaPackageSet,
    createTauriProfileAuditPlugin,
    loadTauriProfileManifest,
} from '../../applications/browser/tauri-esbuild-profile-audit.mjs';
import {
    createTauriBrowserBuildPlans,
    ensureModuleScript
} from '../../applications/browser/tauri-src/esbuild-deferred.mjs';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const properLockfile = require('proper-lockfile');
const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function manifest(name, dependencies = {}, extra = {}) {
    return {
        name,
        version: '1.2.3',
        dependencies,
        theiaExtensions: [{ frontend: 'lib/browser/example-frontend-module' }],
        ...extra,
    };
}

function fixture({ roots = ['product'], featureGroups = {}, dependencies, packages, profileName = 'tauri-critical' }) {
    const browserDependencies = dependencies ?? Object.fromEntries(Object.keys(packages).map(name => [name, '^1.0.0']));
    return {
        profileName,
        profileConfig: {
            schema: 'ride.tauri-frontend-profile@2',
            profiles: {
                'tauri-critical': { roots },
                full: { includeAllBrowserRoots: true },
            },
            featureGroups,
        },
        browserManifest: {
            name: 'browser-app',
            version: '1.0.0',
            dependencies: browserDependencies,
            devDependencies: {
                '@theia/cli': '^1.0.0',
            },
            theia: { frontend: { config: { applicationName: 'R-IDE' } } },
        },
        packageManifests: packages,
    };
}

test('Tauri esbuild contract rejects undeclared Theia inputs and accepts allowed subpaths', async t => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-esbuild-audit-'));
    t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
    const allowedDirectory = path.join(directory, 'node_modules', '@theia', 'allowed');
    const forbiddenDirectory = path.join(directory, 'deduped-packages', 'forbidden');
    await fs.promises.mkdir(path.join(allowedDirectory, 'lib'), { recursive: true });
    await fs.promises.mkdir(path.join(forbiddenDirectory, 'lib'), { recursive: true });
    await fs.promises.writeFile(path.join(allowedDirectory, 'package.json'), JSON.stringify({ name: '@theia/allowed' }));
    await fs.promises.writeFile(path.join(forbiddenDirectory, 'package.json'), JSON.stringify({ name: '@theia/forbidden' }));

    const allowed = buildAllowedTheiaPackageSet({
        packages: [{ requestName: '@theia/allowed-alias', packageName: '@theia/allowed' }],
    });
    assert.deepEqual([...allowed].sort(), ['@theia/allowed', '@theia/allowed-alias']);
    await auditTheiaMetafile({
        metafile: { inputs: { 'node_modules\\@theia\\allowed\\lib\\frontend.js': {} } },
        allowedPackages: allowed,
        baseDirectory: directory,
    });
    await assert.rejects(
        auditTheiaMetafile({
            metafile: { inputs: { [path.join(forbiddenDirectory, 'lib', 'backend.js')]: {} } },
            allowedPackages: allowed,
            baseDirectory: directory,
        }),
        error => {
            assert.match(error.message, /@theia\/forbidden/);
            assert.doesNotMatch(error.message, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
            return true;
        },
    );

    const callbacks = {};
    createTauriProfileAuditPlugin({ baseDirectory: directory, allowedPackages: allowed }).setup({
        onResolve(filter, callback) {
            callbacks.resolve = { filter, callback };
        },
        onEnd(callback) {
            callbacks.end = callback;
        },
    });
    assert.equal(await callbacks.resolve.callback({ path: '@theia/allowed/lib/browser' }), undefined);
    assert.match((await callbacks.resolve.callback({ path: '@theia/forbidden/lib/browser' })).errors[0].text, /undeclared/);
    await assert.rejects(
        callbacks.end({ errors: [], metafile: { inputs: { [path.join(forbiddenDirectory, 'lib', 'backend.js')]: {} } } }),
        /@theia\/forbidden/,
    );
});

test('tracked full browser without a generated profile manifest keeps audit disabled', async t => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-esbuild-full-'));
    t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
    assert.equal(await loadTauriProfileManifest(directory), undefined);
});

test('resolves a stable dependency-first topological extension closure', () => {
    const packages = {
        product: manifest('product', { plugin: '^1.0.0', workspace: '^1.0.0' }),
        plugin: manifest('plugin', { workspace: '^1.0.0' }),
        workspace: manifest('workspace', { filesystem: '^1.0.0' }),
        filesystem: manifest('filesystem', { core: '^1.0.0' }),
        core: manifest('core'),
    };
    const first = resolveProfile(fixture({ packages }));
    const reordered = resolveProfile(fixture({
        packages: {
            core: packages.core,
            workspace: packages.workspace,
            product: packages.product,
            filesystem: packages.filesystem,
            plugin: packages.plugin,
        },
    }));

    assert.deepEqual(first.extensions, ['core', 'filesystem', 'workspace', 'plugin', 'product']);
    assert.deepEqual(reordered.extensions, first.extensions);
    assert.equal(reordered.digest, first.digest);
});

test('handles dependency cycles deterministically and emits every extension once', () => {
    const result = resolveProfile(fixture({
        roots: ['c'],
        packages: {
            c: manifest('c', { b: '^1.0.0' }),
            b: manifest('b', { a: '^1.0.0' }),
            a: manifest('a', { b: '^1.0.0' }),
        },
    }));

    assert.deepEqual(result.extensions, ['a', 'b', 'c']);
});

test('follows dependencies and required peers while allowing missing optional peers', () => {
    const result = resolveProfile(fixture({
        packages: {
            product: manifest('product', { dependency: '^1.0.0' }, {
                peerDependencies: { peer: '^1.0.0', optionalPeer: '^1.0.0' },
                peerDependenciesMeta: { optionalPeer: { optional: true } },
            }),
            dependency: manifest('dependency'),
            peer: manifest('peer'),
        },
    }));

    assert.deepEqual(result.extensions, ['dependency', 'peer', 'product']);
});

test('excludes an installed optional peer from the required manifest closure', () => {
    const result = resolveProfile(fixture({
        roots: ['product'],
        dependencies: { product: '^1.0.0' },
        packages: {
            product: manifest('product', {}, {
                peerDependencies: { optionalPeer: '^1.0.0' },
                peerDependenciesMeta: { optionalPeer: { optional: true } },
            }),
            optionalPeer: manifest('optionalPeer'),
        },
    }));

    assert.deepEqual(result.extensions, ['product']);
    assert.deepEqual(result.packages.map(entry => entry.requestName), ['product']);
});

test('rejects unknown roots', () => {
    assert.throws(
        () => resolveProfile(fixture({ roots: ['unknown'], packages: { product: manifest('product') } })),
        /Unknown profile root "unknown"/,
    );
});

test('rejects required missing dependencies and reports the dependency path', () => {
    assert.throws(
        () => resolveProfile(fixture({
            dependencies: { product: '^1.0.0', missing: '^1.0.0' },
            packages: { product: manifest('product', { missing: '^1.0.0' }) },
        })),
        /product -> missing.*required dependency is not installed/i,
    );
});

test('records runtime closure packages without declaring them as Theia extensions', () => {
    const result = resolveProfile(fixture({
        dependencies: { product: '^1.0.0' },
        packages: {
            product: manifest('product', { electron: '42.3.0' }),
            electron: { name: 'electron', version: '42.3.0' },
        },
    }));

    assert.deepEqual(result.extensions, ['product']);
    assert.deepEqual(result.packages.map(entry => entry.requestName), ['electron', 'product']);
});

test('does not declare a package with an empty Theia contribution list as an extension', () => {
    const result = resolveProfile(fixture({
        dependencies: { product: '^1.0.0' },
        packages: {
            product: manifest('product', { runtime: '^1.0.0' }),
            runtime: { name: 'runtime', version: '1.1.0', theiaExtensions: [] },
        },
    }));

    assert.deepEqual(result.extensions, ['product']);
    assert.deepEqual(result.packages.map(entry => entry.requestName), ['runtime', 'product']);
});

test('records a package-manager runtime override outside its parent range', () => {
    const result = resolveProfile(fixture({
        dependencies: { product: '^1.0.0', utility: '^9.0.0' },
        packages: {
            product: manifest('product', { utility: '^4.0.0' }),
            utility: { name: 'utility', version: '9.1.0' },
        },
    }));
    assert.deepEqual(result.extensions, ['product']);
    assert.deepEqual(result.packages.map(entry => entry.requestName), ['utility', 'product']);
});

test('rejects a transitive Theia extension that violates its parent range', () => {
    assert.throws(() => resolveProfile(fixture({
        dependencies: { product: '^1.0.0' },
        packages: {
            product: manifest('product', { child: '^1.0.0' }),
            child: manifest('child', {}, { version: '2.0.0' }),
        },
    })), /product -> child.*2\.0\.0.*parent dependency.*\^1\.0\.0/i);
});

test('does not apply an unselected browser root range to a nested runtime dependency', () => {
    const result = resolveProfile(fixture({
        roots: ['product'],
        dependencies: { product: '^1.0.0', 'fs-extra': '^9.1.0' },
        packages: {
            product: manifest('product', { helper: '^1.0.0' }),
            helper: { name: 'helper', version: '1.0.0', dependencies: { 'fs-extra': '^4.0.0' } },
            'fs-extra': { name: 'fs-extra', version: '4.0.3' },
        },
    }));

    assert.deepEqual(result.extensions, ['product']);
    assert.deepEqual(result.packages.map(entry => entry.requestName), ['fs-extra', 'helper', 'product']);
});

test('applies a browser root range only to the root request, not a nested package with the same name', async () => {
    const browserDirectory = path.resolve('browser-app');
    const graph = await resolveInstalledPackageGraph({
        browserManifest: { dependencies: { product: '^1.0.0', 'fs-extra': '^9.1.0' } },
        roots: ['product', 'fs-extra'],
        browserDirectory,
        canonicalizePackageDirectory: async directory => path.resolve(directory),
        resolver: async (requestName, fromDirectory) => {
            const nested = requestName === 'fs-extra' && path.basename(fromDirectory) === 'helper';
            const packageKey = nested ? 'fs-extra-nested' : requestName;
            const manifests = {
                product: manifest('product', { helper: '^1.0.0' }),
                helper: { name: 'helper', version: '1.0.0', dependencies: { 'fs-extra': '^4.0.0' } },
                'fs-extra': { name: 'fs-extra', version: '9.1.0' },
                'fs-extra-nested': { name: 'fs-extra', version: '4.0.3' },
            };
            return {
                requestName,
                packageDirectory: path.join(path.resolve('installed'), packageKey),
                manifest: manifests[packageKey],
            };
        },
    });

    assert.deepEqual(
        [...graph.records.values()].filter(record => record.requestName === 'fs-extra').map(record => record.manifest.version).sort(),
        ['4.0.3', '9.1.0'],
    );
});

test('uses exact package names for deferred conflicts without prefix matching', () => {
    const packages = {
        product: manifest('product', { '@theia/notebook': '^1.0.0', '@theia/ai-core': '^1.0.0' }),
        '@theia/notebook': manifest('@theia/notebook'),
        '@theia/ai-core': manifest('@theia/ai-core'),
        '@theia/ai': manifest('@theia/ai'),
    };

    assert.throws(
        () => resolveProfile(fixture({
            packages,
            featureGroups: {
                notebook: { deferredRoots: ['@theia/notebook'], blockedRoots: [] },
            },
        })),
        /Deferred root "@theia\/notebook".*product -> @theia\/notebook/i,
    );

    const result = resolveProfile(fixture({
        packages,
        featureGroups: {
            ai: { deferredRoots: ['@theia/ai'], blockedRoots: [] },
        },
    }));
    assert.ok(result.extensions.includes('@theia/ai-core'));
});

test('emits evidence-backed blocked roots separately from true deferred roots', () => {
    const result = resolveProfile(fixture({
        packages: {
            product: manifest('product', { notebook: '^1.0.0' }),
            notebook: manifest('notebook'),
            collaboration: manifest('collaboration'),
        },
        featureGroups: {
            notebook: {
                deferredRoots: [],
                blockedRoots: [{ name: 'notebook', reason: 'plugin host requires notebook' }],
            },
            collaboration: {
                deferredRoots: ['collaboration'],
                blockedRoots: [],
            },
        },
    }));

    assert.deepEqual(result.featureGroups, {
        collaboration: {
            deferredRoots: ['collaboration'],
            blockedRoots: [],
        },
        notebook: {
            deferredRoots: [],
            blockedRoots: [{
                name: 'notebook',
                reason: 'plugin host requires notebook',
                dependencyPath: ['product', 'notebook'],
            }],
        },
    });
});

test('emits an explicit deferred frontend module contract without treating its package as absent', () => {
    const result = resolveProfile(fixture({
        roots: ['product', 'secondary-window'],
        packages: {
            product: manifest('product'),
            'secondary-window': manifest('secondary-window'),
        },
        featureGroups: {
            'secondary-window': {
                deferredRoots: [],
                blockedRoots: [{
                    name: 'secondary-window',
                    reason: 'The package remains critical for the generated secondary-window entry.',
                }],
                deferredFrontendModules: [{
                    package: 'secondary-window',
                    module: 'secondary-window/lib/browser/secondary-window-frontend-module',
                    proxy: 'tauri-src/secondary-window-proxy-frontend-module.ts',
                    entry: 'tauri-src/secondary-window-feature.ts',
                    action: 'extract-widget',
                }],
            },
        },
    }));

    assert.deepEqual(result.featureGroups['secondary-window'].deferredFrontendModules, [{
        package: 'secondary-window',
        module: 'secondary-window/lib/browser/secondary-window-frontend-module',
        proxy: 'tauri-src/secondary-window-proxy-frontend-module.ts',
        entry: 'tauri-src/secondary-window-feature.ts',
        action: 'extract-widget',
    }]);
    assert.ok(result.extensions.includes('secondary-window'));
});

test('rejects ambiguous or non-canonical deferred frontend module declarations', () => {
    const packages = {
        product: manifest('product'),
        'secondary-window': manifest('secondary-window'),
    };
    const group = deferredFrontendModules => ({
        'secondary-window': {
            deferredRoots: [],
            blockedRoots: [],
            deferredFrontendModules,
        },
    });
    const valid = {
        package: 'secondary-window',
        module: 'secondary-window/lib/browser/secondary-window-frontend-module',
        proxy: 'tauri-src/secondary-window-proxy-frontend-module.ts',
        entry: 'tauri-src/secondary-window-feature.ts',
        action: 'extract-widget',
    };

    assert.throws(() => resolveProfile(fixture({
        roots: ['product'], packages, featureGroups: group([{ ...valid, package: 'missing' }]),
    })), /unknown deferred frontend package "missing"/i);
    assert.throws(() => resolveProfile(fixture({
        roots: ['product'], packages, featureGroups: group([{ ...valid, module: '../escape' }]),
    })), /canonical module request/i);
    assert.throws(() => resolveProfile(fixture({
        roots: ['product'], packages, featureGroups: group([valid, valid]),
    })), /deferred frontend module.*duplicated/i);
});

test('tracked profile defers only secondary-window and records every other group gate failure', async () => {
    const browserDirectory = path.join(appDirectory, 'applications', 'browser');
    const profile = JSON.parse(await fs.promises.readFile(path.join(browserDirectory, 'tauri-profile.json'), 'utf8'));
    const deferredGroups = Object.entries(profile.featureGroups)
        .filter(([, group]) => (group.deferredFrontendModules?.length ?? 0) > 0);

    assert.deepEqual(deferredGroups.map(([name]) => name), ['secondary-window']);
    assert.deepEqual(profile.featureGroups['secondary-window'].deferredFrontendModules, [{
        package: '@theia/secondary-window',
        module: '@theia/secondary-window/lib/browser/secondary-window-frontend-module',
        proxy: 'tauri-src/secondary-window-proxy-frontend-module.ts',
        entry: 'tauri-src/secondary-window-feature.ts',
        action: 'extract-widget',
    }]);
    for (const [name, group] of Object.entries(profile.featureGroups)) {
        assert.deepEqual(group.deferredRoots, [], `${name} must not silently omit package roots`);
        if (name !== 'secondary-window') {
            assert.match(group.deferBlockedReason, /adapter|backend|smoke|inventory|startup|provider|rebind|widget/i);
        }
    }
});

test('Tauri browser build splits only the ESM main entry and keeps classic worker names intact', () => {
    const options = {
        entryPoints: {
            bundle: './src-gen/frontend/index.js',
            'secondary-window': './src-gen/frontend/secondary-index.js',
            'editor.worker': 'editor-worker.js',
            'plugin-worker': 'plugin-worker.js',
        },
        outdir: 'lib/frontend',
        plugins: [],
    };
    const criticalManifest = {
        profile: 'tauri-critical',
        featureGroups: {
            'secondary-window': {
                deferredFrontendModules: [{
                    package: '@theia/secondary-window',
                    module: '@theia/secondary-window/lib/browser/secondary-window-frontend-module',
                    proxy: 'tauri-src/secondary-window-proxy-frontend-module.ts',
                    entry: 'tauri-src/secondary-window-feature.ts',
                    action: 'extract-widget',
                }],
            },
        },
    };
    const plans = createTauriBrowserBuildPlans(options, criticalManifest, path.resolve('generated-target'));

    assert.deepEqual(Object.keys(plans.main.entryPoints), ['bundle']);
    assert.equal(plans.main.format, 'esm');
    assert.equal(plans.main.splitting, true);
    assert.equal(plans.main.chunkNames, 'chunks/[name]-[hash]');
    assert.equal(
        plans.main.alias['@theia/secondary-window/lib/browser/secondary-window-frontend-module'],
        path.resolve('generated-target', 'tauri-src/secondary-window-proxy-frontend-module.ts')
    );
    assert.deepEqual(plans.classic.map(plan => ({
        entries: Object.keys(plan.entryPoints),
        format: plan.format,
        splitting: plan.splitting,
    })), [
        { entries: ['secondary-window'], format: 'iife', splitting: false },
        { entries: ['editor.worker'], format: 'iife', splitting: false },
        { entries: ['plugin-worker'], format: 'iife', splitting: false },
    ]);

    const full = createTauriBrowserBuildPlans(options, { ...criticalManifest, profile: 'full' }, path.resolve('full-target'));
    assert.deepEqual(full.main.alias ?? {}, {});
});

test('generated frontend HTML uses one external module script in build and watch mode', async t => {
    const html = '<body><script type="text/javascript" src="./bundle.js" charset="utf-8"></script></body>';
    const moduleHtml = '<body><script type="module" src="./bundle.js" charset="utf-8"></script></body>';
    assert.equal(ensureModuleScript(html), moduleHtml);
    assert.equal(ensureModuleScript(moduleHtml), moduleHtml);
    assert.throws(() => ensureModuleScript('<body></body>'), /bundle script/i);
    assert.throws(
        () => ensureModuleScript(`${html}${html}`),
        /exactly one bundle script/i
    );

    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-module-script-watch-'));
    t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
    const indexPath = path.join(directory, 'lib', 'frontend', 'index.html');
    await fs.promises.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.promises.writeFile(indexPath, html);
    const plans = createTauriBrowserBuildPlans({
        entryPoints: {
            bundle: 'bundle.js',
            'secondary-window': 'secondary-window.js',
            'editor.worker': 'editor.worker.js',
            'plugin-worker': 'plugin-worker.js',
        },
        outdir: path.dirname(indexPath),
        plugins: [],
    }, { profile: 'tauri-critical', featureGroups: {} }, directory);
    const moduleScriptPlugin = plans.main.plugins.find(plugin => plugin.name === 'ride-tauri-module-script');
    assert.ok(moduleScriptPlugin, 'main ESM build must patch index.html after every build, including watch rebuilds');
    assert.ok(plans.classic.every(plan => !plan.plugins.some(plugin => plugin.name === 'ride-tauri-module-script')));
    let onEnd;
    moduleScriptPlugin.setup({
        onEnd(callback) {
            onEnd = callback;
        }
    });
    assert.equal(typeof onEnd, 'function');
    await onEnd({ errors: [] });
    assert.equal(await fs.promises.readFile(indexPath, 'utf8'), moduleHtml);
    await onEnd({ errors: [] });
    assert.equal(await fs.promises.readFile(indexPath, 'utf8'), moduleHtml);
});

test('secondary-window source uses a dynamic proxy and a concrete disposable adapter', async () => {
    const sourceDirectory = path.join(appDirectory, 'applications', 'browser', 'tauri-src');
    const proxy = await fs.promises.readFile(path.join(sourceDirectory, 'secondary-window-proxy-frontend-module.ts'), 'utf8');
    const feature = await fs.promises.readFile(path.join(sourceDirectory, 'secondary-window-feature.ts'), 'utf8');

    assert.match(proxy, /import\(['"]\.\/secondary-window-feature['"]\)/);
    assert.doesNotMatch(proxy, /@theia\/secondary-window\/lib\/browser\/secondary-window-frontend-(?:module|contribution)/);
    assert.match(feature, /SecondaryWindowContribution/);
    assert.match(feature, /class RideSecondaryWindowContributionAdapter/);
    assert.doesNotMatch(feature, /\.secondaryWindowHandler\s*=/);
    assert.match(feature, /registerCommands/);
    assert.match(feature, /registerToolbarItems/);
    assert.match(feature, /return commandRegistration/);
    assert.match(feature, /return toolbarRegistration/);
});

test('secondary-window proxy splits from the initial bundle and executes the real contribution action', async t => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-secondary-window-e2e-'));
    t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
    const sourceDirectory = path.join(appDirectory, 'applications', 'browser', 'tauri-src');
    const deferredModule = '@theia/secondary-window/lib/browser/secondary-window-frontend-module';
    const entryPoints = {
        bundle: path.join(directory, 'frontend-entry.mjs'),
        'secondary-window': path.join(directory, 'secondary-window-entry.mjs'),
        'editor.worker': path.join(directory, 'editor-worker.mjs'),
        'plugin-worker': path.join(directory, 'plugin-worker.mjs'),
    };
    await Promise.all([
        fs.promises.writeFile(entryPoints.bundle, `import frontendModule from ${JSON.stringify(deferredModule)};\nexport default frontendModule;\n`),
        fs.promises.writeFile(entryPoints['secondary-window'], 'globalThis.secondaryWindowEntry = true;\n'),
        fs.promises.writeFile(entryPoints['editor.worker'], 'globalThis.editorWorkerEntry = true;\n'),
        fs.promises.writeFile(entryPoints['plugin-worker'], 'globalThis.pluginWorkerEntry = true;\n'),
    ]);
    const manifest = {
        profile: 'tauri-critical',
        featureGroups: {
            'secondary-window': {
                deferredFrontendModules: [{
                    package: '@theia/secondary-window',
                    module: deferredModule,
                    proxy: 'tauri-src/secondary-window-proxy-frontend-module.ts',
                    entry: 'tauri-src/secondary-window-feature.ts',
                    action: 'extract-widget',
                }],
            },
        },
    };
    const commonOptions = {
        entryPoints,
        outdir: path.join(directory, 'critical'),
        bundle: true,
        packages: 'external',
        write: true,
        logLevel: 'silent',
    };
    const generatedHtml = '<body><script type="text/javascript" src="./bundle.js" charset="utf-8"></script></body>';
    await fs.promises.mkdir(commonOptions.outdir, { recursive: true });
    await fs.promises.writeFile(path.join(commonOptions.outdir, 'index.html'), generatedHtml);
    const criticalPlans = createTauriBrowserBuildPlans(commonOptions, manifest, path.join(appDirectory, 'applications', 'browser'));
    await esbuild.build(criticalPlans.main);
    for (const plan of criticalPlans.classic) {
        await esbuild.build(plan);
    }

    const initialBundle = await fs.promises.readFile(path.join(directory, 'critical', 'bundle.js'), 'utf8');
    const chunkDirectory = path.join(directory, 'critical', 'chunks');
    const chunkNames = (await fs.promises.readdir(chunkDirectory)).sort();
    const chunks = await Promise.all(chunkNames.map(async name => ({
        name,
        source: await fs.promises.readFile(path.join(chunkDirectory, name), 'utf8'),
    })));
    assert.doesNotMatch(initialBundle, /secondary-window-frontend-contribution/);
    assert.doesNotMatch(initialBundle, /SecondaryWindowContribution/);
    assert.ok(chunks.some(({ source }) => source.includes('secondary-window-frontend-contribution')));
    assert.ok(chunks.some(({ source }) => source.includes('SecondaryWindowContribution')));
    assert.ok(chunkNames.every(name => /^secondary-window-feature-[A-Z0-9]+\.js$/.test(name)));
    for (const name of ['secondary-window.js', 'editor.worker.js', 'plugin-worker.js']) {
        assert.equal(fs.existsSync(path.join(directory, 'critical', name)), true, `${name} must retain its fixed classic-worker name`);
    }

    const fullDirectory = path.join(directory, 'full');
    await fs.promises.mkdir(fullDirectory, { recursive: true });
    await fs.promises.writeFile(path.join(fullDirectory, 'index.html'), generatedHtml);
    const fullPlans = createTauriBrowserBuildPlans(
        { ...commonOptions, outdir: fullDirectory },
        { ...manifest, profile: 'full' },
        path.join(appDirectory, 'applications', 'browser')
    );
    await esbuild.build(fullPlans.main);
    const fullBundle = await fs.promises.readFile(path.join(fullDirectory, 'bundle.js'), 'utf8');
    assert.match(fullBundle, /secondary-window-frontend-module/);
    assert.doesNotMatch(fullBundle, /RideSecondaryWindowProxy|secondary-window-feature/);

    const featureBundle = path.join(directory, 'secondary-window-feature.cjs');
    const fullModuleBundle = path.join(directory, 'secondary-window-full-module.cjs');
    const fullModuleEntry = path.join(directory, 'secondary-window-full-entry.mjs');
    const widgetsShim = path.join(directory, 'widgets-shim.cjs');
    const handlerShim = path.join(directory, 'secondary-window-handler-shim.cjs');
    const commandShim = path.join(directory, 'command-shim.cjs');
    const toolbarShim = path.join(directory, 'toolbar-shim.cjs');
    await Promise.all([
        fs.promises.writeFile(widgetsShim, String.raw`
            exports.codicon = name => 'codicon codicon-' + name;
            exports.ExtractableWidget = { is: widget => Boolean(widget) };
        `),
        fs.promises.writeFile(handlerShim, 'exports.SecondaryWindowHandler = class SecondaryWindowHandler {};\n'),
        fs.promises.writeFile(commandShim, String.raw`
            exports.Command = { toLocalizedCommand: command => command };
            exports.CommandContribution = Symbol.for('ride.test.CommandContribution');
        `),
        fs.promises.writeFile(toolbarShim, String.raw`
            exports.TabBarToolbarContribution = Symbol.for('ride.test.TabBarToolbarContribution');
        `),
        fs.promises.writeFile(fullModuleEntry, `
            import frontendModule from ${JSON.stringify(deferredModule)};
            export { frontendModule };
            export { SecondaryWindowHandler } from '@theia/core/lib/browser/secondary-window-handler';
            export { CommandContribution } from '@theia/core/lib/common/command';
        `),
    ]);
    await esbuild.build({
        entryPoints: [path.join(sourceDirectory, 'secondary-window-feature.ts')],
        outfile: featureBundle,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        nodePaths: [path.join(appDirectory, 'node_modules')],
        alias: {
            '@theia/core/lib/browser/widgets': widgetsShim,
            '@theia/core/lib/browser/secondary-window-handler': handlerShim,
        },
        external: [
            '@theia/core/shared/inversify',
            '@theia/core/lib/common/command',
            'theia-ide-product-ext/*',
        ],
        logLevel: 'silent',
    });
    await esbuild.build({
        entryPoints: [fullModuleEntry],
        outfile: fullModuleBundle,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        nodePaths: [path.join(appDirectory, 'node_modules')],
        alias: {
            '@theia/core/lib/browser/widgets': widgetsShim,
            '@theia/core/lib/browser/secondary-window-handler': handlerShim,
            '@theia/core/lib/browser/shell/tab-bar-toolbar': toolbarShim,
            '@theia/core/lib/common/command': commandShim,
        },
        external: ['@theia/core/shared/inversify'],
        logLevel: 'silent',
    });
    const fullSmokeScript = String.raw`
        const assert = require('node:assert/strict');
        const { Container } = require('@theia/core/shared/inversify');
        const bundled = require(process.argv[1]);
        const frontendModule = bundled.frontendModule.default ?? bundled.frontendModule;
        const { SecondaryWindowHandler, CommandContribution } = bundled;
        const moved = [];
        const container = new Container();
        container.bind(SecondaryWindowHandler).toConstantValue({
            moveWidgetToSecondaryWindow: async widget => moved.push(widget)
        });
        container.load(frontendModule);
        container.getAllAsync(CommandContribution).then(async contributions => {
            assert.equal(contributions.length, 1);
            const handlers = new Map();
            contributions[0].registerCommands({
                registerCommand(command, handler) {
                    handlers.set(command.id, handler);
                    return { dispose: () => handlers.delete(command.id) };
                }
            });
            const widget = { id: 'full-profile-widget' };
            await handlers.get('extract-widget').execute(widget);
            assert.deepEqual(moved, [widget]);
        }).catch(error => {
            console.error(error);
            process.exitCode = 1;
        });
    `;
    execFileSync(process.execPath, [
        '--input-type=commonjs', '--eval', fullSmokeScript,
        fullModuleBundle
    ], {
        cwd: appDirectory,
        env: { ...process.env, NODE_PATH: path.join(appDirectory, 'node_modules') },
        stdio: 'pipe',
    });
    const smokeScript = String.raw`
        const assert = require('node:assert/strict');
        const { RideDeferredCommandProxy, RideDeferredFeatureLoader } = require('theia-ide-product-ext/lib/browser/ride-deferred-feature-loader');
        const { createSecondaryWindowFeature } = require(process.argv[1]);
        const handlers = new Map();
        const toolbarItems = new Map();
        const commands = {
            registerCommand(command, handler) {
                if (handlers.has(command.id)) throw new Error('duplicate command ' + command.id);
                handlers.set(command.id, handler);
                return { dispose: () => handlers.delete(command.id) };
            },
            executeCommand(id, ...args) {
                return handlers.get(id)?.execute(...args);
            },
        };
        const toolbar = {
            registerItem(item) {
                if (toolbarItems.has(item.id)) throw new Error('duplicate toolbar ' + item.id);
                toolbarItems.set(item.id, item);
                return { dispose: () => toolbarItems.delete(item.id) };
            },
        };
        const moved = [];
        const secondaryWindowHandler = { moveWidgetToSecondaryWindow: async widget => moved.push(widget) };
        const loader = new RideDeferredFeatureLoader(commands, {}, {}, toolbar, {}, { error: async () => undefined });
        const proxy = new RideDeferredCommandProxy(loader, {
            id: 'secondary-window',
            command: { id: 'extract-widget', label: 'Move View to Secondary Window' },
            toolbarItem: { id: 'extract-widget', command: 'extract-widget' },
            load: async () => createSecondaryWindowFeature(secondaryWindowHandler),
        });
        proxy.registerCommands(commands);
        proxy.registerToolbarItems(toolbar);
        const widget = { id: 'e2e-extractable-widget' };
        Promise.resolve(commands.executeCommand('extract-widget', widget)).then(() => {
            assert.deepEqual(moved, [widget]);
            assert.equal(handlers.has('extract-widget'), true);
            assert.equal(toolbarItems.has('extract-widget'), true);
            loader.dispose();
            assert.equal(handlers.has('extract-widget'), false);
            assert.equal(toolbarItems.has('extract-widget'), false);
        }).catch(error => {
            console.error(error);
            process.exitCode = 1;
        });
    `;
    execFileSync(process.execPath, ['--input-type=commonjs', '--eval', smokeScript, featureBundle], {
        cwd: appDirectory,
        env: { ...process.env, NODE_PATH: path.join(appDirectory, 'node_modules') },
        stdio: 'pipe',
    });
});

test('rejects blocked roots that lack critical-closure evidence or a reason', () => {
    const packages = {
        product: manifest('product'),
        notebook: manifest('notebook'),
    };
    assert.throws(() => resolveProfile(fixture({
        packages,
        featureGroups: {
            notebook: {
                deferredRoots: [],
                blockedRoots: [{ name: 'notebook', reason: 'not actually required' }],
            },
        },
    })), /Blocked root "notebook".*not in the critical closure/i);
    assert.throws(() => resolveProfile(fixture({
        packages: {
            product: manifest('product', { notebook: '^1.0.0' }),
            notebook: manifest('notebook'),
        },
        featureGroups: {
            notebook: {
                deferredRoots: [],
                blockedRoots: [{ name: 'notebook', reason: '   ' }],
            },
        },
    })), /Blocked root "notebook".*reason/i);
});

test('rejects roots that are deferred and blocked or duplicated across feature groups', () => {
    const packages = {
        product: manifest('product', { notebook: '^1.0.0' }),
        notebook: manifest('notebook'),
    };
    assert.throws(() => resolveProfile(fixture({
        packages,
        featureGroups: {
            notebook: {
                deferredRoots: ['notebook'],
                blockedRoots: [{ name: 'notebook', reason: 'required' }],
            },
        },
    })), /both deferred and blocked/i);
    assert.throws(() => resolveProfile(fixture({
        packages,
        featureGroups: {
            first: { deferredRoots: ['notebook'], blockedRoots: [] },
            second: { deferredRoots: ['notebook'], blockedRoots: [] },
        },
    })), /more than one feature group/i);
});

test('fails closed when a true deferred root enters the critical closure', () => {
    assert.throws(() => resolveProfile(fixture({
        packages: {
            product: manifest('product', { notebook: '^1.0.0' }),
            notebook: manifest('notebook'),
        },
        featureGroups: {
            notebook: { deferredRoots: ['notebook'], blockedRoots: [] },
        },
    })), /Deferred root "notebook".*product -> notebook/i);
});

test('resolves npm aliases and validates alias target name and version', () => {
    const input = fixture({
        roots: ['product'],
        dependencies: {
            product: '^1.0.0',
            'core-alias': 'npm:@theia/core@^1.2.0',
        },
        packages: {
            product: manifest('product', { 'core-alias': 'npm:@theia/core@^1.2.0' }),
            'core-alias': manifest('@theia/core'),
        },
    });

    const result = resolveProfile(input);
    assert.deepEqual(result.extensions, ['core-alias', 'product']);
    assert.deepEqual(result.packages.find(entry => entry.requestName === 'core-alias'), {
        requestName: 'core-alias',
        packageName: '@theia/core',
        version: '1.2.3',
        dependencyPath: ['product', 'core-alias'],
    });

    input.packageManifests['core-alias'] = manifest('@theia/core', {}, { version: '2.0.0' });
    assert.throws(() => resolveProfile(input), /core-alias.*does not satisfy.*\^1\.2\.0/i);
    input.packageManifests['core-alias'] = manifest('@theia/not-core');
    assert.throws(() => resolveProfile(input), /core-alias.*expected package name "@theia\/core"/i);
});

test('requires every selected root to satisfy both browser and parent ranges', () => {
    assert.throws(() => resolveProfile(fixture({
        roots: ['product', 'child'],
        dependencies: { product: '^1.0.0', child: '^2.0.0' },
        packages: {
            product: manifest('product', { child: '^1.0.0' }),
            child: manifest('child', {}, { version: '1.5.0' }),
        },
    })), /child.*1\.5\.0.*browser manifest.*\^2\.0\.0/i);
});

test('rejects invalid semver ranges instead of silently skipping validation', () => {
    assert.throws(() => resolveProfile(fixture({
        dependencies: { product: 'not-a-semver-range' },
        packages: { product: manifest('product') },
    })), /product.*invalid.*not-a-semver-range/i);
});

test('uses a canonical digest independent of object key order and sensitive to contract changes', () => {
    const left = canonicalDigest({ schema: 1, nested: { b: 2, a: 1 }, list: ['x', 'y'] });
    const reordered = canonicalDigest({ list: ['x', 'y'], nested: { a: 1, b: 2 }, schema: 1 });
    const changed = canonicalDigest({ schema: 2, nested: { b: 2, a: 1 }, list: ['x', 'y'] });

    assert.match(left, /^[0-9a-f]{64}$/);
    assert.equal(reordered, left);
    assert.notEqual(changed, left);
});

test('full profile selects every browser dependency root', () => {
    const packages = {
        alpha: manifest('alpha'),
        beta: manifest('beta'),
        gamma: manifest('gamma'),
    };
    const result = resolveProfile(fixture({ profileName: 'full', roots: ['alpha'], packages }));

    assert.deepEqual(result.roots, ['alpha', 'beta', 'gamma']);
    assert.deepEqual(result.extensions, ['alpha', 'beta', 'gamma']);
});

test('includes the complete @theia/plugin-ext transitive browser-root closure', () => {
    const result = resolveProfile(fixture({
        roots: ['theia-ide-product-ext'],
        packages: {
            'theia-ide-product-ext': manifest('theia-ide-product-ext', { '@theia/plugin-ext': '^1.0.0' }),
            '@theia/plugin-ext': manifest('@theia/plugin-ext', { '@theia/workspace': '^1.0.0' }),
            '@theia/workspace': manifest('@theia/workspace', { '@theia/filesystem': '^1.0.0' }),
            '@theia/filesystem': manifest('@theia/filesystem', { '@theia/core': '^1.0.0' }),
            '@theia/core': manifest('@theia/core'),
        },
    }));

    assert.deepEqual(result.extensions, [
        '@theia/core',
        '@theia/filesystem',
        '@theia/workspace',
        '@theia/plugin-ext',
        'theia-ide-product-ext',
    ]);
});

test('discovers a transitive Theia extension outside the browser root manifest', () => {
    const result = resolveProfile(fixture({
        roots: ['product'],
        dependencies: { product: '^1.0.0' },
        packages: {
            product: manifest('product', { helper: '^1.0.0' }),
            helper: {
                name: 'helper',
                version: '1.4.0',
                dependencies: { 'nested-theia': '^2.0.0' },
            },
            'nested-theia': manifest('nested-theia', {}, { version: '2.3.0' }),
        },
    }));

    assert.deepEqual(result.extensions, ['nested-theia', 'product']);
    assert.deepEqual(result.packages.map(entry => entry.requestName), [
        'nested-theia',
        'helper',
        'product',
    ]);
    assert.deepEqual(result.packages.find(entry => entry.requestName === 'nested-theia').dependencyPath, [
        'product',
        'helper',
        'nested-theia',
    ]);
});

test('uses npm default prerelease range semantics', () => {
    assert.throws(() => resolveProfile(fixture({
        dependencies: { product: '^1.2.0' },
        packages: { product: manifest('product', {}, { version: '1.3.0-beta.1' }) },
    })), /product.*1\.3\.0-beta\.1.*does not satisfy.*\^1\.2\.0/i);

    const explicit = resolveProfile(fixture({
        dependencies: { product: '^1.3.0-beta.1' },
        packages: { product: manifest('product', {}, { version: '1.3.0-beta.2' }) },
    }));
    assert.deepEqual(explicit.extensions, ['product']);
});

test('records multiple runtime identities while retaining Theia extensions below each path', async () => {
    const browserDirectory = path.resolve('browser-app');
    const manifestsByContext = {
        product: manifest('product', { left: '^1.0.0', right: '^1.0.0' }),
        left: { name: 'left', version: '1.0.0', dependencies: { shared: '^1.0.0' } },
        right: { name: 'right', version: '1.0.0', dependencies: { shared: '^2.0.0' } },
        'shared-left': { name: 'shared', version: '1.5.0', dependencies: { 'nested-left': '^1.0.0' } },
        'shared-right': { name: 'shared', version: '2.5.0', dependencies: { 'nested-right': '^1.0.0' } },
        'nested-left': manifest('nested-left'),
        'nested-right': manifest('nested-right'),
    };
    const graph = await resolveInstalledPackageGraph({
        browserManifest: { dependencies: { product: '^1.0.0' } },
        roots: ['product'],
        browserDirectory,
        canonicalizePackageDirectory: async directory => path.resolve(directory),
        resolver: async (requestName, fromDirectory) => {
            const parent = path.basename(fromDirectory);
            const key = requestName === 'shared' ? `shared-${parent}` : requestName;
            return {
                requestName,
                packageDirectory: path.join(path.resolve('installed'), key),
                manifest: manifestsByContext[key],
            };
        },
    });
    const input = fixture({
        roots: ['product'],
        dependencies: { product: '^1.0.0' },
        packages: { product: manifestsByContext.product },
    });
    const result = resolveProfile({ ...input, installedGraph: graph });

    assert.deepEqual(result.extensions, ['nested-left', 'nested-right', 'product']);
    assert.deepEqual(result.packages.filter(entry => entry.requestName === 'shared').map(entry => ({
        version: entry.version,
        dependencyPath: entry.dependencyPath,
    })), [
        { version: '1.5.0', dependencyPath: ['product', 'left', 'shared'] },
        { version: '2.5.0', dependencyPath: ['product', 'right', 'shared'] },
    ]);
});

test('traverses same-version packages at different installation locations and unions their extension closures', async t => {
    const installedRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-install-context-'));
    t.after(() => fs.promises.rm(installedRoot, { recursive: true, force: true }));
    const browserDirectory = path.join(installedRoot, 'browser-app');
    const manifestsByContext = {
        product: manifest('product', { left: '^1.0.0', right: '^1.0.0' }),
        left: { name: 'left', version: '1.0.0', dependencies: { shared: '^1.0.0' } },
        right: { name: 'right', version: '1.0.0', dependencies: { shared: '^1.0.0' } },
        'shared-left': manifest('shared', { 'nested-left': '^1.0.0' }, { version: '1.5.0' }),
        'shared-right': manifest('shared', { 'nested-right': '^1.0.0' }, { version: '1.5.0' }),
        'nested-left': manifest('nested-left'),
        'nested-right': manifest('nested-right'),
    };
    for (const key of Object.keys(manifestsByContext)) {
        await fs.promises.mkdir(path.join(installedRoot, key), { recursive: true });
    }
    const graph = await resolveInstalledPackageGraph({
        browserManifest: { dependencies: { product: '^1.0.0' } },
        roots: ['product'],
        browserDirectory,
        resolver: async (requestName, fromDirectory) => {
            const parent = path.basename(fromDirectory);
            const key = requestName === 'shared' ? `shared-${parent}` : requestName;
            return {
                requestName,
                packageDirectory: path.join(installedRoot, key),
                manifest: manifestsByContext[key],
            };
        },
    });
    const result = resolveProfile({
        ...fixture({
            roots: ['product'],
            dependencies: { product: '^1.0.0' },
            packages: { product: manifestsByContext.product },
        }),
        installedGraph: graph,
    });

    assert.deepEqual(result.extensions, ['nested-left', 'nested-right', 'shared', 'product']);
    assert.equal(result.extensions.filter(name => name === 'shared').length, 1);
    assert.deepEqual(result.packages.filter(entry => entry.requestName === 'shared').map(entry => entry.dependencyPath), [
        ['product', 'left', 'shared'],
        ['product', 'right', 'shared'],
    ]);
    assert.equal(JSON.stringify(result).includes(path.resolve(installedRoot)), false);
});

test('finds the package root above nested module-format package metadata', async t => {
    const packageDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-package-root-'));
    t.after(() => fs.promises.rm(packageDirectory, { recursive: true, force: true }));
    const nestedDirectory = path.join(packageDirectory, 'lib', 'cjs');
    await fs.promises.mkdir(nestedDirectory, { recursive: true });
    await fs.promises.writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
        name: 'inversify', version: '6.2.2',
    }));
    await fs.promises.writeFile(path.join(nestedDirectory, 'package.json'), JSON.stringify({ type: 'commonjs' }));
    const entry = path.join(nestedDirectory, 'index.js');
    await fs.promises.writeFile(entry, 'module.exports = {};\n');

    assert.equal(findPackageManifest(entry), path.join(packageDirectory, 'package.json'));
    assert.equal(
        selectCanonicalPackageManifest(path.join(nestedDirectory, 'package.json')),
        path.join(packageDirectory, 'package.json'),
    );
});

test('resolves an installed package manifest when exports hide package metadata and the main entry', async t => {
    const applicationDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-hidden-manifest-'));
    t.after(() => fs.promises.rm(applicationDirectory, { recursive: true, force: true }));
    const packageDirectory = path.join(applicationDirectory, 'node_modules', '@openai', 'codex-sdk');
    await fs.promises.mkdir(packageDirectory, { recursive: true });
    await fs.promises.writeFile(path.join(applicationDirectory, 'package.json'), '{}');
    await fs.promises.writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
        name: '@openai/codex-sdk',
        version: '0.1.0',
        exports: { './types': './types.js' },
    }));

    const installed = await resolveInstalledManifest('@openai/codex-sdk', applicationDirectory);
    assert.equal(installed.packageDirectory, packageDirectory);
    assert.equal(installed.manifest.name, '@openai/codex-sdk');
});

async function writeSentinel(directory, value) {
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(path.join(directory, 'sentinel.txt'), value);
}

const transactionStateSequence = {
    prepared: 1,
    'backed-up': 2,
    installed: 3,
    'rolled-back': 4,
};

function transactionStatePath(plan, state, nonce = state.replaceAll('-', '')) {
    const sequence = String(transactionStateSequence[state]).padStart(2, '0');
    return path.join(
        plan.parentDirectory,
        `.${plan.targetName}.transaction-${plan.transactionId}.${sequence}-${state}-${nonce}.json`,
    );
}

async function writeTransactionStateFixture(plan, state, nonce, contents) {
    const marker = contents ?? `${JSON.stringify({
        schema: 'ride.directory-transaction@2',
        targetName: plan.targetName,
        transactionId: plan.transactionId,
        state,
        sequence: transactionStateSequence[state],
    })}\n`;
    await fs.promises.writeFile(transactionStatePath(plan, state, nonce), marker);
}

async function transactionArtifacts(plan) {
    return (await fs.promises.readdir(plan.parentDirectory))
        .filter(name => name.startsWith(`.${plan.targetName}.transaction-${plan.transactionId}.`))
        .sort();
}

test('directory transaction replaces a target and removes its recovery artifacts', async t => {
    const parentDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-transaction-ok-'));
    t.after(() => fs.promises.rm(parentDirectory, { recursive: true, force: true }));
    const plan = createDirectoryTransactionPlan(parentDirectory, 'lib', 'success');
    await writeSentinel(plan.targetDirectory, 'old');
    await writeSentinel(plan.temporaryDirectory, 'new');

    await replaceDirectoryTransactional(plan);

    assert.equal(await fs.promises.readFile(path.join(plan.targetDirectory, 'sentinel.txt'), 'utf8'), 'new');
    assert.equal(fs.existsSync(plan.backupDirectory), false);
    assert.equal(fs.existsSync(plan.markerPath), false);
});

test('directory transaction restores original bytes when install rename fails', async t => {
    const parentDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-transaction-rollback-'));
    t.after(() => fs.promises.rm(parentDirectory, { recursive: true, force: true }));
    const plan = createDirectoryTransactionPlan(parentDirectory, 'lib', 'install-fails');
    await writeSentinel(plan.targetDirectory, 'old-bytes');
    await writeSentinel(plan.temporaryDirectory, 'new-bytes');
    let renameCount = 0;
    const filesystem = {
        ...fs.promises,
        rename: async (source, destination) => {
            if ([plan.targetDirectory, plan.temporaryDirectory, plan.backupDirectory]
                .some(candidate => path.resolve(candidate) === path.resolve(source))) {
                renameCount += 1;
                if (renameCount === 2) {
                    throw Object.assign(new Error('install failed'), { code: 'EIO' });
                }
            }
            return fs.promises.rename(source, destination);
        },
    };

    await assert.rejects(replaceDirectoryTransactional(plan, { filesystem }), /install failed/);

    assert.equal(await fs.promises.readFile(path.join(plan.targetDirectory, 'sentinel.txt'), 'utf8'), 'old-bytes');
    assert.equal(await fs.promises.readFile(path.join(plan.temporaryDirectory, 'sentinel.txt'), 'utf8'), 'new-bytes');
    assert.equal(fs.existsSync(plan.backupDirectory), false);
});

test('directory transaction preserves original and rollback errors for recovery', async t => {
    const parentDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-transaction-double-fail-'));
    t.after(() => fs.promises.rm(parentDirectory, { recursive: true, force: true }));
    const plan = createDirectoryTransactionPlan(parentDirectory, 'lib', 'rollback-fails');
    await writeSentinel(plan.targetDirectory, 'old');
    await writeSentinel(plan.temporaryDirectory, 'new');
    let renameCount = 0;
    const filesystem = {
        ...fs.promises,
        rename: async (source, destination) => {
            if ([plan.targetDirectory, plan.temporaryDirectory, plan.backupDirectory]
                .some(candidate => path.resolve(candidate) === path.resolve(source))) {
                renameCount += 1;
                if (renameCount === 2) {
                    throw Object.assign(new Error('install failed'), { code: 'EIO' });
                }
                if (renameCount === 3) {
                    throw Object.assign(new Error('rollback failed'), { code: 'EACCES' });
                }
            }
            return fs.promises.rename(source, destination);
        },
    };

    await assert.rejects(replaceDirectoryTransactional(plan, { filesystem }), error => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.errors[0].message, /install failed/);
        assert.match(error.errors[1].message, /rollback failed/);
        return true;
    });
    assert.equal(fs.existsSync(plan.targetDirectory), false);
    assert.equal(await fs.promises.readFile(path.join(plan.backupDirectory, 'sentinel.txt'), 'utf8'), 'old');
    assert.ok((await transactionArtifacts(plan)).some(name => name.includes('.02-backed-up-')));
});

test('cleanup failure leaves an installed marker that startup recovery completes', async t => {
    const parentDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-transaction-cleanup-'));
    t.after(() => fs.promises.rm(parentDirectory, { recursive: true, force: true }));
    const plan = createDirectoryTransactionPlan(parentDirectory, 'lib', 'cleanup-fails');
    await writeSentinel(plan.targetDirectory, 'old');
    await writeSentinel(plan.temporaryDirectory, 'new');
    const filesystem = {
        ...fs.promises,
        rm: async (candidate, options) => {
            if (path.resolve(candidate) === path.resolve(plan.backupDirectory)) {
                throw Object.assign(new Error('cleanup failed'), { code: 'EACCES' });
            }
            return fs.promises.rm(candidate, options);
        },
    };

    await assert.rejects(replaceDirectoryTransactional(plan, { filesystem }), /cleanup failed/);
    assert.equal(await fs.promises.readFile(path.join(plan.targetDirectory, 'sentinel.txt'), 'utf8'), 'new');
    assert.equal(fs.existsSync(plan.backupDirectory), true);
    const installedMarker = (await transactionArtifacts(plan)).find(name => name.includes('.03-installed-'));
    assert.ok(installedMarker);
    assert.equal(JSON.parse(await fs.promises.readFile(path.join(parentDirectory, installedMarker), 'utf8')).state, 'installed');

    await recoverDirectoryTransactions({ parentDirectory, targetName: 'lib' });
    assert.equal(fs.existsSync(plan.backupDirectory), false);
    assert.deepEqual(await transactionArtifacts(plan), []);
});

test('startup recovery restores a backed-up target when the target is missing', async t => {
    const parentDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-transaction-orphan-'));
    t.after(() => fs.promises.rm(parentDirectory, { recursive: true, force: true }));
    const plan = createDirectoryTransactionPlan(parentDirectory, 'lib', 'orphaned');
    await writeSentinel(plan.backupDirectory, 'old');
    await writeSentinel(plan.temporaryDirectory, 'new');
    await fs.promises.writeFile(plan.markerPath, `${JSON.stringify({
        schema: 'ride.directory-transaction@1',
        targetName: 'lib',
        transactionId: 'orphaned',
        state: 'backed-up',
    })}\n`);

    await recoverDirectoryTransactions({ parentDirectory, targetName: 'lib' });

    assert.equal(await fs.promises.readFile(path.join(plan.targetDirectory, 'sentinel.txt'), 'utf8'), 'old');
    assert.equal(fs.existsSync(plan.temporaryDirectory), false);
    assert.equal(fs.existsSync(plan.markerPath), false);
});

test('startup recovery rolls back an installed target when a backed-up marker still has both directories', async t => {
    const parentDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-transaction-crash-gap-'));
    t.after(() => fs.promises.rm(parentDirectory, { recursive: true, force: true }));
    const plan = createDirectoryTransactionPlan(parentDirectory, 'lib', 'install-before-marker');
    await writeSentinel(plan.targetDirectory, 'complete-new-version');
    await writeSentinel(plan.backupDirectory, 'complete-old-version');
    await fs.promises.writeFile(plan.markerPath, `${JSON.stringify({
        schema: 'ride.directory-transaction@1',
        targetName: 'lib',
        transactionId: 'install-before-marker',
        state: 'backed-up',
    })}\n`);

    await recoverDirectoryTransactions({ parentDirectory, targetName: 'lib' });

    assert.equal(await fs.promises.readFile(path.join(plan.targetDirectory, 'sentinel.txt'), 'utf8'), 'complete-old-version');
    assert.equal(fs.existsSync(plan.backupDirectory), false);
    assert.equal(fs.existsSync(plan.temporaryDirectory), false);
    assert.equal(fs.existsSync(plan.markerPath), false);
});

test('transaction state publication syncs file and parent before filesystem mutation', async t => {
    const parentDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-transaction-fsync-'));
    t.after(() => fs.promises.rm(parentDirectory, { recursive: true, force: true }));
    const plan = createDirectoryTransactionPlan(parentDirectory, 'lib', 'fsync-order');
    await writeSentinel(plan.targetDirectory, 'old');
    await writeSentinel(plan.temporaryDirectory, 'new');
    const events = [];
    const filesystem = {
        ...fs.promises,
        open: async (candidate, flags) => {
            if (path.resolve(candidate) === path.resolve(parentDirectory)) {
                events.push('open-parent');
                return {
                    sync: async () => { events.push('sync-parent'); },
                    close: async () => { events.push('close-parent'); },
                };
            }
            events.push('open-marker-temp');
            const handle = await fs.promises.open(candidate, flags);
            return {
                writeFile: async data => { events.push('write-marker'); await handle.writeFile(data); },
                sync: async () => { events.push('sync-marker'); await handle.sync(); },
                close: async () => { events.push('close-marker'); await handle.close(); },
            };
        },
        rename: async (source, destination) => {
            if (path.basename(source).includes('.marker-tmp-')) {
                events.push('rename-marker');
            } else {
                events.push('rename-directory');
            }
            return fs.promises.rename(source, destination);
        },
    };

    await replaceDirectoryTransactional(plan, {
        filesystem,
        createMarkerNonce: (() => { let value = 0; return () => `nonce${value += 1}`; })(),
    });

    const firstDirectoryRename = events.indexOf('rename-directory');
    assert.deepEqual(events.slice(0, firstDirectoryRename), [
        'open-marker-temp',
        'write-marker',
        'sync-marker',
        'close-marker',
        'rename-marker',
        'open-parent',
        'sync-parent',
        'close-parent',
    ]);
});

test('transaction recovers safely after marker write or rename interruption', async t => {
    for (const failure of ['write', 'rename']) {
        const parentDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), `ride-transaction-marker-${failure}-`));
        t.after(() => fs.promises.rm(parentDirectory, { recursive: true, force: true }));
        const plan = createDirectoryTransactionPlan(parentDirectory, 'lib', `${failure}-interrupted`);
        await writeSentinel(plan.targetDirectory, 'complete-old');
        await writeSentinel(plan.temporaryDirectory, 'complete-new');
        const filesystem = {
            ...fs.promises,
            open: async (candidate, flags) => {
                const handle = await fs.promises.open(candidate, flags);
                if (failure !== 'write' || !path.basename(candidate).includes('.marker-tmp-')) {
                    return handle;
                }
                return {
                    writeFile: async data => {
                        await handle.writeFile(data.subarray ? data.subarray(0, 4) : String(data).slice(0, 4));
                        throw new Error('marker write interrupted');
                    },
                    sync: () => handle.sync(),
                    close: () => handle.close(),
                };
            },
            rename: async (source, destination) => {
                if (failure === 'rename' && path.basename(source).includes('.marker-tmp-')) {
                    throw new Error('marker rename interrupted');
                }
                return fs.promises.rename(source, destination);
            },
        };

        await assert.rejects(replaceDirectoryTransactional(plan, {
            filesystem,
            createMarkerNonce: () => `${failure}nonce`,
        }), new RegExp(`marker ${failure} interrupted`));
        await recoverDirectoryTransactions({ parentDirectory, targetName: 'lib' });
        assert.equal(await fs.promises.readFile(path.join(plan.targetDirectory, 'sentinel.txt'), 'utf8'), 'complete-old');
        assert.equal(await fs.promises.readFile(path.join(plan.temporaryDirectory, 'sentinel.txt'), 'utf8'), 'complete-new');
        assert.deepEqual(await transactionArtifacts(plan), []);
    }
});

test('recovery uses the previous complete state when the latest marker is truncated', async t => {
    const parentDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-transaction-truncated-'));
    t.after(() => fs.promises.rm(parentDirectory, { recursive: true, force: true }));
    const plan = createDirectoryTransactionPlan(parentDirectory, 'lib', 'truncated-latest');
    await writeSentinel(plan.targetDirectory, 'complete-old');
    await writeSentinel(plan.temporaryDirectory, 'complete-new');
    await writeTransactionStateFixture(plan, 'prepared', 'preparednonce');
    await fs.promises.rename(plan.targetDirectory, plan.backupDirectory);
    await writeTransactionStateFixture(plan, 'backed-up', 'truncatednonce', '{"schema":');

    await recoverDirectoryTransactions({ parentDirectory, targetName: 'lib' });

    assert.equal(await fs.promises.readFile(path.join(plan.targetDirectory, 'sentinel.txt'), 'utf8'), 'complete-old');
    assert.equal(fs.existsSync(plan.backupDirectory), false);
    assert.equal(fs.existsSync(plan.temporaryDirectory), false);
    assert.deepEqual(await transactionArtifacts(plan), []);
});

test('recovery restores a complete old version after power loss in backed-up state', async t => {
    const parentDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-transaction-power-loss-'));
    t.after(() => fs.promises.rm(parentDirectory, { recursive: true, force: true }));
    const plan = createDirectoryTransactionPlan(parentDirectory, 'lib', 'power-loss');
    await writeSentinel(plan.targetDirectory, 'complete-old');
    await writeSentinel(plan.temporaryDirectory, 'complete-new');
    await writeTransactionStateFixture(plan, 'prepared', 'preparednonce');
    await fs.promises.rename(plan.targetDirectory, plan.backupDirectory);
    await writeTransactionStateFixture(plan, 'backed-up', 'backupnonce');

    await recoverDirectoryTransactions({ parentDirectory, targetName: 'lib' });

    assert.equal(await fs.promises.readFile(path.join(plan.targetDirectory, 'sentinel.txt'), 'utf8'), 'complete-old');
    assert.equal(fs.existsSync(plan.backupDirectory), false);
    assert.equal(fs.existsSync(plan.temporaryDirectory), false);
    assert.deepEqual(await transactionArtifacts(plan), []);
});

test('Windows filesystem retry is bounded to EPERM and EBUSY', async () => {
    let attempts = 0;
    const delays = [];
    const value = await retryFilesystemOperation(async () => {
        attempts += 1;
        if (attempts < 3) {
            throw Object.assign(new Error('locked'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' });
        }
        return 'done';
    }, {
        platform: 'win32',
        maxAttempts: 3,
        delayMs: 7,
        sleep: async delay => delays.push(delay),
    });

    assert.equal(value, 'done');
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [7, 14]);
    let immediateAttempts = 0;
    await assert.rejects(retryFilesystemOperation(async () => {
        immediateAttempts += 1;
        throw Object.assign(new Error('bad path'), { code: 'ENOENT' });
    }, { platform: 'win32', maxAttempts: 5, sleep: async () => {} }), /bad path/);
    assert.equal(immediateAttempts, 1);
});

function profileBuildManifest({ profile = 'tauri-critical', buildId = 'publish-build', commit = 'd'.repeat(40) } = {}) {
    const contract = {
        schema: 'ride.tauri-frontend-profile@2',
        profile,
        roots: ['product'],
        extensions: ['product'],
        packages: [{
            requestName: 'product',
            packageName: 'product',
            version: '1.2.3',
            dependencyPath: ['product'],
        }],
        featureGroups: {},
    };
    return {
        schema: 'ride.tauri-profile',
        version: 1,
        commit,
        sourceIdentity: { commit, clean: true },
        buildId,
        profile,
        digest: canonicalDigest(contract),
        roots: contract.roots,
        extensions: contract.extensions,
        packages: contract.packages,
        featureGroups: contract.featureGroups,
    };
}

async function createPublishSource(browserDirectory, manifest, marker = manifest.profile) {
    const sourceDirectory = path.join(browserDirectory, '.ride-tauri-profile', 'builds', manifest.buildId);
    await fs.promises.mkdir(path.join(sourceDirectory, 'lib', 'frontend'), { recursive: true });
    await fs.promises.mkdir(path.join(sourceDirectory, 'lib', 'backend'), { recursive: true });
    await fs.promises.writeFile(path.join(sourceDirectory, 'lib', 'frontend', 'index.html'), marker);
    await fs.promises.writeFile(path.join(sourceDirectory, 'lib', 'backend', 'main.js'), marker);
    await fs.promises.writeFile(path.join(sourceDirectory, 'ride-tauri-profile.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return sourceDirectory;
}

test('publish validates identity and writes byte-identical manifests before cleaning its build', async t => {
    const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-publish-ok-'));
    t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
    const manifest = profileBuildManifest();
    const sourceDirectory = await createPublishSource(browserDirectory, manifest);

    const result = await publishProfileBuild({
        browserDirectory,
        expectedProfile: manifest.profile,
        buildId: manifest.buildId,
        sourceDirectory,
        sourceIdentity: async () => manifest.sourceIdentity,
    });

    assert.equal(result.profile, manifest.profile);
    assert.equal(result.buildId, manifest.buildId);
    const destination = path.join(browserDirectory, 'lib');
    const copies = await Promise.all([
        path.join(destination, 'ride-tauri-profile.json'),
        path.join(destination, 'frontend', 'ride-tauri-profile.json'),
        path.join(destination, 'backend', 'ride-tauri-profile.json'),
    ].map(candidate => fs.promises.readFile(candidate)));
    assert.equal(copies[0].equals(copies[1]), true);
    assert.equal(copies[0].equals(copies[2]), true);
    assert.equal(JSON.parse(copies[0]).commit, manifest.commit);
    assert.equal(fs.existsSync(sourceDirectory), false);
});

test('publish rejects profile mismatch, stale commit, and corrupt digest without replacing lib', async t => {
    const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-publish-reject-'));
    t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
    await writeSentinel(path.join(browserDirectory, 'lib'), 'previous');

    const wrongProfile = profileBuildManifest({ buildId: 'wrong-profile', profile: 'full' });
    await assert.rejects(publishProfileBuild({
        browserDirectory,
        expectedProfile: 'tauri-critical',
        buildId: wrongProfile.buildId,
        sourceDirectory: await createPublishSource(browserDirectory, wrongProfile),
        sourceIdentity: async () => wrongProfile.sourceIdentity,
    }), /profile.*mismatch/i);

    const stale = profileBuildManifest({ buildId: 'stale-build', commit: 'e'.repeat(40) });
    await assert.rejects(publishProfileBuild({
        browserDirectory,
        expectedProfile: stale.profile,
        buildId: stale.buildId,
        sourceDirectory: await createPublishSource(browserDirectory, stale),
        sourceIdentity: async () => ({ commit: 'f'.repeat(40), clean: true }),
    }), /stale|commit.*mismatch/i);

    const corrupt = profileBuildManifest({ buildId: 'corrupt-build' });
    corrupt.digest = '0'.repeat(64);
    await assert.rejects(publishProfileBuild({
        browserDirectory,
        expectedProfile: corrupt.profile,
        buildId: corrupt.buildId,
        sourceDirectory: await createPublishSource(browserDirectory, corrupt),
        sourceIdentity: async () => corrupt.sourceIdentity,
    }), /digest.*mismatch/i);

    assert.equal(await fs.promises.readFile(path.join(browserDirectory, 'lib', 'sentinel.txt'), 'utf8'), 'previous');
});

test('publish rejects malformed manifest fields and a non-canonical source directory', async t => {
    const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-publish-malformed-'));
    t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
    const malformed = { ...profileBuildManifest({ buildId: 'malformed-build' }), unexpected: true };
    const sourceDirectory = await createPublishSource(browserDirectory, malformed);
    await assert.rejects(publishProfileBuild({
        browserDirectory,
        expectedProfile: malformed.profile,
        buildId: malformed.buildId,
        sourceDirectory,
        sourceIdentity: async () => malformed.sourceIdentity,
    }), /manifest fields|unsupported.*unexpected/i);

    const valid = profileBuildManifest({ buildId: 'source-build' });
    const canonicalSource = await createPublishSource(browserDirectory, valid);
    await assert.rejects(publishProfileBuild({
        browserDirectory,
        expectedProfile: valid.profile,
        buildId: valid.buildId,
        sourceDirectory: path.join(browserDirectory, 'elsewhere'),
        sourceIdentity: async () => valid.sourceIdentity,
    }), /source directory.*canonical/i);
    assert.equal(fs.existsSync(canonicalSource), true);
});

test('proper-lockfile is a direct exact production dependency', async () => {
    const packageManifest = JSON.parse(await fs.promises.readFile(path.join(appDirectory, 'package.json'), 'utf8'));
    assert.equal(packageManifest.devDependencies?.['proper-lockfile'], '4.1.2');
    const productionSource = await fs.promises.readFile(path.join(appDirectory, 'scripts', 'tauri-frontend-profile.mjs'), 'utf8');
    assert.match(productionSource, /require\(['"]proper-lockfile['"]\)/);
    assert.doesNotMatch(productionSource, /createPublishLockFilesystem|leaseId|quarantine|isProcessAlive|process\.kill\(pid|parsePublishLockOwner|readPublishLockOwner/);
});

test('publish lock delegates fixed cross-process policy to proper-lockfile', async t => {
    const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-publish-lock-provider-'));
    t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
    let captured;
    let released = false;
    const lock = await acquirePublishLock({
        browserDirectory,
        lockProvider: {
            lock: async (target, options) => {
                captured = { target, options };
                return async () => { released = true; };
            },
        },
    });

    assert.equal(captured.target, path.resolve(browserDirectory));
    assert.equal(captured.options.realpath, false);
    assert.equal(captured.options.lockfilePath, path.join(path.resolve(browserDirectory), '.ride-tauri-publish.lock'));
    assert.ok(captured.options.stale >= 5_000);
    assert.ok(captured.options.update <= captured.options.stale / 2);
    assert.ok(captured.options.retries.retries > 0);
    assert.ok(captured.options.retries.retries * captured.options.retries.maxTimeout <= 31_000);
    assert.equal(typeof captured.options.onCompromised, 'function');
    assert.equal('fs' in captured.options, false, 'proper-lockfile must use its native filesystem implementation');
    lock.assertHealthy();
    await lock.release();
    assert.equal(released, true);
});

test('publish lock never swallows compromise or provider release errors', async t => {
    const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-publish-lock-errors-'));
    t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
    let options;
    let releaseCalls = 0;
    const compromised = await acquirePublishLock({
        browserDirectory,
        lockProvider: {
            lock: async (_target, value) => {
                options = value;
                return async () => { releaseCalls += 1; };
            },
        },
    });
    options.onCompromised(Object.assign(new Error('heartbeat lost'), { code: 'ECOMPROMISED' }));
    assert.throws(() => compromised.assertHealthy(), /heartbeat lost/);
    await assert.rejects(compromised.release(), /heartbeat lost/);
    assert.equal(releaseCalls, 1);

    const releaseFailure = await acquirePublishLock({
        browserDirectory,
        lockProvider: {
            lock: async () => async () => { throw new Error('release failed'); },
        },
    });
    await assert.rejects(releaseFailure.release(), /release failed/);
});

test('publish fails closed before installation when its lock is compromised', async t => {
    const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-publish-lock-compromised-'));
    t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
    await writeSentinel(path.join(browserDirectory, 'lib'), 'previous');
    const manifest = profileBuildManifest({ buildId: 'compromised-build' });
    const sourceDirectory = await createPublishSource(browserDirectory, manifest);
    let lockOptions;
    const lockProvider = {
        lock: async (_target, options) => {
            lockOptions = options;
            return async () => {};
        },
    };
    const copyTree = async (source, destination) => {
        await fs.promises.cp(source, destination, { recursive: true, errorOnExist: true });
        lockOptions.onCompromised(Object.assign(new Error('publish heartbeat lost'), { code: 'ECOMPROMISED' }));
    };

    await assert.rejects(publishProfileBuild({
        browserDirectory,
        expectedProfile: manifest.profile,
        buildId: manifest.buildId,
        sourceDirectory,
        sourceIdentity: async () => manifest.sourceIdentity,
        copyTree,
        lockOptions: { lockProvider },
    }), /publish heartbeat lost/);
    assert.equal(await fs.promises.readFile(path.join(browserDirectory, 'lib', 'sentinel.txt'), 'utf8'), 'previous');
    assert.equal(fs.existsSync(sourceDirectory), true);
});

test('publish preserves both operation and lock release failures', async t => {
    const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-publish-lock-aggregate-'));
    t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
    const manifest = profileBuildManifest({ buildId: 'aggregate-build' });
    const sourceDirectory = await createPublishSource(browserDirectory, manifest);

    await assert.rejects(publishProfileBuild({
        browserDirectory,
        expectedProfile: manifest.profile,
        buildId: manifest.buildId,
        sourceDirectory,
        sourceIdentity: async () => manifest.sourceIdentity,
        copyTree: async () => { throw new Error('copy failed'); },
        lockOptions: {
            lockProvider: {
                lock: async () => async () => { throw new Error('release failed'); },
            },
        },
    }), error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors.map(item => item.message), ['copy failed', 'release failed']);
        return true;
    });
});

test('publish removes its partial copy before a transaction marker exists', async t => {
    const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-publish-copy-cleanup-'));
    t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
    await writeSentinel(path.join(browserDirectory, 'lib'), 'previous');
    const manifest = profileBuildManifest({ buildId: 'partial-copy-build' });
    const sourceDirectory = await createPublishSource(browserDirectory, manifest);

    await assert.rejects(publishProfileBuild({
        browserDirectory,
        expectedProfile: manifest.profile,
        buildId: manifest.buildId,
        sourceDirectory,
        sourceIdentity: async () => manifest.sourceIdentity,
        copyTree: async (_source, destination) => {
            await fs.promises.mkdir(destination, { recursive: true });
            await fs.promises.writeFile(path.join(destination, 'partial.txt'), 'partial');
            throw new Error('partial copy failed');
        },
    }), /partial copy failed/);

    assert.equal(await fs.promises.readFile(path.join(browserDirectory, 'lib', 'sentinel.txt'), 'utf8'), 'previous');
    const leftovers = (await fs.promises.readdir(browserDirectory)).filter(name => name.startsWith('.lib.tmp-'));
    assert.deepEqual(leftovers, []);
});

test('publish preserves copy and temporary cleanup failures', async t => {
    const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-publish-copy-cleanup-error-'));
    t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
    const manifest = profileBuildManifest({ buildId: 'partial-copy-cleanup-error' });
    const sourceDirectory = await createPublishSource(browserDirectory, manifest);
    const filesystem = {
        ...fs.promises,
        rm: async (candidate, options) => {
            if (path.basename(candidate).startsWith('.lib.tmp-')) {
                throw new Error('temporary cleanup failed');
            }
            return fs.promises.rm(candidate, options);
        },
    };

    await assert.rejects(publishProfileBuild({
        browserDirectory,
        expectedProfile: manifest.profile,
        buildId: manifest.buildId,
        sourceDirectory,
        sourceIdentity: async () => manifest.sourceIdentity,
        copyTree: async (_source, destination) => {
            await fs.promises.mkdir(destination, { recursive: true });
            throw new Error('copy failed before marker');
        },
        transactionOptions: { filesystem },
    }), error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors.map(item => item.message), [
            'copy failed before marker',
            'temporary cleanup failed',
        ]);
        return true;
    });
});

test('proper-lockfile heartbeat keeps an active publish lock from becoming stale', { timeout: 12_000 }, async t => {
    const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-publish-lock-heartbeat-'));
    t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
    const lockDirectory = path.join(browserDirectory, '.ride-tauri-publish.lock');
    const lock = await acquirePublishLock({ browserDirectory });
    const initialMtime = (await fs.promises.stat(lockDirectory)).mtimeMs;
    await new Promise(resolve => setTimeout(resolve, 5_500));
    const refreshedMtime = (await fs.promises.stat(lockDirectory)).mtimeMs;
    assert.ok(refreshedMtime > initialMtime, 'heartbeat must refresh lock directory mtime');
    await assert.rejects(properLockfile.lock(browserDirectory, {
        realpath: false,
        lockfilePath: lockDirectory,
        stale: 5_000,
        update: 2_000,
        retries: 0,
    }), error => error?.code === 'ELOCKED');
    await lock.release();
});

test('legacy and non-proper publish locks fail closed without deleting any contents', async t => {
    const cases = [
        ['active-v1', 'owner.json', JSON.stringify({ schema: 'ride.tauri-publish-lock@1', pid: process.pid })],
        ['stale-v2', 'owner.json', JSON.stringify({ schema: 'ride.tauri-publish-lock@2', pid: 999999 })],
        ['dead-owner', 'owner.json', '{"schema":"ride.tauri-publish-lock@1","pid":999999}'],
        ['ownerless-init', 'legacy-initializing.tmp', 'initializing'],
    ];
    for (const [name, entryName, contents] of cases) {
        const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), `ride-publish-lock-${name}-`));
        t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
        const lockDirectory = path.join(browserDirectory, '.ride-tauri-publish.lock');
        const entryPath = path.join(lockDirectory, entryName);
        await fs.promises.mkdir(lockDirectory);
        await fs.promises.writeFile(entryPath, contents);
        const staleTime = new Date(Date.now() - 60_000);
        await fs.promises.utimes(lockDirectory, staleTime, staleTime);
        let providerCalls = 0;

        await assert.rejects(acquirePublishLock({
            browserDirectory,
            lockProvider: {
                lock: async () => {
                    providerCalls += 1;
                    return async () => {};
                },
            },
        }), /legacy|non-proper.*publish lock.*remove.*manually/i);
        assert.equal(providerCalls, 0);
        assert.equal(await fs.promises.readFile(entryPath, 'utf8'), contents);
        assert.equal(fs.existsSync(lockDirectory), true);
    }
});

test('proper-lockfile alone recovers its stale empty lock and release allows a successor', async t => {
    const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-publish-lock-stale-empty-'));
    t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
    const lockDirectory = path.join(browserDirectory, '.ride-tauri-publish.lock');
    await fs.promises.mkdir(lockDirectory);
    const staleTime = new Date(Date.now() - 60_000);
    await fs.promises.utimes(lockDirectory, staleTime, staleTime);

    const recovered = await acquirePublishLock({ browserDirectory });
    await recovered.release();
    assert.equal(fs.existsSync(lockDirectory), false);
    const successor = await acquirePublishLock({ browserDirectory });
    await successor.release();
    assert.equal(fs.existsSync(lockDirectory), false);
});

test('proper-lockfile serializes three independent process critical sections', { timeout: 15_000 }, async t => {
    const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-publish-lock-processes-'));
    t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
    const eventLog = path.join(browserDirectory, 'critical-sections.ndjson');
    const moduleUrl = pathToFileURL(path.join(appDirectory, 'scripts', 'tauri-frontend-profile.mjs')).href;
    const childScript = `
        import fs from 'node:fs';
        import { acquirePublishLock } from ${JSON.stringify(moduleUrl)};
        const [browserDirectory, contender, eventLog] = process.argv.slice(1);
        const lock = await acquirePublishLock({ browserDirectory });
        fs.appendFileSync(eventLog, JSON.stringify({ contender, event: 'enter' }) + '\\n');
        await new Promise(resolve => setTimeout(resolve, 150));
        fs.appendFileSync(eventLog, JSON.stringify({ contender, event: 'exit' }) + '\\n');
        await lock.release();
    `;
    const runContender = contender => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
            '--input-type=module',
            '--eval',
            childScript,
            browserDirectory,
            contender,
            eventLog,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('exit', code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Lock contender ${contender} exited with ${code}: ${stderr}`));
            }
        });
    });
    await Promise.all(['a', 'b', 'c'].map(runContender));

    const events = (await fs.promises.readFile(eventLog, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    let active = 0;
    let maximumActive = 0;
    for (const event of events) {
        active += event.event === 'enter' ? 1 : -1;
        maximumActive = Math.max(maximumActive, active);
        assert.ok(active >= 0, 'a contender cannot exit before entering');
    }
    assert.equal(events.length, 6);
    assert.equal(active, 0);
    assert.equal(maximumActive, 1);
    assert.equal(fs.existsSync(path.join(browserDirectory, '.ride-tauri-publish.lock')), false);
});

test('concurrent publishes serialize and never mix profile outputs', async t => {
    const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-publish-concurrent-'));
    t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
    const firstManifest = profileBuildManifest({ buildId: 'first-build', profile: 'tauri-critical', commit: '3'.repeat(40) });
    const secondManifest = profileBuildManifest({ buildId: 'second-build', profile: 'full', commit: '3'.repeat(40) });
    const firstSource = await createPublishSource(browserDirectory, firstManifest, 'first-build');
    const secondSource = await createPublishSource(browserDirectory, secondManifest, 'second-build');
    let allowFirstCopy;
    const firstCopyGate = new Promise(resolve => { allowFirstCopy = resolve; });
    let firstEntered;
    const firstEnteredPromise = new Promise(resolve => { firstEntered = resolve; });
    let secondCopyStarted = false;
    const copyTree = async (source, destination) => {
        if (path.resolve(source) === path.resolve(path.join(firstSource, 'lib'))) {
            firstEntered();
            await firstCopyGate;
        } else if (path.resolve(source) === path.resolve(path.join(secondSource, 'lib'))) {
            secondCopyStarted = true;
        }
        await fs.promises.cp(source, destination, { recursive: true, errorOnExist: true });
    };
    const common = {
        browserDirectory,
        sourceIdentity: async () => ({ commit: '3'.repeat(40), clean: true }),
        copyTree,
    };
    const first = publishProfileBuild({
        ...common,
        expectedProfile: firstManifest.profile,
        buildId: firstManifest.buildId,
        sourceDirectory: firstSource,
    });
    await firstEnteredPromise;
    const second = publishProfileBuild({
        ...common,
        expectedProfile: secondManifest.profile,
        buildId: secondManifest.buildId,
        sourceDirectory: secondSource,
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(secondCopyStarted, false, 'second publish must wait outside the copy/install section');
    allowFirstCopy();
    await Promise.all([first, second]);

    const destination = path.join(browserDirectory, 'lib');
    const rootManifest = JSON.parse(await fs.promises.readFile(path.join(destination, 'ride-tauri-profile.json'), 'utf8'));
    const frontendMarker = await fs.promises.readFile(path.join(destination, 'frontend', 'index.html'), 'utf8');
    const backendMarker = await fs.promises.readFile(path.join(destination, 'backend', 'main.js'), 'utf8');
    assert.equal(rootManifest.buildId, 'second-build');
    assert.equal(rootManifest.profile, 'full');
    assert.equal(frontendMarker, 'second-build');
    assert.equal(backendMarker, 'second-build');
    assert.equal(fs.existsSync(firstSource), false);
    assert.equal(fs.existsSync(secondSource), false);
});

test('CLI requires and preserves profile build identity arguments', () => {
    assert.deepEqual(parseProfileCliArguments([
        'prepare', '--profile', 'tauri-critical', '--build-id', 'cli-build',
    ], {}), {
        command: 'prepare',
        profileName: 'tauri-critical',
        buildId: 'cli-build',
        sourceDirectory: undefined,
    });
    assert.deepEqual(parseProfileCliArguments([
        'publish', '--profile', 'full', '--build-id', 'cli-full', '--source-dir', 'C:\\builds\\cli-full',
    ], {}), {
        command: 'publish',
        profileName: 'full',
        buildId: 'cli-full',
        sourceDirectory: 'C:\\builds\\cli-full',
    });
    assert.throws(() => parseProfileCliArguments(['publish', '--profile', 'full'], {}), /--build-id/i);
    assert.throws(() => parseProfileCliArguments([
        'publish', '--profile', 'full', '--build-id', 'cli-full',
    ], {}), /--source-dir/i);
});

test('generates an isolated target without writing tracked package.json or src-gen', async t => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-profile-test-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const browserDirectory = path.join(root, 'app', 'applications', 'browser');
    const packageDirectories = {
        product: path.join(root, 'installed', 'product'),
        shared: path.join(root, 'installed', 'shared'),
        '@theia/cli': path.join(root, 'installed', 'theia-cli'),
    };
    await fs.promises.mkdir(path.join(browserDirectory, 'resources'), { recursive: true });
    await fs.promises.mkdir(path.join(browserDirectory, 'ico'), { recursive: true });
    await fs.promises.mkdir(path.join(browserDirectory, 'tauri-src'), { recursive: true });
    await fs.promises.mkdir(path.join(browserDirectory, 'src-gen'), { recursive: true });
    await Promise.all(Object.values(packageDirectories).map(directory => fs.promises.mkdir(directory, { recursive: true })));
    await fs.promises.writeFile(path.join(browserDirectory, 'package.json'), JSON.stringify({
        name: 'browser-app',
        version: '1.0.0',
        dependencies: { product: '^1.0.0', shared: '^1.0.0' },
        devDependencies: { '@theia/cli': '^1.0.0' },
        theia: { generator: { config: { preloadTemplate: './resources/preload.html' } } },
    }, null, 2));
    await fs.promises.writeFile(path.join(browserDirectory, 'tauri-profile.json'), JSON.stringify({
        schema: 'ride.tauri-frontend-profile@2',
        profiles: { 'tauri-critical': { roots: ['product'] }, full: { includeAllBrowserRoots: true } },
        featureGroups: {},
        buildDevDependencies: ['@theia/cli'],
    }, null, 2));
    await fs.promises.writeFile(path.join(browserDirectory, 'esbuild.mjs'), 'export {};\n');
    await fs.promises.writeFile(path.join(browserDirectory, 'ride-esbuild-dedupe.mjs'), 'export {};\n');
    await fs.promises.writeFile(path.join(browserDirectory, 'tauri-esbuild-profile-audit.mjs'), 'export {};\n');
    await fs.promises.writeFile(path.join(browserDirectory, 'resources', 'preload.html'), '<main></main>\n');
    await fs.promises.writeFile(path.join(browserDirectory, 'ico', 'favicon.ico'), 'ico');
    await fs.promises.writeFile(path.join(browserDirectory, 'tauri-src', 'deferred.ts'), 'export {};\n');
    await fs.promises.writeFile(path.join(browserDirectory, 'src-gen', 'sentinel.txt'), 'tracked generated sentinel');
    const installedManifests = {
        product: manifest('product', { shared: '^1.0.0' }),
        shared: manifest('shared'),
        '@theia/cli': { name: '@theia/cli', version: '1.2.3' },
    };
    await Promise.all(Object.entries(installedManifests).map(([requestName, installedManifest]) => (
        fs.promises.writeFile(path.join(packageDirectories[requestName], 'package.json'), JSON.stringify(installedManifest))
    )));
    const originalPackage = await fs.promises.readFile(path.join(browserDirectory, 'package.json'), 'utf8');

    const result = await generateProfileTarget({
        browserDirectory,
        profileName: 'tauri-critical',
        buildId: 'isolated-build',
        sourceIdentity: async () => ({ commit: '9'.repeat(40), clean: true }),
        resolveInstalledManifest: async (requestName, fromDirectory) => ({
            manifest: installedManifests[requestName],
            packageDirectory: packageDirectories[requestName],
            requestName,
        }),
    });

    assert.equal(await fs.promises.readFile(path.join(browserDirectory, 'package.json'), 'utf8'), originalPackage);
    assert.equal(await fs.promises.readFile(path.join(browserDirectory, 'src-gen', 'sentinel.txt'), 'utf8'), 'tracked generated sentinel');
    assert.equal(result.targetDirectory, path.join(browserDirectory, '.ride-tauri-profile', 'builds', 'isolated-build'));
    const generatedPackage = JSON.parse(await fs.promises.readFile(path.join(result.targetDirectory, 'package.json'), 'utf8'));
    assert.deepEqual(generatedPackage.dependencies, { shared: '1.2.3', product: '^1.0.0' });
    assert.deepEqual(generatedPackage.devDependencies, { '@theia/cli': '^1.0.0' });
    assert.deepEqual(generatedPackage.theia, { generator: { config: { preloadTemplate: './resources/preload.html' } } });
    assert.equal(generatedPackage.scripts, undefined);
    assert.ok(fs.existsSync(path.join(result.targetDirectory, 'esbuild.mjs')));
    assert.ok(fs.existsSync(path.join(result.targetDirectory, 'tauri-esbuild-profile-audit.mjs')));
    assert.ok(fs.existsSync(path.join(result.targetDirectory, 'ride-esbuild-dedupe.mjs')));
    assert.ok(fs.existsSync(path.join(result.targetDirectory, 'resources', 'preload.html')));
    assert.ok(fs.existsSync(path.join(result.targetDirectory, 'ico', 'favicon.ico')));
    assert.equal(
        await fs.promises.readFile(path.join(result.targetDirectory, 'tauri-src', 'deferred.ts'), 'utf8'),
        'export {};\n'
    );
    const profileManifest = JSON.parse(await fs.promises.readFile(path.join(result.targetDirectory, 'ride-tauri-profile.json'), 'utf8'));
    assert.equal(profileManifest.schema, 'ride.tauri-profile');
    assert.equal(profileManifest.version, 1);
    assert.equal(profileManifest.profile, 'tauri-critical');
    assert.equal(profileManifest.commit, '9'.repeat(40));
    assert.deepEqual(profileManifest.sourceIdentity, { commit: '9'.repeat(40), clean: true });
    assert.equal(profileManifest.buildId, 'isolated-build');
    assert.match(profileManifest.digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(profileManifest.featureGroups, result.featureGroups);
    assert.equal(fs.existsSync(path.join(result.targetDirectory, 'src-gen', 'sentinel.txt')), false);
});

test('generates and resolves a nested transitive Theia extension from its installed directory', async t => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-profile-nested-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const browserDirectory = path.join(root, 'app', 'applications', 'browser');
    const installedRoot = path.join(root, 'installed');
    const directories = Object.fromEntries(['product', 'helper', 'nested-theia', '@theia-cli'].map(name => [
        name,
        path.join(installedRoot, name),
    ]));
    await fs.promises.mkdir(path.join(browserDirectory, 'resources'), { recursive: true });
    await fs.promises.mkdir(path.join(browserDirectory, 'ico'), { recursive: true });
    for (const directory of Object.values(directories)) {
        await fs.promises.mkdir(directory, { recursive: true });
    }
    const browserManifest = {
        name: 'browser-app',
        version: '1.0.0',
        dependencies: { product: '^1.0.0' },
        devDependencies: { '@theia/cli': '^1.0.0' },
    };
    const manifests = {
        product: manifest('product', { helper: '^1.0.0' }),
        helper: { name: 'helper', version: '1.4.0', dependencies: { 'nested-theia': '^2.0.0' } },
        'nested-theia': manifest('nested-theia', {}, { version: '2.3.0' }),
        '@theia/cli': { name: '@theia/cli', version: '1.2.3' },
    };
    await fs.promises.writeFile(path.join(browserDirectory, 'package.json'), JSON.stringify(browserManifest));
    await fs.promises.writeFile(path.join(browserDirectory, 'tauri-profile.json'), JSON.stringify({
        schema: 'ride.tauri-frontend-profile@2',
        profiles: { 'tauri-critical': { roots: ['product'] }, full: { includeAllBrowserRoots: true } },
        featureGroups: {},
        buildDevDependencies: ['@theia/cli'],
    }));
    await fs.promises.writeFile(path.join(browserDirectory, 'esbuild.mjs'), 'export {};\n');
    await fs.promises.writeFile(path.join(browserDirectory, 'ride-esbuild-dedupe.mjs'), 'export {};\n');
    await fs.promises.writeFile(path.join(browserDirectory, 'tauri-esbuild-profile-audit.mjs'), 'export {};\n');
    for (const [requestName, packageManifest] of Object.entries(manifests)) {
        await fs.promises.writeFile(path.join(directories[requestName === '@theia/cli' ? '@theia-cli' : requestName], 'package.json'), JSON.stringify(packageManifest));
    }

    const result = await generateProfileTarget({
        browserDirectory,
        profileName: 'tauri-critical',
        buildId: 'nested-build',
        sourceIdentity: async () => ({ commit: 'a'.repeat(40), clean: true }),
        resolveInstalledManifest: async requestName => ({
            requestName,
            packageDirectory: directories[requestName === '@theia/cli' ? '@theia-cli' : requestName],
            manifest: manifests[requestName],
        }),
    });

    assert.equal(result.targetDirectory, path.join(browserDirectory, '.ride-tauri-profile', 'builds', 'nested-build'));
    const generated = JSON.parse(await fs.promises.readFile(path.join(result.targetDirectory, 'package.json'), 'utf8'));
    assert.deepEqual(generated.dependencies, {
        'nested-theia': '2.3.0',
        product: '^1.0.0',
    });
    const targetRequire = createRequire(path.join(result.targetDirectory, 'package.json'));
    assert.equal(targetRequire.resolve('nested-theia/package.json'), path.join(directories['nested-theia'], 'package.json'));
});

test('rejects dirty source identity before generating a build target', async t => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-profile-dirty-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    await assert.rejects(generateProfileTarget({
        browserDirectory: root,
        profileName: 'tauri-critical',
        buildId: 'dirty-build',
        sourceIdentity: async () => ({ commit: 'b'.repeat(40), clean: false }),
    }), /source tree.*clean/i);
});

test('source provenance ignores generated paths but rejects an untracked app resource before prepare', async t => {
    const repository = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-profile-provenance-'));
    t.after(() => fs.promises.rm(repository, { recursive: true, force: true }));
    const runGit = args => execFileSync('git', args, { cwd: repository, stdio: 'ignore' });
    runGit(['init']);
    runGit(['config', 'user.email', 'tests@example.invalid']);
    runGit(['config', 'user.name', 'R-IDE Tests']);
    await fs.promises.mkdir(path.join(repository, 'app', 'resources'), { recursive: true });
    await fs.promises.writeFile(path.join(repository, '.gitignore'), [
        'app/node_modules/',
        'app/lib/',
        'app/.ride-tauri-profile/',
        'app/src-gen/',
        '',
    ].join('\n'));
    await fs.promises.writeFile(path.join(repository, 'app', 'tracked.txt'), 'tracked');
    runGit(['add', '.']);
    runGit(['commit', '-m', 'fixture']);
    const profileModule = await import('../tauri-frontend-profile.mjs');
    assert.equal(typeof profileModule.readSourceIdentity, 'function');

    for (const relative of ['node_modules/cache.bin', 'lib/main.js', '.ride-tauri-profile/builds/x/file', 'src-gen/generated.js']) {
        const candidate = path.join(repository, 'app', relative);
        await fs.promises.mkdir(path.dirname(candidate), { recursive: true });
        await fs.promises.writeFile(candidate, 'ignored');
    }
    assert.deepEqual(profileModule.readSourceIdentity(repository), {
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
        clean: true,
    });

    await fs.promises.writeFile(path.join(repository, 'app', 'resources', 'untracked-asset.png'), 'new input');
    const dirtyIdentity = profileModule.readSourceIdentity(repository);
    assert.equal(dirtyIdentity.clean, false);
    await assert.rejects(generateProfileTarget({
        browserDirectory: path.join(repository, 'app', 'browser'),
        profileName: 'tauri-critical',
        buildId: 'untracked-resource',
        sourceIdentity: async () => dirtyIdentity,
    }), /source tree.*clean/i);
});

test('rejects conflicting installed identities for one request name with both paths', async t => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-profile-conflict-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const browserDirectory = path.join(root, 'browser');
    await fs.promises.mkdir(browserDirectory, { recursive: true });
    await fs.promises.writeFile(path.join(browserDirectory, 'package.json'), JSON.stringify({
        name: 'browser-app', version: '1.0.0', dependencies: { product: '^1.0.0' }, devDependencies: {},
    }));
    await fs.promises.writeFile(path.join(browserDirectory, 'tauri-profile.json'), JSON.stringify({
        schema: 'ride.tauri-frontend-profile@2',
        profiles: { 'tauri-critical': { roots: ['product'] } },
        featureGroups: {},
    }));
    await fs.promises.writeFile(path.join(browserDirectory, 'esbuild.mjs'), 'export {};\n');
    await fs.promises.writeFile(path.join(browserDirectory, 'ride-esbuild-dedupe.mjs'), 'export {};\n');
    await fs.promises.writeFile(path.join(browserDirectory, 'tauri-esbuild-profile-audit.mjs'), 'export {};\n');
    const packageByRequest = {
        product: manifest('product', { left: '^1.0.0', right: '^1.0.0' }),
        left: { name: 'left', version: '1.0.0', dependencies: { shared: '^1.0.0' } },
        right: { name: 'right', version: '1.0.0', dependencies: { shared: 'npm:other@^1.0.0' } },
    };
    await assert.rejects(generateProfileTarget({
        browserDirectory,
        profileName: 'tauri-critical',
        buildId: 'conflict-build',
        sourceIdentity: async () => ({ commit: 'c'.repeat(40), clean: true }),
        canonicalizePackageDirectory: async directory => path.resolve(directory),
        resolveInstalledManifest: async (requestName, fromDirectory) => {
            if (requestName === 'shared') {
                const fromRight = path.basename(fromDirectory) === 'right';
                return {
                    requestName,
                    packageDirectory: path.join(root, fromRight ? 'other' : 'shared'),
                    manifest: manifest(fromRight ? 'other' : 'shared', {}, { version: '1.2.0' }),
                };
            }
            return {
                requestName,
                packageDirectory: path.join(root, requestName),
                manifest: packageByRequest[requestName],
            };
        },
    }), /product -> left -> shared.*product -> right -> shared|product -> right -> shared.*product -> left -> shared/i);
});
