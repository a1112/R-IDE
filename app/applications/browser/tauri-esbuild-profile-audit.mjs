import fs from 'node:fs';
import path from 'node:path';

const PROFILE_MANIFEST_NAME = 'ride-tauri-profile.json';
const THEIA_SPECIFIER = /^(@theia\/[^/]+)(?:\/|$)/;

export function theiaPackageNameFromSpecifier(specifier) {
    if (typeof specifier !== 'string') {
        return undefined;
    }
    return specifier.replaceAll('\\', '/').match(THEIA_SPECIFIER)?.[1];
}

export function buildAllowedTheiaPackageSet(profileManifest) {
    if (!profileManifest || !Array.isArray(profileManifest.packages)) {
        throw new Error('Generated Tauri profile manifest must declare its package contract.');
    }
    const allowed = new Set();
    for (const record of profileManifest.packages) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
            throw new Error('Generated Tauri profile package contract is malformed.');
        }
        for (const field of ['requestName', 'packageName']) {
            const packageName = record[field];
            if (typeof packageName !== 'string' || !packageName) {
                throw new Error(`Generated Tauri profile package ${field} is malformed.`);
            }
            if (theiaPackageNameFromSpecifier(packageName) === packageName) {
                allowed.add(packageName);
            }
        }
    }
    return allowed;
}

async function packageOwnerFromFilesystem(input, baseDirectory, filesystem) {
    const portableInput = input.replaceAll('\\', path.sep).replaceAll('/', path.sep);
    let directory = path.dirname(path.isAbsolute(portableInput)
        ? portableInput
        : path.resolve(baseDirectory, portableInput));
    while (true) {
        try {
            const manifest = JSON.parse(await filesystem.readFile(path.join(directory, 'package.json'), 'utf8'));
            const packageName = theiaPackageNameFromSpecifier(manifest?.name);
            if (packageName) {
                return packageName;
            }
        } catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes(error?.code) && !(error instanceof SyntaxError)) {
                throw error;
            }
        }
        const parent = path.dirname(directory);
        if (parent === directory) {
            return undefined;
        }
        directory = parent;
    }
}

function packageOwnerFromPortablePath(input) {
    const segments = input.replaceAll('\\', '/').split('/').filter(Boolean);
    for (let index = 0; index < segments.length - 2; index += 1) {
        if (segments[index] === 'node_modules' && segments[index + 1] === '@theia') {
            return `@theia/${segments[index + 2]}`;
        }
    }
    return undefined;
}

export async function auditTheiaMetafile({
    metafile,
    allowedPackages,
    baseDirectory,
    filesystem = fs.promises,
}) {
    if (!metafile || !metafile.inputs || typeof metafile.inputs !== 'object') {
        throw new Error('Tauri profile esbuild audit requires an in-memory metafile.');
    }
    if (!(allowedPackages instanceof Set)) {
        throw new Error('Tauri profile esbuild audit requires an allowed package set.');
    }
    const undeclared = new Set();
    for (const input of Object.keys(metafile.inputs).sort()) {
        const packageName = await packageOwnerFromFilesystem(input, baseDirectory, filesystem)
            ?? packageOwnerFromPortablePath(input);
        if (packageName && !allowedPackages.has(packageName)) {
            undeclared.add(packageName);
        }
    }
    if (undeclared.size > 0) {
        throw new Error(`Tauri profile bundle imported undeclared Theia package(s): ${[...undeclared].sort().join(', ')}`);
    }
}

export function createTauriProfileAuditPlugin({ baseDirectory, allowedPackages }) {
    return {
        name: 'ride-tauri-profile-contract',
        setup(build) {
            build.onResolve({ filter: /^@theia\/[^/]+(?:\/|$)/ }, args => {
                const packageName = theiaPackageNameFromSpecifier(args.path);
                if (!allowedPackages.has(packageName)) {
                    return { errors: [{ text: `Tauri profile imported undeclared Theia package: ${packageName}` }] };
                }
                return undefined;
            });
            build.onEnd(async result => {
                if ((result.errors?.length ?? 0) === 0) {
                    await auditTheiaMetafile({
                        metafile: result.metafile,
                        allowedPackages,
                        baseDirectory,
                    });
                }
            });
        },
    };
}

export async function loadTauriProfileManifest(baseDirectory, filesystem = fs.promises) {
    const manifestPath = path.join(path.resolve(baseDirectory), PROFILE_MANIFEST_NAME);
    let text;
    try {
        text = await filesystem.readFile(manifestPath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`Generated Tauri profile manifest is malformed: ${error.message}`);
    }
}
