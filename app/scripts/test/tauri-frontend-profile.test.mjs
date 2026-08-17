import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    canonicalDigest,
    createAtomicDirectoryPlan,
    generateProfileTarget,
    resolveProfile,
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

function fixture({ roots = ['product'], deferredGroups = {}, dependencies, packages, profileName = 'tauri-critical' }) {
    const browserDependencies = dependencies ?? Object.fromEntries(Object.keys(packages).map(name => [name, '^1.0.0']));
    return {
        profileName,
        profileConfig: {
            schema: 'ride.tauri-frontend-profile@1',
            profiles: {
                'tauri-critical': { roots },
                full: { includeAllBrowserRoots: true },
            },
            deferredGroups,
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

test('limits the application closure to browser roots instead of unrelated runtime packages', () => {
    const result = resolveProfile(fixture({
        dependencies: { product: '^1.0.0', shared: '^1.0.0' },
        packages: {
            product: manifest('product', { electron: '42.3.0' }),
        },
    }));

    assert.deepEqual(result.extensions, ['product']);
    assert.deepEqual(result.packages, [{ requestName: 'product', packageName: 'product', version: '1.2.3' }]);
});

test('does not collapse nested runtime versions into the Theia extension graph', () => {
    const result = resolveProfile(fixture({
        dependencies: { product: '^1.0.0', utility: '^9.0.0' },
        packages: {
            product: manifest('product', { utility: '^4.0.0' }),
            utility: { name: 'utility', version: '9.1.0' },
        },
    }));

    assert.deepEqual(result.extensions, ['product']);
});

test('fails closed on exact critical/deferred conflicts without prefix matching', () => {
    const packages = {
        product: manifest('product', { '@theia/notebook': '^1.0.0', '@theia/ai-core': '^1.0.0' }),
        '@theia/notebook': manifest('@theia/notebook'),
        '@theia/ai-core': manifest('@theia/ai-core'),
    };

    assert.throws(
        () => resolveProfile(fixture({
            packages,
            deferredGroups: { notebook: ['@theia/notebook'] },
        })),
        /Deferred root "@theia\/notebook".*product -> @theia\/notebook/i,
    );

    const result = resolveProfile(fixture({
        packages,
        deferredGroups: { ai: ['@theia/ai'] },
    }));
    assert.ok(result.extensions.includes('@theia/ai-core'));
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
    });

    input.packageManifests['core-alias'] = manifest('@theia/core', {}, { version: '2.0.0' });
    assert.throws(() => resolveProfile(input), /core-alias.*does not satisfy.*\^1\.2\.0/i);
    input.packageManifests['core-alias'] = manifest('@theia/not-core');
    assert.throws(() => resolveProfile(input), /core-alias.*expected package name "@theia\/core"/i);
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
    const result = resolveProfile(fixture({ profileName: 'full', packages }));

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

test('constrains atomic target paths to the ignored profile directory', () => {
    const browserDirectory = path.resolve('browser-app');
    const plan = createAtomicDirectoryPlan(browserDirectory, '.ride-tauri-profile', 'unit');

    assert.equal(plan.targetDirectory, path.join(browserDirectory, '.ride-tauri-profile'));
    assert.equal(path.dirname(plan.temporaryDirectory), browserDirectory);
    assert.match(path.basename(plan.temporaryDirectory), /^\.ride-tauri-profile\.tmp-unit-/);
    assert.throws(() => createAtomicDirectoryPlan(browserDirectory, '..', 'unit'), /\.ride-tauri-profile/i);
    assert.throws(() => createAtomicDirectoryPlan(browserDirectory, 'profile', 'unit'), /\.ride-tauri-profile/i);
});

test('generates an isolated target without writing tracked package.json or src-gen', async t => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-profile-test-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const browserDirectory = path.join(root, 'app', 'applications', 'browser');
    const packageDirectory = path.join(root, 'installed', 'product');
    await fs.promises.mkdir(path.join(browserDirectory, 'resources'), { recursive: true });
    await fs.promises.mkdir(path.join(browserDirectory, 'ico'), { recursive: true });
    await fs.promises.mkdir(path.join(browserDirectory, 'src-gen'), { recursive: true });
    await fs.promises.mkdir(packageDirectory, { recursive: true });
    await fs.promises.writeFile(path.join(browserDirectory, 'package.json'), JSON.stringify({
        name: 'browser-app',
        version: '1.0.0',
        dependencies: { product: '^1.0.0', shared: '^1.0.0' },
        devDependencies: { '@theia/cli': '^1.0.0' },
        theia: { generator: { config: { preloadTemplate: './resources/preload.html' } } },
    }, null, 2));
    await fs.promises.writeFile(path.join(browserDirectory, 'tauri-profile.json'), JSON.stringify({
        schema: 'ride.tauri-frontend-profile@1',
        profiles: { 'tauri-critical': { roots: ['product'] }, full: { includeAllBrowserRoots: true } },
        deferredGroups: {},
        buildDevDependencies: ['@theia/cli'],
    }, null, 2));
    await fs.promises.writeFile(path.join(browserDirectory, 'esbuild.mjs'), 'export {};\n');
    await fs.promises.writeFile(path.join(browserDirectory, 'ride-esbuild-dedupe.mjs'), 'export {};\n');
    await fs.promises.writeFile(path.join(browserDirectory, 'resources', 'preload.html'), '<main></main>\n');
    await fs.promises.writeFile(path.join(browserDirectory, 'ico', 'favicon.ico'), 'ico');
    await fs.promises.writeFile(path.join(browserDirectory, 'src-gen', 'sentinel.txt'), 'tracked generated sentinel');
    await fs.promises.writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify(manifest('product')));
    const originalPackage = await fs.promises.readFile(path.join(browserDirectory, 'package.json'), 'utf8');

    const result = await generateProfileTarget({
        browserDirectory,
        profileName: 'tauri-critical',
        resolveInstalledManifest: async (requestName, fromDirectory) => ({
            manifest: requestName === '@theia/cli'
                ? manifest('@theia/cli')
                : requestName === 'shared'
                    ? manifest('shared', {}, { version: fromDirectory === browserDirectory ? '1.2.3' : '0.5.0' })
                    : manifest('product', { shared: '^1.0.0' }),
            packageDirectory,
            requestName,
        }),
    });

    assert.equal(await fs.promises.readFile(path.join(browserDirectory, 'package.json'), 'utf8'), originalPackage);
    assert.equal(await fs.promises.readFile(path.join(browserDirectory, 'src-gen', 'sentinel.txt'), 'utf8'), 'tracked generated sentinel');
    assert.equal(result.targetDirectory, path.join(browserDirectory, '.ride-tauri-profile'));
    const generatedPackage = JSON.parse(await fs.promises.readFile(path.join(result.targetDirectory, 'package.json'), 'utf8'));
    assert.deepEqual(generatedPackage.dependencies, { shared: '^1.0.0', product: '^1.0.0' });
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
    assert.match(profileManifest.commit, /^[0-9a-f]{40}$/);
    assert.match(profileManifest.digest, /^[0-9a-f]{64}$/);
    assert.equal(fs.existsSync(path.join(result.targetDirectory, 'src-gen', 'sentinel.txt')), false);
});
