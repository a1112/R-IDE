import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

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
            renameCount += 1;
            if (renameCount === 2) {
                throw Object.assign(new Error('install failed'), { code: 'EIO' });
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
            renameCount += 1;
            if (renameCount === 2) {
                throw Object.assign(new Error('install failed'), { code: 'EIO' });
            }
            if (renameCount === 3) {
                throw Object.assign(new Error('rollback failed'), { code: 'EACCES' });
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
    assert.equal(fs.existsSync(plan.markerPath), true);
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
    assert.equal(JSON.parse(await fs.promises.readFile(plan.markerPath, 'utf8')).state, 'installed');

    await recoverDirectoryTransactions({ parentDirectory, targetName: 'lib' });
    assert.equal(fs.existsSync(plan.backupDirectory), false);
    assert.equal(fs.existsSync(plan.markerPath), false);
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

test('publish lock safely recovers a stale dead owner and writes canonical ownership', async t => {
    const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-publish-lock-'));
    t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
    const lockDirectory = path.join(browserDirectory, '.ride-tauri-publish.lock');
    await fs.promises.mkdir(lockDirectory);
    await fs.promises.writeFile(path.join(lockDirectory, 'owner.json'), `${JSON.stringify({
        schema: 'ride.tauri-publish-lock@1',
        pid: 999999,
        buildId: 'dead-build',
        profile: 'tauri-critical',
        commit: '1'.repeat(40),
        acquiredAt: 100,
    })}\n`);

    const release = await acquirePublishLock({
        browserDirectory,
        owner: {
            buildId: 'live-build',
            profile: 'full',
            commit: '2'.repeat(40),
        },
        now: () => 10_000,
        staleMs: 1_000,
        timeoutMs: 2_000,
        sleep: async () => {},
        isProcessAlive: () => false,
    });

    const owner = JSON.parse(await fs.promises.readFile(path.join(lockDirectory, 'owner.json'), 'utf8'));
    assert.deepEqual(owner, {
        schema: 'ride.tauri-publish-lock@1',
        pid: process.pid,
        buildId: 'live-build',
        profile: 'full',
        commit: '2'.repeat(40),
        acquiredAt: 10_000,
    });
    await release();
    assert.equal(fs.existsSync(lockDirectory), false);
});

test('publish lock waits for owner metadata initialization instead of failing ENOENT', async t => {
    const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-publish-lock-race-'));
    t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
    const lockDirectory = path.join(browserDirectory, '.ride-tauri-publish.lock');
    await fs.promises.mkdir(lockDirectory);
    let waits = 0;
    const release = await acquirePublishLock({
        browserDirectory,
        owner: { buildId: 'next-build', profile: 'full', commit: '4'.repeat(40) },
        now: () => 10_000,
        staleMs: 1_000,
        timeoutMs: 2_000,
        isProcessAlive: () => false,
        sleep: async () => {
            waits += 1;
            if (waits === 1) {
                await fs.promises.writeFile(path.join(lockDirectory, 'owner.json'), `${JSON.stringify({
                    schema: 'ride.tauri-publish-lock@1',
                    pid: 999999,
                    buildId: 'initializing-build',
                    profile: 'tauri-critical',
                    commit: '4'.repeat(40),
                    acquiredAt: 100,
                })}\n`);
            }
        },
    });

    assert.ok(waits >= 1);
    await release();
});

test('publish lock gives a fresh ownerless directory time to finish concurrent initialization', async t => {
    const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-publish-lock-ownerless-fresh-'));
    t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
    const lockDirectory = path.join(browserDirectory, '.ride-tauri-publish.lock');
    await fs.promises.mkdir(lockDirectory);
    await fs.promises.utimes(lockDirectory, new Date(9_500), new Date(9_500));
    let currentTime = 10_000;
    let waits = 0;
    let observedFreshDirectory = false;

    const release = await acquirePublishLock({
        browserDirectory,
        owner: { buildId: 'waiting-build', profile: 'full', commit: '5'.repeat(40) },
        now: () => currentTime,
        staleMs: 1_000,
        timeoutMs: 2_000,
        retryDelayMs: 100,
        isProcessAlive: () => true,
        sleep: async delay => {
            waits += 1;
            currentTime += delay;
            if (waits === 1) {
                observedFreshDirectory = fs.existsSync(lockDirectory)
                    && !fs.existsSync(path.join(lockDirectory, 'owner.json'));
                await fs.promises.writeFile(path.join(lockDirectory, 'owner.json'), `${JSON.stringify({
                    schema: 'ride.tauri-publish-lock@1',
                    pid: process.pid,
                    buildId: 'initializing-build',
                    profile: 'tauri-critical',
                    commit: '5'.repeat(40),
                    acquiredAt: currentTime,
                })}\n`);
            } else if (waits === 2) {
                await fs.promises.rm(lockDirectory, { recursive: true });
            }
        },
    });

    assert.equal(observedFreshDirectory, true);
    assert.ok(waits >= 2);
    await release();
});

test('publish lock preserves an owner initialized immediately before stale ownerless quarantine', async t => {
    const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-publish-lock-ownerless-quarantine-race-'));
    t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
    const lockDirectory = path.join(browserDirectory, '.ride-tauri-publish.lock');
    await fs.promises.mkdir(lockDirectory);
    await fs.promises.utimes(lockDirectory, new Date(100), new Date(100));
    let currentTime = 10_000;
    let initializedDuringQuarantine = false;
    let preservedLiveOwner = false;
    const filesystem = {
        ...fs.promises,
        rename: async (source, destination) => {
            if (!initializedDuringQuarantine && path.resolve(source) === path.resolve(lockDirectory)
                && path.basename(destination).startsWith('.ride-tauri-publish.lock.stale-')) {
                initializedDuringQuarantine = true;
                await fs.promises.writeFile(path.join(lockDirectory, 'owner.json'), `${JSON.stringify({
                    schema: 'ride.tauri-publish-lock@1',
                    pid: process.pid,
                    buildId: 'initializing-build',
                    profile: 'tauri-critical',
                    commit: '5'.repeat(40),
                    acquiredAt: currentTime,
                })}\n`);
            }
            return fs.promises.rename(source, destination);
        },
    };

    const release = await acquirePublishLock({
        browserDirectory,
        filesystem,
        owner: { buildId: 'waiting-build', profile: 'full', commit: '5'.repeat(40) },
        now: () => currentTime,
        staleMs: 1_000,
        timeoutMs: 2_000,
        retryDelayMs: 100,
        isProcessAlive: () => true,
        sleep: async delay => {
            currentTime += delay;
            preservedLiveOwner = JSON.parse(
                await fs.promises.readFile(path.join(lockDirectory, 'owner.json'), 'utf8'),
            ).buildId === 'initializing-build';
            await fs.promises.rm(lockDirectory, { recursive: true });
        },
    });

    assert.equal(initializedDuringQuarantine, true);
    assert.equal(preservedLiveOwner, true);
    await release();
});

test('publish lock rejects non-directory and symbolic-link lock paths', async t => {
    const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-publish-lock-unsafe-'));
    t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
    const lockDirectory = path.join(browserDirectory, '.ride-tauri-publish.lock');
    const options = {
        browserDirectory,
        owner: { buildId: 'safe-build', profile: 'full', commit: '5'.repeat(40) },
        timeoutMs: 0,
    };
    await fs.promises.writeFile(lockDirectory, 'not a directory');
    await assert.rejects(acquirePublishLock(options), /unsafe.*publish lock path/i);
    await fs.promises.rm(lockDirectory);
    const linkTarget = path.join(browserDirectory, 'lock-link-target');
    await fs.promises.mkdir(linkTarget);
    await fs.promises.symlink(linkTarget, lockDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(acquirePublishLock(options), /unsafe.*publish lock path/i);
});

test('publish lock recovers a stale ownerless directory using its own mtime', async t => {
    const browserDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-publish-lock-ownerless-stale-'));
    t.after(() => fs.promises.rm(browserDirectory, { recursive: true, force: true }));
    const lockDirectory = path.join(browserDirectory, '.ride-tauri-publish.lock');
    await fs.promises.mkdir(lockDirectory);
    await fs.promises.utimes(lockDirectory, new Date(100), new Date(100));
    let currentTime = 10_000;

    const release = await acquirePublishLock({
        browserDirectory,
        owner: { buildId: 'ownerless-recovery', profile: 'full', commit: '5'.repeat(40) },
        now: () => currentTime,
        staleMs: 1_000,
        timeoutMs: 2_000,
        retryDelayMs: 100,
        sleep: async delay => { currentTime += delay; },
    });

    const owner = JSON.parse(await fs.promises.readFile(path.join(lockDirectory, 'owner.json'), 'utf8'));
    assert.equal(owner.buildId, 'ownerless-recovery');
    await release();
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
        lockOptions: { retryDelayMs: 2, timeoutMs: 2_000 },
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
    await fs.promises.writeFile(path.join(browserDirectory, 'resources', 'preload.html'), '<main></main>\n');
    await fs.promises.writeFile(path.join(browserDirectory, 'ico', 'favicon.ico'), 'ico');
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
    assert.ok(fs.existsSync(path.join(result.targetDirectory, 'ride-esbuild-dedupe.mjs')));
    assert.ok(fs.existsSync(path.join(result.targetDirectory, 'resources', 'preload.html')));
    assert.ok(fs.existsSync(path.join(result.targetDirectory, 'ico', 'favicon.ico')));
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
    }), /tracked source tree.*clean/i);
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
