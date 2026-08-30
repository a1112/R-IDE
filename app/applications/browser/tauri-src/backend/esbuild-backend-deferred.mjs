// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import path from 'node:path';

const BACKEND_MAIN_ONLY_PLUGINS = new Set([
    '@theia/esbuild-plugin',
    'plugin:copy',
    'ride-tauri-backend-patches',
]);

function normalize(candidate) {
    return candidate.replaceAll('\\', '/').replace(/^\.\//, '');
}

function hasPathSuffix(candidate, expected) {
    const actualParts = normalize(candidate).split('/').filter(Boolean);
    const expectedParts = normalize(expected).split('/').filter(Boolean);
    return expectedParts.length <= actualParts.length
        && expectedParts.every((part, index) => part === actualParts[actualParts.length - expectedParts.length + index]);
}

function deferredBackendModules(profileManifest) {
    if (profileManifest?.profile !== 'tauri-critical') {
        return [];
    }
    return Object.entries(profileManifest.featureGroups ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([, group]) => [...(group.deferredBackendModules ?? [])]
            .sort((left, right) => left.action.localeCompare(right.action)));
}

function relativeModuleRequest(descriptor) {
    const importer = `${descriptor.package}/lib/node/backend-module.js`;
    const relative = path.posix.relative(path.posix.dirname(importer), descriptor.module);
    return relative.startsWith('.') ? relative : `./${relative}`;
}

function escapeRegex(candidate) {
    return candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createDeferredBackendAliasPlugin(descriptors, baseDirectory) {
    const requests = [...new Set(descriptors.map(relativeModuleRequest))];
    const filter = new RegExp(`^(?:${requests.map(escapeRegex).join('|')})$`);
    return {
        name: 'ride-tauri-deferred-backend-alias',
        setup(build) {
            build.onResolve({ filter }, args => {
                for (const descriptor of descriptors) {
                    const importer = `node_modules/${descriptor.package}/lib/node/backend-module.js`;
                    if (args.path === relativeModuleRequest(descriptor)
                        && hasPathSuffix(args.importer, importer)) {
                        return { path: path.resolve(baseDirectory, descriptor.proxy) };
                    }
                }
                return undefined;
            });
        },
    };
}

function featureBuildOptions(nodeOptions, descriptor, baseDirectory) {
    const {
        entryPoints: _entryPoints,
        outdir: _outdir,
        outfile: _outfile,
        plugins = [],
        ...sharedOptions
    } = nodeOptions;
    return {
        ...sharedOptions,
        entryPoints: [path.resolve(baseDirectory, descriptor.entry)],
        outfile: path.resolve(baseDirectory, descriptor.output),
        format: 'cjs',
        platform: 'node',
        splitting: false,
        plugins: plugins.filter(plugin => !BACKEND_MAIN_ONLY_PLUGINS.has(plugin.name)),
    };
}

export function createTauriBackendBuildPlans(nodeOptions, profileManifest, baseDirectory) {
    const descriptors = deferredBackendModules(profileManifest);
    if (descriptors.length === 0) {
        return { main: nodeOptions, features: [] };
    }
    const main = {
        ...nodeOptions,
        plugins: [
            createDeferredBackendAliasPlugin(descriptors, baseDirectory),
            ...(nodeOptions.plugins ?? []),
        ],
    };
    const features = descriptors.map(descriptor => ({
        action: descriptor.action,
        descriptor,
        options: featureBuildOptions(nodeOptions, descriptor, baseDirectory),
    }));
    return { main, features };
}
