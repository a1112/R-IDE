// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import fs from 'node:fs';
import path from 'node:path';

const BACKEND_MAIN_ONLY_PLUGINS = new Set([
    '@theia/esbuild-plugin',
    'plugin:copy',
    'ride-tauri-backend-patches',
]);

function normalize(candidate) {
    const normalized = path.resolve(candidate).replaceAll('\\', '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function portableRelativePathIdentity(candidate) {
    return candidate.replaceAll('\\', '/').toLowerCase();
}

function assertInside(baseDirectory, candidate, label) {
    const relative = path.relative(path.resolve(baseDirectory), path.resolve(candidate));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`${label} must stay inside the generated browser application.`);
    }
}

function moduleFile(baseDirectory, request) {
    const candidate = path.resolve(baseDirectory, 'node_modules', ...request.split('/'));
    return path.extname(candidate) ? candidate : `${candidate}.js`;
}

function assertRegularFile(candidate, label) {
    let stat;
    try {
        stat = fs.lstatSync(candidate);
    } catch (error) {
        throw new Error(`${label} is missing: ${candidate} (${error.message}).`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`${label} must be a regular file: ${candidate}.`);
    }
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
    const relative = path.posix.relative(path.posix.dirname(descriptor.importer), descriptor.module);
    return relative.startsWith('.') ? relative : `./${relative}`;
}

function escapeRegex(candidate) {
    return candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveDescriptor(descriptor, baseDirectory) {
    const proxy = path.resolve(baseDirectory, descriptor.proxy);
    const entry = path.resolve(baseDirectory, descriptor.entry);
    const output = path.resolve(baseDirectory, descriptor.output);
    const importer = moduleFile(baseDirectory, descriptor.importer);
    const implementation = moduleFile(baseDirectory, descriptor.module);
    for (const [candidate, label] of [
        [proxy, 'Deferred backend proxy'],
        [entry, 'Deferred backend feature entry'],
        [output, 'Deferred backend feature output'],
        [importer, 'Deferred backend importer'],
        [implementation, 'Deferred backend implementation'],
    ]) {
        assertInside(baseDirectory, candidate, label);
    }
    for (const [candidate, label] of [
        [proxy, 'Deferred backend proxy'],
        [entry, 'Deferred backend feature entry'],
        [importer, 'Deferred backend importer'],
        [implementation, 'Deferred backend implementation'],
    ]) {
        assertRegularFile(candidate, label);
    }
    return {
        ...descriptor,
        baseDirectory: path.resolve(baseDirectory),
        proxyPath: proxy,
        entryPath: entry,
        outputPath: output,
        importerPath: importer,
        implementationPath: implementation,
        request: relativeModuleRequest(descriptor),
    };
}

function physicalFileIdentities(candidate) {
    const realpath = fs.realpathSync.native?.(candidate) ?? fs.realpathSync(candidate);
    const stat = fs.statSync(candidate, { bigint: true });
    const identities = [`realpath:${normalize(realpath)}`];
    if (stat.dev !== 0n || stat.ino !== 0n) {
        identities.push(`file:${stat.dev}:${stat.ino}`);
    }
    return identities;
}

function assertDistinctDescriptorSourceFiles(descriptors) {
    for (const field of ['proxy', 'entry']) {
        const identities = new Map();
        for (const descriptor of descriptors) {
            for (const identity of physicalFileIdentities(descriptor[`${field}Path`])) {
                const existing = identities.get(identity);
                if (existing) {
                    throw new Error(
                        `Deferred backend ${field} physical identity is duplicated: ${existing[field]} and ${descriptor[field]}.`,
                    );
                }
                identities.set(identity, descriptor);
            }
        }
    }
}

function mainOutputPaths(nodeOptions, baseDirectory) {
    if (nodeOptions.outfile) {
        return new Set([normalize(path.resolve(baseDirectory, nodeOptions.outfile))]);
    }
    const outdir = path.resolve(baseDirectory, nodeOptions.outdir ?? '.');
    const extension = nodeOptions.outExtension?.['.js'] ?? '.js';
    const entries = Array.isArray(nodeOptions.entryPoints)
        ? nodeOptions.entryPoints.map(entry => path.basename(typeof entry === 'string' ? entry : entry.out ?? entry.in, path.extname(typeof entry === 'string' ? entry : entry.out ?? entry.in)))
        : Object.keys(nodeOptions.entryPoints ?? {});
    return new Set(entries.map(entry => normalize(path.join(outdir, `${entry}${extension}`))));
}

function createDeferredBackendAliasPlugin(descriptors) {
    const requests = [...new Set(descriptors.map(descriptor => descriptor.request))];
    const filter = new RegExp(`^(?:${requests.map(escapeRegex).join('|')})$`);
    return {
        name: 'ride-tauri-deferred-backend-alias',
        setup(build) {
            build.onResolve({ filter }, args => {
                const descriptor = descriptors.find(candidate => (
                    args.path === candidate.request
                    && normalize(args.importer) === normalize(candidate.importerPath)
                ));
                return descriptor ? { path: descriptor.proxyPath } : undefined;
            });
        },
    };
}

function featureBuildOptions(nodeOptions, descriptor) {
    const {
        entryPoints: _entryPoints,
        outdir: _outdir,
        outfile: _outfile,
        plugins = [],
        ...sharedOptions
    } = nodeOptions;
    return {
        ...sharedOptions,
        absWorkingDir: descriptor.baseDirectory,
        entryPoints: [descriptor.entryPath],
        outfile: descriptor.outputPath,
        format: 'cjs',
        platform: 'node',
        splitting: false,
        plugins: plugins.filter(plugin => !BACKEND_MAIN_ONLY_PLUGINS.has(plugin.name)),
    };
}

export function createTauriBackendBuildPlans(nodeOptions, profileManifest, baseDirectory) {
    const rawDescriptors = deferredBackendModules(profileManifest);
    for (const field of ['proxy', 'entry']) {
        const values = new Set();
        for (const descriptor of rawDescriptors) {
            const identity = portableRelativePathIdentity(descriptor[field]);
            if (values.has(identity)) {
                throw new Error(`Deferred backend ${field} is duplicated: ${descriptor[field]}.`);
            }
            values.add(identity);
        }
    }
    const descriptors = rawDescriptors
        .map(descriptor => resolveDescriptor(descriptor, baseDirectory));
    assertDistinctDescriptorSourceFiles(descriptors);
    if (descriptors.length === 0) {
        return { main: nodeOptions, features: [] };
    }
    const occupiedOutputs = mainOutputPaths(nodeOptions, baseDirectory);
    for (const descriptor of descriptors) {
        const output = normalize(descriptor.outputPath);
        if (occupiedOutputs.has(output)) {
            throw new Error(`Deferred backend output collides with another backend output: ${descriptor.output}.`);
        }
        occupiedOutputs.add(output);
    }
    const main = {
        ...nodeOptions,
        absWorkingDir: path.resolve(baseDirectory),
        plugins: [
            createDeferredBackendAliasPlugin(descriptors),
            ...(nodeOptions.plugins ?? []),
        ],
    };
    const features = descriptors.map(descriptor => ({
        action: descriptor.action,
        descriptor,
        options: featureBuildOptions(nodeOptions, descriptor),
    }));
    return { main, features };
}

async function collectContextDisposalErrors(contexts) {
    const results = await Promise.allSettled(contexts.map(context => (
        Promise.resolve().then(() => context.dispose())
    )));
    return results
        .filter(result => result.status === 'rejected')
        .map(result => result.reason);
}

function operationAndDisposalError(operationError, disposalError, message) {
    const disposalErrors = disposalError instanceof AggregateError
        ? disposalError.errors
        : [disposalError];
    return new AggregateError([operationError, ...disposalErrors], message);
}

export async function createTauriBuildContexts(contextOptions, createContext) {
    const contexts = [];
    try {
        for (const options of contextOptions) {
            contexts.push(await createContext(options));
        }
    } catch (creationError) {
        const disposalErrors = await collectContextDisposalErrors([...contexts].reverse());
        if (disposalErrors.length > 0) {
            throw new AggregateError(
                [creationError, ...disposalErrors],
                'Tauri build context creation and partial cleanup failed.',
            );
        }
        throw creationError;
    }
    return contexts;
}

export async function runTauriBuildContexts(contexts, { watch = false } = {}) {
    let disposal;
    const dispose = () => {
        disposal ??= collectContextDisposalErrors(contexts).then(errors => {
            if (errors.length > 0) {
                throw new AggregateError(errors, 'One or more Tauri build contexts failed to dispose.');
            }
        });
        return disposal;
    };
    if (watch) {
        try {
            await Promise.all(contexts.map(context => context.watch()));
        } catch (error) {
            try {
                await dispose();
            } catch (disposeError) {
                throw operationAndDisposalError(
                    error,
                    disposeError,
                    'Tauri watch startup and context disposal failed.',
                );
            }
            throw error;
        }
        return dispose;
    }

    let buildError;
    try {
        for (const context of contexts) {
            await context.rebuild();
        }
    } catch (error) {
        buildError = error;
    }
    try {
        await dispose();
    } catch (disposeError) {
        if (buildError) {
            throw operationAndDisposalError(
                buildError,
                disposeError,
                'Tauri build and context disposal failed.',
            );
        }
        throw disposeError;
    }
    if (buildError) {
        throw buildError;
    }
    return dispose;
}
